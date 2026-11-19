import { timingSafeEqual } from "node:crypto";
import { SECRET_USE_HEADER } from "iterate/secret-placeholder";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { SecretDurableObject } from "./secret/durable-object.ts";
import { grantRefusal } from "./secret-oauth.ts";

// workerd's own comparison, which Node's Web Crypto has not got
Object.assign(crypto.subtle, { timingSafeEqual });

// THE SCOPE CEILING (`grantedWithin`) AND THE ACCOUNT OF A GRANT (`account` + `expectAccount`), for
// a client of the mind's own: a public client of an MCP server's authorization server, as a mind
// connects to Cloudflare's MCP server.
const PATH = "/secrets/cloudflare";
const ORIGIN = "https://mcp.example.net";
const TOKEN_ENDPOINT = `${ORIGIN}/token`;
const MCP = `${ORIGIN}/mcp`;
const member = { userId: "user_aaaa", email: "member@example.com", member: true };
const WITHIN = ["zone.read", "dns.read", "user:read", "account:read", "offline_access"];
/** The connect of a mind that asks two reads, within its ceiling, and checks the account. */
const CONNECT = {
  authorizationEndpoint: `${ORIGIN}/authorize`,
  tokenEndpoint: TOKEN_ENDPOINT,
  clientId: "https://example.com/client.json",
  scope: "zone.read dns.read offline_access",
  urls: [ORIGIN],
  grantedWithin: WITHIN,
};
/** The account check through the MCP server's `execute`: the code answers `{ id: <zone> }` only
 *  when the grant reaches one account, and that account holds the zone. */
const ACCOUNT_CHECK = {
  account: {
    url: MCP,
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute" } },
    id: "result.content.0.text@json.id",
    name: "result.content.0.text@json.name",
  },
  expectAccount: "example.com",
};

/** What the provider answers: the token answer's `scope` (absent: none), the account check's
 *  text, its status, and the scope of a refresh's answer. */
type Provider = {
  granted?: string;
  checked?: unknown;
  checkStatus?: number;
  refreshed?: string;
  // the code's exchange waits for it
  held?: Promise<void>;
};

test("a grant within its ceiling is kept, and the ceiling goes with its refresh", async () => {
  const { secret, current, seen } = vault({ granted: "zone.read dns.read offline_access" });
  const { nonce } = await begun(secret, CONNECT);
  const completed = await secret.completeOAuth(PATH, { code: "the-code", nonce, by: member });
  expect({
    scopes: "result" in completed && completed.result.scopes,
    refresh: current()?.refresh,
    seen,
  }).toEqual({
    scopes: ["zone.read", "dns.read", "offline_access"],
    refresh: {
      kind: "oauth-refresh-token",
      tokenEndpoint: TOKEN_ENDPOINT,
      clientAuth: "client_secret_basic",
      grantedWithin: WITHIN,
    },
    seen: [`${TOKEN_ENDPOINT} authorization_code`],
  });
});

test.for<[string, Provider, RegExp]>([
  [
    "a permission beyond the ceiling (the person chose a wider set)",
    { granted: "zone.read workers-scripts.write offline_access" },
    /permissions that this connection may not hold: workers-scripts\.write\. Nothing was kept\..*"Full access"/,
  ],
  [
    "no scope at all (the answer does not say what was granted)",
    {},
    /did not say which permissions it granted.*Nothing was kept/,
  ],
])(
  "a grant whose answer names %s is refused: nothing is kept, and the page says why",
  async ([, provider, words]) => {
    const { secret, current } = vault(provider);
    const { nonce } = await begun(secret, CONNECT);
    expect(await secret.completeOAuth(PATH, { code: "the-code", nonce, by: member })).toEqual(
      refused(nonce, words),
    );
    expect({ kept: current(), result: await result(secret, nonce) }).toEqual({
      kept: undefined,
      result: { status: "failed", error: expect.stringMatching(words) },
    });
  },
);

test("the account check: the grant reaches one account, the one that holds the mind's zone", async () => {
  const one = { id: "example.com", name: "iterate (dev/preview)" };
  const { secret, current, seen } = vault({
    granted: "zone.read offline_access",
    checked: one,
  });
  const { nonce } = await begun(secret, { ...CONNECT, ...ACCOUNT_CHECK });
  await secret.completeOAuth(PATH, { code: "the-code", nonce, by: member });
  expect({ kept: Boolean(current()), result: await result(secret, nonce), seen }).toEqual({
    kept: true,
    result: { status: "complete", scopes: ["zone.read", "offline_access"], account: one },
    seen: [`${TOKEN_ENDPOINT} authorization_code`, `${MCP} POST tools/call Bearer access-1`],
  });
});

