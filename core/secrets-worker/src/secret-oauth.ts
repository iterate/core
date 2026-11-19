// A client secret may be a placeholder naming the secret that holds it; the pending attempt and the
// record keep the placeholder. The nonce is no secret: the start page's cookie binds the attempt.
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { CLOUDFLARE_READ_SCOPES, type ClientAuth } from "iterate/api";
import { codedError } from "iterate/lib";
import { base64url } from "iterate/signed";
import type { CloudClient } from "./cloud-client.ts";
import {
  clientAuthOf,
  clientSecretReferenceOf,
  type ClientSecretOf,
  isRecord,
  oauthTokenRequest,
  oauthTokensOf,
  originsOf,
  secretUseOf,
  type SecretRecord,
  type SecretUse,
} from "./secrets.ts";

// An hour: the link often reaches a person through an agent's chat, and they open it later.
const SECRET_OAUTH_TTL_MS = 60 * 60_000;

export type NormalizedSecretOAuthOptions = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  // "" for a public client
  clientSecret: string;
  clientAuth: ClientAuth;
  scope?: string;
  urls: string[];
  extra: Record<string, string>;
  next: string | null;
  account: AccountLookup | null;
  // the scope ceiling (iterate/api `grantedWithin`), and the account the grant must be for
  grantedWithin?: string[];
  expectAccount?: string;
  // RFC 7009: where a refused grant is given back
  revocationEndpoint?: string;
  use: SecretUse;
  anyoneWithLink: boolean;
  straightToProvider?: true;
  // `install`: a GitHub App's install page, which names no redirect URI and takes no PKCE challenge.
  // `beginEndpoint`: the Cloud's page the person confirms on, before the provider's.
  // `accounts`: the accounts whose installations the mind asks to be connected to.
  // `origin`: the Cloud's own address, which the secret keeps (./cloud-client.ts).
  cloud?: {
    name: string;
    origin: string;
    redirectUri: string;
    install: boolean;
    beginEndpoint?: string;
    accounts?: string[];
  };
};

// `body`: the JSON text of a POST (`method`), such as an MCP server's `tools/call`.
export type AccountLookup = {
  url: string;
  id: string;
  name: string | null;
  method?: "POST";
  body?: string;
};

// Nothing a browser may see.
export type PendingSecretOAuth = {
  options: NormalizedSecretOAuthOptions;
  // The exchange must repeat it exactly: RFC 6749 §4.1.3.
  redirectUri: string;
  codeVerifier: string;
  nonce: string;
  until: number;
};

// A provider caps `state` (X at 500 characters), so it holds no more.
export type SecretOAuthState = { path: string; nonce: string; start?: string };

export function stateOf(state: SecretOAuthState): string {
  return base64url(new TextEncoder().encode(JSON.stringify(state)));
}

export function parseSecretOAuthState(value: string | null): SecretOAuthState | null {
  if (!value) return null;
  try {
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
          character.charCodeAt(0),
        ),
      ),
    );
    if (
      !isRecord(claims) ||
      typeof claims.path !== "string" ||
      typeof claims.nonce !== "string" ||
      typeof (claims.start ?? "") !== "string"
    )
      return null;
    return {
      path: claims.path,
      nonce: claims.nonce,
      ...(typeof claims.start === "string" && { start: claims.start }),
    };
  } catch {
    return null;
  }
}

// Never an open redirect: `next` must be an `https:` URL on one of `origins`. The scheme is asked
// too: a `blob:` URL carries the origin of the page that made it.
function nextUrlOf(next: unknown, origins: readonly string[]): string | null {
  if (!next) return null;
  const url = URL.canParse(String(next)) ? new URL(String(next)) : null;
  if (!url || url.protocol !== "https:" || !origins.includes(url.origin))
    throw new Error(
      `next is an absolute URL on ${origins.join(" or ")}, got ${JSON.stringify(next)}`,
    );
  return url.href;
}

