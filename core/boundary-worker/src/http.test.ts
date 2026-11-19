// THE BOUNDARY'S ONE RULE (./http.ts): a request on the control-plane hostname is the control plane's,
// and a request on any other hostname goes to the mind, for its config worker.
import { MIND_PROVIDE_EXTERNAL_MIND_HEADER } from "iterate/mind-api";
import type { AuthService } from "iterate/workers";
import { expect, test } from "vitest";
import { boundaryResponse, isControlPlaneRequest, type MindTransport } from "./http.ts";

const CONFIG = {
  mindId: "a".repeat(64),
  controlPlaneHostname: "iterate.example.com",
  zones: ["example.com", "example.org"],
  ownerEmails: ["ada@elsewhere.example"],
  topology: "full-cloudflare",
};

test.for([
  ["https://iterate.example.com/", true],
  ["https://iterate.example.com/api", true],
  ["https://ITERATE.Example.com/api", true],
  ["https://example.com/", false],
  ["https://dash.example.com/", false],
  ["https://app.iterate.example.com/", false],
  // `iterate` on a second zone is a hostname like any other: one mind has one control-plane hostname
  ["https://iterate.example.org/api", false],
  ["https://example.org/", false],
] as const)("%s is the control plane's: %s", ([url, expected]) => {
  expect(isControlPlaneRequest(new Request(url), CONFIG)).toBe(expected);
});

test("a request on any hostname but the control-plane hostname goes to the mind, whatever its path", async () => {
  const stack = stackOf();
  for (const url of ["https://example.org/api", "https://dash.example.com/secrets/x"])
    expect(await (await stack.answered(url)).text(), url).toBe("the mind's own");
  expect(stack).toMatchObject({
    reachedMind: ["https://example.org/api", "https://dash.example.com/secrets/x"],
    reachedAuth: [],
  });
});

test("a request on the control-plane hostname that is no API or MCP path goes to the auth Worker, and its facts to the mind's log", async () => {
  const stack = stackOf();
  const answer = await stack.answered("https://iterate.example.com/sign-in");
  expect(await answer.text()).toBe("the auth Worker's");
  expect(stack).toMatchObject({
    reachedAuth: ["https://iterate.example.com/sign-in"],
    reachedMind: [],
  });
});

test("a hostname that ends with a dot is refused with 421 before anything else: no bearer or cookie on it reaches the mind's code or a Worker", async () => {
  const stack = stackOf();
  for (const url of [
    // the control-plane hostname with a dot is not equal to it as a string, and must not go to the
    // mind's code with the caller's bearer
    "https://iterate.example.com./api",
    "https://dash.example.org./",
    "http://iterate.example.com./",
  ]) {
    const answer = await stack.answered(url, {
      authorization: "Bearer a-live-token",
      cookie: "__Host-iterate-session=a-live-session",
    });
    expect(answer, url).toMatchObject({ status: 421 });
  }
  expect([stack.reachedMind, stack.reachedAuth, stack.asked]).toEqual([[], [], []]);
});

// what a home lab's launcher sends: the header that says where its session ends
const DIAL = { upgrade: "websocket", [MIND_PROVIDE_EXTERNAL_MIND_HEADER]: "1" };

test("a dial that says it hands in a mind goes to the object that holds the link, unasked: its session authenticates there", async () => {
  const stack = stackOf({ link: true });
  const answer = await stack.answered("https://iterate.example.com/api", DIAL);
  expect(await answer.text()).toBe("the link's session");
  expect(stack).toMatchObject({
    asked: [],
    linked: ["https://iterate.example.com/api"],
    reachedMind: [],
  });
});

test("a stack whose mind is a Worker takes no mind: the dial is refused, and nothing is asked", async () => {
  const stack = stackOf();
  const answer = await stack.answered("https://iterate.example.com/api", DIAL);
  expect(answer).toMatchObject({ status: 403 });
  expect(stack).toMatchObject({ asked: [], linked: [], reachedMind: [] });
});

test.for([
  ["a POST with a member's bearer", { link: false }, { authorization: "Bearer a-member's-token" }],
  ["a GET with a session cookie", { link: false }, { cookie: "__Host-iterate-session=live" }],
  [
    "a request that names the hand-in and is no upgrade",
    { link: true },
    { [MIND_PROVIDE_EXTERNAL_MIND_HEADER]: "1" },
  ],
] as const)(
  "the API is a WebSocket alone: %s is refused with 426, and neither the mind nor the auth Worker is asked",
  async ([, transport, headers]) => {
    const stack = stackOf(transport);
    const answer = await stack.answered("https://iterate.example.com/api", headers);
    expect([answer.status, answer.headers.get("upgrade")]).toEqual([426, "websocket"]);
    expect(stack).toMatchObject({ asked: [], linked: [], reachedMind: [], reachedAuth: [] });
  },
);

