// secret-oauth.ts — how a secret obtains its FIRST OAuth tokens, the pure half. `itx.secrets.beginOAuth(path,
// options)` sends a human through the provider's consent page; the provider redirects to the
// platform's one callback (`SECRET_OAUTH_CALLBACK_PATH`, served by worker.ts) with a code; the
// secret's facet exchanges the code (PKCE, RFC 7636) and becomes an ordinary `oauth-refresh-token`
// secret — everything in secrets.ts applies from then on, and no code but that facet ever holds a
// token.
//
// Two pure functions of (options, fetch): `beginSecretOAuth` builds the pending attempt and the
// authorize URL; `completeSecretOAuth` turns the pending attempt and a code into a `SecretRecord`.
// The host (secret/durable-object.ts) signs the `state`, keeps the pending attempt and runs these.
//
// A CLIENT IN THE CLEAR passes `clientId` and, for a confidential client, `clientSecret`: the secret
// itself, or one placeholder naming the secret that holds it, as egress spells it
// (`getSecret("/secrets/<name>")`, or with `{ field }`), so an agent that never handles a secret can
// pass one. The pending attempt and the record keep the placeholder; how the facet resolves it is
// secret/durable-object.ts `#clientSecretOf`.
//
// AN INTEGRATION'S CONNECT (src/integrations/) names whose app instead of passing a client in the
// clear: `client: { platform: "slack" }` is the deployment's own (ITERATE `integrations.<provider>`,
// read inside the secret's facet and never copied into the record — the record holds the tokens, and
// a refresh names the same client). Its redirect URI is the provider's
// `/api/integrations/<provider>/callback`, whose handler finishes the connection. `next` is where
// the callback sends the human once the tokens are stored: the platform's origin or the Dash's,
// nowhere else (`nextUrlOf`).
//
// A PROJECT'S OWN CALLBACK: iterate/api `SecretOAuthOptions.redirect` and `secrets.completeOAuth` say
// the flow and what `redirect` excludes; context/built-ins.ts `secrets.beginOAuth` composes the URL.

import * as oauth from "oauth4webapi";
import { z } from "zod";
import type { ClientAuth, SecretOAuthClient } from "iterate/api";
import { codedError } from "iterate/lib";
import { OAUTH_INTEGRATION_PROVIDERS } from "./integrations/contract.ts";
import { consentAccountRefusal } from "./integrations/rules.ts";
import {
  clientAuthOf,
  clientSecretAsHeld,
  clientSecretReferenceOf,
  isRecord,
  oauthTokenRequest,
  oauthTokensOf,
  originsOf,
  type SecretRecord,
} from "./secrets.ts";

/** How long an OAuth attempt stays open: the signed `state`'s expiry and the pending attempt's. An
 *  hour, because the link often reaches a person through an agent's chat, and they open it later. */
export const SECRET_OAUTH_TTL_MS = 60 * 60_000;

/** The options validated and normalized — the shape the pending attempt and the exchange read. */
export type NormalizedSecretOAuthOptions = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** "" with `client`: the host resolves it. */
  clientId: string;
  /** "" for a public client, and with `client`. A placeholder stays one here and in the record. */
  clientSecret: string;
  client: SecretOAuthClient | null;
  clientAuth: ClientAuth;
  scope?: string;
  urls: string[];
  extra: Record<string, string>;
  next: string | null;
  expectAccount: string | null;
  /** The endpoint that names the account the tokens are for, and the JSON paths of its id and
   *  name (iterate/api `SecretOAuthOptions.account`): null when the token response names it. */
  account: AccountLookup | null;
  /** The project's own callback page (the header): null for the platform's callback. */
  redirectUri: string | null;
};

/** An endpoint within the pin that names an account, called with the new access token, and where
 *  in its JSON the account's id and name are (`data.id`, `data.username`). */
export type AccountLookup = { url: string; id: string; name: string | null };

/** The pending attempt, kept by the secret's facet between the redirect out and the code
 *  back: everything the exchange needs and nothing a browser ever sees. */
export type PendingSecretOAuth = {
  options: NormalizedSecretOAuthOptions;
  /** The exact redirect URI the authorize URL carried — the exchange must repeat it (RFC 6749 §4.1.3).
   *  `options.redirectUri` set means it is the project's own page: the attempt project code may
   *  complete (`itx.secrets.completeOAuth`); null, only the platform's callback completes it. */
  redirectUri: string;
  codeVerifier: string;
  /** Pairs the callback with THIS attempt (a replayed or foreign state cannot complete it). */
  nonce: string;
  /** SECRET_OAUTH_TTL_MS from the start: long enough to reach the link and sign in, short enough
   *  that a stale attempt dies. */
  until: number;
};

/** The claims the platform signs into the `state` parameter — how the callback finds the secret:
 *  `context` is the secret's context, its Durable Object name (`<projectId>.iterate/secrets/<name>`;
 *  under `/users/<id>` or `/organizations/<id>` for a user's or an organization's own secret) — the
 *  callback derives the RESOURCE OWNER from it (context/paths.ts `resourceScope`) and admits the
 *  human by that. `kind` keeps these claims apart from every other claim set the same key signs. */
