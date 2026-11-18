// The control plane's API as the boundary ends it (./control-plane-api.ts, ./session-mind.ts): the
// real answer to a request at `/api`, dialled over capnweb's own WebSocket pair, with an auth
// Worker and a mind that say what they were asked.
import {
  newWebSocketRpcSession,
  type RpcStub,
  RpcTarget,
  upgradeWebSocketResponse,
  WebSocketPair,
} from "capnweb";
import type { ControlPlaneApi } from "iterate/api";
import type { ApiCaller, AuthService, ControlPlaneSession, MindTarget } from "iterate/workers";
import { expect, test, vi } from "vitest";
import { controlPlaneApiResponse } from "./control-plane-api.ts";

const CONTROL_PLANE = "https://iterate.example.com";
const MEMBER = "a-member's-token";
const KEY = "a-key's-token";
const HOME_LAB = "the-home-lab's-token";
const COOKIE = "__Host-iterate-session=a-live-session";

test("a token in the call: the mind is asked once, with who the token is and never the token, and the first call is pipelined", async () => {
  const stack = stackOf();
  const { api } = stack.dial();
  // nothing awaited before the call: the root, the session and the mind go with it
  expect(await api.authenticate(MEMBER).mind.whoami()).toEqual({ path: "/" });
  expect(stack).toMatchObject({
    asked: [[MEMBER, `${CONTROL_PLANE}/api`]],
    apis: [{ principal: { actor: "user_ada", email: "ada@example.com" }, grant: "grant_1" }],
  });
});

test("with nothing in the call, the bearer of the socket's own request is the credential", async () => {
  const stack = stackOf();
  const { api } = stack.dial({ authorization: `Bearer ${MEMBER}` });
  expect(await api.authenticate().mind.whoami()).toEqual({ path: "/" });
  expect(stack).toMatchObject({ asked: [[MEMBER, `${CONTROL_PLANE}/api`]] });
});

test("with nothing in the call and no bearer, the session cookie counts from the control plane's own origin", async () => {
  const stack = stackOf();
  const { api } = stack.dial({ cookie: COOKIE, origin: CONTROL_PLANE });
  expect(await api.authenticate().mind.whoami()).toEqual({ path: "/" });
  expect(stack).toMatchObject({
    cookies: [COOKIE],
    // a cookie's session has no grant
    apis: [{ principal: { actor: "user_ada", email: "ada@example.com" } }],
  });
  expect(stack.apis[0]).not.toHaveProperty("grant");
});

test.for([
  ["a hostname of the mind's zones, which is same-site", { origin: "https://app.example.com" }],
  ["the mind's apex", { origin: "https://example.com" }],
  ["the control plane's hostname on another scheme", { origin: "http://iterate.example.com" }],
  ["no Origin at all", {}],
] as const)(
  "the cookie from %s is refused, and the auth Worker is not asked about it",
  async ([, origin]) => {
    const stack = stackOf();
    const { api } = stack.dial({ cookie: COOKIE, ...origin });
    await expect(Promise.resolve(api.authenticate().mind.whoami())).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(stack).toMatchObject({ cookies: [], apis: [] });
  },
);

test("the cookie of a person who is no member opens no session", async () => {
  const stack = stackOf({ member: false });
  const { api } = stack.dial({ cookie: COOKIE, origin: CONTROL_PLANE });
  await expect(Promise.resolve(api.authenticate())).rejects.toMatchObject({
    code: "UNAUTHENTICATED",
  });
  expect(stack).toMatchObject({ apis: [] });
});

test("a token in the call is the one credential asked about: a live cookie beside a dead token opens nothing", async () => {
  const stack = stackOf();
  const { api } = stack.dial({ cookie: COOKIE, origin: CONTROL_PLANE });
  await expect(Promise.resolve(api.authenticate("a-dead-token"))).rejects.toMatchObject({
    code: "UNAUTHENTICATED",
  });
  expect(stack).toMatchObject({ cookies: [] });
  // a refused credential may be followed by one that is not, on the same socket
  expect(await api.authenticate(MEMBER).mind.whoami()).toEqual({ path: "/" });
});