test("under /api/ the rest is the mind's, as a plain request: a signed file URL reaches it with no credential", async () => {
  const stack = stackOf();
  const answer = await stack.answered("https://iterate.example.com/api/files/x?signature=s", {
    cookie: "__Host-iterate-session=live",
  });
  expect(await answer.text()).toBe("the mind's own");
  expect(stack).toMatchObject({
    reachedMind: ["https://iterate.example.com/api/files/x?signature=s"],
  });
});

test("the header means nothing off the API's own address: the MCP server answers as it does for any caller", async () => {
  const stack = stackOf({ link: true });
  const answer = await stack.answered("https://iterate.example.com/mcp", {
    ...DIAL,
    authorization: "Bearer the-home-lab's-token",
  });
  expect(answer).toMatchObject({ status: 401 });
  expect(stack).toMatchObject({
    asked: [["the-home-lab's-token", "https://iterate.example.com/mcp"]],
    linked: [],
  });
});

// THE MIND'S OWN REQUEST (iterate/lib `ITX_OWN_HEADER`): only the Door's argument says it, after
// the strip, and only the mind's hosts are told; nothing from outside can say it.
test("only the Door's own request to a host of the mind carries the own stamp and its mark: one from outside that writes both, and an own request to the control plane, carry neither anywhere", async () => {
  const reached: [string, string | null, string | null][] = [];
  const heard = (where: string) => async (request: Request) => {
    reached.push([
      `${where} ${new URL(request.url).pathname}`,
      request.headers.get("x-itx-own"),
      request.headers.get("x-iterate-cause"),
    ]);
    return new Response("ok");
  };
  const env = {
    ITERATE: JSON.stringify(CONFIG),
    AUTH: { fetch: heard("auth"), whoIs: async () => null } as Partial<AuthService>,
  } as Parameters<typeof boundaryResponse>[1];
  const mind = { fetch: heard("mind"), append: async () => {} } as Partial<MindTransport>;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const ask = (url: string, own?: true) =>
    boundaryResponse(
      new Request(url, { headers: { "x-itx-own": "1", "X-Iterate-Cause": "a mark" } }),
      env,
      ctx,
      mind as MindTransport,
      own && { own },
    );
  await ask("https://app.example.org/own", true);
  await ask("https://app.example.org/outside");
  await ask("https://iterate.example.com/sign-in", true);
  await ask("https://iterate.example.com/api/webhooks/github", true);
  expect(reached).toEqual([
    ["mind /own", "1", "a mark"],
    ["mind /outside", null, null],
    ["auth /sign-in", null, null],
    ["mind /api/webhooks/github", null, null],
  ]);
});

/** A stack whose auth Worker and mind say that they were reached. `asked`: each token the auth
 *  Worker was asked about, with the audience. `link`: the mind runs elsewhere, and `linked` is
 *  each dial that the boundary let in. The home lab's token is live for the audience of the right
 *  to hand in a mind alone. */
function stackOf({ link = false } = {}) {
  const reachedAuth: string[] = [];
  const reachedMind: string[] = [];
  const asked: string[][] = [];
  const linked: string[] = [];
  const env = {
    ITERATE: JSON.stringify(CONFIG),
    AUTH: {
      fetch: async (request: Request) => {
        reachedAuth.push(request.url);
        return new Response("the auth Worker's");
      },
      whoIs: async (token: string, resource: string) => {
        asked.push([token, resource]);
        const audience = {
          "the-home-lab's-token": "/api/provide-connect",
          "a-member's-token": "/api",
        }[token];
        return resource === `https://iterate.example.com${audience}`
          ? {
              principal: { actor: "user_ada" },
              grant: "grant_1",
              expiresAt: 1_800_000_000,
              member: true,
            }
          : null;
      },
    } as Partial<AuthService>,
  } as Parameters<typeof boundaryResponse>[1];
  const mind = {
    fetch: async (request: Request) => {
      reachedMind.push(request.url);
      return new Response("the mind's own");
    },
    append: async () => {},
    ...(link && {
      link: async (dial: Request) => {
        linked.push(dial.url);
        return new Response("the link's session");
      },
    }),
  } as Partial<MindTransport> as MindTransport;
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return {
    answered: (url: string, headers: Record<string, string> = {}) =>
      boundaryResponse(new Request(url, { headers }), env, ctx, mind),
    reachedAuth,
    reachedMind,
    asked,
    linked,
  };
}
