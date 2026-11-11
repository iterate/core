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
import { isBlocked } from "./blocked.ts";
import { isMember } from "./members.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";

export const AUTHORIZE_ENDPOINT = "/oauth2/auth";
export const TOKEN_ENDPOINT = "/oauth2/token";
export const CLIENT_REGISTRATION_ENDPOINT = "/oauth2/register";

const OAuthScope = z.enum(["iterate", "identity"]);

/** What a request for `requested` scopes is granted: the resource's one scope, when the request
 *  names it or names none. A client that asks for every scope the metadata lists (the Codex CLI
 *  does, `iterate identity`) gets that one alone, as RFC 6749 §3.3 allows; the token answer says
 *  which. A request for other scopes only is refused (null). */
export function grantedScopes(
  requested: readonly string[],
  hostResource: boolean,
): string[] | null {
  const scope = hostResource ? "identity" : "iterate";
  return requested.length === 0 || requested.includes(scope) ? [scope] : null;
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

/** The resource a client named, as the stack knows it. A token for a mind hostname is for the
 *  whole host, so a path on one (`https://app.example.com/mcp`, or the bare `/` a URL parser adds)
 *  means its origin: an MCP client names its server's URL. Anything else is returned unchanged. */
export function knownResourceOf(env: Env, resource: string): string {
  if (iterateConfigOf(env).resources.includes(resource) || !URL.canParse(resource)) return resource;
  return mindHostResourceOf(env, new URL(resource).origin) || resource;
}

/** `request` with its `resource` as `knownResourceOf` reads it: the query's at the authorization
 *  endpoint, the form's at the token endpoint. */
export async function withKnownResource(env: Env, request: Request): Promise<Request> {
  const url = new URL(request.url);
  const asked = url.searchParams.get("resource");
  if (asked && knownResourceOf(env, asked) !== asked) {
    url.searchParams.set("resource", knownResourceOf(env, asked));
    return new Request(url, request);
  }
  const type = request.headers.get("content-type") || "";
  if (request.method !== "POST" || !type.startsWith("application/x-www-form-urlencoded"))
    return request;
  const form = new URLSearchParams(await request.clone().text());
  const named = form.get("resource");
  if (!named || knownResourceOf(env, named) === named) return request;
  form.set("resource", knownResourceOf(env, named));
  return new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: form.toString(),
  });
}

export const hostCallbackOf = (hostResource: string) =>
  `${hostResource}${HOST_SESSION_PREFIX}callback`;

// A grant lives for as long as its client keeps refreshing it, and ends once it has been idle for
// SESSION_IDLE_SECONDS. Only a let-in grant has a `deadline` (epoch ms), from which it is refused.
// A grant made before 2026-11-12 carries one of thirty days, which nothing reads.
export const GrantProps = z.object({
  userId: z.string().startsWith("user_"),
  email: z.string(),
  deadline: z.number().int().positive().optional(),
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
  const deadline = letInDeadlineOf(props.data);
  const expiresAt = deadline
    ? Math.min(validated.expiresAt, Math.floor(deadline / 1000))
    : validated.expiresAt;
  const member = await isMember(env, props.data.email);
  if (expiresAt * 1000 <= Date.now() || (!hostResource && !member)) return null;
  // a member is never blocked, so only a mind hostname's token asks
  if (!member && (await isBlocked(env, props.data.email))) return null;
  return {
    principal: { actor: props.data.userId, email: props.data.email },
    grant: props.data.grantId,
    expiresAt,
    member,
  };
}

/** The instant a let-in grant ends. A let-in grant with none ended at its making. */
const letInDeadlineOf = (grant: GrantProps) => (grant.letIn ? grant.deadline || 1 : undefined);

// The library revokes a grant this refuses, with its tokens. A let-in grant gets one access token
// for its whole remaining time: nobody may refresh it. Any other grant gets an access token and
// the library's idle lifetime, which each refresh starts again.
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
  if (hostResource && (await isBlocked(env, grant.email)))
    throw refused("blocked", "The session is no longer active.");
  const lifetime = grantLifetimeOf(grant, {
    refresh: input.grantType !== GrantType.AUTHORIZATION_CODE,
    host: Boolean(hostResource),
    now: Date.now(),
  });
  if (lifetime === "deadline_passed") throw refused(lifetime, "The session has expired.");
  if (lifetime === "let_in_no_refresh")
    throw refused(lifetime, "Being let in cannot be renewed. Ask again.");
  return { accessTokenProps: { ...grant, grantId: input.grantId }, ...lifetime };
}

