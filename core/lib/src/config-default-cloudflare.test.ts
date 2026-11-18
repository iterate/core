// The default config's Cloudflare connection (core/configs/default/cloudflare.ts): the call of
// Cloudflare's REST API with the credential that the vault keeps, and the billing token.
import { expect, test } from "vitest";
import {
  cloudflareBilling,
  cloudflareBillingToken,
  cloudflareForAgent,
} from "../../configs/default/cloudflare.ts";

const ACCOUNT = "aaaaabbbbbccccc111112222233333aa";

test("execute is one request to Cloudflare's REST API, with the vault's token as a placeholder, never a value", async () => {
  const mind = mindWith({ set: true });

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
        authorization: 'Bearer getSecret("/secrets/cloudflare", { field: "token" })',
        body: '{"view":"events"}',
        redirect: "manual",
      },
    ],
  });
});

test("a consent that the vault refreshes is sent by its own field, and whoami names the accounts it reaches", async () => {
  const mind = mindWith({ set: true, refresh: "oauth-refresh-token" }, () =>
    Response.json({
      result: [{ id: ACCOUNT, name: "Ada's account", settings: {} }],
      // Cloudflare lists 50 accounts a page: the count says how many there are
      result_info: { page: 1, per_page: 50, count: 1, total_count: 61 },
    }),
  );

  expect(await cloudflareForAgent(mind.itx, "whoami")).toEqual({
    status: 200,
    accounts: [{ id: ACCOUNT, name: "Ada's account" }],
    total: 61,
  });
  expect(mind.sent).toMatchObject([
    {
      method: "GET",
      url: "https://api.cloudflare.com/client/v4/accounts?per_page=50",
      authorization: 'Bearer getSecret("/secrets/cloudflare", { field: "accessToken" })',
    },
  ]);
});

test("whoami keeps Cloudflare's answer when Cloudflare refuses: the status alone reads as a credential of no account", async () => {
  const refusal = { success: false, errors: [{ code: 10000, message: "Authentication error" }] };
  const mind = mindWith({ set: true }, () => Response.json(refusal, { status: 403 }));

  expect(await cloudflareForAgent(mind.itx, "whoami")).toEqual({
    status: 403,
    accounts: [],
    total: 0,
    body: refusal,
  });
});

test("a long answer comes cut, and an answer that is no JSON comes as its text", async () => {
  const long = mindWith({ set: true }, () => new Response("x".repeat(30_000)));
  expect(await cloudflareForAgent(long.itx, "execute", { path: "/zones" })).toMatchObject({
    status: 200,
    cut: true,
    text: expect.stringMatching(/^x{24000}…\(cut: ask for less/),
  });
  const plain = mindWith({ set: true }, () => new Response("no", { status: 403 }));
  expect(await cloudflareForAgent(plain.itx, "execute", { path: "/zones" })).toEqual({
    status: 403,
    body: "no",
  });
});

test("a mind with no credential says so, and sends nothing", async () => {
  const mind = mindWith({ set: false });

  await expect(cloudflareForAgent(mind.itx, "whoami")).rejects.toThrow(
    "This mind has no Cloudflare connection: /secrets/cloudflare is not set.",
  );

  expect(mind).toMatchObject({ sent: [] });
});

test("a request that names a destination path is refused before anything is sent: such a destination sends the account's data away for good", async () => {
  for (const path of [
    `/accounts/${ACCOUNT}/workers/observability/destinations`,
    `/accounts/${ACCOUNT}/alerting/v3/destinations/webhooks`,
    `/accounts/${ACCOUNT}/logpush/jobs`,
  ]) {
    const mind = mindWith({ set: true });
    await expect(cloudflareForAgent(mind.itx, "execute", { method: "POST", path })).rejects.toThrow(
      "makes a lasting export",
    );
    expect(mind).toMatchObject({ sent: [] });
  }
});

test.for([
  ["search", {}, 'has no "search"'],
  ["docs", { query: "workers" }, 'has no "docs"'],
  ["deploy", {}, 'the tool is "execute"'],
  ["execute", { code: "async () => 1" }, "execute takes { method, path, body }"],
  ["execute", { path: "accounts" }, "starts with a slash"],
  ["execute", { path: "//evil.example/x" }, "starts with a slash"],
  ["execute", { path: "/accounts/../user" }, "starts with a slash"],
  ["execute", { path: "/zones", method: "TRACE" }, "the method is GET"],
] as const)(
  "a call that is no request of the API is refused, and sends nothing: %s %j",
  async ([tool, args, says]) => {
    const mind = mindWith({ set: true });
    await expect(cloudflareForAgent(mind.itx, tool, args)).rejects.toThrow(says);
    expect(mind).toMatchObject({ sent: [] });
  },
);

test("without a billing token, the mind answers the two links a member needs, and collects the token on its own page", async () => {
  const mind = mindWith({ set: false });

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
  expect(await cloudflareBillingToken(mindWith({ set: true }).itx)).toEqual({ set: true });
});

test("the billing token reads the account's cost and nothing else", async () => {
  const mind = mindWith({ set: true });
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

  const refused = mindWith({ set: true });
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
    cloudflareBilling(mindWith({ set: false }).itx, ACCOUNT, "billing/history"),
  ).rejects.toThrow("This mind has no billing token");
  expect(refused).toMatchObject({ sent: [] });
});

/** A mind whose vault holds its Cloudflare secrets or not, with what it sent to Cloudflare, which
 *  answers `answer`, and what it asked a person for. */
function mindWith(
  held: { set: boolean; refresh?: string },
  answer: () => Response = () => Response.json({ success: true, result: [] }),
) {
  const sent: {
    method: string;
    url: string;
    authorization: string | null;
    body: string;
    redirect: string;
  }[] = [];
  const collected: unknown[] = [];
  return {
    sent,
    collected,
    itx: {
      secrets: {
        describe: async (path: string) => ({ path, ...held }),
        cloud: async () => null,
        collectFromUser: async (input: unknown) => {
          collected.push(input);
          return { url: "https://iterate.example.com/collect" };
        },
      },
      fetch: async (request: Request) => {
        sent.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.text(),
          redirect: request.redirect,
        });
        return answer();
      },
    },
  };
}