test.for<[string, Provider, RegExp]>([
  ["two accounts", { checked: { accounts: 2 } }, /named no one account.*example\.com alone/],
  ["another account", { checked: { id: "other.com" } }, /is for "other\.com".*example\.com alone/],
  ["no answer", { checkStatus: 500 }, /did not say which account.*answered 500/],
])("a grant that reaches %s is refused, and nothing is kept", async ([, provider, words]) => {
  const { secret, current } = vault({ granted: "zone.read offline_access", ...provider });
  const { nonce } = await begun(secret, { ...CONNECT, ...ACCOUNT_CHECK });
  expect(await secret.completeOAuth(PATH, { code: "the-code", nonce, by: member })).toEqual(
    refused(nonce, words),
  );
  expect({ kept: current(), result: await result(secret, nonce) }).toEqual({
    kept: undefined,
    result: { status: "failed", error: expect.stringMatching(words) },
  });
});

test("a refresh whose answer names a scope beyond the ceiling is refused: its tokens are never used", async () => {
  const { secret, current, seen } = vault({
    granted: "zone.read offline_access",
    refreshed: "zone.read workers-scripts.write",
  });
  const { nonce } = await begun(secret, CONNECT);
  vi.useFakeTimers({ toFake: ["Date"] });
  await secret.completeOAuth(PATH, { code: "the-code", nonce, by: member });
  // the token ends after an hour: the next use refreshes it first, and the refresh is refused
  vi.setSystemTime(Date.now() + 61 * 60_000);
  await secret.fetch(
    new Request(MCP, {
      method: "POST",
      headers: {
        [SECRET_USE_HEADER]: PATH,
        authorization: `Bearer getSecret("${PATH}", { field: "accessToken" })`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  vi.useRealTimers();
  // the use goes once with what the secret held: the refused answer's token never leaves
  expect(seen).toEqual([
    `${TOKEN_ENDPOINT} authorization_code`,
    `${TOKEN_ENDPOINT} refresh_token`,
    `${MCP} POST tools/list Bearer access-1`,
  ]);
  expect(current()).toBeDefined();
});

test("the stack's former client at Cloudflare: a connect through it is refused with words", async () => {
  const { secret } = vault({});
  await expect(
    secret.secret(PATH, "beginOAuth", { client: { stack: "cloudflare" } }),
  ).rejects.toThrow(/no OAuth client at Cloudflare any more.*cloudflareConnect/);
});

test.for<[string, object, RegExp]>([
  [
    "a scope outside its own ceiling",
    { scope: "zone.read d1.read" },
    /d1\.read, which grantedWithin does not hold/,
  ],
  ["an empty ceiling", { grantedWithin: [] }, /grantedWithin is a list of scope names/],
  [
    "a ceiling with a space in a name",
    { grantedWithin: ["zone.read dns.read"] },
    /grantedWithin is a list/,
  ],
  [
    "an account to expect, and no endpoint that names it",
    { expectAccount: "example.com" },
    /expectAccount needs account/,
  ],
  [
    "a body for a GET",
    { account: { url: MCP, id: "id", body: {} } },
    /account\.body goes with method: "POST"/,
  ],
])("a connect that names %s is refused before anything is asked", async ([, options, words]) => {
  const { secret } = vault({});
  await expect(secret.secret(PATH, "beginOAuth", { ...CONNECT, ...options })).rejects.toThrow(
    words,
  );
});

// THE VAULT'S OWN CEILING: Cloudflare's OAuth grants reads alone, whatever the caller names.
const CLOUDFLARE = "https://mcp.cloudflare.com";
const CLOUDFLARE_CONNECT = {
  authorizationEndpoint: `${CLOUDFLARE}/authorize`,
  tokenEndpoint: `${CLOUDFLARE}/token`,
  clientId: "https://example.com/client.json",
  clientAuth: "none",
  scope: "zone.read offline_access",
  urls: [CLOUDFLARE],
};

test("a connect to Cloudflare with no ceiling of its own: a grant that holds a write is refused", async () => {
  const { secret, current } = vault({ granted: "zone.read workers-scripts.write offline_access" });
  const { nonce } = await begun(secret, CLOUDFLARE_CONNECT);
  expect(await secret.completeOAuth(PATH, { code: "the-code", nonce, by: member })).toEqual(
    refused(nonce, /may not hold: workers-scripts\.write\. Nothing was kept/),
  );
  expect(current()).toBeUndefined();
});

test("a connect to Cloudflare with no ceiling of its own: a grant of reads is kept, held to the vault's ceiling", async () => {
  const { secret, current } = vault({ granted: "zone.read user:read offline_access" });
  const { nonce } = await begun(secret, CLOUDFLARE_CONNECT);
  await secret.completeOAuth(PATH, { code: "the-code", nonce, by: member });
  const refresh = z.object({ grantedWithin: z.array(z.string()) }).parse(current()?.refresh);
  expect({
    reads: refresh.grantedWithin.includes("zone.read"),
    writes: refresh.grantedWithin.filter((scope) => !/\.read$|^offline_access$/.test(scope)),
  }).toEqual({ reads: true, writes: expect.not.arrayContaining(["workers-scripts.write"]) });
});

test.for<[string, object, RegExp]>([
  [
    "a ceiling wider than the vault's own",
    { grantedWithin: ["zone.read", "workers-scripts.write", "offline_access"] },
    /grantedWithin names workers-scripts\.write, beyond what the vault keeps of a grant from Cloudflare: reads alone/,
  ],
  [
    "a scope that writes, and no ceiling",
    { scope: "zone.read workers-scripts.write" },
    /scope asks for workers-scripts\.write, beyond what the vault keeps of a grant from Cloudflare/,
  ],
  [
    "a token endpoint elsewhere, whose token may go to Cloudflare",
    {
      tokenEndpoint: `${ORIGIN}/token`,
      urls: [ORIGIN, "https://api.cloudflare.com"],
    },
    /comes from Cloudflare's own token endpoint, not https:\/\/mcp\.example\.net/,
  ],
])(
  "a connect to Cloudflare that names %s is refused before anything is asked",
  async ([, options, words]) => {
    const { secret } = vault({});
    await expect(
      secret.secret(PATH, "beginOAuth", { ...CLOUDFLARE_CONNECT, ...options }),
    ).rejects.toThrow(words);
  },
);

test("a refresh whose answer names no scope is refused: its tokens are never used", async () => {
  const { secret, current, seen } = vault({ granted: "zone.read offline_access" });
  const { nonce } = await begun(secret, CONNECT);
  vi.useFakeTimers({ toFake: ["Date"] });
  await secret.completeOAuth(PATH, { code: "the-code", nonce, by: member });
  vi.setSystemTime(Date.now() + 61 * 60_000);
  await secret.fetch(useOfTheGrant());
  vi.useRealTimers();
  expect(seen).toEqual([
    `${TOKEN_ENDPOINT} authorization_code`,
    `${TOKEN_ENDPOINT} refresh_token`,
    `${MCP} POST tools/list Bearer access-1`,
  ]);
  expect(current()).toBeDefined();
});

test("a refused grant goes back to the provider (RFC 7009), and the fact says so", async () => {
  const { secret, seen } = vault({ granted: "zone.read workers-scripts.write offline_access" });
  const { nonce } = await begun(secret, { ...CONNECT, revocationEndpoint: TOKEN_ENDPOINT });
  const answer = await secret.completeOAuth(PATH, { code: "the-code", nonce, by: member });
  expect({ answer, seen }).toEqual({
    answer: refused(nonce, /workers-scripts\.write/, true),
    seen: [
      `${TOKEN_ENDPOINT} authorization_code`,
      `${TOKEN_ENDPOINT} revoke refresh_token refresh-1`,
      `${TOKEN_ENDPOINT} revoke access_token access-1`,
    ],
  });
});

test("a late refusal of one attempt leaves a newer attempt as it is", async () => {
  let answer: () => void = () => {};
  const { secret } = vault({
    granted: "zone.read workers-scripts.write offline_access",
    held: new Promise<void>((resolve) => (answer = resolve)),
  });
  const first = await begun(secret, CONNECT);
  const late = secret.completeOAuth(PATH, { code: "the-code", nonce: first.nonce, by: member });
  // while the provider answers the first, a member begins again
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await begun(secret, CONNECT);
  answer();
  expect(await late).toEqual(refused(first.nonce, /workers-scripts\.write/));
  expect(await result(secret, second.nonce)).toEqual({ status: "pending" });
});

test("the ceiling's words: none named, one beyond, all within", () => {
  expect([
    grantRefusal(undefined, WITHIN),
    grantRefusal("", WITHIN),
    grantRefusal("zone.read,workers-scripts.write", WITHIN),
    grantRefusal("zone.read offline_access", WITHIN),
  ]).toEqual([
    expect.stringContaining("did not say which permissions"),
    expect.stringContaining("did not say which permissions"),
    expect.stringContaining(": workers-scripts.write."),
    undefined,
  ]);
});

/** What the vault answers for a grant that it refused, and the fact that goes with it. */
function refused(nonce: string, words: RegExp, revoked = false) {
  return {
    refused: { code: "FORBIDDEN", message: expect.stringMatching(words) },
    facts: [
      {
        path: PATH,
        events: [
          {
            type: "events.iterate.com/secret/grant-refused",
            payload: { nonce, reason: expect.stringMatching(words), revoked },
          },
        ],
      },
    ],
  };
}

/** One use of the grant toward the MCP server. */
function useOfTheGrant() {
  return new Request(MCP, {
    method: "POST",
    headers: {
      [SECRET_USE_HEADER]: PATH,
      authorization: `Bearer getSecret("${PATH}", { field: "accessToken" })`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

/** One attempt: its nonce. */
async function begun(secret: SecretDurableObject, options: object) {
  return z
    .object({ result: z.object({ nonce: z.string() }) })
    .parse(await secret.secret(PATH, "beginOAuth", options)).result;
}

/** What the vault says of the attempt `nonce`. */
async function result(secret: SecretDurableObject, nonce: string) {
  const answer = await secret.secret(PATH, "oauthResult", { nonce });
  const wrapped = z.object({ result: z.unknown() }).safeParse(answer);
  return wrapped.success && wrapped.data.result !== undefined ? wrapped.data.result : answer;
}

/** The secret's object of a mind, and what left it: each token request (`<url> <grant>`) and each
 *  account check (`<url> <method> <rpc method> <authorization>`). */
function vault(provider: Provider) {
  const seen: string[] = [];
  let minted = 0;
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === MCP) {
      const rpc = z.object({ method: z.string() }).parse(await request.json());
      seen.push(`${MCP} ${request.method} ${rpc.method} ${request.headers.get("authorization")}`);
      if (provider.checkStatus) return new Response("no", { status: provider.checkStatus });
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(provider.checked, null, 2) }] },
      });
    }
    const form = new URLSearchParams(await request.text());
    const grant = form.get("grant_type") || "";
    if (!grant) {
      seen.push(`${request.url} revoke ${form.get("token_type_hint")} ${form.get("token")}`);
      return new Response(null, { status: 200 });
    }
    seen.push(`${request.url} ${grant}`);
    if (grant === "authorization_code") await provider.held;
    minted += 1;
    const scope = grant === "refresh_token" ? provider.refreshed : provider.granted;
    return Response.json({
      access_token: `access-${minted}`,
      refresh_token: `refresh-${minted}`,
      expires_in: 3600,
      scope,
    });
  });
  const store = new Map<string, unknown>();
  const state = {
    id: { name: PATH },
    exports: {},
    storage: {
      kv: {
        get: (key: string) => structuredClone(store.get(key)),
        put: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
        delete: (key: string) => store.delete(key),
        list: () => [],
      },
    },
  };
  const env = {
    ITERATE: JSON.stringify({
      mindId: "a".repeat(64),
      controlPlaneHostname: "iterate.example.com",
      zones: ["example.com"],
      ownerEmails: ["owner@example.net"],
      topology: "full-cloudflare",
    }),
    ITERATE__AT_REST_KEY: "at-rest-key-for-tests-only",
    ITERATE__CLOUDFLARE_REALTIME: JSON.stringify({
      sfu: { refusal: "Authentication error" },
      turn: { refusal: "Authentication error" },
    }),
    APPROVALS: { getByName: () => ({ add: async () => {}, remove: async () => {} }) },
  };
  // the cast: the object reads only the bindings above
  const secret = new SecretDurableObject(state as never, env as never);
  const current = () =>
    z
      .object({ cell: z.object({ refresh: z.unknown() }) })
      .optional()
      .parse(state.storage.kv.get("current"))?.cell;
  return { secret, current, seen };
}
