import { OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { expect, test } from "vitest";
import { z } from "zod";
import { promptOf } from "./authorize.ts";
import { CALLBACK_PATH as DEVICE_CALLBACK_PATH } from "./device/protocol.ts";
import type { Env } from "./env.ts";
import {
  AUTHORIZE_ENDPOINT,
  CLIENT_REGISTRATION_ENDPOINT,
  grantedScopes,
  grantLifetimeOf,
  type GrantProps,
  knownResourceOf,
  mindHostResourceOf,
  oauthHelpers,
  sessionsByClientOf,
  TOKEN_ENDPOINT,
  tokenEndpointResponse,
  withKnownResource,
  hostClientOf,
} from "./oauth.ts";
import { configVars } from "./test-support.ts";
import { whoIs } from "./who-is.ts";

const NOW = Date.UTC(2026, 10, 12);
const DAY_MS = 24 * 3600_000;
const person = { userId: "user_1", email: "member@example.com", method: "passkey" } as const;
const letIn = { reason: "a deploy", clientName: "the installer" };

test("a sign-in has no end date: a refresh years on gets an hour's token, and the library's idle limit alone ends it", () => {
  for (const now of [NOW, NOW + 3 * 365 * DAY_MS]) {
    expect(grantLifetimeOf(person, { refresh: true, host: false, now })).toEqual({
      accessTokenTTL: 3600,
    });
    expect(grantLifetimeOf(person, { refresh: false, host: true, now })).toEqual({
      accessTokenTTL: 24 * 3600,
    });
  }
});

test("being let in keeps its end: one token for the time asked for, no refresh, and nothing past the deadline", () => {
  const grant: GrantProps = { ...person, deadline: NOW + 900_000, letIn };
  expect(grantLifetimeOf(grant, { refresh: false, host: false, now: NOW })).toEqual({
    accessTokenTTL: 900,
    refreshTokenTTL: 900,
  });
  expect(grantLifetimeOf(grant, { refresh: true, host: false, now: NOW })).toBe(
    "let_in_no_refresh",
  );
  expect(grantLifetimeOf(grant, { refresh: false, host: false, now: NOW + 900_000 })).toBe(
    "deadline_passed",
  );
  expect(grantLifetimeOf({ ...person, letIn }, { refresh: false, host: false, now: NOW })).toBe(
    "deadline_passed",
  );
});

test.for([
  ["the API's own scope", ["iterate"], false, ["iterate"]],
  ["no scope at all", [], false, ["iterate"]],
  // the Codex CLI asks for every scope in the server's metadata
  ["every scope the metadata lists", ["iterate", "identity"], false, ["iterate"]],
  ["another scope only", ["identity"], false, null],
  ["a mind hostname's own scope", ["identity"], true, ["identity"]],
  ["every scope, for a mind hostname", ["iterate", "identity"], true, ["identity"]],
  ["the API's scope only, for a mind hostname", ["iterate"], true, null],
] as const)(
  "a request for %s is granted the resource's one scope, or refused",
  ([, requested, host, granted]) => {
    expect(grantedScopes(requested, host)).toEqual(granted);
  },
);

test("a hostname's sign-in client is made once, and new ones are counted: a refused one stores nothing", async () => {
  const kv = new Map<string, string>();
  let admit = true;
  let asked = 0;
  const stack = {
    ...env,
    OAUTH_KV: {
      get: async (key: string, type?: unknown) => {
        const kept = kv.get(key);
        return kept && type ? JSON.parse(kept) : kept || null;
      },
      put: async (key: string, value: string) => void kv.set(key, value),
    },
    DB: {
      prepare: (sql: string) => ({ bind: (...bound: unknown[]) => ({ sql, bound }) }),
      // the admission's two statements: the sweep, then the count that admits or not
      batch: async (statements: { bound: unknown[] }[]) => {
        asked += 1;
        expect(statements[1]!.bound.slice(0, 2)).toEqual(["host-client", null]);
        return [{}, { results: admit ? [{ admitted: 1 }] : [] }];
      },
    },
  } as unknown as Env;
  const first = await hostClientOf(stack, "guestbook.example.com");
  expect(first).toEqual(expect.any(String));
  // the same host again asks nobody: its client is kept
  expect(await hostClientOf(stack, "guestbook.example.com")).toBe(first);
  expect(asked).toBe(1);
  // past the stack's count, a name nobody saw before gets no client and no row
  admit = false;
  const rows = [...kv.keys()];
  await expect(hostClientOf(stack, "made-up-1234.example.com")).rejects.toThrow(
    "Too many sign-ins",
  );
  expect([...kv.keys()]).toEqual(rows);
  // the host that has its client still signs in
  expect(await hostClientOf(stack, "guestbook.example.com")).toBe(first);
  await expect(hostClientOf(stack, "elsewhere.test")).rejects.toThrow(
    "not a hostname of this mind",
  );
});

// the one thing these read of the stack: its config
const env = configVars({ ownerEmails: ["owner@elsewhere.test"] }) as unknown as Env;

test("any hostname of any zone of the mind is a resource, but the control-plane hostname", () => {
  const config = {
    controlPlaneHostname: "iterate.example.com",
    zones: ["example.com", "second.example"],
  };
  const host = (resource: string) => mindHostResourceOf(config, resource);
  expect([
    host("https://guestbook.example.com"),
    host("https://example.com"),
    host("https://second.example"),
    host("https://shop.second.example"),
  ]).toEqual([
    "https://guestbook.example.com",
    "https://example.com",
    "https://second.example",
    "https://shop.second.example",
  ]);
  expect([
    // the issuer's own origin
    host("https://iterate.example.com"),
    host("https://elsewhere.test"),
    // another domain that only ends with the same letters
    host("https://notsecond.example"),
    host("http://shop.second.example"),
    host("https://shop.second.example:8443"),
    host("https://shop.second.example/path"),
  ]).toEqual([null, null, null, null, null, null]);
});

test("a person signs in on a hostname of the mind's second zone: its token is for that host", async () => {
  const stack = stackOf({ zones: ["example.com", "second.example"] });
  const host = "https://shop.second.example";
  const { answer } = await exchanged(stack, host, owner);
  const { access_token: token } = TokenAnswer.parse(await answer.json());
  expect(await whoIs(stack, token, host)).toMatchObject({
    principal: { actor: owner.userId, email: OWNER },
    member: true,
  });
  // a token is for one resource
  expect(await whoIs(stack, token, HOST)).toBeNull();
});

test("a path on a mind hostname names the host, as an MCP client names its server; nothing else changes", () => {
  const known = (resource: string) => knownResourceOf(env, resource);
  expect(known("https://guestbook.example.com/mcp")).toBe("https://guestbook.example.com");
  expect(known("https://guestbook.example.com/")).toBe("https://guestbook.example.com");
  expect(known("https://guestbook.example.com")).toBe("https://guestbook.example.com");
  // the platform's own resources are whole URLs, and a path beside them is no resource
  expect(known("https://iterate.example.com/mcp")).toBe("https://iterate.example.com/mcp");
  expect(known("https://iterate.example.com/mcp/x")).toBe("https://iterate.example.com/mcp/x");
  expect(known("https://elsewhere.test/mcp")).toBe("https://elsewhere.test/mcp");
  expect(known("http://guestbook.example.com/mcp")).toBe("http://guestbook.example.com/mcp");
});

test("the authorization and token requests carry the host for a path on it", async () => {
  const authorize = await withKnownResource(
    env,
    new Request(
      "https://iterate.example.com/oauth2/auth?client_id=c&resource=https%3A%2F%2Fguestbook.example.com%2Fmcp",
    ),
  );
  expect(new URL(authorize.url).searchParams.get("resource")).toBe("https://guestbook.example.com");
  const token = await withKnownResource(
    env,
    new Request("https://iterate.example.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=r&resource=https%3A%2F%2Fguestbook.example.com%2Fmcp",
    }),
  );
  expect(Object.fromEntries(new URLSearchParams(await token.text()))).toEqual({
    grant_type: "refresh_token",
    refresh_token: "r",
    resource: "https://guestbook.example.com",
  });
  const untouched = new Request("https://iterate.example.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=refresh_token&resource=https%3A%2F%2Fiterate.example.com%2Fmcp",
  });
  expect(await withKnownResource(env, untouched)).toBe(untouched);
});

