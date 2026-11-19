// The default config's Cloudflare connection (core/configs/default/cloudflare.ts): the one link
// of a connect, at Cloudflare's MCP server with the mind as its own client, the calls of
// Cloudflare's REST API through the server's `execute` and of the server's other tools with the
// grant that the vault keeps, and the billing token.
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  accountCheckCode,
  CLIENT_DOCUMENT_PATH,
  cloudflareBilling,
  cloudflareBillingToken,
  cloudflareClientDocument,
  cloudflareConnect,
  cloudflareForAgent,
  cloudflareLastHour,
  cloudflareMcpForAgent,
} from "../../configs/default/cloudflare.ts";
import { CLOUDFLARE_READ_SCOPES } from "./api.ts";
import { callAnswerLink } from "./integrations.ts";

const ACCOUNT = "aaaaabbbbbccccc111112222233333aa";
const BEARER = 'Bearer getSecret("/secrets/cloudflare", { field: "accessToken" })';
const MCP = "https://mcp.cloudflare.com/mcp";

test("the one link is the MCP server's consent page, for the mind as its own client: all reads asked, the vault's two checks named", async () => {
  const mind = mindWith({});

  expect(await cloudflareConnect(mind.itx, { tell: "/agents/onboarding" })).toEqual({
    link: "https://iterate.example.com/secrets/oauth/start?n=1",
    // the attempt's name in the vault, for `itx.secrets.oauthResult`
    nonce: "attempt-1",
  });

  const [begun] = mind.begun;
  expect(begun).toMatchObject({
    path: "/secrets/cloudflare",
    options: {
      authorizationEndpoint: "https://mcp.cloudflare.com/authorize",
      tokenEndpoint: "https://mcp.cloudflare.com/token",
      // the client id is the URL of the mind's own document: no client in the account
      clientId: `https://example.com${CLIENT_DOCUMENT_PATH}`,
      // a public client: no client authentication at the token endpoint
      clientAuth: "none",
      scope: `${CLOUDFLARE_READ_SCOPES.join(" ")} offline_access`,
      grantedWithin: [...CLOUDFLARE_READ_SCOPES, "user:read", "account:read", "offline_access"],
      account: {
        url: MCP,
        method: "POST",
        id: "result.content.0.text@json.id",
        name: "result.content.0.text@json.name",
      },
      expectAccount: "example.com",
      // the token goes to the MCP server alone
      urls: ["https://mcp.cloudflare.com"],
      // a refused grant goes back to the server (RFC 7009)
      revocationEndpoint: "https://mcp.cloudflare.com/token",
      extra: { resource: MCP },
      straightToProvider: true,
      // the consent brings the member back to the chat of the agent that asked
      next: "https://dash.example.com/?agent=%2Fagents%2Fonboarding",
    },
  });
  expect(Object.keys(begun?.options || {})).not.toContain("clientSecret");
  // the account check is one call of the server's `execute`, with the code that names the zone
  expect(
    z.object({ account: z.object({ body: z.unknown() }) }).parse(begun?.options).account,
  ).toMatchObject({
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "execute",
        arguments: { code: accountCheckCode("example.com"), truncate: false },
      },
    },
  });
  // the agent to tell is kept for this attempt alone
  expect(JSON.parse(mind.kv["cloudflare/connect-tell"] || "")).toMatchObject([
    { nonce: "attempt-1", agent: "/agents/onboarding" },
  ]);

  // a connect that no agent asked for comes back to the page with the card, tells nobody, and
  // leaves the first attempt's note as it is
  await cloudflareConnect(mind.itx);
  expect(mind.begun[1]?.options.next).toBe("https://dash.example.com/?page=integrations");
  expect(JSON.parse(mind.kv["cloudflare/connect-tell"] || "")).toMatchObject([
    { nonce: "attempt-1" },
  ]);
  await expect(cloudflareConnect(mind.itx, { tell: "/secrets/cloudflare" })).rejects.toThrow(
    "tell is the path of an agent",
  );
});

