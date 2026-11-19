import { timingSafeEqual } from "node:crypto";
import { CLOUDFLARE_READ_SCOPES } from "iterate/api";
import { SECRET_USE_HEADER, VAULT_ANSWER_HEADER } from "iterate/secret-placeholder";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { secretsConfigOf } from "./config.ts";
import { SecretDurableObject } from "./secret/durable-object.ts";
import { hasCloudflareClient, stackClientFor } from "./stack-client.ts";

// workerd's own comparison, which Node's Web Crypto has not got
Object.assign(crypto.subtle, { timingSafeEqual });

const PATH = "/secrets/cloudflare";
const CLIENT = { clientId: "the-stack-client", clientSecret: "the-stack-client-secret" };
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const member = { userId: "user_aaaa", email: "member@example.com", member: true };
/** The Cloudflare account that the stack runs in. */
const ACCOUNT = "0".repeat(32);
const OTHER = "f".repeat(32);
/** What the stack's Cloudflare answers a new grant: the scopes that it says it granted, the
 *  accounts that it lists for the grant's token, those that a read of reaches, or a failed list. */
type Cloudflare = { granted?: string; listed?: string[]; reached?: string[]; listStatus?: number };

test("a connect through the stack's client: Cloudflare's own consent page, the read scopes, and no secret in the attempt", async () => {
  const { secret, state } = stack(CLIENT);
  const { url, target } = await begun(secret, { straightToProvider: true });
  expect({
    page: url.origin + url.pathname,
    client: url.searchParams.get("client_id"),
    redirect: url.searchParams.get("redirect_uri"),
    challenge: url.searchParams.get("code_challenge_method"),
    scopes: url.searchParams.get("scope")?.split(" ").toSorted(),
    pin: target?.urls,
    straight: target?.straightToProvider,
  }).toEqual({
    page: "https://dash.cloudflare.com/oauth2/auth",
    client: CLIENT.clientId,
    redirect: "https://iterate.example.com/secrets/oauth/callback",
    challenge: "S256",
    scopes: [...CLOUDFLARE_READ_SCOPES, "offline_access"].toSorted(),
    pin: ["https://api.cloudflare.com", "https://mcp.cloudflare.com"],
    straight: true,
  });
  expect(JSON.stringify(state.storage.kv.get("pending"))).not.toContain(CLIENT.clientSecret);
});

test("the code's exchange and each refresh go to Cloudflare's token endpoint with the client's secret, and the token goes to the API alone", async () => {
  const { secret, state, seen, checks } = stack(CLIENT);
  const { nonce } = await begun(secret, {});
  vi.useFakeTimers({ toFake: ["Date"] });
  const completed = await secret.completeOAuth(PATH, { code: "the-code", nonce, by: member });
  const use = (url: string, field = "accessToken") =>
    secret.fetch(
      new Request(url, {
        headers: {
          [SECRET_USE_HEADER]: PATH,
          authorization: `Bearer getSecret("${PATH}", { field: "${field}" })`,
        },
      }),
    );
  const first = await use("https://api.cloudflare.com/client/v4/user");
  // not to the token endpoint's host, and never the fields that the refresh reads
  const elsewhere = await use("https://dash.cloudflare.com/oauth2/userinfo");
  const named = await use("https://api.cloudflare.com/client/v4/user", "clientSecret");
  // Cloudflare's token ends after an hour: the next use refreshes it first
  vi.setSystemTime(Date.now() + 61 * 60_000);
  const later = await use("https://mcp.cloudflare.com/mcp");
  vi.useRealTimers();

  expect({
    scopes: completed.result.scopes,
    described: await secret.secret(PATH, "describe", undefined),
    refresh: z
      .object({ cell: z.object({ refresh: z.unknown() }) })
      .parse(state.storage.kv.get("current")).cell.refresh,
    statuses: [first.status, elsewhere.status, named.status, later.status],
    checks,
    refusals: [elsewhere, named].map((answer) => answer.headers.get(VAULT_ANSWER_HEADER)),
    seen,
  }).toEqual({
    scopes: ["zone.read", "offline_access"],
    described: expect.objectContaining({
      set: true,
      urls: ["https://api.cloudflare.com", "https://mcp.cloudflare.com"],
      refresh: "oauth-refresh-token",
    }),
    refresh: {
      kind: "oauth-refresh-token",
      tokenEndpoint: TOKEN_ENDPOINT,
      clientAuth: "client_secret_post",
      client: { stack: "cloudflare" },
    },
    statuses: [200, 403, 403, 200],
    // before the grant was kept: the accounts it reaches, read with its own new token
    checks: [
      "/client/v4/accounts Bearer access-1",
      `/client/v4/accounts/${ACCOUNT}/d1/database Bearer access-1`,
    ],
    refusals: ["refused", "refused"],
    seen: [
      {
        url: TOKEN_ENDPOINT,
        grant: "authorization_code",
        client: CLIENT.clientId,
        secret: CLIENT.clientSecret,
        token: "the-code",
      },
      { url: "https://api.cloudflare.com/client/v4/user", authorization: "Bearer access-1" },
      {
        url: TOKEN_ENDPOINT,
        grant: "refresh_token",
        client: CLIENT.clientId,
        secret: CLIENT.clientSecret,
        token: "refresh-1",
      },
      { url: "https://mcp.cloudflare.com/mcp", authorization: "Bearer access-2" },
    ],
  });
});

