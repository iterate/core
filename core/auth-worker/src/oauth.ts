import {
  GrantType,
  OAuthAuthorizationServer,
  OAuthError,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { platformOriginOf } from "iterate/mind-api";
import { HOST_SESSION_PREFIX, type TokenIdentity } from "iterate/workers";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import { admitted, TOO_MANY } from "./device/limits.ts";
import { isMember } from "./members.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";

export const AUTHORIZE_ENDPOINT = "/oauth2/auth";
export const TOKEN_ENDPOINT = "/oauth2/token";
export const CLIENT_REGISTRATION_ENDPOINT = "/oauth2/register";

const OAuthScope = z.enum(["iterate", "identity"]);

export function grantedScopes(
  requested: readonly string[],
  hostResource: boolean,
): string[] | null {
  const scope = hostResource ? "identity" : "iterate";
  return requested.every((name) => name === scope) ? [scope] : null;
}

export function mindHostResourceOf(env: Env, resource: string | null | undefined) {
  if (!resource || !URL.canParse(resource)) return null;
  const url = new URL(resource);
  const { domain } = iterateConfigOf(env);
  const underDomain = url.hostname === domain || url.hostname.endsWith(`.${domain}`);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.origin !== resource ||
    !underDomain ||
    url.origin === platformOriginOf(domain)
  )
    return null;
  return resource;
}

export const hostCallbackOf = (hostResource: string) =>
  `${hostResource}${HOST_SESSION_PREFIX}callback`;

// `deadline` (epoch ms): the grant is refused from then on, however recently it was used.
export const GrantProps = z.object({
  userId: z.string().startsWith("user_"),
  email: z.string(),
  deadline: z.number().int().positive(),
  letIn: z
    .object({
      reason: z.string(),
      clientName: z.string(),
      signer: z.object({ actor: z.string(), key: z.string() }).optional(),
    })
    .optional(),
});
export type GrantProps = z.infer<typeof GrantProps>;

// The grant's id, which the library's validation does not report.
const TokenProps = GrantProps.extend({ grantId: z.string().min(1) });

const SESSION_IDLE_SECONDS = 7 * 24 * 3600;
const ACCESS_TOKEN_SECONDS = 3600;
// The whole of the browser's session on a mind hostname (no refresh token); `whoIs` reads
// membership afresh on every request.
const HOST_ACCESS_TOKEN_SECONDS = 24 * 3600;
// The library writes a client again at a token exchange past half of this, so twice a grant's idle
// life keeps every client that still has a grant.
const CLIENT_REGISTRATION_SECONDS = 2 * SESSION_IDLE_SECONDS;
// The library would take up to 1 MiB; it caps a client metadata document at 5 KiB.
const CLIENT_METADATA_MAX_CHARACTERS = 4096;
export const GRANT_LIFETIME_MS = 30 * 24 * 3600_000;

// Built per call: the library takes a fixed list of resources, and a call may be about one mind
// hostname besides the config's.
export function authorizationServer(
  env: Env,
  { hostResource, facts }: { hostResource?: string | null; facts?: AccountFacts } = {},
) {
  const { resources } = iterateConfigOf(env);
  return new OAuthAuthorizationServer<Env>({
    issuer: issuerOf(env),
    resources: hostResource ? [...resources, hostResource] : resources,
    authorizeEndpoint: AUTHORIZE_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientRegistrationEndpoint: CLIENT_REGISTRATION_ENDPOINT,
    clientRegistrationTTL: CLIENT_REGISTRATION_SECONDS,
    // anyone may register, so each registration is counted and kept small
    clientRegistrationCallback: async ({ clientMetadata, request }) => {
      if (JSON.stringify(clientMetadata).length > CLIENT_METADATA_MAX_CHARACTERS)
        return {
          description: `Client metadata may be ${CLIENT_METADATA_MAX_CHARACTERS} characters at most.`,
          status: 413,
        };
      if (!(await admitted(env, "registration", request)))
        return { code: "temporarily_unavailable", description: TOO_MANY, status: 429 };
    },
    // the library advertises CIMD only with the Worker's `global_fetch_strictly_public` flag too
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: OAuthScope.options,
    accessTokenTTL: ACCESS_TOKEN_SECONDS,
    refreshTokenTTL: SESSION_IDLE_SECONDS,
    refreshTokenIdleTTL: SESSION_IDLE_SECONDS,
    tokenExchangeCallback: (input) => grantLifetime(env, input, facts || new AccountFacts()),
    // the wire stays generic; `detail` is never a secret
    onError: ({ code, status, internal }) => {
      console.warn({
        event: "oauth.refusal",
        code,
        status,
        category: internal.category,
        reason: internal.reason,
        detail: internal.detail instanceof Error ? String(internal.detail) : internal.detail,
      });
    },
  });
}

export const oauthHelpers = (env: Env, hostResource?: string | null) =>
  authorizationServer(env, { hostResource }).getOAuthApi(env);