// With a Cloud client the Cloud says the endpoints, the client and the pin. Its token endpoint is
// its broker, outside the pin, where a code and a sealed refresh token go and no usable token does.
// `cloud` is that client as the Cloud at `cloud.origin` published it: the origin that the caller
// named in `client.origin`, which the attempt and then the secret keep.
export function normalizeSecretOAuth(
  given: unknown,
  nextOrigins: readonly string[] = [],
  cloud: (CloudClient & { origin: string }) | null = null,
): NormalizedSecretOAuthOptions {
  if (!isRecord(given)) throw new Error("secrets.beginOAuth: options is an object");
  const install = given.install === true;
  const asked = cloud && isRecord(given.client) ? given.client.accounts : undefined;
  const accounts = (Array.isArray(asked) ? asked : []).filter(
    (each): each is string => typeof each === "string" && /^[A-Za-z0-9-]{1,39}$/.test(each),
  );
  if (
    asked !== undefined &&
    !(Array.isArray(asked) && asked.length <= 20 && accounts.length === asked.length)
  )
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: client.accounts is a list of account names at the provider, 20 at most",
    );
  const said = [
    "authorizationEndpoint",
    "tokenEndpoint",
    "clientId",
    "clientSecret",
    "urls",
  ].filter((key) => cloud && given[key] !== undefined);
  if (said.length || (cloud && install && !cloud.installUrl))
    throw codedError(
      "INVALID_INPUT",
      said.length
        ? `secrets.beginOAuth: with a Cloud client, ${said.join(", ")} is the Cloud's to say`
        : `secrets.beginOAuth: the Cloud's client ${cloud?.name} has no install page`,
    );
  const ofCloud = cloud && {
    ...given,
    authorizationEndpoint: install ? cloud.installUrl : cloud.authorizationEndpoint,
    tokenEndpoint: cloud.tokenEndpoint,
    clientId: cloud.clientId,
    urls: cloud.urls,
    scope: given.scope ?? cloud.scopes?.join(" "),
  };
  const options: Record<string, unknown> = ofCloud || given;
  // HTTPS ONLY, checked here, before an attempt is stored: a person's browser goes to the
  // authorization endpoint, and the code, its verifier, the client secret and each refresh token
  // go to the token endpoint. A Cloud client's endpoints are on the Cloud's origin, which is
  // `https:` (./secrets.ts `cloudOriginOf`).
  const endpoint = (key: "authorizationEndpoint" | "tokenEndpoint") => {
    const url = new URL(String(options[key]));
    if (url.protocol !== "https:")
      throw new Error(`secrets.beginOAuth: ${key} must be an https URL`);
    return url;
  };
  const authorizationEndpoint = endpoint("authorizationEndpoint");
  const tokenEndpoint = endpoint("tokenEndpoint");
  if (typeof options.clientId !== "string" || !options.clientId)
    throw new Error("secrets.beginOAuth: clientId is required");
  const urls = options.urls === undefined ? [tokenEndpoint.origin] : originsOf(options.urls);
  if (!cloud && !urls.includes(tokenEndpoint.origin))
    throw new Error(
      `secrets.beginOAuth: tokenEndpoint ${tokenEndpoint.origin} is outside the pin ${urls.join(", ")} — the tokens only ever go toward a pinned host`,
    );
  const account = accountLookupOf(options.account, urls);
  // the vault's own ceiling for the provider: the scope answer that it checks must be the
  // provider's own, so a grant whose token may go to the provider comes from its token endpoint
  const own = ownCeilingOf([authorizationEndpoint.origin, tokenEndpoint.origin, ...urls]);
  if (own && !ownCeilingOf([tokenEndpoint.origin]))
    throw codedError(
      "INVALID_INPUT",
      `secrets.beginOAuth: a grant whose token may go to ${own.provider} comes from ${own.provider}'s own token endpoint, not ${tokenEndpoint.origin}`,
    );
  const grantedWithin = grantedWithinOf(options.grantedWithin, options.scope, Boolean(cloud), own);
  const revocationEndpoint = revocationEndpointOf(options.revocationEndpoint, urls);
  const expectAccount = typeof options.expectAccount === "string" ? options.expectAccount : "";
  if ("expectAccount" in options && !expectAccount)
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: expectAccount is the account's id, a string",
    );
  if (expectAccount && !account && !cloud)
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: expectAccount needs account, the endpoint that names the account of the new tokens",
    );
  const extra: Record<string, string> = {};
  if (isRecord(options.extra))
    for (const [key, value] of Object.entries(options.extra)) extra[key] = String(value);
  const clientSecret = typeof options.clientSecret === "string" ? options.clientSecret : "";
  clientSecretReferenceOf(clientSecret); // a placeholder among other text is refused here
  // A client ID is not secret and goes into the authorize URL its caller gets back, so it is never
  // read out of a secret: resolving a placeholder there would hand any secret's value to the caller.
  if (String(options.clientId).includes("getSecret("))
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: clientId is the client ID itself, never a getSecret placeholder: it is no secret, and it goes into the authorize URL",
    );
  return {
    authorizationEndpoint: authorizationEndpoint.href,
    tokenEndpoint: tokenEndpoint.href,
    clientId: String(options.clientId),
    clientSecret,
    clientAuth: clientAuthOf(options.clientAuth),
    ...(typeof options.scope === "string" && options.scope && { scope: options.scope }),
    urls,
    extra,
    next: nextUrlOf(options.next, nextOrigins),
    account,
    grantedWithin,
    expectAccount: expectAccount || undefined,
    revocationEndpoint,
    use: secretUseOf(options),
    anyoneWithLink: options.anyoneWithLink === true,
    ...(options.straightToProvider === true && { straightToProvider: true }),
    ...(cloud && {
      cloud: {
        name: cloud.name,
        origin: cloud.origin,
        redirectUri: cloud.redirectUri,
        install,
        beginEndpoint: cloud.beginEndpoint,
        ...(accounts.length > 0 && { accounts }),
      },
    }),
  };
}