test("the account check names the zone only for a grant of exactly one account, the one that holds the zone", async () => {
  const run = (accounts: { id: string; name: string }[], zones: unknown[]) =>
    runInNewContext(`(${accountCheckCode("example.com")})()`, {
      cloudflare: {
        request: async ({ path }: { path: string }) => ({
          result: path.startsWith("/accounts") ? accounts : zones,
        }),
      },
    });
  const ada = { id: ACCOUNT, name: "Ada's account" };
  const zone = { name: "example.com", account: { id: ACCOUNT } };
  expect([
    await run([ada], [zone]),
    await run([ada, { id: "b".repeat(32), name: "Bea's" }], [zone]),
    await run([ada], []),
    await run([{ id: "b".repeat(32), name: "Bea's" }], [zone]),
    await run([ada], [{ name: "example.com.evil.net", account: { id: ACCOUNT } }]),
  ]).toEqual([
    { id: "example.com", name: "Ada's account" },
    { accounts: 2 },
    { accounts: 1 },
    { accounts: 1 },
    { accounts: 1 },
  ]);
});

test("the client document: public, its own URL as the client id, the vault's callback its one redirect", async () => {
  const mind = mindWith({});
  const answer = await cloudflareClientDocument(mind.itx, "https://example.com");
  expect(await answer.json()).toEqual({
    client_id: "https://example.com/cloudflare-mcp-client.json",
    client_name: "iterate mind example.com",
    client_uri: "https://example.com",
    redirect_uris: ["https://iterate.example.com/secrets/oauth/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

test("a request goes to the MCP server as one call of execute, with the grant as a placeholder, never a value", async () => {
  const mind = mindWith({ grant: true });
  await cloudflareForAgent(mind.itx, "execute", { path: "/zones" });
  expect(mind).toMatchObject({
    mcp: [
      {
        authorization: BEARER,
        accept: "application/json, text/event-stream",
        redirect: "manual",
        tool: "execute",
        truncate: false,
      },
    ],
  });
  // a token that the server refuses: its status, as it is
  const refused = mindWith({ grant: true }, undefined, 401);
  expect(await cloudflareForAgent(refused.itx, "execute", { path: "/zones" })).toEqual({
    status: 401,
    body: "invalid_token",
  });
});

test("the Cloudflare card's Connect answers a link that the Dash follows: the vault's start page, on the control plane", async () => {
  expect(
    callAnswerLink(await cloudflareConnect(mindWith({}).itx), "iterate.example.com"),
  ).toMatchObject({ follow: expect.any(URL) });
});

test("execute is one request to Cloudflare's REST API, with the grant's token as a placeholder, never a value", async () => {
  const mind = mindWith({ grant: true });

  expect(
    await cloudflareForAgent(mind.itx, "execute", {
      method: "post",
      path: `/accounts/${ACCOUNT}/workers/observability/telemetry/query`,
      body: { view: "events" },
    }),
  ).toEqual({ status: 200, body: { success: true, result: [] } });

  expect(mind).toMatchObject({
    sent: [
      {
        method: "POST",
        url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`,
        authorization: BEARER,
        body: '{"view":"events"}',
        redirect: "manual",
        via: "execute",
      },
    ],
  });
});

test("whoami says who consented, which account holds the mind, and how the mind's own Workers are named", async () => {
  const mind = mindWith({ grant: true }, cloudflareOfTheMind);

  expect(await cloudflareForAgent(mind.itx, "whoami")).toEqual({
    status: 200,
    user: "ada@example.org",
    account: { id: ACCOUNT, name: "Ada's account" },
    zone: "example.com",
    workers: "iterate-example-com-",
  });
  expect(
    mind.sent.map(({ method, url, authorization }) => ({ method, url, authorization })),
  ).toEqual(
    [
      "https://api.cloudflare.com/client/v4/zones?name=example.com&per_page=1",
      "https://api.cloudflare.com/client/v4/user",
      "https://api.cloudflare.com/client/v4/zones/zone-1/workers/routes",
    ].map((url) => ({ method: "GET", url, authorization: BEARER })),
  );
});

test("whoami keeps Cloudflare's words when Cloudflare refuses, and says so when the grant is of another account", async () => {
  const refusing = mindWith(
    { grant: true },
    () => new Response("Authentication error", { status: 403 }),
  );
  expect(await cloudflareForAgent(refusing.itx, "whoami")).toEqual({
    status: 403,
    body: "Cloudflare answered 403 to the grant: Cloudflare API error: GET /zones?name=example.com&per_page=1 returned HTTP 403: Authentication error",
  });
  // Cloudflare answers, and the grant does not list the mind's zone
  const another = mindWith({ grant: true }, () => Response.json({ result: [] }));
  expect(await cloudflareForAgent(another.itx, "whoami")).toEqual({
    status: 200,
    body: expect.stringContaining(
      "The consent does not reach the Cloudflare account that holds example.com",
    ),
  });
});

test("a long answer comes cut, and Cloudflare's refusal comes with its status and its words", async () => {
  const long = mindWith({ grant: true }, () => Response.json({ result: "x".repeat(30_000) }));
  expect(await cloudflareForAgent(long.itx, "execute", { path: "/zones" })).toMatchObject({
    status: 200,
    cut: true,
    text: expect.stringMatching(/^\{"result":"x{23989}…\(cut: ask for less/),
  });
  const plain = mindWith({ grant: true }, () => new Response("no", { status: 403 }));
  expect(await cloudflareForAgent(plain.itx, "execute", { path: "/zones" })).toEqual({
    status: 403,
    body: "Cloudflare API error: GET /zones returned HTTP 403: no",
  });
});

test("a mind that is not connected says so and how to connect, and sends nothing", async () => {
  const mind = mindWith({ grant: false });
  const words =
    "This mind is not connected to Cloudflare: /secrets/cloudflare is not set. Call itx.config.cloudflareConnect()";

  await expect(cloudflareForAgent(mind.itx, "whoami")).rejects.toThrow(words);
  await expect(cloudflareMcpForAgent(mind.itx, "whoami")).rejects.toThrow(words);
  await expect(cloudflareLastHour(mind.itx)).rejects.toThrow(words);

  expect(mind).toMatchObject({ sent: [], dialed: [] });
});

test.for([
  ["search", {}, 'itx.config.cloudflareMcp("search"'],
  ["docs", { query: "workers" }, 'itx.config.cloudflareMcp("docs"'],
  ["deploy", {}, 'the tool is "execute"'],
  ["execute", { code: "async () => 1" }, "execute takes { method, path, body }"],
  ["execute", { path: "accounts" }, "starts with a slash"],
  ["execute", { path: "//evil.example/x" }, "starts with a slash"],
  ["execute", { path: "/accounts/../user" }, "starts with a slash"],
  ["execute", { path: "/zones", method: "TRACE" }, "the method is GET"],
] as const)(
  "a call that is no request of the API is refused, and sends nothing: %s %j",
  async ([tool, args, says]) => {
    const mind = mindWith({ grant: true });
    await expect(cloudflareForAgent(mind.itx, tool, args)).rejects.toThrow(says);
    expect(mind).toMatchObject({ sent: [] });
  },
);

test("a tool of Cloudflare's MCP server is called with the same grant as a placeholder, and the session is closed", async () => {
  const mind = mindWith({ grant: true });

  expect(await cloudflareMcpForAgent(mind.itx, "search", { code: "async () => 1" })).toEqual({
    answered: "search",
  });

  expect(mind).toMatchObject({
    dialed: [
      {
        url: "https://mcp.cloudflare.com/mcp",
        headers: { authorization: BEARER },
        called: [["search", { code: "async () => 1" }]],
        closed: true,
      },
    ],
  });
});

test("the last hour of the mind's own Workers: who is connected, each Worker's requests by outcome, and the newest errors", async () => {
  const mind = mindWith({ grant: true }, async (request) => {
    if (!request.url.endsWith("/telemetry/query")) return cloudflareOfTheMind(request);
    const asked = JSON.parse(await request.text());
    // both queries name the mind's own Workers alone, and the last hour
    expect(asked.parameters.filters[0]).toEqual({
      key: "$metadata.service",
      operation: "includes",
      type: "string",
      value: "iterate-example-com-",
    });
    expect(asked.timeframe.to - asked.timeframe.from).toBe(3_600_000);
    return Response.json({
      result:
        asked.view === "calculations"
          ? {
              calculations: [
                {
                  aggregates: [
                    {
                      value: 41,
                      groups: [
                        { key: "$metadata.service", value: "iterate-example-com-boundary" },
                        { key: "$workers.outcome", value: "ok" },
                      ],
                    },
                  ],
                },
              ],
            }
          : {
              events: {
                events: [
                  {
                    timestamp: Date.parse("2026-11-18T20:00:00Z"),
                    $metadata: { service: "iterate-example-com-mind", message: "it broke" },
                  },
                ],
              },
            },
    });
  });

  expect(await cloudflareLastHour(mind.itx)).toEqual({
    connectedAs: "ada@example.org",
    account: "Ada's account",
    workers: "iterate-example-com-*",
    requests: [{ worker: "iterate-example-com-boundary", outcome: "ok", count: 41 }],
    errors: [
      { at: "2026-11-18T20:00:00.000Z", worker: "iterate-example-com-mind", said: "it broke" },
    ],
  });
  expect(
    mind.sent
      .filter(({ url }) => url.endsWith("/telemetry/query"))
      .map(({ method, url }) => url + method),
  ).toEqual(
    Array.from(
      { length: 2 },
      () =>
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/queryPOST`,
    ),
  );
});

test("without a billing token, the mind answers the two links a member needs, and collects the token on its own page", async () => {
  const mind = mindWith({ grant: false });

  const answer = await cloudflareBillingToken(mind.itx);

  expect(answer).toMatchObject({ set: false, pasteItAt: "https://iterate.example.com/collect" });
  const form = new URL(answer.set ? "" : answer.makeTheTokenAt);
  expect(form.origin + form.pathname).toBe("https://dash.cloudflare.com/");
  expect(form.searchParams.get("to")).toBe("/:account/api-tokens");
  expect(JSON.parse(form.searchParams.get("permissionGroupKeys") || "")).toEqual([
    { key: "billing", type: "read" },
  ]);
  // the page takes the token for Cloudflare's API alone
  expect(mind).toMatchObject({
    collected: [
      {
        path: "/secrets/cloudflare-billing",
        egress: { urls: ["https://api.cloudflare.com"] },
        description: expect.stringContaining("Billing Read"),
      },
    ],
  });
  expect(await cloudflareBillingToken(mindWith({ billing: true }).itx)).toEqual({ set: true });
});

test("the billing token reads the account's cost and nothing else", async () => {
  const mind = mindWith({ billing: true });
  expect(await cloudflareBilling(mind.itx, ACCOUNT, "billable-usage?from=2026-01-01")).toEqual({
    status: 200,
    body: { success: true, result: [] },
  });
  expect(mind).toMatchObject({
    sent: [
      {
        method: "GET",
        url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/billable-usage?from=2026-01-01`,
        authorization: 'Bearer getSecret("/secrets/cloudflare-billing")',
        body: "",
        redirect: "manual",
      },
    ],
  });
  for (const path of ["billing/history", "billing/credits", "subscriptions"])
    expect(await cloudflareBilling(mind.itx, ACCOUNT, path)).toMatchObject({ status: 200 });

  const refused = mindWith({ billing: true });
  for (const path of [
    "workers/scripts",
    "tokens",
    "billing/../workers/scripts",
    "/billing/history",
    "billing/history#x",
    // a person's name and address
    "billing/profile",
    "billing/profiles",
  ])
    await expect(cloudflareBilling(refused.itx, ACCOUNT, path)).rejects.toThrow("costs alone");
  await expect(cloudflareBilling(refused.itx, "not-an-id", "billing/history")).rejects.toThrow(
    "32-character id",
  );
  await expect(
    cloudflareBilling(mindWith({ billing: false }).itx, ACCOUNT, "billing/history"),
  ).rejects.toThrow("This mind has no billing token");
  expect(refused).toMatchObject({ sent: [] });
});

/** Cloudflare, asked with a grant of the account that holds the mind's zone `example.com`. */
function cloudflareOfTheMind(request: Request) {
  const { pathname } = new URL(request.url);
  if (pathname.endsWith("/user")) return Response.json({ result: { email: "ada@example.org" } });
  if (pathname.endsWith("/workers/routes"))
    return Response.json({
      result: [
        // a route that turns Workers off: Cloudflare answers null for its script
        { pattern: "off.example.com/*", script: null },
        { pattern: "*.example.com/*", script: "iterate-example-com-boundary" },
        { pattern: "example.com/*", script: "iterate-example-com-boundary" },
      ],
    });
  return Response.json({
    result: [{ id: "zone-1", account: { id: ACCOUNT, name: "Ada's account" } }],
  });
}

/** A mind at `iterate.example.com` with the zone `example.com`: what its vault holds, what it
 *  sent to Cloudflare (which answers `answer`), what it dialed, began and asked a person for. */
function mindWith(
  held: { grant?: boolean; billing?: boolean },
  answer: (request: Request) => Response | Promise<Response> = () =>
    Response.json({ success: true, result: [] }),
  /** The MCP server's own status: 401 refuses the token. */
  serverStatus = 200,
) {
  const sent: {
    method: string;
    url: string;
    authorization: string | null;
    body: string;
    redirect: string;
    via?: "execute";
  }[] = [];
  /** Each call of the MCP server's `execute` over HTTP. */
  const mcp: Record<string, unknown>[] = [];
  const dialed: {
    url: string;
    headers: Record<string, string>;
    called: [string, Record<string, unknown> | undefined][];
    closed: boolean;
  }[] = [];
  const begun: { path: string; options: Record<string, unknown> }[] = [];
  const collected: unknown[] = [];
  const kv: Record<string, string> = {};
  const set: Record<string, boolean | undefined> = {
    "/secrets/cloudflare": held.grant,
    "/secrets/cloudflare-billing": held.billing,
  };
  /** Cloudflare's MCP server, as far as `execute` goes: it runs the request that the code names
   *  against Cloudflare (`answer`), and answers what the code returns, as text in the result. */
  async function mcpServer(request: Request) {
    const call = ToolCall.parse(await request.json());
    mcp.push({
      authorization: request.headers.get("authorization"),
      accept: request.headers.get("accept"),
      redirect: request.redirect,
      tool: call.params.name,
      truncate: call.params.arguments.truncate,
    });
    if (serverStatus !== 200) return new Response("invalid_token", { status: serverStatus });
    const named = call.params.arguments.code.match(/cloudflare\.request\((\{.*\})\)/)?.[1];
    const asked = Asked.parse(JSON.parse(named || "{}"));
    const url = `https://api.cloudflare.com/client/v4${asked.path}`;
    const body = asked.body === undefined ? "" : JSON.stringify(asked.body);
    sent.push({
      method: asked.method,
      url,
      authorization: request.headers.get("authorization"),
      body,
      redirect: request.redirect,
      via: "execute",
    });
    const cloudflare = await answer(
      new Request(url, { method: asked.method, body: body || undefined }),
    );
    const text = await cloudflare.text();
    const returned = cloudflare.ok
      ? { status: 200, body: JSON.parse(text) }
      : {
          status: cloudflare.status,
          body: `Cloudflare API error: ${asked.method} ${asked.path} returned HTTP ${cloudflare.status}: ${text}`,
        };
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(returned) }] },
    });
  }
  return {
    sent,
    mcp,
    dialed,
    begun,
    collected,
    kv,
    itx: {
      url: async () => "https://example.com",
      secrets: {
        describe: async (path: string) => ({ path, set: !!set[path] }),
        oauthCallbackUrl: async () => "https://iterate.example.com/secrets/oauth/callback",
        beginOAuth: async (path: string, options: Record<string, unknown>) => {
          begun.push({ path, options });
          return {
            authorizationUrl: `https://iterate.example.com/secrets/oauth/start?n=${begun.length}`,
            nonce: `attempt-${begun.length}`,
          };
        },
        oauthResult: async () => ({ status: "pending" as const }),
        collectFromUser: async (input: unknown) => {
          collected.push(input);
          return { url: "https://iterate.example.com/collect" };
        },
        delete: async () => {},
      },
      kv: {
        get: async (key: string) => kv[key] ?? null,
        put: async (key: string, value: string) => void (kv[key] = value),
        delete: async (key: string) => void delete kv[key],
      },
      fetch: async (request: Request) => {
        if (request.url === MCP) return await mcpServer(request);
        const body = await request.clone().text();
        sent.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
          body,
          redirect: request.redirect,
        });
        return answer(request);
      },
      connectToMcp: async (url: string, options: { headers: Record<string, string> }) => {
        const session = {
          url,
          headers: options.headers,
          called: [] as [string, Record<string, unknown> | undefined][],
          closed: false,
        };
        dialed.push(session);
        return {
          callTool: async (name: string, args?: Record<string, unknown>) => {
            session.called.push([name, args]);
            return { answered: name };
          },
          close: async () => void (session.closed = true),
        };
      },
    },
  };
}

const ToolCall = z.object({
  params: z.object({
    name: z.string(),
    arguments: z.object({ code: z.string(), truncate: z.boolean().optional() }),
  }),
});
const Asked = z.object({ method: z.string(), path: z.string(), body: z.unknown().optional() });