export async function tokenIdentity(
  env: Env,
  token: string,
  resource: string,
): Promise<TokenIdentity | null> {
  // The library looks a bearer up by a KV key made of its parts: past KV's 512-byte key limit the
  // lookup throws. Its own tokens are about 90 characters.
  if (new TextEncoder().encode(token).byteLength > 256) return null;
  const hostResource = mindHostResourceOf(env, resource);
  if (!hostResource && !iterateConfigOf(env).resources.includes(resource)) return null;
  const validated = await authorizationServer(env, { hostResource }).validateToken(
    resource,
    token,
    env,
  );
  if (!validated) return null;
  const props = TokenProps.safeParse(validated.props);
  if (!props.success || props.data.userId !== validated.userId) return null;
  const expiresAt = Math.min(validated.expiresAt, Math.floor(props.data.deadline / 1000));
  const member = await isMember(env, props.data.email);
  if (expiresAt * 1000 <= Date.now() || (!hostResource && !member)) return null;
  return {
    principal: { actor: props.data.userId, email: props.data.email },
    grant: props.data.grantId,
    expiresAt,
    member,
  };
}

// The library revokes a grant this refuses, with its tokens. A let-in grant gets one access token
// for its whole remaining time: nobody may refresh it.
async function grantLifetime(
  env: Env,
  input: TokenExchangeCallbackOptions<Env>,
  facts: AccountFacts,
): Promise<TokenExchangeCallbackResult> {
  const parsed = GrantProps.safeParse(input.props);
  const refused = (reason: string, description: string) => {
    if (parsed.success)
      facts.add(parsed.data.userId, {
        type: "events.iterate.com/account/grant-ended",
        payload: { grantId: input.grantId },
        idempotencyKey: `account/grant-ended/${input.grantId}`,
      });
    return new OAuthError("invalid_grant", {
      description,
      internal: { category: "grant-lifetime", reason },
    });
  };
  if (!parsed.success || parsed.data.userId !== input.userId)
    throw refused("props_invalid", "The session is no longer active.");
  const grant = parsed.data;
  const hostResource = mindHostResourceOf(env, input.resource);
  if (!hostResource && !(await isMember(env, grant.email)))
    throw refused("not_a_member", "The session is no longer active.");
  const remaining = Math.floor((grant.deadline - Date.now()) / 1000);
  // KV's shortest expiry, below which the library refuses a lifetime.
  if (remaining < 60) throw refused("deadline_passed", "The session has expired.");
  if (grant.letIn && input.grantType !== GrantType.AUTHORIZATION_CODE)
    throw refused("let_in_no_refresh", "Being let in cannot be renewed. Ask again.");
  if (grant.letIn)
    return {
      accessTokenProps: { ...grant, grantId: input.grantId },
      accessTokenTTL: remaining,
      refreshTokenTTL: remaining,
    };
  const token = {
    accessTokenProps: { ...grant, grantId: input.grantId },
    accessTokenTTL: Math.min(
      hostResource ? HOST_ACCESS_TOKEN_SECONDS : ACCESS_TOKEN_SECONDS,
      remaining,
    ),
  };
  if (remaining >= SESSION_IDLE_SECONDS) return token;
  // The library honours `refreshTokenTTL` only at the code exchange and `refreshTokenIdleTTL`
  // only at a refresh.
  return input.grantType === GrantType.AUTHORIZATION_CODE
    ? { ...token, refreshTokenTTL: remaining }
    : { ...token, refreshTokenIdleTTL: remaining };
}

// A revocation (RFC 7009) is a `token` and no `grant_type`. The library answers it 200 whatever it
// did, so whether the grant ended is read before and after; a token is `<userId>:<grantId>:<secret>`.
export async function tokenEndpointResponse(env: Env, request: Request, ctx: ExecutionContext) {
  const form = await request
    .clone()
    .formData()
    .catch(() => null);
  const facts = new AccountFacts();
  const resource = form?.get("resource");
  const server = authorizationServer(env, {
    hostResource: mindHostResourceOf(env, typeof resource === "string" ? resource : null),
    facts,
  });
  const token = form?.get("token");
  const [userId, grantId] = typeof token === "string" ? token.split(":") : [];
  if (form?.has("grant_type") || !userId || !grantId)
    return facts.on(await server.fetch(request, env, ctx));
  const helpers = server.getOAuthApi(env);
  const before = await grantHeld(helpers, userId, grantId);
  const response = await server.fetch(request, env, ctx);
  if (before && !(await grantHeld(helpers, userId, grantId)))
    facts.add(userId, {
      type: "events.iterate.com/account/grant-ended",
      payload: { grantId },
      idempotencyKey: `account/grant-ended/${grantId}`,
    });
  return facts.on(response);
}

/** Ends every grant of a person, with its tokens: the apps, the CLI, an MCP client, and the
 *  mind hostnames' own sessions. */
export async function endGrantsOf(env: Env, userId: string, facts: AccountFacts) {
  const helpers = oauthHelpers(env);
  const grants: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(userId, { cursor });
    grants.push(...page.items.map((grant) => grant.id));
    cursor = page.cursor;
  } while (cursor);
  for (const grantId of grants) {
    await helpers.revokeGrant(grantId, userId);
    facts.add(userId, {
      type: "events.iterate.com/account/grant-ended",
      payload: { grantId },
      idempotencyKey: `account/grant-ended/${grantId}`,
    });
  }
}

async function grantHeld(
  helpers: ReturnType<typeof oauthHelpers>,
  userId: string,
  grantId: string,
): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(userId, { cursor });
    if (page.items.some((grant) => grant.id === grantId)) return true;
    cursor = page.cursor;
  } while (cursor);
  return false;
}