test.for(["bearer", "BEARER", "Bearer"])(
  "the scheme of the request's Authorization header is read in any case: %s",
  async (scheme) => {
    const stack = stackOf();
    // a cookie of another person rides the same request: the header is the credential
    const { api } = stack.dial({
      authorization: `${scheme} ${MEMBER}`,
      cookie: COOKIE,
      origin: CONTROL_PLANE,
    });
    expect(await api.authenticate().mind.whoami()).toEqual({ path: "/" });
    expect(stack).toMatchObject({ asked: [[MEMBER, `${CONTROL_PLANE}/api`]], cookies: [] });
  },
);

test.for([
  ["a bearer that is not live", `Bearer a-dead-token`],
  ["another scheme", "Basic YWRhOnNlY3JldA=="],
  ["a bearer with no token", "Bearer"],
])(
  "a request with an Authorization header never falls back to its cookie: %s",
  async ([, authorization]) => {
    const stack = stackOf();
    const { api } = stack.dial({ authorization, cookie: COOKIE, origin: CONTROL_PLANE });
    await expect(Promise.resolve(api.authenticate())).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(stack).toMatchObject({ cookies: [], apis: [] });
  },
);

test.for([
  ["an empty text", ""],
  ["null", null],
  ["a number", 7],
  ["an object", { token: MEMBER }],
])(
  "only no argument means the request's own credential: %s is refused, beside a live cookie and a live bearer",
  async ([, token]) => {
    const stack = stackOf();
    const { api } = stack.dial({
      authorization: `Bearer ${MEMBER}`,
      cookie: COOKIE,
      origin: CONTROL_PLANE,
    });
    // the cast: a client's type of the call takes a text
    await expect(Promise.resolve(api.authenticate(token as string))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(stack).toMatchObject({ asked: [], cookies: [], apis: [] });
    // and the socket still takes its one session
    expect(await api.authenticate().mind.whoami()).toEqual({ path: "/" });
  },
);

test("a key's session has whoami and provide, and nothing else: no cd, and no other name is asked of the mind", async () => {
  const stack = stackOf();
  const mind = stack.dial().api.authenticate(KEY).mind;
  expect(await mind.whoami()).toEqual({ path: "/" });
  await mind.provide("itx.printer", new (class extends RpcTarget {})() as never);
  expect(stack.lends).toHaveLength(1);
  // the cast: the fake mind's own names, which a client's type of the mind does not hold
  const fake = mind as unknown as RpcStub<ReturnType<typeof mindOf>>;
  for (const refused of [() => mind.cd("/agents").whoami(), () => mind.readEvents(0, 1)])
    await expect(Promise.resolve(refused())).rejects.toMatchObject({ code: "FORBIDDEN" });
  // a path under a name that the key has not got ends at that name
  await expect(Promise.resolve(fake.files.write("/a.txt", new ReadableStream()))).rejects.toThrow(
    "is not a function",
  );
});

test("the names that capnweb and frameworks probe, and the boundary's own question, are never asked of the mind", async () => {
  const stack = stackOf();
  const mind = stack.dial().api.authenticate(MEMBER).mind;
  // the cast: names that a client's type of the mind does not hold
  const probing = mind as unknown as Record<string, () => Promise<unknown>>;
  for (const name of ["sessionLives", "toJSON"])
    await expect(Promise.resolve(probing[name]!()), name).rejects.toThrow("is not a function");
  // a member's other names reach the mind as before
  expect(await mind.whoami()).toEqual({ path: "/" });
});

test("a key's token gets its lender as the mind's caller, and no member's principal", async () => {
  const stack = stackOf();
  const { api } = stack.dial();
  await api.authenticate(KEY).mind.whoami();
  expect(stack).toMatchObject({
    apis: [{ lender: { actor: "service_printer", key: "key:1", provide: "printer" } }],
  });
});

test("the token of the right to hand in a mind gets no mind, and a member's credential hands in none", async () => {
  const stack = stackOf();
  const homeLab = stack.dial().api.authenticate(HOME_LAB);
  await expect(Promise.resolve(homeLab.mind.whoami())).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  // where the session ends in the boundary's own invocation, no link can be held
  await expect(Promise.resolve(whole(homeLab).provideExternalMind(NO_MIND)))
    .rejects //
    .toMatchObject({ code: "INVALID_INPUT" });
  expect(stack).toMatchObject({ apis: [] });

  const member = stack.dial().api.authenticate(MEMBER);
  await expect(Promise.resolve(whole(member).provideExternalMind(NO_MIND)))
    .rejects //
    .toMatchObject({ code: "FORBIDDEN" });
});

test("one socket has one session: a second authenticate is refused, and the mind is asked once", async () => {
  const stack = stackOf();
  const { api } = stack.dial();
  await api.authenticate(MEMBER).mind.whoami();
  await expect(Promise.resolve(api.authenticate(KEY))).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(stack.apis).toHaveLength(1);
});

test("the mind's getter answers the same kept stub at each read: two reads ask the mind once", async () => {
  const stack = stackOf();
  using session = await stack.dial().api.authenticate(MEMBER);
  expect([await session.mind.whoami(), await session.mind.whoami()]).toEqual([
    { path: "/" },
    { path: "/" },
  ]);
  expect(stack.apis).toHaveLength(1);
});

test("a mind that cannot be asked fails the read of mind with its own error, and the session stands until the mind is back: then it ends with 1012", async () => {
  vi.useFakeTimers();
  const stack = stackOf({ mindIsAway: true });
  const { api, closed } = stack.dial();
  using session = await api.authenticate(MEMBER);
  await expect(Promise.resolve(session.mind.whoami())).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });
  // asked again every ten seconds, and the session stands while the mind is away
  await vi.advanceTimersByTimeAsync(20_000);
  expect(stack.apis).toHaveLength(3);
  stack.mindIsAway = false;
  await vi.advanceTimersByTimeAsync(10_000);
  // the client's next session reaches the mind: the stub that the question got is let go
  expect(await closed).toEqual(RESTARTED);
  expect(stack).toMatchObject({ released: 1 });
  await vi.advanceTimersByTimeAsync(40_000);
  expect(stack.apis).toHaveLength(4);
});