export type SecretOAuthState = {
  kind: "secret-oauth";
  context: string;
  nonce: string;
  exp: number;
  /** Where the callback redirects once the tokens are stored. */
  next?: string | null;
};

/** The platform's redirect URI for a secret's OAuth begun without `redirect` — registered once per
 *  provider. */
export const SECRET_OAUTH_CALLBACK_PATH = "/.secrets/oauth/callback";

/** The redirect URI path of an attempt on the platform: a deployment app's is its provider's
 *  callback, the URL iterate's Slack app and Google client are registered with, and every other
 *  attempt's `SECRET_OAUTH_CALLBACK_PATH`. worker.ts serves all of them with the same callback. */
export function secretOAuthCallbackPathOf(client: SecretOAuthClient | null): string {
  if (!client) return SECRET_OAUTH_CALLBACK_PATH;
  return `/api/integrations/${client.platform}/callback`;
}

/** `next` checked: an absolute URL on one of `origins` (the platform's and the Dash's), never an
 *  open redirect; null when absent. */
export function nextUrlOf(next: unknown, origins: readonly string[]): string | null {
  if (!next) return null;
  const url = URL.canParse(String(next)) ? new URL(String(next)) : null;
  if (!url || !origins.includes(url.origin))
    throw new Error(
      `next is an absolute URL on ${origins.join(" or ")}, got ${JSON.stringify(next)}`,
    );
  return url.href;
}

/** The options validated and normalized: http(s) endpoints, the pin as origins (defaulting to the
 *  token endpoint's origin, which it must contain), the client-auth method from the registry, one
 *  client, and `next` on one of `nextOrigins`. */
export function normalizeSecretOAuth(
  options: unknown,
  nextOrigins: readonly string[] = [],
): NormalizedSecretOAuthOptions {
  if (!isRecord(options)) throw new Error("secrets.beginOAuth: options is an object");
  const endpoint = (key: "authorizationEndpoint" | "tokenEndpoint") => {
    const url = new URL(String(options[key]));
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(`secrets.beginOAuth: ${key} must be an http(s) URL`);
    return url;
  };
  const authorizationEndpoint = endpoint("authorizationEndpoint");
  const tokenEndpoint = endpoint("tokenEndpoint");
  const client = secretOAuthClientOf(options.client);
  if (client && (options.clientId !== undefined || options.clientSecret !== undefined))
    throw new Error("secrets.beginOAuth: pass client, or clientId (and clientSecret), not both");
  if (!client && (typeof options.clientId !== "string" || !options.clientId))
    throw new Error("secrets.beginOAuth: clientId (or client) is required");
  // the project's own page, composed by the built-in (context/built-ins.ts `secrets.beginOAuth`)
  const redirectUri = typeof options.redirectUri === "string" ? options.redirectUri : null;
  if (redirectUri && client)
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: the deployment's app comes back to the callback registered for it — redirect is for a client of your own",
    );
  if (redirectUri && options.next !== undefined)
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: with redirect your page is the landing — no next",
    );
  const urls = options.urls === undefined ? [tokenEndpoint.origin] : originsOf(options.urls);
  if (!urls.includes(tokenEndpoint.origin))
    throw new Error(
      `secrets.beginOAuth: tokenEndpoint ${tokenEndpoint.origin} is outside the pin ${urls.join(", ")} — the tokens only ever go toward a pinned host`,
    );
  const account = accountLookupOf(options.account, urls, Boolean(client));
  const extra: Record<string, string> = {};
  if (isRecord(options.extra))
    for (const [key, value] of Object.entries(options.extra)) extra[key] = String(value);
  const clientSecret = typeof options.clientSecret === "string" ? options.clientSecret : "";
  clientSecretReferenceOf(clientSecret); // a placeholder among other text is refused here
  // A client ID is not secret and goes into the authorize URL its caller gets back, so it is never
  // read out of a secret: resolving a placeholder there would hand any secret's value to the caller.
  if (!client && String(options.clientId).includes("getSecret("))
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: clientId is the client ID itself, never a getSecret placeholder: it is no secret, and it goes into the authorize URL",
    );
  return {
    authorizationEndpoint: authorizationEndpoint.href,
    tokenEndpoint: tokenEndpoint.href,
    clientId: client ? "" : String(options.clientId),
    clientSecret,
    client,
    clientAuth: clientAuthOf(options.clientAuth),
    ...(typeof options.scope === "string" && options.scope && { scope: options.scope }),
    urls,
    extra,
    next: nextUrlOf(options.next, nextOrigins),
    expectAccount:
      typeof options.expectAccount === "string" && options.expectAccount
        ? options.expectAccount
        : null,
    account,
    redirectUri,
  };
}

/** `account` checked: absent, or `{ url, id, name? }` — an http(s) endpoint within the pin (the new
 *  token goes to it), and the JSON paths. Not with the deployment's own client. */
