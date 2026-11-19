import {
  GrantType,
  OAuthAuthorizationServer,
  OAuthError,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { codedError } from "iterate/lib";
import { type MindConfig, controlPlaneOriginOf, zoneOf } from "iterate/mind-config";
import { SignInMethod } from "iterate/principal";
import { HOST_SESSION_PREFIX, type TokenIdentity } from "iterate/workers";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import { appOf } from "./asking-app.ts";
import { admitted, TOO_MANY } from "./device/limits.ts";
import { CALLBACK_PATH as DEVICE_CALLBACK_PATH } from "./device/protocol.ts";
import { isBlocked } from "./blocked.ts";
import type { Reach } from "./cookies.ts";
import { tokenAudiencesOf } from "./config.ts";
import { isMember } from "./members.ts";
import { configOf, type Env, issuerOf } from "./env.ts";

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

/** `resource` when it is A MIND HOSTNAME'S ORIGIN, else null: `https://<hostname>` for any
 *  hostname of any zone of the mind but the control-plane hostname, which is this Worker's own. A token
 *  for it is for that whole host, so a person signs in on every hostname of every zone. */
export function mindHostResourceOf(
  config: Pick<MindConfig, "controlPlaneHostname" | "zones">,
  resource: string | null | undefined,
) {
  if (!resource || !URL.canParse(resource)) return null;
  const url = new URL(resource);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.origin !== resource ||
    !zoneOf(config, url.hostname) ||
    url.origin === controlPlaneOriginOf(config)
  )
    return null;
  return resource;
}

/** The resource a client named, as the stack knows it. A token for a mind hostname is for the
 *  whole host, so a path on one (`https://app.example.com/mcp`, or the bare `/` a URL parser adds)
 *  means its origin: an MCP client names its server's URL. Anything else is returned unchanged. */
