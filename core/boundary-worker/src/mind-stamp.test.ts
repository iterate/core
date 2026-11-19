// A MIND'S SIGNED REQUEST AT THE BOUNDARY (./stamp.ts `mindStamped`): checked by the auth Worker,
// stamped as that mind or answered by the boundary itself, and its statement never reaches the
// mind's code. The auth Worker is a stand-in that records what it is asked.
import type { AuthService } from "iterate/workers";
import { expect, test, vi } from "vitest";
import { mindHostResponse } from "./host-session.ts";
import { stampedRequest } from "./stamp.ts";

const config = {
  mindId: "a".repeat(64),
  controlPlaneHostname: "iterate.mind.example",
  zones: ["mind.example"],
  ownerEmails: ["ada@elsewhere.example"],
  topology: "full-cloudflare" as const,
};
const URL_ASKED = "https://proxy.mind.example/api.openai.com/v1/responses?x=1";
const MIND = { actor: "b".repeat(64), kind: "mind", hostname: "iterate.sender.example" };
/** A cause as it leaves another stack (iterate/lib `causeLeavingTheStack`). */
const CAUSE = JSON.stringify({
  chain: "2026-11-19T00:00:00.000Z with another stack ~n1",
  depth: 3,
});

test("a good statement: the mind is stamped in x-itx-mind by the URL and method as they arrived, the statement and every caller's x-itx header are dropped, no member, no person and no grant", async () => {
  const { auth, asked } = authAnswering({ principal: MIND, expiresAt: 1_900_000_000 });
  const stamped = await stampedRequest(
    signed({ "x-itx-principal": '{"actor":"user_9"}', "x-itx-grant": "g", "x-itx-person": "{}" }),
    { auth, route: null, config },
  );
  expect(asked).toMatchObject({
    checks: [{ statement: expect.any(String), method: "POST", url: URL_ASKED }],
  });
  expect(stamped).toMatchObject({ caller: "anonymous", email: null, byMind: true });
  expect(stamped.answer).toBeUndefined();
  const forwarded = Object.fromEntries(stamped.forwarded.headers);
  expect(forwarded).toMatchObject({
    "x-itx-mind": JSON.stringify(MIND),
    "x-itx-expires": "1900000000",
  });
  // a reader that knows only x-itx-principal sees nobody
  expect(
    Object.keys(forwarded)
      .filter((name) => name.startsWith("x-itx-"))
      .sort(),
  ).toEqual(["x-itx-expires", "x-itx-mind"]);
  expect(forwarded).not.toHaveProperty("iterate-auth-statement");
});

test("a good statement beside a member's session and a bearer: the statement decides alone, no session and no bearer is read or reaches the app; the app's own cookies and the cause pass", async () => {
  const { auth, asked } = authAnswering({ principal: MIND, expiresAt: 1_900_000_000 });
  const stamped = await stampedRequest(
    signed({
      cookie: "__Host-iterate-session=member-token; app=kept",
      authorization: "Bearer ours",
      // the sender's cause reaches the mind's kernel, which reads it at ingress
      "x-iterate-cause": CAUSE,
    }),
    { auth, route: null, config },
  );
  const forwarded = Object.fromEntries(stamped.forwarded.headers);
  expect(forwarded).toMatchObject({
    cookie: "app=kept",
    "x-itx-mind": JSON.stringify(MIND),
    "x-iterate-cause": CAUSE,
  });
  for (const name of ["authorization", "x-itx-principal", "x-itx-person", "x-itx-grant"])
    expect(forwarded).not.toHaveProperty(name);
  // neither the session nor the bearer is asked about
  expect(asked).toMatchObject({ whoIs: [] });
});

test("the same statement, method and URL again is stamped from memory with no call to the auth Worker, and never past the statement's end", async () => {
  const now = Date.now();
  const { auth, asked } = authAnswering({
    principal: MIND,
    expiresAt: Math.floor((now + 60_000) / 1000),
  });
  const statement = crypto.randomUUID();
  const twice = [];
  for (let use = 0; use < 2; use += 1)
    twice.push(
      await stampedRequest(signed({ "iterate-auth-statement": statement }), {
        auth,
        route: null,
        config,
      }),
    );
  expect(twice.map((each) => each.forwarded.headers.get("x-itx-mind"))).toEqual([
    JSON.stringify(MIND),
    JSON.stringify(MIND),
  ]);
  expect(asked.checks).toHaveLength(1);
  // another method by the same statement is asked about again
  await stampedRequest(signed({ "iterate-auth-statement": statement }, { method: "PUT" }), {
    auth,
    route: null,
    config,
  });
  expect(asked.checks).toHaveLength(2);
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
  try {
    await stampedRequest(signed({ "iterate-auth-statement": statement }), {
      auth,
      route: null,
      config,
    });
  } finally {
    clock.mockRestore();
  }
  expect(asked.checks).toHaveLength(3);
});