const AccountLookupInput = z.object({
  // the lookup carries the access token as a bearer
  url: z.url({ protocol: /^https$/ }),
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  method: z.enum(["GET", "POST"]).optional(),
  body: z.unknown().optional(),
});

/** A scope's name: no space, no comma, as a `scope` string separates them. */
const SCOPE_NAME = /^[^\s,]{1,200}$/;

/** THE VAULT'S OWN CEILING FOR A PROVIDER: the scopes outside which it keeps no grant whose
 *  tokens the provider issues or may receive. No caller can leave it out or widen it: a caller's
 *  `grantedWithin` only narrows it. Cloudflare's OAuth (its dashboard's server and its MCP
 *  server's) grants reads alone here: a grant that writes could change the account that the mind
 *  runs in, its own Workers among them. The MCP server adds `user:read`, `account:read` and
 *  `offline_access` to every grant. */
const OWN_CEILINGS: readonly { provider: string; hosts: RegExp; scopes: readonly string[] }[] = [
  {
    provider: "Cloudflare",
    hosts: /(^|\.)cloudflare\.com$/,
    scopes: [...CLOUDFLARE_READ_SCOPES, "user:read", "account:read", "offline_access"],
  },
];

/** The vault's own ceiling for the first provider that one of `origins` belongs to. */
function ownCeilingOf(origins: readonly string[]) {
  return OWN_CEILINGS.find(({ hosts }) =>
    origins.some((origin) => URL.canParse(origin) && hosts.test(new URL(origin).hostname)),
  );
}

/** THE CEILING THAT A GRANT IS HELD TO, at its consent and at each refresh: the caller's
 *  `grantedWithin`, within the vault's own for the provider; the vault's own when the caller
 *  named none. A grant kept before the vault had its own ceiling meets it at its next refresh. */
export function grantCeilingOf(
  given: readonly string[] | undefined,
  origins: readonly string[],
): readonly string[] | undefined {
  const own = ownCeilingOf(origins)?.scopes;
  if (!own) return given;
  return given ? given.filter((scope) => own.includes(scope)) : own;
}

