// A client secret may be a placeholder naming the secret that holds it; the pending attempt and the
// record keep the placeholder. The nonce is no secret: the start page's cookie binds the attempt.
import * as oauth from "oauth4webapi";
import { z } from "zod";
import type { ClientAuth } from "iterate/api";
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
  use: SecretUse;
  anyoneWithLink: boolean;
  // `install`: a GitHub App's install page, which names no redirect URI and takes no PKCE challenge.
  // `beginEndpoint`: the Cloud's page the person confirms on, before the provider's.
  // `accounts`: the accounts whose installations the project asks to be connected to.
  cloud?: {
    name: string;
    redirectUri: string;
    install: boolean;
    beginEndpoint?: string;
    accounts?: string[];
  };
};

export type AccountLookup = { url: string; id: string; name: string | null };

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

// Never an open redirect: `next` must be on one of `origins`.
function nextUrlOf(next: unknown, origins: readonly string[]): string | null {
  if (!next) return null;
  const url = URL.canParse(String(next)) ? new URL(String(next)) : null;
  if (!url || !origins.includes(url.origin))
    throw new Error(
      `next is an absolute URL on ${origins.join(" or ")}, got ${JSON.stringify(next)}`,
    );
  return url.href;
}

// With a Cloud client the Cloud says the endpoints, the client and the pin. Its token endpoint is
// its broker, outside the pin, where a code and a sealed refresh token go and no usable token does.
export function normalizeSecretOAuth(
  given: unknown,
  nextOrigins: readonly string[] = [],
  cloud: CloudClient | null = null,
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
  const options: Record<string, unknown> = cloud
    ? {
        ...given,
        authorizationEndpoint: install ? cloud.installUrl : cloud.authorizationEndpoint,
        tokenEndpoint: cloud.tokenEndpoint,
        clientId: cloud.clientId,
        urls: cloud.urls,
        scope: given.scope ?? cloud.scopes?.join(" "),
      }
    : given;
  const endpoint = (key: "authorizationEndpoint" | "tokenEndpoint") => {
    const url = new URL(String(options[key]));
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(`secrets.beginOAuth: ${key} must be an http(s) URL`);
    return url;
  };
  const authorizationEndpoint = endpoint("authorizationEndpoint");
  // the start page sends a person's browser there from the platform's own hostname
  if (authorizationEndpoint.protocol !== "https:")
    throw new Error("secrets.beginOAuth: authorizationEndpoint must be an https URL");
  const tokenEndpoint = endpoint("tokenEndpoint");
  if (typeof options.clientId !== "string" || !options.clientId)
    throw new Error("secrets.beginOAuth: clientId is required");
  const urls = options.urls === undefined ? [tokenEndpoint.origin] : originsOf(options.urls);
  if (!cloud && !urls.includes(tokenEndpoint.origin))
    throw new Error(
      `secrets.beginOAuth: tokenEndpoint ${tokenEndpoint.origin} is outside the pin ${urls.join(", ")} — the tokens only ever go toward a pinned host`,
    );
  const account = accountLookupOf(options.account, urls);
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
    use: secretUseOf(options),
    anyoneWithLink: options.anyoneWithLink === true,
    ...(cloud && {
      cloud: {
        name: cloud.name,
        redirectUri: cloud.redirectUri,
        install,
        beginEndpoint: cloud.beginEndpoint,
        ...(accounts.length > 0 && { accounts }),
      },
    }),
  };
}

const AccountLookupInput = z.object({
  url: z.url({ protocol: /^https?$/ }),
  id: z.string().min(1),
  name: z.string().min(1).optional(),
});
function accountLookupOf(value: unknown, urls: string[]): AccountLookup | null {
  if (value === undefined) return null;
  const parsed = AccountLookupInput.safeParse(value);
  if (!parsed.success)
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: account is { url, id, name? } — the endpoint that names the account, and the JSON paths of its id and name",
    );
  const url = new URL(parsed.data.url);
  if (!urls.includes(url.origin))
    throw codedError(
      "INVALID_INPUT",
      `secrets.beginOAuth: account.url ${url.origin} is outside the pin ${urls.join(", ")} — the token only ever goes toward a pinned host`,
    );
  return { url: url.href, id: parsed.data.id, name: parsed.data.name || null };
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

function jsonPathOf(json: unknown, path: string): unknown {
  let value = json;
  for (const key of path.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[key];
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
    ...(cloud && { client: { cloud: cloud.name } }),
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