export function knownResourceOf(env: Env, resource: string): string {
  const config = configOf(env);
  if (tokenAudiencesOf(config).includes(resource) || !URL.canParse(resource)) return resource;
  return mindHostResourceOf(config, new URL(resource).origin) || resource;
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

const hostClientKeyOf = (host: string) => `iterate-host-client:${host}`;

/** The id of the client this stack made for `host` (`hostClientOf`), if it made one. */
export const keptHostClientOf = (env: Env, host: string) => env.OAUTH_KV.get(hostClientKeyOf(host));

/** The OAuth client a mind hostname signs its visitors in with, made at the host's first sign-in.
 *  Two first sign-ins at once may each make one; the last id kept is used from then on, and the
 *  other still works for the sign-in that holds it. The library never expires a client, and a mind
 *  whose code asks every hostname's visitor to sign in would make one for each name a stranger
 *  thinks of: so new ones are counted like new registrations, 120 in ten minutes for the stack. */
export async function hostClientOf(env: Env, host: string): Promise<string> {
  const hostResource = mindHostResourceOf(configOf(env), `https://${host}`);
  if (!hostResource) throw codedError("INVALID_INPUT", `${host} is not a hostname of this mind`);
  const key = hostClientKeyOf(new URL(hostResource).host);
  const kept = await env.OAUTH_KV.get(key);
  if (kept) return kept;
  if (!(await admitted(env, "host-client", new Request(hostResource))))
    throw codedError("FORBIDDEN", TOO_MANY);
  const { clientId } = await oauthHelpers(env, hostResource).createClient({
    clientName: new URL(hostResource).host,
    clientUri: hostResource,
    redirectUris: [hostCallbackOf(hostResource)],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
  });
  await env.OAUTH_KV.put(key, clientId);
  return clientId;
}

// A grant lives for as long as its client keeps refreshing it, and ends once it has been idle for
// SESSION_IDLE_SECONDS. Only a let-in grant and a member of another mind's have a `deadline` (epoch
// ms), from which it is refused.
// STRICT: a stored grant with a field that this code does not write, or without one that it
// does, was made under other rules, and is no grant, at a token's validation and at a refresh.
const GrantFields = z.strictObject({
  userId: z.string().startsWith("user_"),
  email: z.string(),
  /** HOW THE PERSON SIGNED IN, WHOSE SESSION GOT THE GRANT (./cookies.ts `PersonSession`).
   *  "passkey": the grant acts as a member while its address is a member's, asked at every use.
   *  "email": the grant of a person whom a mailed code signed in is for a mind hostname alone and
   *  is never a member's, whatever its address becomes: mail must not open the mind
   *  (`grantIsMembers`; one rule to remove keeps the old stack's, `standingByMethod`). A token
   *  says it of its person (`tokenIdentity`). Absent only on a grant that the old stack made
   *  before 13 Nov 2026, which has no `standingByMethod` either (`grantIsMembers`). */
  method: SignInMethod.optional(),
  /** The name a guest typed (./guest-sign-in.ts), or the hostname of the mind that vouched for a
   *  member of it (./mind-sign-in.ts): a guest's grant and such a member's alone have it. */
  name: z.string().min(1).optional(),
  /** The mind that vouched (method "mind"): its id, its hostname and the person's user id there. */
  mind: z
    .strictObject({ id: z.string().min(1), hostname: z.string().min(1), userId: z.string().min(1) })
    .optional(),
  /** A RULE TO REMOVE once every grant that the old stack made with no mark has ended or been
   *  made again (the owner, 18 Nov 2026: "only if we remember to remove that cruft later on").
   *  The mark says that a grant's standing is its method's, as `grantIsMembers` reads it. The old
   *  stack wrote it on every grant since 16 Nov 2026, and this stack writes it on every grant it
   *  makes (./authorize.ts). A grant without it is one that the old stack made before, which
   *  keeps that stack's rule: a mailed code's grant of a member's address acts as a member, and
   *  so does a grant that kept no method at all (made before 13 Nov 2026: the Beelink bridges'
   *  device sign-in of 12 Nov is one). The live minds moved to this stack with their grants (iterate.com and Jeeves, 19 Nov 2026):
   *  without the rule their members' agents and bridges would sign in again with a passkey. To
   *  remove it: the unmarked case in `grantIsMembers`, the write in ./authorize.ts, and this field
   *  once no stored grant holds it. */
  standingByMethod: z.literal(true).optional(),
  deadline: z.number().int().positive().optional(),
  letIn: z
    .strictObject({
      reason: z.string(),
      clientName: z.string(),
      signer: z.strictObject({ actor: z.string(), key: z.string() }).optional(),
    })
    .optional(),
});
// Only the old stack's unmarked grants lack a method: this stack writes both on every grant.
const markedHasMethod = (grant: z.infer<typeof GrantFields>) =>
  Boolean(grant.method) || !grant.standingByMethod;
const MARKED_HAS_METHOD = { message: "a grant with standingByMethod names its method" };
export const GrantProps = GrantFields.refine(markedHasMethod, MARKED_HAS_METHOD);
export type GrantProps = z.infer<typeof GrantProps>;

// The grant's id, which the library's validation does not report.
const TokenProps = GrantFields.extend({ grantId: z.string().min(1) }).refine(
  markedHasMethod,
  MARKED_HAS_METHOD,
);

const SESSION_IDLE_SECONDS = 7 * 24 * 3600;
const ACCESS_TOKEN_SECONDS = 3600;
// The whole of the browser's session on a mind hostname (no refresh token); `whoIs` reads
// membership afresh on every request.
const HOST_ACCESS_TOKEN_SECONDS = 24 * 3600;
// A guest's session on a mind hostname. The browser earns the next one with no question while it
// comes back (./guest-sign-in.ts), so an app's own check of what the guest holds runs this often.
const GUEST_HOST_ACCESS_TOKEN_SECONDS = 15 * 60;
// The library writes a client again at a token exchange past half of this, so twice a grant's idle
// life keeps every client that still has a grant.
const CLIENT_REGISTRATION_SECONDS = 2 * SESSION_IDLE_SECONDS;
// The library would take up to 1 MiB; it caps a client metadata document at 5 KiB.
const CLIENT_METADATA_MAX_CHARACTERS = 4096;

// Built per call: the library takes a fixed list of resources, and a call may be about one mind
// hostname besides the config's audiences.
export function authorizationServer(
  env: Env,
  { hostResource, facts }: { hostResource?: string | null; facts?: AccountFacts } = {},
) {
  const audiences = tokenAudiencesOf(configOf(env));
  return new OAuthAuthorizationServer<Env>({
    issuer: issuerOf(env),
    resources: hostResource ? [...audiences, hostResource] : audiences,
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
  const config = configOf(env);
  const hostResource = mindHostResourceOf(config, resource);
  if (!hostResource && !tokenAudiencesOf(config).includes(resource)) return null;
  const validated = await authorizationServer(env, { hostResource }).validateToken(
    resource,
    token,
    env,
  );
  if (!validated) return null;
  const props = TokenProps.safeParse(validated.props);
  if (!props.success || props.data.userId !== validated.userId) return null;
  const deadline = deadlineOf(props.data);
  const expiresAt = deadline
    ? Math.min(validated.expiresAt, Math.floor(deadline / 1000))
    : validated.expiresAt;
  const member = await grantIsMembers(env, props.data);
  if (expiresAt * 1000 <= Date.now() || (!hostResource && !member)) return null;
  // a member is never blocked, so only a mind hostname's token asks
  if (!member && (await isBlocked(env, props.data.email))) return null;
  // a guest has a name and no address: the key of their row stays here
  if (props.data.method === "guest") {
    // A GUEST'S TOKEN IS GOOD ONLY WHILE THE APP STILL TAKES GUESTS: its description, as this
    // issuer keeps it (./asking-app.ts, asked again within five minutes), names "guest". So an
    // app that stops naming it ends every guest's reach at the next request.
    if (!hostResource || !(await appOf(env, hostResource))?.signIn.includes("guest")) return null;
    return {
      principal: { actor: props.data.userId },
      grant: props.data.grantId,
      expiresAt,
      member: false,
      method: "guest",
      name: props.data.name,
    };
  }
  // A MEMBER OF ANOTHER MIND'S TOKEN, as a guest's, is good only while the app still names "mind",
  // and names the mind that vouched; the key of their row stays here.
  if (props.data.method === "mind") {
    const { mind, name } = props.data;
    if (!hostResource || !mind || !(await appOf(env, hostResource))?.signIn.includes("mind"))
      return null;
    return {
      principal: { actor: props.data.userId },
      grant: props.data.grantId,
      expiresAt,
      member: false,
      method: "mind",
      name,
      mind,
    };
  }
  return {
    principal: { actor: props.data.userId, email: props.data.email },
    grant: props.data.grantId,
    expiresAt,
    member,
    method: props.data.method,
  };
}

/** Whether a grant acts as a member now: a passkey's session got it, and its address is a
 *  member's. And, BY A RULE TO REMOVE (`GrantProps.standingByMethod`), a grant that the old stack
 *  made with no mark, for a mailed code or with no method at all: its address is a member's. */
const grantIsMembers = async (env: Env, grant: GrantProps) =>
  (grant.method === "passkey" ||
    (!grant.standingByMethod && (grant.method === "email" || !grant.method))) &&
  (await isMember(env, grant.email));

/** The instant a let-in grant, or a member of another mind's, ends: when their cookie does
 *  (./cookies.ts `mindSessionCookie`). One with none ended at its making. */
const deadlineOf = (grant: GrantProps) =>
  grant.letIn || grant.method === "mind" ? grant.deadline || 1 : undefined;

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
  const hostResource = mindHostResourceOf(configOf(env), input.resource);
  if (!hostResource && !(await grantIsMembers(env, grant)))
    throw refused("not-member", "The session is no longer active.");
  if (hostResource && (await isBlocked(env, grant.email)))
    throw refused("blocked", "The session is no longer active.");
  const lifetime = grantLifetimeOf(grant, {
    refresh: input.grantType !== GrantType.AUTHORIZATION_CODE,
    host: Boolean(hostResource),
    now: Date.now(),
  });
  if (lifetime === "deadline_passed") throw refused(lifetime, "The session has expired.");
  if (lifetime === "guest_no_refresh")
    throw refused(lifetime, "A guest's session is not renewed here. Open the page again.");
  if (lifetime === "mind_no_refresh")
    throw refused(lifetime, "A sign-in by another mind is not renewed here. Open the page again.");
  if (lifetime === "let_in_no_refresh")
    throw refused(lifetime, "Being let in cannot be renewed. Ask again.");
  return { accessTokenProps: { ...grant, grantId: input.grantId }, ...lifetime };
}

/** What one token exchange gives a grant, or why the grant ends at it. */
export function grantLifetimeOf(
  grant: GrantProps,
  exchange: { refresh: boolean; host: boolean; now: number },
):
  | { accessTokenTTL: number; refreshTokenTTL?: number }
  | "deadline_passed"
  | "let_in_no_refresh"
  | "guest_no_refresh"
  | "mind_no_refresh" {
  const deadline = deadlineOf(grant);
  // A GUEST'S 15 MINUTES ARE ALL A GRANT GIVES: no refresh token (0 is the library's "none"), and
  // one a grant got before this rule renews nothing. The next 15 minutes are earned at the
  // authorization endpoint, where the cookie, the block and the bounds are asked again
  // (./guest-sign-in.ts). Any other host sign-in keeps the library's refresh token: an MCP client
  // of an app's host renews by it.
  if (grant.method === "guest" && exchange.refresh) return "guest_no_refresh";
  if (grant.method === "guest" && exchange.host)
    return { accessTokenTTL: GUEST_HOST_ACCESS_TOKEN_SECONDS, refreshTokenTTL: 0 };
  // A MEMBER OF ANOTHER MIND keeps the rest of the 24 hours that their mind's vouch gave, on a mind
  // hostname alone, and renews nothing (./mind-sign-in.ts).
  if (grant.method === "mind") {
    const remaining = Math.floor(((deadline || 1) - exchange.now) / 1000);
    if (!exchange.host || remaining < 60) return "deadline_passed";
    if (exchange.refresh) return "mind_no_refresh";
    return { accessTokenTTL: remaining, refreshTokenTTL: 0 };
  }
  if (!deadline && exchange.host) return { accessTokenTTL: HOST_ACCESS_TOKEN_SECONDS };
  if (!deadline) return { accessTokenTTL: ACCESS_TOKEN_SECONDS };
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
    hostResource: mindHostResourceOf(configOf(env), typeof resource === "string" ? resource : null),
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

/** One live sign-in of a person, as /sessions and the members page list it: a grant, whose client
 *  holds tokens. An app's, a CLI's, a device's, an MCP client's, or a mind hostname's own. */
export type SignIn = {
  id: string;
  /** The person whose access it is. */
  userId: string;
  clientId: string;
  /** The client's own name, or "" for one that gave none: a mind hostname's own sign-in. */
  clientName: string;
  /** What it is for: a resource of the stack, or a mind hostname's origin. Absent when the
   *  client's request named none. */
  resource?: string;
  /** Where the grant's code went: the client's own address, and its host. */
  redirectUri?: string;
  goesTo?: string;
  /** The mind hostname whose own sign-in this is, read from where its code went: a browser's
   *  session on one of the mind's pages or apps. */
  host?: string;
  /** The code went to this stack's own device page: a CLI or a device typed a code. */
  device: boolean;
  scopes: string[];
  /** The client's own logo, as it gave it when the grant was made, and the domain that its client
   *  ID is a document on. A picture is shown only with both (client-mark.ts `shownLogoOf`). */
  logoUri?: string;
  clientDomain?: string;
  /** Epoch seconds. `endsAt` moves at each renewal: it is when an unused sign-in ends. */
  createdAt: number;
  endsAt?: number;
  /** Its client renews it by use: it holds a refresh token. A mind hostname's own sign-in and a
   *  let-in hold none, and end at `endsAt` whatever their use. */
  renews: boolean;
  /** Epoch seconds: when its client last renewed it. The store keeps no time of use: a client
   *  that works renews within the hour, so this is the last hour of use, read from `endsAt`.
   *  Absent before the first renewal, and on a sign-in that does not renew. */
  renewedAt?: number;
  /** Epoch milliseconds: a let-in's fixed end, which no use moves. */
  until?: number;
};

/** What a grant keeps for these lists, written when it is made (./authorize.ts `complete`). */
export const SignInMetadata = z.object({
  clientName: z.string(),
  /** The grant's own `method` (`GrantProps`), kept where a list of a person's grants reads it.
   *  Absent on a grant of the earlier stack that kept no method, and read as absent when it is one
   *  that this stack does not know (`google`, `cloudflare`): the list still shows the rest. Only the
   *  list's `reach` reads it; a grant's standing is `GrantProps`'s alone (`grantIsMembers`). */
  method: SignInMethod.optional().catch(undefined),
  resource: z.string().optional(),
  logoUri: z.string().optional(),
  until: z.number().optional(),
});
export type SignInMetadata = z.infer<typeof SignInMetadata>;

/** The mind hostname whose own sign-in a grant is, read from where its code went: that host's
 *  own callback. */
function hostOfOwnCallback(env: Env, redirectUri: string | undefined) {
  if (!redirectUri || !URL.canParse(redirectUri)) return undefined;
  const host = mindHostResourceOf(configOf(env), new URL(redirectUri).origin);
  return host && redirectUri === hostCallbackOf(host) ? host : undefined;
}

/** One OAuth client that holds access as a person, with its live sessions and grants. */
export type ClientWithAccess = {
  clientId: string;
  /** The client's own name. A mind hostname's own client is named as its app names itself, else by
   *  its host, and a client that gave no name is "". */
  name: string;
  /** The mind hostname whose own client this is: one of the mind's pages or apps. */
  host?: string;
  /** Where its access goes, and what it gave of itself, as its newest sign-in has them. */
  redirectUri?: string;
  goesTo?: string;
  device: boolean;
  logoUri?: string;
  clientDomain?: string;
  /** Newest first. */
  signIns: SignIn[];
};

/** THE SESSIONS AND GRANTS OF A PERSON, BY OAUTH CLIENT. The one list of who holds access as a
 *  person, member or not: each client once, with every live sign-in it holds under it. An app or
 *  a CLI that the person let in is a client, an MCP client is one, and so is each of the mind's
 *  own hostnames, whose page holds a browser's session. /sessions shows a person their own, member
 *  or not, and the members page shows an owner every member's (./access-list.ts draws both). `endAccess` is the one way to end any of it. */
export async function sessionsByClientOf(
  env: Env,
  userId: string,
  reach: Reach,
): Promise<ClientWithAccess[]> {
  const clients = new Map<string, ClientWithAccess>();
  for (const signIn of await signInsOf(env, userId, reach)) {
    const client = clients.get(signIn.clientId);
    if (client) {
      client.signIns.push(signIn);
      continue;
    }
    // A mind hostname's own client holds what its app says of itself, its name and its icon
    // (./asking-app.ts writes them). A host that says nothing is named by its host.
    const own = signIn.host
      ? await oauthHelpers(env, signIn.host)
          .lookupClient(signIn.clientId)
          .catch(() => null)
      : null;
    clients.set(signIn.clientId, {
      clientId: signIn.clientId,
      name: signIn.host ? own?.clientName || new URL(signIn.host).host : signIn.clientName,
      host: signIn.host,
      redirectUri: signIn.redirectUri,
      goesTo: signIn.goesTo,
      device: signIn.device,
      logoUri: signIn.host ? own?.logoUri : signIn.logoUri,
      clientDomain: signIn.clientDomain,
      signIns: [signIn],
    });
  }
  return [...clients.values()];
}

/** THE ONE REVOKE: ends one sign-in of a person, or every sign-in that one client holds as that
 *  person, each with its tokens. Answers how many it ended: a sign-in or a client that is not
 *  that person's, or not within `reach`, ends nothing. */
export async function endAccess(
  env: Env,
  userId: string,
  reach: Reach,
  which: { signIn: string } | { client: string },
  facts: AccountFacts,
): Promise<number> {
  const helpers = oauthHelpers(env);
  const ending = (await signInsOf(env, userId, reach)).filter((signIn) =>
    "signIn" in which ? signIn.id === which.signIn : signIn.clientId === which.client,
  );
  for (const signIn of ending) {
    await helpers.revokeGrant(signIn.id, userId);
    facts.add(userId, {
      type: "events.iterate.com/account/grant-ended",
      payload: { grantId: signIn.id },
      idempotencyKey: `account/grant-ended/${signIn.id}`,
    });
  }
  return ending.length;
}

/** A person's live sign-ins within `reach`, newest first. A grant whose metadata says no method
 *  is within "all" alone. */
async function signInsOf(env: Env, userId: string, reach: Reach): Promise<SignIn[]> {
  const helpers = oauthHelpers(env);
  const signIns: SignIn[] = [];
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(userId, { cursor });
    for (const grant of page.items) {
      const metadata = SignInMetadata.safeParse(grant.metadata);
      if (reach !== "all" && metadata.data?.method !== reach) continue;
      // The library sets a grant's end one idle limit ahead at each exchange of a grant that
      // holds a refresh token, and one access token's life ahead, once, on a grant that holds none.
      const renewedAt = grant.expiresAt && grant.expiresAt - SESSION_IDLE_SECONDS;
      // A hostname's own sign-in is one access token, which the page's cookie holds: the page
      // never renews it, whatever end the library gave the grant.
      const host = hostOfOwnCallback(env, grant.redirectUri);
      const renews =
        !host && !metadata.data?.until && !!renewedAt && renewedAt >= grant.createdAt - 60;
      signIns.push({
        id: grant.id,
        userId,
        clientId: grant.clientId,
        // a client that gave no name is kept by its id, which says nothing to a person
        clientName:
          metadata.data?.clientName && metadata.data.clientName !== grant.clientId
            ? metadata.data.clientName
            : "",
        resource: metadata.data?.resource,
        redirectUri: grant.redirectUri,
        goesTo: URL.canParse(grant.redirectUri || "")
          ? new URL(grant.redirectUri!).host
          : undefined,
        host,
        device: grant.redirectUri === `${issuerOf(env)}${DEVICE_CALLBACK_PATH}`,
        scopes: grant.scope,
        logoUri: metadata.data?.logoUri,
        // as the library says it on the consent page: a client ID that is a document on a domain
        clientDomain: /^https:\/\/[^/]+\/./.test(grant.clientId)
          ? new URL(grant.clientId).hostname
          : undefined,
        createdAt: grant.createdAt,
        endsAt: host ? grant.createdAt + HOST_ACCESS_TOKEN_SECONDS : grant.expiresAt,
        renews,
        renewedAt: renews && renewedAt && renewedAt > grant.createdAt + 60 ? renewedAt : undefined,
        until: metadata.data?.until,
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return signIns.sort((a, b) => b.createdAt - a.createdAt);
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