test("an authorization request's prompt is read, and the request goes on without it", () => {
  const of = (query: string) =>
    promptOf(new URL(`https://iterate.example.com/oauth2/auth?${query}`));
  expect(of("client_id=c&prompt=select_account&state=s")).toEqual({
    prompt: "select_account",
    here: "/oauth2/auth?client_id=c&state=s",
  });
  // a list: to sign in again is the stronger ask
  expect(of("client_id=c&prompt=select_account%20login")).toMatchObject({ prompt: "login" });
  expect(of("client_id=c&prompt=consent")).toEqual({
    prompt: null,
    here: "/oauth2/auth?client_id=c",
  });
  expect(of("client_id=c")).toEqual({ prompt: null, here: "/oauth2/auth?client_id=c" });
});

// A grant keeps no way of sign-in: a passkey's session alone gets one (./authorize.ts
// `grantRefusal`). What it is to the stack is its address's membership, asked at every use.
test("a grant acts as a member while its address is a member's", async () => {
  const stack = stackOf();
  expect(await standingIn(stack, await granted(stack, owner, "device"))).toEqual({
    host: expect.objectContaining({ member: true }),
    api: expect.objectContaining({ member: true }),
    refreshed: 200,
  });
});

test("a grant acts as no member once its address is no member's: a host's token says so, and the API's is nobody's", async () => {
  const kv = new Map<string, string>();
  const before = stackOf({}, kv);
  const held = await granted(before, owner, "app");
  // `whoIs` alone, so the refresh below spends a refresh token that no refresh spent before
  expect(await whoIs(before, held.api!.tokens.access_token, API)).toMatchObject({ member: true });
  const removed = stackOf({ ownerEmails: ["someone@elsewhere.test"] }, kv);
  expect(await standingIn(removed, held)).toEqual({
    host: expect.objectContaining({ member: false }),
    api: null,
    refreshed: 400,
  });
});