// The scope ceiling (iterate/api `grantedWithin`): a list of scope names, which holds every scope
// that the connect asks for, within the vault's own for the provider (`own`). With a Cloud's
// client the client says the scopes.
function grantedWithinOf(
  value: unknown,
  scope: unknown,
  client: boolean,
  own: ReturnType<typeof ownCeilingOf>,
): string[] | undefined {
  const given = value === undefined ? undefined : scopeListOf(value, client);
  const ownScopes = own?.scopes;
  if (!given && !ownScopes) return undefined;
  const within = [...new Set(given || ownScopes)];
  const wider = ownScopes ? within.filter((each) => !ownScopes.includes(each)) : [];
  if (wider.length)
    throw codedError(
      "INVALID_INPUT",
      `secrets.beginOAuth: grantedWithin names ${wider.join(", ")}, beyond what the vault keeps of a grant from ${own?.provider}: reads alone`,
    );
  const outside = (typeof scope === "string" ? scope.split(/\s+/) : [])
    .filter(Boolean)
    .filter((each) => !within.includes(each));
  if (outside.length)
    throw codedError(
      "INVALID_INPUT",
      own && !given
        ? `secrets.beginOAuth: scope asks for ${outside.join(", ")}, beyond what the vault keeps of a grant from ${own.provider}: reads alone`
        : `secrets.beginOAuth: scope asks for ${outside.join(", ")}, which grantedWithin does not hold`,
    );
  return within;
}

/** A caller's `grantedWithin`: 1 to 1000 scope names, and only with a client of its own. */
function scopeListOf(value: unknown, client: boolean): string[] {
  if (
    client ||
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 1000 ||
    !value.every((each): each is string => typeof each === "string" && SCOPE_NAME.test(each))
  )
    throw codedError(
      "INVALID_INPUT",
      client
        ? "secrets.beginOAuth: grantedWithin is for a client of your own (clientId)"
        : "secrets.beginOAuth: grantedWithin is a list of scope names, 1 to 1000",
    );
  return value;
}

/** RFC 7009's endpoint, where the vault gives back a grant that it refused: https, within the
 *  pin, since the refused token goes there. */
function revocationEndpointOf(value: unknown, urls: string[]): string | undefined {
  if (value === undefined) return undefined;
  const url = typeof value === "string" && URL.canParse(value) ? new URL(value) : null;
  if (url?.protocol !== "https:" || !urls.includes(url.origin))
    throw codedError(
      "INVALID_INPUT",
      `secrets.beginOAuth: revocationEndpoint is an https URL within the pin ${urls.join(", ")}`,
    );
  return url.href;
}

/** WHY A GRANT IS REFUSED BY ITS CEILING (`grantedWithin`), in words for the person's page, or
 *  undefined when it may be kept. `granted` is the token answer's `scope`. Closed on what the
 *  answer does not say: a grant whose answer names no scope is refused, since the platform cannot
 *  tell what the person approved. */
export function grantRefusal(granted: string | undefined, within: readonly string[]) {
  const scopes = (granted || "").split(/[\s,]+/).filter(Boolean);
  if (!scopes.length)
    return "The provider did not say which permissions it granted, and this connection keeps only a grant whose permissions it can check. Nothing was kept.";
  const outside = scopes.filter((scope) => !within.includes(scope));
  if (!outside.length) return undefined;
  return `The grant holds permissions that this connection may not hold: ${outside.join(", ")}. Nothing was kept. Connect again, and approve only the permissions that were asked for: do not add any, and do not choose a wider set such as "Full access".`;
}
function accountLookupOf(value: unknown, urls: string[]): AccountLookup | null {
  if (value === undefined) return null;
  const parsed = AccountLookupInput.safeParse(value);
  if (!parsed.success)
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: account is { url, id, name? } — the https endpoint that names the account, and the JSON paths of its id and name",
    );
  const url = new URL(parsed.data.url);
  if (!urls.includes(url.origin))
    throw codedError(
      "INVALID_INPUT",
      `secrets.beginOAuth: account.url ${url.origin} is outside the pin ${urls.join(", ")} — the token only ever goes toward a pinned host`,
    );
  const { method, body } = parsed.data;
  if (body !== undefined && method !== "POST")
    throw codedError("INVALID_INPUT", 'secrets.beginOAuth: account.body goes with method: "POST"');
  return {
    url: url.href,
    id: parsed.data.id,
    name: parsed.data.name || null,
    ...(method === "POST" && { method, body: JSON.stringify(body ?? {}) }),
  };
}