test("a statement longer than any receiver reads is refused with no call, and one that ends during its check stamps nobody", async () => {
  const { auth, asked } = authAnswering({ principal: MIND, expiresAt: 1_900_000_000 });
  const long = await stampedRequest(
    signed({ "iterate-auth-statement": "x".repeat(16 * 1024 + 1) }),
    {
      auth,
      route: null,
      config,
    },
  );
  expect(long.answer).toMatchObject({ status: 401 });
  expect(asked.checks).toHaveLength(0);
  // the check answers a stamp whose end has passed by the time it returns
  const ended = authAnswering({ principal: MIND, expiresAt: Math.floor(Date.now() / 1000) - 1 });
  const late = await stampedRequest(signed({ "iterate-auth-statement": crypto.randomUUID() }), {
    auth: ended.auth,
    route: null,
    config,
  });
  expect(late.answer).toMatchObject({ status: 401 });
});

test("a refused or unchecked statement hands on no request with the statement or a caller's stamp", async () => {
  for (const answer of [{ refused: "the statement is for another URL" }, new Error("D1 is down")]) {
    const { auth } = authAnswering(answer);
    const stamped = await stampedRequest(signed({ "x-itx-mind": '{"actor":"forged"}' }), {
      auth,
      route: null,
      config,
    });
    expect(stamped.answer?.status).toBeGreaterThanOrEqual(401);
    expect(stamped.forwarded.headers.has("iterate-auth-statement")).toBe(false);
    expect(stamped.forwarded.headers.has("x-itx-mind")).toBe(false);
  }
});

test("a refused statement is the boundary's 401, and a check that throws its 503: the mind's code sees neither", async () => {
  for (const [answer, status, body] of [
    [
      { refused: "the statement is for another URL" },
      401,
      '{"error":"the statement is for another URL"}',
    ],
    [
      new Error("D1 is down"),
      503,
      "The signed statement of this request could not be checked now.\n",
    ],
  ] as const) {
    const { auth } = authAnswering(answer);
    let forwarded = 0;
    const response = await mindHostResponse(
      signed(),
      { auth, config, recordFacts: (sent: Response) => sent },
      async () => {
        forwarded += 1;
        return new Response("the app");
      },
    );
    expect({ status: response.status, body: await response.text(), forwarded }).toEqual({
      status,
      body,
      forwarded: 0,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

test("an app's 401 for a mind's request is the app's answer, never a sign-in page", async () => {
  const { auth } = authAnswering({ principal: MIND, expiresAt: 1_900_000_000 });
  const response = await mindHostResponse(
    signed(
      { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
      {
        method: "GET",
        body: null,
      },
    ),
    { auth, config, recordFacts: (sent: Response) => sent },
    async () =>
      new Response("members only", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="iterate"' },
      }),
  );
  expect({ status: response.status, body: await response.text() }).toEqual({
    status: 401,
    body: "members only",
  });
});

test("on a control-plane route the statement is dropped and nothing checks it; an empty statement on a mind's hostname is dropped and checks nothing", async () => {
  const { auth, asked } = authAnswering({ refused: "never asked" });
  const onRoute = await stampedRequest(
    new Request("https://iterate.mind.example/secrets", {
      headers: { "iterate-auth-statement": "x" },
    }),
    {
      auth: { ...auth, browserSession: async () => null } as AuthService,
      route: "secrets",
      config,
    },
  );
  expect(onRoute.forwarded.headers.has("iterate-auth-statement")).toBe(false);
  const empty = await stampedRequest(
    new Request(URL_ASKED, { headers: { "iterate-auth-statement": "" } }),
    { auth, route: null, config },
  );
  expect(empty.forwarded.headers.has("iterate-auth-statement")).toBe(false);
  expect(empty).not.toHaveProperty("byMind");
  expect(asked).toMatchObject({ checks: [] });
});

/** An auth Worker whose check answers `answer` (or throws it), and that records each ask. */
function authAnswering(answer: unknown) {
  const asked: { checks: unknown[]; whoIs: string[] } = { checks: [], whoIs: [] };
  const auth = {
    mindOfSignedRequest: async (input: unknown) => {
      asked.checks.push(input);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    whoIs: async (token: string) => {
      asked.whoIs.push(token);
      // a member's session and a bearer of ours, which must stamp nobody here
      return {
        principal: { actor: "user_1", email: "ada@elsewhere.example" },
        grant: "grant_1",
        expiresAt: 2_000_000_000,
        member: true,
        method: "passkey",
      };
    },
    hostClient: async () => "client-1",
  };
  // the cast: the boundary reads only these methods of the auth Worker
  return { auth: auth as unknown as AuthService, asked };
}

const signed = (headers: Record<string, string> = {}, init: RequestInit = {}) =>
  new Request(URL_ASKED, {
    method: "POST",
    body: "{}",
    ...init,
    headers: { "iterate-auth-statement": crypto.randomUUID(), ...headers },
  });
