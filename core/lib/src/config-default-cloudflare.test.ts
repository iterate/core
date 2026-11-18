// The default config's Cloudflare connection (core/configs/default/cloudflare.ts): the one link
// of a connect, by the stack's client or by a member's own, the calls of Cloudflare's REST API
// and of its MCP server with the grant that the vault keeps, and the billing token.
import { expect, test } from "vitest";
import {
  cloudflareBilling,
  cloudflareBillingToken,
  cloudflareConnect,
  cloudflareForAgent,
  cloudflareLastHour,
  cloudflareMcpForAgent,
  OWN_CLIENT_SCOPES,
} from "../../configs/default/cloudflare.ts";
import { CLOUDFLARE_READ_SCOPES } from "./api.ts";

const ACCOUNT = "aaaaabbbbbccccc111112222233333aa";
const BEARER = 'Bearer getSecret("/secrets/cloudflare", { field: "accessToken" })';

test("with the stack's client, the one link is Cloudflare's own consent page, and the mind names no client, scope or secret", async () => {
  const mind = mindWith({ stackClient: true });

  expect(await cloudflareConnect(mind.itx, { tell: "/agents/onboarding" })).toEqual({
    way: "stack-client",
    link: "https://iterate.example.com/secrets/oauth/start?n=1",
  });

  expect(mind).toMatchObject({
    begun: [
      {
        path: "/secrets/cloudflare",
        options: {
          client: { stack: "cloudflare" },
          straightToProvider: true,
          // the consent brings the member back to the chat of the agent that asked
          next: "https://dash.example.com/?agent=%2Fagents%2Fonboarding",
        },
      },
    ],
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

test("with no client of the stack's, the one link is the mind's form for a client that a member makes, and it says how to make it", async () => {
  const mind = mindWith({ stackClient: false });

  const answer = await cloudflareConnect(mind.itx, { tell: "/agents/onboarding" });

  expect(answer).toEqual({
    way: "own-client",
    link: "https://iterate.example.com/collect",
    makeTheClient: {
      where: expect.stringContaining("Manage Account, OAuth clients"),
      name: "iterate",
      redirectUri: "https://iterate.example.com/secrets/oauth/callback",
      grantTypes: ["authorization_code", "refresh_token"],
      tokenEndpointAuthMethod: "client_secret_post",
      scopes: Object.values(OWN_CLIENT_SCOPES),
    },
  });
  expect(mind).toMatchObject({ begun: [] });
  expect(mind).toMatchObject({
    collected: [
      {
        path: "/secrets/cloudflare-client",
        // the client's secret goes to Cloudflare's token endpoint, for the grant's refresh alone
        egress: { urls: ["https://dash.cloudflare.com"] },
        lendTo: ["/secrets/cloudflare"],
        description: expect.stringContaining(
          "Redirect URI: `https://iterate.example.com/secrets/oauth/callback`",
        ),
        fields: [
          { name: "clientId", label: "Client ID", public: true },
          { name: "clientSecret", label: "Client secret" },
        ],
        // the form leads on to the consent page, and keeps the agent that asked
        redirectUrl: "https://dash.example.com/connect/cloudflare?tell=%2Fagents%2Fonboarding",
      },
    ],
  });
});

test("a client that a member made is what the consent goes through: its secret as a placeholder, read scopes alone", async () => {
  const mind = mindWith({ stackClient: false, ownClient: "a-member-made-client" });

  expect(await cloudflareConnect(mind.itx)).toEqual({
    way: "own-client",
    link: "https://iterate.example.com/secrets/oauth/start?n=1",
  });

  expect(mind).toMatchObject({ collected: [] });
  expect(mind).toMatchObject({
    begun: [
      {
        path: "/secrets/cloudflare",
        options: {
          authorizationEndpoint: "https://dash.cloudflare.com/oauth2/auth",
          tokenEndpoint: "https://dash.cloudflare.com/oauth2/token",
          clientId: "a-member-made-client",
          clientSecret: 'getSecret("/secrets/cloudflare-client", { field: "clientSecret" })',
          clientAuth: "client_secret_post",
          scope: `${Object.keys(OWN_CLIENT_SCOPES).join(" ")} offline_access`,
          urls: [
            "https://dash.cloudflare.com",
            "https://api.cloudflare.com",
            "https://mcp.cloudflare.com",
          ],
          straightToProvider: true,
          next: "https://dash.example.com/?page=integrations",
        },
      },
    ],
  });
  // what a member ticks is within what the stack's own client may read
  const read: readonly string[] = CLOUDFLARE_READ_SCOPES;
  expect(Object.keys(OWN_CLIENT_SCOPES).filter((scope) => !read.includes(scope))).toEqual([]);
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
    body: "Cloudflare answered 403 to the grant: Authentication error",
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

test("a long answer comes cut, and an answer that is no JSON comes as its text", async () => {
  const long = mindWith({ grant: true }, () => new Response("x".repeat(30_000)));
  expect(await cloudflareForAgent(long.itx, "execute", { path: "/zones" })).toMatchObject({
    status: 200,
    cut: true,
    text: expect.stringMatching(/^x{24000}…\(cut: ask for less/),
  });
  const plain = mindWith({ grant: true }, () => new Response("no", { status: 403 }));
  expect(await cloudflareForAgent(plain.itx, "execute", { path: "/zones" })).toEqual({
    status: 403,
    body: "no",
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
  held: { grant?: boolean; billing?: boolean; stackClient?: boolean; ownClient?: string },
  answer: (request: Request) => Response | Promise<Response> = () =>
    Response.json({ success: true, result: [] }),
) {
  const sent: {
    method: string;
    url: string;
    authorization: string | null;
    body: string;
    redirect: string;
  }[] = [];
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
    "/secrets/cloudflare-client": !!held.ownClient,
  };
  return {
    sent,
    dialed,
    begun,
    collected,
    kv,
    itx: {
      url: async () => "https://example.com",
      secrets: {
        describe: async (path: string) => ({
          path,
          set: !!set[path],
          ...(path === "/secrets/cloudflare-client" &&
            held.ownClient && { public: { clientId: held.ownClient } }),
        }),
        hasStackClient: async () => !!held.stackClient,
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