// A person whom a mailed code signed in was no member then. Their grant is for a mind hostname
// alone, and never a member's: an address that becomes a member's later gives it nothing.
test("a grant of a person whom a mailed code signed in is never a member's, though its address is a member's now", async () => {
  const stack = stackOf();
  // as ./authorize.ts writes it
  const mailed = { ...owner, method: "email", standingByMethod: true } as const;
  const host = await exchanged(stack, HOST, mailed);
  const token = TokenAnswer.parse(await host.answer.json()).access_token;
  // the token says how its person signed in, which the boundary stamps on the person
  expect(await whoIs(stack, token, HOST)).toMatchObject({
    principal: { email: OWNER },
    member: false,
    method: "email",
  });
  expect((await exchanged(stack, API, mailed)).answer).toMatchObject({ status: 400 });
});

test("a grant for the API is refused to an address that is no member's", async () => {
  const stack = stackOf();
  const stranger = {
    userId: "user_stranger",
    email: "stranger@elsewhere.test",
    method: "passkey",
  } as const;
  expect((await exchanged(stack, API, stranger)).answer).toMatchObject({ status: 400 });
});

// A grant that other rules made is in the store with a field that this code does not write: its
// props say how its person signed in, and whoever made it did not ask for a passkey. Its address
// is a member's here, so by the address alone its tokens would act as a member.
test.for([
  { name: "a field of another shape", props: { method: "cloudflare", standingByMethod: true } },
  { name: "an unknown field", props: { via: "another issuer" } },
  // the earlier stack's grant of a passkey that its holder added while no member
  { name: "the mark of no member's passkey", props: { standingByMethod: true, outsider: true } },
  // only the old stack's unmarked grants lack a method
  {
    name: "a mark and no word of how its person signed in",
    props: { method: undefined, standingByMethod: true },
  },
  // the old stack's grants by a way that this stack does not have, marked and not
  { name: "a sign-in by Google", props: { method: "google" } },
  { name: "a marked sign-in by Google", props: { method: "google", standingByMethod: true } },
  { name: "a sign-in at Cloudflare", props: { method: "cloudflare" } },
  { name: "an owner's ticket", props: { method: "first-owner-ticket", standingByMethod: true } },
  { name: "a member's link", props: { method: "member-link", standingByMethod: true } },
  { name: "that word under another name", props: { method: undefined, proof: "passkey" } },
])(
  "a stored grant with $name is no grant: its access token is nobody's, and its refresh is refused",
  async ({ props }) => {
    const kv = new Map<string, string>();
    const stack = stackOf({}, kv);
    // the same store, read by a server that asks nothing of a grant's props at an exchange
    const lenient = new OAuthAuthorizationServer<Env>({
      issuer: ISSUER,
      resources: [API, `${ISSUER}/mcp`, HOST],
      authorizeEndpoint: AUTHORIZE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      clientRegistrationEndpoint: CLIENT_REGISTRATION_ENDPOINT,
      scopesSupported: ["iterate", "identity"],
    });
    for (const resource of [HOST, API]) {
      // the cast: the grant is of a shape that this code does not write, which is the test
      const stored = { ...owner, ...props } as unknown as GrantProps;
      const held = await exchanged(stack, resource, stored, "app", (request) =>
        lenient.fetch(request, stack, ctx),
      );
      const tokens = TokenAnswer.parse(await held.answer.json());
      // the store holds a live token: the lenient server takes it
      expect(await lenient.validateToken(resource, tokens.access_token, stack)).toMatchObject({
        userId: owner.userId,
      });
      expect(await whoIs(stack, tokens.access_token, resource)).toBeNull();
      const refreshed = await tokenAnswer(stack, {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: held.clientId,
        resource,
      });
      expect(refreshed).toMatchObject({ status: 400 });
    }
  },
);