test("a session whose mind is gone under it ends with 1012 within ten seconds: the boundary asks the mind's stub whether it lives, and a healthy session is left alone", async () => {
  vi.useFakeTimers();
  const stack = stackOf();
  const { api, closed } = stack.dial();
  await api.authenticate(MEMBER).mind.whoami();
  let over = false;
  void closed.then(() => (over = true));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(over).toBe(false);
  stack.mindsInvocationIsGone = true;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await closed).toEqual(RESTARTED);
  expect(stack).toMatchObject({ released: 1 });
});

test("a client that went with no close is ended 30 to 40 seconds after its last frame: the mind's stub is let go, with 4000", async () => {
  vi.useFakeTimers();
  const stack = stackOf();
  const { api, socket, closed } = stack.dial();
  await api.authenticate(MEMBER).mind.whoami();
  let over = false;
  void closed.then(() => (over = true));
  // a live client answers the probe: a minute of quiet ends nothing
  await vi.advanceTimersByTimeAsync(60_000);
  expect(over).toBe(false);
  // the client's network goes just after its answer to the last probe: it sends nothing more,
  // and answers no probe. Asked after 20 s, gone 10 s later.
  socket.send = () => {};
  await vi.advanceTimersByTimeAsync(20_000);
  expect(over).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await closed).toEqual({ code: 4000, reason: "the peer went silent: dial again" });
  expect(stack).toMatchObject({ released: 1 });
});