export function accountOf(
  json: unknown,
  lookup: AccountLookup,
): { id: string; name: string | null } {
  const found = jsonPathOf(json, lookup.id);
  const id = typeof found === "number" ? String(found) : typeof found === "string" ? found : "";
  if (!id) throw new Error(`the account endpoint named no account at ${lookup.id}`);
  const name = lookup.name ? jsonPathOf(json, lookup.name) : null;
  return { id, name: typeof name === "string" && name ? name : null };
}

// `a.b.0.c`; a step that ends in `@json` reads a string that holds JSON (an MCP tool's text).
function jsonPathOf(json: unknown, path: string): unknown {
  let value = json;
  for (const step of path.split(".")) {
    const parse = step.endsWith("@json");
    const key = parse ? step.slice(0, -"@json".length) : step;
    if (Array.isArray(value)) value = /^\d+$/.test(key) ? value[Number(key)] : undefined;
    else if (isRecord(value)) value = value[key];
    else return undefined;
    if (parse) {
      if (typeof value !== "string") return undefined;
      try {
        value = JSON.parse(value);
      } catch {
        return undefined;
      }
    }
  }
  return value;
}

// PKCE S256: RFC 7636.
export async function beginSecretOAuth(
  options: NormalizedSecretOAuthOptions,
  attempt: { redirectUri: string; state: string; nonce: string },
): Promise<{ pending: PendingSecretOAuth; authorizationUrl: string }> {
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const url = new URL(options.authorizationEndpoint);
  // a GitHub App's install page takes the state alone: the App's own callback is its redirect
  const params: Record<string, string | undefined> = options.cloud?.install
    ? { ...options.extra, state: attempt.state }
    : {
        ...options.extra,
        response_type: "code",
        client_id: options.clientId,
        redirect_uri: attempt.redirectUri,
        state: attempt.state,
        code_challenge: await oauth.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: "S256",
        scope: options.scope,
      };
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return {
    pending: {
      options,
      redirectUri: attempt.redirectUri,
      codeVerifier,
      nonce: attempt.nonce,
      until: Date.now() + SECRET_OAUTH_TTL_MS,
    },
    authorizationUrl: url.href,
  };
}

// `clientSecretOf` resolves a placeholder for the exchange alone; the record keeps the placeholder.
export async function completeSecretOAuth(
  pending: PendingSecretOAuth,
  code: string,
  fetchFn: (request: Request) => Promise<Response>,
  clientSecretOf: ClientSecretOf,
  cloudProof = "",
): Promise<SecretRecord> {
  const { options } = pending;
  const { cloud } = options;
  const response = await fetchFn(
    oauthTokenRequest({
      tokenEndpoint: options.tokenEndpoint,
      clientId: options.clientId,
      clientSecret: await clientSecretOf(options.clientSecret, options.tokenEndpoint),
      clientAuth: options.clientAuth,
      params: {
        grant_type: "authorization_code",
        code,
        ...(!cloud?.install && {
          redirect_uri: pending.redirectUri,
          code_verifier: pending.codeVerifier,
        }),
        ...(cloud && { cloud_proof: cloudProof }),
      },
    }),
  );
  const tokens = await oauthTokensOf(response, "oauth");
  const refresh = {
    kind: "oauth-refresh-token" as const,
    tokenEndpoint: options.tokenEndpoint,
    clientAuth: options.clientAuth,
    // the ceiling holds at each refresh too
    grantedWithin: options.grantedWithin,
    // the Cloud that the attempt named is the secret's Cloud from here on
    ...(cloud && { client: { cloud: cloud.name, origin: cloud.origin } }),
  };
  return {
    material: {
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      ...tokens,
    },
    urls: options.urls,
    refresh,
    ...options.use,
  };
}