// The earlier stack marked a grant made by this rule with `standingByMethod`: such a grant keeps
// what it was there, and gains nothing.
test("a grant that the earlier stack marked keeps its standing: a passkey's acts as a member, a mailed code's as none", async () => {
  const stack = stackOf();
  const marked = { ...owner, standingByMethod: true } as const;
  expect(await standingIn(stack, await granted(stack, marked, "device"))).toEqual({
    host: expect.objectContaining({ member: true }),
    api: expect.objectContaining({ member: true }),
    refreshed: 200,
  });
  const mailed = { ...marked, method: "email" } as const;
  const host = TokenAnswer.parse(await (await exchanged(stack, HOST, mailed)).answer.json());
  expect(await whoIs(stack, host.access_token, HOST)).toMatchObject({ member: false });
  expect((await exchanged(stack, API, mailed)).answer).toMatchObject({ status: 400 });
});

// THE OLD STACK'S GRANTS, as its code stored them (git show 503f90fed:core/auth-worker/src/oauth.ts):
// a grant made before 16 Nov 2026 has no mark, and keeps the rule it was made under. A rule to
// remove (./oauth.ts `GrantProps.standingByMethod`).
test("the old stack's grant of a member by a passkey, with no mark, acts as a member and is renewed", async () => {
  const stack = stackOf();
  expect(await standingIn(stack, await granted(stack, owner, "device"))).toEqual({
    host: expect.objectContaining({ member: true, method: "passkey" }),
    api: expect.objectContaining({ member: true }),
    refreshed: 200,
  });
});

// Jeeves's case: a mind whose members signed in by a mailed code, whose bridges hold such grants
test("the old stack's grant of a member by a mailed code, with no mark, acts as a member while the address is one, and gains nothing", async () => {
  const kv = new Map<string, string>();
  const stack = stackOf({}, kv);
  const mailed = { ...owner, method: "email" } as const;
  const held = await granted(stack, mailed, "device");
  expect(await whoIs(stack, held.api!.tokens.access_token, API)).toMatchObject({
    member: true,
    method: "email",
  });
  expect(await standingIn(stack, held)).toMatchObject({ refreshed: 200 });
  // an address that is no member's: nothing
  const removed = stackOf({ ownerEmails: ["someone@elsewhere.test"] }, kv);
  expect(await whoIs(removed, held.host.access_token, HOST)).toMatchObject({ member: false });
  const stranger = { ...mailed, userId: "user_stranger", email: "stranger@elsewhere.test" };
  expect((await exchanged(stack, API, stranger)).answer).toMatchObject({ status: 400 });
});