test("at the credential's end the session is over at once, whatever its client does: the mind's stub is let go and no call is taken, before any close event", async () => {
  vi.useFakeTimers();
  // sooner than a silent client's end: the timers move with no turn of the event loop, so the
  // client answers nothing in that time
  const stack = stackOf({ tokenEndsIn: 15_000 });
  const { api, closed } = stack.dial();
  const mind = api.authenticate(MEMBER).mind.dup();
  await mind.whoami();
  expect(stack).toMatchObject({ released: 0 });
  // the timer alone, with no turn of the event loop: no close event has reached either side
  vi.advanceTimersByTime(15_000);
  expect(stack).toMatchObject({ released: 1 });
  await expect(Promise.resolve(mind.whoami())).rejects.toThrow();
  expect(await closed).toEqual({
    code: 1008,
    reason: "the sign-in for this session ended: authenticate again",
  });
  expect(stack).toMatchObject({ released: 1 });
});

test("a socket that never authenticates is over after ten seconds, before any close event", async () => {
  vi.useFakeTimers();
  const { api, closed } = stackOf().dial();
  vi.advanceTimersByTime(10_000);
  await expect(Promise.resolve(api.about())).rejects.toThrow();
  expect(await closed).toEqual({ code: 1008, reason: "no call of authenticate in ten seconds" });
});

test("the ten seconds stop while authenticate waits for the auth Worker, and start again when it is refused", async () => {
  vi.useFakeTimers();
  const stack = stackOf();
  const answer = Promise.withResolvers<null>();
  const slow = stack.dial({}, { whoIs: () => answer.promise });
  const signIn = Promise.resolve(slow.api.authenticate("a-slow-token")).catch(
    (error: unknown) => error,
  );
  let closed = false;
  void slow.closed.then(() => (closed = true));
  // well past the ten seconds, and the sign-in is still asked about
  await vi.advanceTimersByTimeAsync(30_000);
  expect(closed).toBe(false);
  answer.resolve(null);
  expect(await signIn).toMatchObject({ code: "UNAUTHENTICATED" });
  await vi.advanceTimersByTimeAsync(9_000);
  expect(closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await slow.closed).toEqual({
    code: 1008,
    reason: "no call of authenticate in ten seconds",
  });
});

test("a cookie's session ends with the browser's session when that is sooner than an hour, and after an hour when it is not", async () => {
  vi.useFakeTimers();
  for (const [cookieEndsIn, endsAfter] of [
    [60_000, 60_000],
    [7 * 24 * 3_600_000, 3_600_000],
  ] as const) {
    const { api, closed } = stackOf({ cookieEndsIn }).dial({
      cookie: COOKIE,
      origin: CONTROL_PLANE,
    });
    await api.authenticate().mind.whoami();
    let over = false;
    void closed.then(() => (over = true));
    await vi.advanceTimersByTimeAsync(endsAfter - 1_000);
    expect(over).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await closed).toMatchObject({ code: 1008 });
  }
});

test("the client's own end lets go of the mind's stub", async () => {
  const stack = stackOf();
  const { api, socket } = stack.dial();
  await api.authenticate(MEMBER).mind.whoami();
  socket.close(1000, "done");
  await vi.waitFor(() => expect(stack).toMatchObject({ released: 1 }));
});

test("about() says the stack's public facts to anyone, with no credential", async () => {
  const stack = stackOf();
  expect(await stack.dial().api.about()).toEqual({
    controlPlaneHostname: "iterate.example.com",
    topology: "full-cloudflare",
    stackKey: { keys: ["the stack's published key"] },
  });
  expect(stack).toMatchObject({ asked: [] });
});

test("every other name of the mind goes to it as the client sent it: a path, its arguments and a stream", async () => {
  const stack = stackOf();
  const mind = stack.dial().api.authenticate(MEMBER).mind;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("abc"));
      controller.close();
    },
  });
  // the cast: the fake mind's own names, which a client's type of the mind does not hold
  const fake = mind as unknown as RpcStub<ReturnType<typeof mindOf>>;
  expect(await fake.files.write("/a.txt", stream)).toBe("wrote /a.txt: abc");
});