test.for<[string, object, RegExp]>([
  [
    "a write",
    { scope: "zone.read workers-scripts.write" },
    /workers-scripts\.write is not in its scopes/,
  ],
  ["a read outside the list", { scope: "d1.read" }, /d1\.read is not in its scopes/],
  ["a parameter of the authorize URL", { extra: { prompt: "none" } }, /takes no extra parameters/],
  ["a lend to another secret", { lendTo: ["/secrets/other"] }, /lendTo is not for the caller/],
  ["a use of its own", { operations: ["signHmac"] }, /operations is not for the caller/],
  ["a placement", { placement: "url" }, /placement is not for the caller/],
  ["scopes as a list", { scope: ["zone.read", "d1.read"] }, /scope is one string/],
  ["a pin of the caller's", { urls: ["https://example.net"] }, /urls is the stack's to say/],
  ["a client secret of the caller's", { clientSecret: "x" }, /clientSecret is the stack's to say/],
  [
    "a token endpoint of the caller's",
    { tokenEndpoint: "https://example.net/t" },
    /tokenEndpoint is the stack's to say/,
  ],
])(
  "a connect through the stack's client that names %s is refused, and no attempt is kept",
  async ([, options, words]) => {
    const { secret, state } = stack(CLIENT);
    await expect(
      secret.secret(PATH, "beginOAuth", { client: { stack: "cloudflare" }, ...options }),
    ).rejects.toThrow(words);
    expect(state.storage.kv.get("pending")).toBeUndefined();
  },
);

test("a client that names a Cloud and the stack at once is refused: the stack's secret goes to Cloudflare alone", async () => {
  const { secret, state, seen } = stack(CLIENT);
  // a Cloud that the caller names, which publishes a client with its own broker
  vi.stubGlobal("fetch", async (input: Request | string) => {
    const { origin } = new URL(new Request(input).url);
    seen.push({ url: new Request(input).url });
    return Response.json({
      clients: {
        github: {
          clientId: "theirs",
          authorizationEndpoint: "https://provider.example/authorize",
          redirectUri: `${origin}/clients/github/callback`,
          tokenEndpoint: `${origin}/clients/github/token`,
          urls: ["https://provider.example"],
        },
      },
    });
  });
  await expect(
    secret.secret(PATH, "beginOAuth", {
      client: { stack: "cloudflare", cloud: "github", origin: "https://cloud.example.com" },
    }),
  ).rejects.toThrow("never both");
  expect(state.storage.kv.get("pending")).toBeUndefined();
});

test("a stack whose deploy made no client refuses the connect with Cloudflare's words, and says what a member does", async () => {
  const { secret, config } = stack({ refusal: "Authentication error" });
  expect(hasCloudflareClient(config.cloudflareClient)).toBe(false);
  await expect(
    secret.secret(PATH, "beginOAuth", { client: { stack: "cloudflare" } }),
  ).rejects.toThrow(
    /this stack has no OAuth client at Cloudflare.*Cloudflare said: Authentication error.*a member makes a client/,
  );
});

test("the scopes of a connect: every read when none is named, the named ones else, and always the refresh", () => {
  const { cloudflareClient } = stack(CLIENT).config;
  const scopeOf = (scope?: string) =>
    stackClientFor(cloudflareClient, { stack: "cloudflare" }, { scope }).scope.split(" ");
  expect(hasCloudflareClient(cloudflareClient)).toBe(true);
  expect(scopeOf()).toEqual([...CLOUDFLARE_READ_SCOPES, "offline_access"]);
  expect(scopeOf("zone.read  workers-observability.read")).toEqual([
    "zone.read",
    "workers-observability.read",
    "offline_access",
  ]);
  expect(() => stackClientFor(cloudflareClient, { stack: "github" }, {})).toThrow(
    'client.stack is "cloudflare"',
  );
});

test.for<[string, Cloudflare, RegExp]>([
  [
    "a scope outside the list",
    { granted: "zone.read workers-scripts.write offline_access" },
    /Cloudflare granted more than this mind asks for \(workers-scripts\.write\)/,
  ],
  [
    "a second account",
    { listed: [ACCOUNT, OTHER], reached: [ACCOUNT, OTHER] },
    /reaches 2 Cloudflare accounts, and this mind may read only its own/,
  ],
  [
    "another account alone",
    { listed: [OTHER], reached: [OTHER] },
    /does not reach the Cloudflare account that holds this mind/,
  ],
  [
    "no answer to which accounts",
    { listStatus: 403 },
    /did not say which accounts the consent reaches \(it answered 403\)/,
  ],
])(
  "a grant through the stack's client with %s is refused before anything is stored, and says what to do",
  async ([, cloudflare, words]) => {
    const { secret, state } = stack(CLIENT, cloudflare);
    const { nonce } = await begun(secret, {});
    const refused = secret.completeOAuth(PATH, { code: "the-code", nonce, by: member });
    await expect(refused).rejects.toThrow(words);
    await expect(refused).rejects.toThrow(
      "Nothing was kept. Connect again, and on Cloudflare's page select only the account that holds this mind.",
    );
    expect(state.storage.kv.get("current")).toBeUndefined();
    expect(await secret.secret(PATH, "describe", undefined)).toMatchObject({ set: false });
    // the attempt says why, for the code that asked
    expect(await secret.secret(PATH, "oauthResult", { nonce })).toMatchObject({
      status: "failed",
      error: expect.stringMatching(words),
    });
  },
);

test("an account that Cloudflare lists for the grant but the consent did not cover is no account of the grant", async () => {
  const { secret, state } = stack(CLIENT, { listed: [OTHER, ACCOUNT], reached: [ACCOUNT] });
  const { nonce } = await begun(secret, {});
  await secret.completeOAuth(PATH, { code: "the-code", nonce, by: member });
  expect(state.storage.kv.get("current")).toBeDefined();
});

/** One attempt through the stack's client: its nonce, and where the start link sends a browser. */
async function begun(secret: SecretDurableObject, options: object) {
  const { nonce } = z
    .object({ result: z.object({ nonce: z.string() }) })
    .parse(
      await secret.secret(PATH, "beginOAuth", { client: { stack: "cloudflare" }, ...options }),
    ).result;
  const target = await secret.oauthStartTarget(PATH, { nonce });
  return { nonce, target, url: new URL(target?.authorizationUrl || "about:blank") };
}

/** The secret's object of a stack whose config holds `cloudflareClient`, and what left it: each
 *  request to Cloudflare, with the fields of a token request that say who asks and for what. */
function stack(cloudflareClient: object, cloudflare: Cloudflare = {}) {
  const seen: Record<string, string | null>[] = [];
  /** The vault's reads of the accounts that a new grant reaches, with the grant's token. */
  const checks: string[] = [];
  let minted = 0;
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/client/v4/accounts")) {
      checks.push(`${pathname} ${request.headers.get("authorization")}`);
      const listed = cloudflare.listed || [ACCOUNT];
      if (pathname === "/client/v4/accounts")
        return cloudflare.listStatus
          ? new Response("no", { status: cloudflare.listStatus })
          : Response.json({ result: listed.map((id) => ({ id, name: id })) });
      const reached = (cloudflare.reached || [ACCOUNT]).includes(pathname.split("/")[4] || "");
      return Response.json({ result: [] }, { status: reached ? 200 : 403 });
    }
    if (request.url !== TOKEN_ENDPOINT) {
      seen.push({ url: request.url, authorization: request.headers.get("authorization") });
      return new Response("{}");
    }
    const form = new URLSearchParams(await request.text());
    seen.push({
      url: request.url,
      grant: form.get("grant_type"),
      client: form.get("client_id"),
      secret: form.get("client_secret"),
      token: form.get("code") || form.get("refresh_token"),
    });
    minted += 1;
    return Response.json({
      access_token: `access-${minted}`,
      refresh_token: `refresh-${minted}`,
      expires_in: 3600,
      scope: cloudflare.granted || "zone.read offline_access",
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
    ITERATE__CLOUDFLARE_CLIENT: JSON.stringify(cloudflareClient),
    ITERATE__CLOUDFLARE_REALTIME: JSON.stringify({
      sfu: { refusal: "Authentication error" },
      turn: { refusal: "Authentication error" },
    }),
    ITERATE__CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    APPROVALS: { getByName: () => ({ add: async () => {}, remove: async () => {} }) },
  };
  return {
    // the cast: the object reads only the bindings above
    secret: new SecretDurableObject(state as never, env as never),
    state,
    seen,
    checks,
    config: secretsConfigOf(env),
  };
}