// A pattern is newer than every unmarked grant: no passkey stood behind one for such a person.
test("the old stack's unmarked grant of an address that only an owner email pattern names acts as no member; a passkey's grant of it does", async () => {
  const stack = stackOf({ ownerEmailPatterns: ["*@company.test"] });
  const person = { ...owner, userId: "user_pattern", email: "cy@company.test" };
  expect(
    await whoIs(stack, (await granted(stack, person, "device")).api!.tokens.access_token, API),
  ).toMatchObject({ member: true });
  const { method: _method, ...bare } = person;
  for (const unmarked of [{ ...person, method: "email" } as const, bare]) {
    const host = TokenAnswer.parse(await (await exchanged(stack, HOST, unmarked)).answer.json());
    expect(await whoIs(stack, host.access_token, HOST)).toMatchObject({ member: false });
    expect((await exchanged(stack, API, unmarked)).answer).toMatchObject({ status: 400 });
  }
});

// The old stack's grants before 13 Nov 2026 kept no method (git show 0cef1cd95:core/auth-worker/src/oauth.ts):
// the Beelink bridges' device sign-in of 12 Nov is one. Main's rule: a member while the address is.
test("the old stack's grant with no method at all acts as a member while the address is one, and gains nothing", async () => {
  const kv = new Map<string, string>();
  const stack = stackOf({}, kv);
  const { method: _method, ...bare } = owner;
  const held = await granted(stack, bare, "device");
  const identity = await whoIs(stack, held.api!.tokens.access_token, API);
  expect(identity).toMatchObject({ member: true, principal: { email: OWNER } });
  // it names no way, so no app that names its ways takes it
  expect(identity?.method).toBeUndefined();
  expect(await standingIn(stack, held)).toMatchObject({ refreshed: 200 });
  // an address that is no member's now: nothing
  const removed = stackOf({ ownerEmails: ["someone@elsewhere.test"] }, kv);
  expect(await whoIs(removed, held.api!.tokens.access_token, API)).toBeNull();
  expect(await whoIs(removed, held.host.access_token, HOST)).toMatchObject({ member: false });
  const stranger = { ...bare, userId: "user_stranger", email: "stranger@elsewhere.test" };
  expect((await exchanged(stack, API, stranger)).answer).toMatchObject({ status: 400 });
});

test("the old stack's grant of a guest is a guest's: its host alone, no member, its name, no renewal", async () => {
  const stack = stackOf();
  const guest = {
    userId: "user_guest",
    email: "guest:0",
    method: "guest",
    name: "Bob",
    standingByMethod: true,
  } as const;
  // the app takes guests, as the issuer keeps its description (./asking-app.ts)
  await stack.OAUTH_KV.put(
    `iterate-app-description:${new URL(HOST).host}`,
    JSON.stringify({
      name: null,
      icon: null,
      members: false,
      signIn: ["guest"],
      askAfter: Date.now() + 60_000,
    }),
  );
  const held = await exchanged(stack, HOST, guest);
  const tokens = z
    .object({ access_token: z.string() })
    .passthrough()
    .parse(await held.answer.json());
  expect(await whoIs(stack, tokens.access_token, HOST)).toMatchObject({
    member: false,
    method: "guest",
    name: "Bob",
  });
  expect(tokens).not.toHaveProperty("refresh_token");
  expect((await exchanged(stack, API, guest)).answer).toMatchObject({ status: 400 });
});

// A GRANT OF THE EARLIER STACK in a person's list: its metadata kept no method, or one that this
// stack does not know. The list shows its client's name, its resource and its fixed end, and it is
// within "all" alone.
test.each([
  ["no method", {}],
  ["a method that this stack does not know", { method: "google" }],
])("a sign-in whose metadata keeps %s is listed with the rest of its metadata", async (_, kept) => {
  const stack = stackOf();
  const helpers = oauthHelpers(stack);
  const redirectUri = "http://127.0.0.1:7777/callback";
  const { clientId } = await helpers.createClient({
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: API,
    scope: "iterate",
    code_challenge: await calculatePKCECodeChallenge(generateRandomCodeVerifier()),
    code_challenge_method: "S256",
  });
  const until = Date.now() + DAY_MS;
  await helpers.completeAuthorization({
    request: await helpers.parseAuthRequest(new Request(`${ISSUER}/oauth2/auth?${query}`)),
    userId: owner.userId,
    metadata: { clientName: "an old client", resource: API, until, ...kept },
    scope: ["iterate"],
    revokeExistingGrants: false,
    props: owner,
  });
  expect(await sessionsByClientOf(stack, owner.userId, "all")).toMatchObject([
    { clientId, name: "an old client", signIns: [{ resource: API, until }] },
  ]);
  expect(await sessionsByClientOf(stack, owner.userId, "email")).toEqual([]);
});