test("a lent stub goes to the mind with a holder beside it, and its upgrade is made here: the leg into the mind is a fetch", async () => {
  const stack = stackOf();
  const mind = stack.dial().api.authenticate(MEMBER).mind;
  class Tunnel extends RpcTarget {
    fetch(request: Request) {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", ({ data }) =>
        pair[1].send(`${new URL(request.url).pathname} echoes ${data}`),
      );
      return upgradeWebSocketResponse(pair[0]);
    }
  }
  await mind.provide("itx.tunnels.t", new Tunnel() as never, { description: "a tunnel" });
  expect(stack.lends).toMatchObject([
    { match: "itx.tunnels.t", options: { description: "a tunnel" } },
  ]);

  // as the mind's kernel asks for the lend's fetch (core-itx `LentFetchHolder`)
  const answer = await stack.lends[0]!.holder.fetch(
    "upgrade-1",
    [],
    new Request("https://t.example.com/socket", { headers: { upgrade: "websocket" } }),
    "the-context's-object",
  );
  // no socket crossed back: the answer is the kernel's marker of an upgrade
  expect(answer).toEqual({ webSocketUpgrade: true, headers: [] });
  expect(stack).toMatchObject({
    legs: [
      {
        upgrade: "websocket",
        "x-itx-fetch-upgrade": "upgrade-1",
        "x-itx-fetch-upgrade-context": "the-context's-object",
      },
    ],
  });
  // the two sockets are joined: what the mind's end of the leg sends reaches the lent stub
  const heard = new Promise((resolve) =>
    stack.legEnds[0]!.addEventListener("message", ({ data }) => resolve(data)),
  );
  stack.legEnds[0]!.send("hello");
  expect(await heard).toBe("/socket echoes hello");
});

test("a row is no lend: provide with an expression goes to the mind with no holder", async () => {
  const stack = stackOf();
  const mind = stack.dial().api.authenticate(MEMBER).mind;
  await mind.provide("itx.a", "itx.b");
  expect(stack).toMatchObject({
    lends: [{ match: "itx.a", target: "itx.b", options: {}, holder: undefined }],
  });
});

test("a context reached by cd lends as the root does: with a holder", async () => {
  const stack = stackOf();
  const mind = stack.dial().api.authenticate(MEMBER).mind;
  using there = mind.cd("/agents");
  await there.provide("itx.tunnels.t", new (class extends RpcTarget {})() as never);
  expect(stack.lends).toMatchObject([{ match: "itx.tunnels.t", at: "/agents" }]);
  expect(stack.lends[0]!.holder).toBeDefined();
});

/** A connect function that is never called: each session here refuses the hand-in first. */
const NO_MIND = () => mindOf() as unknown as MindTarget;

/** How a session ends when its mind is gone, or is back. */
const RESTARTED = { code: 1012, reason: "the mind behind this session restarted: connect again" };

/** The whole session, which a client's type of it does not name (iterate/api). */
const whole = (session: unknown) => session as RpcStub<ControlPlaneSession>;

type Lend = {
  match: unknown;
  target?: unknown;
  options: unknown;
  at?: string;
  holder: { fetch(id: string, steps: [], request: Request, context: string): Promise<unknown> };
};

/** A mind's own API, as the mind Worker answers it to `api(who)`: it says what it was lent. */
function mindOf(
  lends: Lend[] = [],
  released = () => {},
  at?: string,
  /** Whether the mind's part of the session lives, as the boundary asks every ten seconds. */
  lives: () => boolean = () => true,
) {
  class Files extends RpcTarget {
    async write(path: string, stream: ReadableStream) {
      return `wrote ${path}: ${await new Response(stream).text()}`;
    }
  }
  class Mind extends RpcTarget {
    whoami() {
      return { path: "/" };
    }
    get files() {
      return new Files();
    }
    provide(match: unknown, target: unknown, options: unknown, holder: Lend["holder"]) {
      // A row arrives as it is. The holder is the boundary's own object here: over Workers RPC
      // the mind gets a stub of it, and keeps a `dup()`.
      const row = typeof target === "string" ? { target } : {};
      lends.push({ match, ...row, options, at, holder });
    }
    cd(path: string) {
      return mindOf(lends, () => {}, path);
    }
    sessionLives() {
      if (!lives()) throw new Error("The execution context is no longer running.");
      return true;
    }
    // a name that capnweb and frameworks probe: no client's call of it reaches the mind
    onRpcBroken() {
      return "the mind's own";
    }
    [Symbol.dispose]() {
      released();
    }
  }
  return new Mind();
}