/** What one token exchange gives a grant, or why the grant ends at it. */
export function grantLifetimeOf(
  grant: GrantProps,
  exchange: { refresh: boolean; host: boolean; now: number },
): { accessTokenTTL: number; refreshTokenTTL?: number } | "deadline_passed" | "let_in_no_refresh" {
  const deadline = letInDeadlineOf(grant);
  if (!deadline)
    return { accessTokenTTL: exchange.host ? HOST_ACCESS_TOKEN_SECONDS : ACCESS_TOKEN_SECONDS };
  const remaining = Math.floor((deadline - exchange.now) / 1000);
  // KV's shortest expiry, below which the library refuses a lifetime.
  if (remaining < 60) return "deadline_passed";
  if (exchange.refresh) return "let_in_no_refresh";
  return { accessTokenTTL: remaining, refreshTokenTTL: remaining };
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

/** One live sign-in of a person, as /keys lists it: a grant, whose client holds tokens. */
export type SignIn = {
  id: string;
  /** The client's own name, or "" for one that gave none: a mind hostname's own sign-in. */
  clientName: string;
  /** What it is for: a resource of the stack, or a mind hostname's origin. Absent on a grant made
   *  before grants kept it. */
  resource?: string;
  /** The host the grant's code went to: the client's own address. */
  goesTo?: string;
  /** Epoch seconds. `endsAt` moves at each refresh: it is when an unused sign-in ends. */
  createdAt: number;
  endsAt?: number;
};

const SignInMetadata = z.object({ clientName: z.string(), resource: z.string().optional() });

/** The mind hostname whose own sign-in a grant is, read from where its code went: for a grant
 *  made before grants kept their resource. */
function hostOfOwnCallback(env: Env, redirectUri: string | undefined) {
  if (!redirectUri || !URL.canParse(redirectUri)) return undefined;
  const host = mindHostResourceOf(env, new URL(redirectUri).origin);
  return host && redirectUri === hostCallbackOf(host) ? host : undefined;
}

export async function signInsOf(env: Env, userId: string): Promise<SignIn[]> {
  const helpers = oauthHelpers(env);
  const signIns: SignIn[] = [];
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(userId, { cursor });
    for (const grant of page.items) {
      const metadata = SignInMetadata.safeParse(grant.metadata);
      signIns.push({
        id: grant.id,
        // a client that gave no name is kept by its id, which says nothing to a person
        clientName:
          metadata.data?.clientName && metadata.data.clientName !== grant.clientId
            ? metadata.data.clientName
            : "",
        resource: metadata.data?.resource || hostOfOwnCallback(env, grant.redirectUri),
        goesTo: URL.canParse(grant.redirectUri || "")
          ? new URL(grant.redirectUri!).host
          : undefined,
        createdAt: grant.createdAt,
        endsAt: grant.expiresAt,
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return signIns.sort((a, b) => b.createdAt - a.createdAt);
}

/** Ends one grant of a person, with its tokens. A grant id that is not theirs ends nothing. */
export async function endGrant(env: Env, userId: string, grantId: string, facts: AccountFacts) {
  const helpers = oauthHelpers(env);
  if (!(await grantHeld(helpers, userId, grantId))) return false;
  await helpers.revokeGrant(grantId, userId);
  facts.add(userId, {
    type: "events.iterate.com/account/grant-ended",
    payload: { grantId },
    idempotencyKey: `account/grant-ended/${grantId}`,
  });
  return true;
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