const OWNER = "owner@elsewhere.test";
const owner = { userId: "user_owner", email: OWNER, method: "passkey" } as const;
const ISSUER = "https://iterate.example.com";
const API = `${ISSUER}/api`;
const HOST = "https://guestbook.example.com";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const TokenAnswer = z.object({ access_token: z.string(), refresh_token: z.string() });

/** A stack whose owner is `OWNER`, with `config` over that, the OAuth library's store in `kv`, and
 *  a database in which nobody was added and nobody is blocked. */
function stackOf(
  config: Parameters<typeof configVars>[0] = {},
  kv = new Map<string, string>(),
): Env {
  return {
    ...configVars({ ownerEmails: [OWNER], ...config }),
    OAUTH_KV: {
      get: async (key: string, type?: unknown) => {
        const kept = kv.get(key) ?? null;
        const json = type === "json" || (type as { type?: string } | undefined)?.type === "json";
        return kept && json ? JSON.parse(kept) : kept;
      },
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
      list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
        keys: [...kv.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
    },
    DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    // the cast: a token's checks read these bindings and no other
  } as unknown as Env;
}

/** A grant of `resource` with `props`, for a client that may refresh, and the token endpoint's
 *  answer for its code. A device's client is the one ./device/start.ts registers: its one
 *  redirect is the device callback. */
async function exchanged(
  stack: Env,
  resource: string,
  props: GrantProps,
  client: "app" | "device" = "app",
  /** The token endpoint that takes the code: the stack's own, or another server's on its store. */
  tokenEndpoint: (request: Request) => Promise<Response> = (request) =>
    tokenEndpointResponse(stack, request, ctx),
) {
  const hostResource = resource === API ? null : resource;
  const helpers = oauthHelpers(stack, hostResource);
  const redirectUri =
    client === "device" ? `${ISSUER}${DEVICE_CALLBACK_PATH}` : "http://127.0.0.1:7777/callback";
  const { clientId } = await helpers.createClient({
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const verifier = generateRandomCodeVerifier();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
    scope: hostResource ? "identity" : "iterate",
    code_challenge: await calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
  });
  const request = await helpers.parseAuthRequest(new Request(`${ISSUER}/oauth2/auth?${query}`));
  const { redirectTo } = await helpers.completeAuthorization({
    request,
    userId: props.userId,
    metadata: { clientName: "a client" },
    scope: request.scope,
    revokeExistingGrants: false,
    props,
  });
  const answer = await tokenEndpoint(
    tokenRequest({
      grant_type: "authorization_code",
      code: new URL(redirectTo).searchParams.get("code")!,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }),
  );
  return { answer, clientId };
}

/** Grants of `props` for a mind hostname, by the app's client, and for the API, by `client`, with
 *  their tokens. `api` is null when the stack refused the API grant's code. */
async function granted(stack: Env, props: GrantProps, client: "app" | "device") {
  const host = await exchanged(stack, HOST, props);
  const api = await exchanged(stack, API, props, client);
  return {
    host: TokenAnswer.parse(await host.answer.json()),
    api: api.answer.ok
      ? { tokens: TokenAnswer.parse(await api.answer.json()), clientId: api.clientId }
      : null,
  };
}

/** What `stack` makes of grants now: `whoIs` of each token, and the status of a refresh of the API
 *  grant. Both API answers are null when the API grant has no token. */
async function standingIn(stack: Env, { host, api }: Awaited<ReturnType<typeof granted>>) {
  return {
    host: await whoIs(stack, host.access_token, HOST),
    api: api && (await whoIs(stack, api.tokens.access_token, API)),
    refreshed:
      api &&
      (
        await tokenAnswer(stack, {
          grant_type: "refresh_token",
          refresh_token: api.tokens.refresh_token,
          client_id: api.clientId,
          resource: API,
        })
      ).status,
  };
}

const tokenRequest = (form: Record<string, string>) =>
  new Request(`${ISSUER}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });

const tokenAnswer = (stack: Env, form: Record<string, string>) =>
  tokenEndpointResponse(stack, tokenRequest(form), ctx);