/** A stack whose auth Worker and mind say what they were asked. `asked`: each token with its
 *  audience. `cookies`: each cookie header. `apis`: who each `api(who)` was for. `legs`: the
 *  headers of each leg that was dialled into the mind, and `legEnds` the mind's end of each. */
function stackOf(
  options: {
    member?: boolean;
    tokenEndsIn?: number;
    cookieEndsIn?: number;
    mindIsAway?: boolean;
  } = {},
) {
  const asked: string[][] = [];
  const cookies: (string | null)[] = [];
  const apis: ApiCaller[] = [];
  const lends: Lend[] = [];
  const legs: Record<string, string>[] = [];
  const legEnds: WebSocket[] = [];
  const state = {
    asked,
    cookies,
    apis,
    lends,
    legs,
    legEnds,
    released: 0,
    mindIsAway: options.mindIsAway ?? false,
    /** The mind's own invocation for a session is gone: every call on its stub fails. */
    mindsInvocationIsGone: false,
  };
  const expiresAt = () => (Date.now() + (options.tokenEndsIn ?? 3_600_000)) / 1000;
  const auth: Pick<AuthService, "whoIs" | "browserSession" | "fetch"> = {
    whoIs: async (token, resource) => {
      asked.push([token, resource]);
      const audience = { [MEMBER]: "/api", [KEY]: "/api", [HOME_LAB]: "/api/provide-connect" }[
        token
      ];
      if (resource !== `${CONTROL_PLANE}${audience}`) return null;
      if (token === KEY)
        return {
          principal: { actor: "service_printer" },
          grant: "key:1",
          expiresAt: expiresAt(),
          member: false,
          provide: "printer",
        };
      return {
        principal: { actor: "user_ada", email: "ada@example.com" },
        grant: "grant_1",
        expiresAt: expiresAt(),
        member: true,
      };
    },
    browserSession: async (cookie) => {
      cookies.push(cookie);
      return {
        userId: "user_ada",
        email: "ada@example.com",
        member: options.member ?? true,
        method: "passkey",
        expiresAt: (Date.now() + (options.cookieEndsIn ?? 30 * 24 * 3_600_000)) / 1000,
      };
    },
    fetch: async () => Response.json({ keys: ["the stack's published key"] }),
  };
  const mind = {
    api: async (who: ApiCaller) => {
      apis.push(who);
      if (state.mindIsAway)
        throw Object.assign(new Error("not connected right now"), { code: "UNAVAILABLE" });
      return mindOf(
        lends,
        () => (state.released += 1),
        undefined,
        () => !state.mindsInvocationIsGone,
      );
    },
    fetch: async (request: Request) => {
      legs.push(Object.fromEntries(request.headers));
      const pair = new WebSocketPair();
      pair[1].accept();
      // capnweb's own half of its pair, which in workerd is the runtime's `WebSocket`
      legEnds.push(pair[1] as unknown as WebSocket);
      return upgradeWebSocketResponse(pair[0]);
    },
  };
  return Object.assign(state, {
    /** `authOverrides`: the auth Worker's answers that this one socket gets in place of the stack's. */
    dial(headers: Record<string, string> = {}, authOverrides: Partial<typeof auth> = {}) {
      const answer = controlPlaneApiResponse(
        new Request(`${CONTROL_PLANE}/api`, { headers: { upgrade: "websocket", ...headers } }),
        {
          auth: { ...auth, ...authOverrides },
          config: { controlPlaneHostname: "iterate.example.com", topology: "full-cloudflare" },
          mind,
        },
      );
      // capnweb's answer to an upgrade holds the client's half of its own pair
      const socket = (answer as unknown as { webSocket: WebSocket }).webSocket;
      socket.accept();
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        socket.addEventListener("close", ({ code, reason }) => resolve({ code, reason })),
      );
      return { api: newWebSocketRpcSession<ControlPlaneApi>(socket), socket, closed };
    },
  });
}
