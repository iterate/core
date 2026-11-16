import type { SignInMethod } from "iterate/principal";
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { expect, test } from "vitest";
import { z } from "zod";
import { promptOf } from "./authorize.ts";
import type { Env } from "./env.ts";
import {
  grantedScopes,
  grantLifetimeOf,
  type GrantProps,
  knownResourceOf,
  oauthHelpers,
  tokenEndpointResponse,
  withKnownResource,
  hostClientOf,
} from "./oauth.ts";
import { whoIs } from "./who-is.ts";

const NOW = Date.UTC(2026, 10, 12);
const DAY_MS = 24 * 3600_000;
const person = { userId: "user_1", email: "member@example.com" };
const letIn = { reason: "a deploy", clientName: "the installer" };

test("a sign-in has no end date: a refresh years on gets an hour's token, and the library's idle limit alone ends it", () => {
  const made: GrantProps = person;
  // a grant made before 2026-11-12 carries a thirty-day deadline, which nothing reads
  const old: GrantProps = { ...person, deadline: NOW - 400 * DAY_MS };
  for (const grant of [made, old])
    for (const now of [NOW, NOW + 3 * 365 * DAY_MS]) {
      expect(grantLifetimeOf(grant, { refresh: true, host: false, now })).toEqual({
        accessTokenTTL: 3600,
      });
      expect(grantLifetimeOf(grant, { refresh: false, host: true, now })).toEqual({
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

// the one thing these read of the stack: its domain and the resources its config names
const env = {
  DOMAIN: "example.com",
  AUTH_SETTINGS: JSON.stringify({
    login: { allow: [{ email: "owner@elsewhere.test" }] },
  }),
} as unknown as Env;

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

// The rule is ./oauth.ts `grantStandingOf`. These grants are made by hand, as one that a mailed
// code got before its address became a member's, or one that Google got before a deploy changed
// what Google proves.
test.for([
  { name: "a passkey", method: "passkey", google: {}, member: true },
  {
    name: "Google, which signs a member in alone",
    method: "google",
    google: { signsInAlone: true },
    member: true,
  },
  { name: "Google, which proves the address alone", method: "google", google: {}, member: false },
  { name: "a mailed code", method: "email", google: {}, member: false },
  { name: "an owner's link", method: "member-link", google: {}, member: false },
  { name: "no way, as before grants kept it", method: undefined, google: {}, member: false },
] as const)(
  "a grant acts as a member only by a way that signs a member in: $name",
  async ({ method, google, member }) => {
    const stack = stackOf(google);
    const host = await exchanged(stack, HOST, method);
    const api = await exchanged(stack, API, method);
    expect({
      host: await whoIs(stack, TokenAnswer.parse(await host.answer.json()).access_token, HOST),
      api: api.answer.status,
    }).toMatchObject({ host: { member }, api: member ? 200 : 400 });
  },
);

test("a deploy that stops Google signing a member in alone ends what Google's grants hold as one", async () => {
  const kv = new Map<string, string>();
  const before = stackOf({ signsInAlone: true }, kv);
  const api = await exchanged(before, API, "google");
  const tokens = TokenAnswer.parse(await api.answer.json());
  expect(await whoIs(before, tokens.access_token, API)).toMatchObject({ member: true });
  const after = stackOf({}, kv);
  const refreshed = await tokenAnswer(after, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: api.clientId,
    resource: API,
  });
  expect({
    token: await whoIs(after, tokens.access_token, API),
    refreshed: refreshed.status,
  }).toMatchObject({ token: null, refreshed: 400 });
});

const OWNER = "owner@elsewhere.test";
const ISSUER = "https://iterate.example.com";
const API = `${ISSUER}/api`;
const HOST = "https://guestbook.example.com";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const TokenAnswer = z.object({ access_token: z.string(), refresh_token: z.string() });

/** The stack of `env` with Google's way, the OAuth library's store in `kv`, and a database in
 *  which nobody was added and nobody is blocked: its one member is the config's. */
function stackOf(google: { signsInAlone?: true }, kv = new Map<string, string>()): Env {
  return {
    ...env,
    AUTH_SETTINGS: JSON.stringify({
      login: { methods: { email: {}, google }, allow: [{ email: OWNER }] },
    }),
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

/** A grant of `resource` that a sign-in by `method` got the owner, for a client that may refresh,
 *  and the token endpoint's answer for its code. */
async function exchanged(stack: Env, resource: string, method: SignInMethod | undefined) {
  const hostResource = resource === API ? null : resource;
  const helpers = oauthHelpers(stack, hostResource);
  const redirectUri = "http://127.0.0.1:7777/callback";
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
    userId: "user_owner",
    metadata: { clientName: "a client" },
    scope: request.scope,
    revokeExistingGrants: false,
    props: { userId: "user_owner", email: OWNER, method },
  });
  const answer = await tokenAnswer(stack, {
    grant_type: "authorization_code",
    code: new URL(redirectTo).searchParams.get("code")!,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource,
  });
  return { answer, clientId };
}

const tokenAnswer = (stack: Env, form: Record<string, string>) =>
  tokenEndpointResponse(
    stack,
    new Request(`${ISSUER}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    }),
    ctx,
  );