const AccountLookupInput = z.object({
  url: z.url({ protocol: /^https?$/ }),
  id: z.string().min(1),
  name: z.string().min(1).optional(),
});
function accountLookupOf(
  value: unknown,
  urls: string[],
  platformClient: boolean,
): AccountLookup | null {
  if (value === undefined) return null;
  const parsed = AccountLookupInput.safeParse(value);
  if (!parsed.success)
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: account is { url, id, name? } — the endpoint that names the account, and the JSON paths of its id and name",
    );
  if (platformClient)
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: account is for a client of your own — the deployment's app names its own accounts",
    );
  const url = new URL(parsed.data.url);
  if (!urls.includes(url.origin))
    throw codedError(
      "INVALID_INPUT",
      `secrets.beginOAuth: account.url ${url.origin} is outside the pin ${urls.join(", ")} — the token only ever goes toward a pinned host`,
    );
  return { url: url.href, id: parsed.data.id, name: parsed.data.name || null };
}

/** The account an endpoint's JSON names, by the lookup's paths: a non-empty id, and the name when
 *  the path finds a string. Throws when the id is missing. */
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

/** The value at a dotted path (`data.id`) in parsed JSON, or undefined. */
function jsonPathOf(json: unknown, path: string): unknown {
  let value = json;
  for (const key of path.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

/** `client` checked: absent, or `{ platform }` naming an OAuth integration's provider. */
function secretOAuthClientOf(value: unknown): SecretOAuthClient | null {
  if (value === undefined) return null;
  const platform =
    isRecord(value) && OAUTH_INTEGRATION_PROVIDERS.find((name) => name === value.platform);
  if (platform) return { platform };
  throw new Error(
    `secrets.beginOAuth: client is { platform } naming one of ${OAUTH_INTEGRATION_PROVIDERS.join(", ")}, got ${JSON.stringify(value)} — a client of your own goes in clientId and clientSecret, with redirect for your page`,
  );
}

/** The authorization-code request with PKCE S256 (RFC 7636): the pending attempt the host keeps,
 *  and the URL the human is sent to. `state` is the platform-signed claim the callback verifies
 *  (the host signs it; this function only places it). */
export async function beginSecretOAuth(
  options: NormalizedSecretOAuthOptions,
  attempt: { redirectUri: string; state: string; nonce: string; now?: number },
): Promise<{ pending: PendingSecretOAuth; authorizationUrl: string }> {
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const url = new URL(options.authorizationEndpoint);
  const params: Record<string, string | undefined> = {
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
      until: (attempt.now ?? Date.now()) + SECRET_OAUTH_TTL_MS,
    },
    authorizationUrl: url.href,
  };
}

/** The code exchange: the pending attempt + the provider's code → the secret's record, with the
 *  `oauth-refresh-token` strategy pointing at the same token endpoint. `credentials` are the client's
 *  as the host resolved them (by default the ones passed in the clear). `clientSecretOf` is what the exchange sends for the client
 *  secret: the host resolves a placeholder there, and the record keeps the placeholder. The
 *  deployment's client (`{ platform }`) is never written into the record: its tokens alone, and a
 *  refresh — when the provider issued a refresh token — that names the same client. */
export async function completeSecretOAuth(
  pending: PendingSecretOAuth,
  code: string,
  fetchFn: (request: Request) => Promise<Response>,
  credentials: { clientId: string; clientSecret: string } = {
    clientId: pending.options.clientId,
    clientSecret: pending.options.clientSecret,
  },
  clientSecretOf = clientSecretAsHeld,
): Promise<SecretRecord> {
  const { options } = pending;
  const response = await fetchFn(
    oauthTokenRequest({
      tokenEndpoint: options.tokenEndpoint,
      clientId: credentials.clientId,
      clientSecret: await clientSecretOf(credentials.clientSecret, options.tokenEndpoint),
      clientAuth: options.clientAuth,
      params: {
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
      },
    }),
  );
  // with `account`, the facet checks the account off that endpoint, not off the token response
  if (options.expectAccount && !options.account) {
    const refusal = consentAccountRefusal(
      options.expectAccount,
      await response
        .clone()
        .json()
        .catch(() => null),
    );
    if (refusal) throw new Error(refusal);
  }
  const tokens = await oauthTokensOf(response, "oauth");
  const refresh = {
    kind: "oauth-refresh-token" as const,
    tokenEndpoint: options.tokenEndpoint,
    clientAuth: options.clientAuth,
  };
  if (options.client)
    return {
      material: tokens,
      urls: options.urls,
      refresh: tokens.refreshToken ? { ...refresh, client: options.client } : null,
    };
  return {
    material: {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret, // "" for a public client — the refresh grant then sends client_id alone
      ...tokens,
    },
    urls: options.urls,
    refresh,
  };
}

/** The signed claims, shape-checked field by field — the signature proved WHO wrote them, this
 *  proves WHAT they are before a project id or a name reaches a Durable Object name. */
export function isSecretOAuthState(claims: unknown): claims is SecretOAuthState {
  return (
    isRecord(claims) &&
    claims.kind === "secret-oauth" &&
    typeof claims.context === "string" &&
    typeof claims.nonce === "string" &&
    typeof claims.exp === "number" &&
    typeof (claims.next ?? "") === "string"
  );
}
