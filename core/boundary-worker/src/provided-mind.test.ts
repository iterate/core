// A mind that runs elsewhere, as the boundary lets it in (./http.ts, ./stamp.ts), holds it
// (./provided-mind.ts) and reaches it (./mind-transport.ts): the boundary's own handler over the
// real `ProvidedMind`, dialled over capnweb's own WebSocket pair, as a home lab dials it.
import {
  newWebSocketRpcSession,
  type RpcStub,
  RpcTarget,
  upgradeWebSocketResponse,
  WebSocketPair,
} from "capnweb";
import type { ControlPlaneApi } from "iterate/api";
import { MIND_PROVIDE_EXTERNAL_MIND_HEADER } from "iterate/mind-api";
import {
  type ApiCaller,
  type AuthService,
  type ControlPlaneSession,
  type Door,
  MIND_TAKEN_OVER_CLOSE_CODE,
  type MindTarget,
} from "iterate/workers";
import { expect, onTestFinished, test, vi } from "vitest";
import { boundaryResponse } from "./http.ts";
import { mindTransportOf } from "./mind-transport.ts";
import { PROVIDED_MIND_DIAL_HEADER, ProvidedMind } from "./provided-mind.ts";

const NOT_CONNECTED = "This mind runs elsewhere and is not connected right now.\n";
const VISITOR = "https://example.com/";

test("with no link, a request is answered 503 and every other call fails as unavailable", async () => {
  const { boundary } = stack();
  const answer = await boundary.fetch(new Request(VISITOR));
  expect([answer.status, answer.headers.get("retry-after"), await answer.text()]).toEqual([
    503,
    "10",
    NOT_CONNECTED,
  ]);
  for (const call of [
    boundary.append("/", []),
    boundary.runAct({ digest: "d", text: "t" }),
    boundary.receiveEmail({ events: [], files: [] }),
  ])
    await expect(call).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: NOT_CONNECTED.trim(),
      data: { kind: "disconnected" },
    });
});

test("a mind that hands in its connect function gets every request, mail and act, and the boundary's door", async () => {
  const { boundary, dial, door } = stack();
  const home = await dial();
  const mind = pretendMind("home");
  await home.handIn(mind);

  const answer = await boundary.fetch(new Request("https://example.com/hello"));
  expect(await answer.text()).toBe("home answered https://example.com/hello");
  await boundary.append("/a", [{ type: "events.iterate.com/mcp/webhook-received" }], true);
  await boundary.runAct({ digest: "d", text: "t" });
  await boundary.receiveEmail({ events: [], files: [] });
  expect(mind).toMatchObject({
    calls: [
      ["fetch", "https://example.com/hello"],
      ["append", "/a", [{ type: "events.iterate.com/mcp/webhook-received" }], true],
      ["runAct", { digest: "d", text: "t" }],
      ["receiveEmail", { events: [], files: [] }],
    ],
  });
  // the door that `connect` was called with, kept with `dup()`, is the boundary's own
  expect(await home.door().isMember("ada@example.com")).toBe(true);
  expect(door).toMatchObject({ props: [{ provided: true }] });
});

test("the dial reaches the object with the boundary's mark and without a caller's stamps: its session authenticates there", async () => {
  const { dial, reachedObject } = stack();
  await dial({ "x-itx-principal": '{"actor":"forged"}' });
  expect(reachedObject).toEqual([
    {
      upgrade: "websocket",
      [MIND_PROVIDE_EXTERNAL_MIND_HEADER]: "1",
      [PROVIDED_MIND_DIAL_HEADER]: "1",
    },
  ]);
});

test("the mark of a dial never comes from a visitor: a request that carries it is a request for the mind", async () => {
  const { boundary, dial } = stack();
  const mind = pretendMind("home");
  await (await dial()).handIn(mind);
  const forged = new Request(VISITOR, { headers: { [PROVIDED_MIND_DIAL_HEADER]: "1" } });
  expect(await (await boundary.fetch(forged)).text()).toBe(`home answered ${VISITOR}`);
  expect(mind).toMatchObject({ marks: [null] });
});

test("a member's token on a dial that says it hands in a mind opens no session there: the mind that is connected stays the link", async () => {
  const { boundary, dial } = stack();
  const incumbent = pretendMind("incumbent");
  await (await dial()).handIn(incumbent);

  // a second machine's launcher, started with a member's API token
  const second = await dial({}, MEMBER);
  const refusal = {
    code: "FORBIDDEN",
    message: expect.stringContaining("only the token of a mind that runs elsewhere"),
  };
  await expect(second.handIn(pretendMind("a test's own"))).rejects.toMatchObject(refusal);
  // the object that holds the link ends no member's session: such a session ends in the
  // boundary's own invocation, on a socket that does not say that it hands in a mind
  await expect(Promise.resolve(second.session.mind.whoami())).rejects.toMatchObject(refusal);
  expect(incumbent).toMatchObject({ sessions: [] });
  expect(await (await boundary.fetch(new Request(VISITOR))).text()).toBe(
    `incumbent answered ${VISITOR}`,
  );
});

test("the token of that right on a dial that does not say so hands in nothing: its session ends in an invocation, which holds no link", async () => {
  const { answered, reachedObject } = stack();
  const socket = acceptedSocketOf(await answered(apiRequest({ upgrade: "websocket" })));
  const api = newWebSocketRpcSession<ControlPlaneApi>(socket);
  const session = api.authenticate(HOME_LAB) as unknown as RpcStub<ControlPlaneSession>;
  await expect(
    Promise.resolve(session.provideExternalMind(() => pretendMind("x") as unknown as MindTarget)),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(reachedObject).toEqual([]);
});

test("that session reaches nothing of the mind, and takes one mind", async () => {
  const home = await stack().dial();
  await expect(Promise.resolve(home.session.mind.whoami())).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: expect.stringContaining("call provideExternalMind"),
  });
  await home.handIn(pretendMind("home"));
  await expect(home.handIn(pretendMind("again"))).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("a member's session, ended by the boundary's own invocation, reaches the mind's API through the link, and ends with 1012 when the link drops and when a link is back", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const { answered, dial } = stack();
  const member = async () => {
    const socket = acceptedSocketOf(await answered(apiRequest({ upgrade: "websocket" })));
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.addEventListener("close", ({ code, reason }) => resolve({ code, reason })),
    );
    // a stub of the pipelined mind, which is no thenable: an async function hands it on as it is
    const mind = newWebSocketRpcSession<ControlPlaneApi>(socket).authenticate(MEMBER).mind.dup();
    return { mind, closed };
  };
  const restarted = { code: 1012, reason: "the mind behind this session restarted: connect again" };
  // with no link, the read of the mind says so, and the session waits for a mind
  const early = await member();
  await expect(Promise.resolve(early.mind.whoami())).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });

  const home = await dial();
  await home.handIn(pretendMind("home"));
  // the session that found no mind ends when one is back: its client's next session reaches it
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await early.closed).toEqual(restarted);

  const live = await member();
  // A stream on this path needs the Workers RPC hop that a Durable Object's stub is: here the
  // two capnweb sessions meet in one process, where capnweb refuses to hand a stream on.
  expect(await live.mind.whoami()).toEqual({ mind: "home", who: MEMBER_IS });
  // the home lab's socket drops: the session over its mind is over, and says "connect again"
  home.socket.close(1001, "the home lab went away");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await live.closed).toEqual(restarted);
});

test("a newer session takes the mind over, and the older one is closed with the code that says so", async () => {
  const { boundary, dial } = stack();
  const older = await dial();
  await older.handIn(pretendMind("older"));
  const newer = await dial();
  await newer.handIn(pretendMind("newer"));

  expect(await (await boundary.fetch(new Request(VISITOR))).text()).toBe(
    `newer answered ${VISITOR}`,
  );
  expect(await older.closed).toEqual({
    code: MIND_TAKEN_OVER_CLOSE_CODE,
    reason: "another session handed in this mind",
  });
  // the older socket's end does not take the newer link with it
  expect(await boundary.fetch(new Request(VISITOR))).toMatchObject({ status: 200 });
});

test("an answer that is no mind replaces nothing: the mind that is connected stays the link", async () => {
  const { boundary, dial } = stack();
  await (await dial()).handIn(pretendMind("healthy"));
  const careless = await dial();
  await expect(
    careless.session.provideExternalMind(() => ({}) as unknown as MindTarget),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
    message: expect.stringContaining("connect(door) answers the mind"),
  });
  expect(await (await boundary.fetch(new Request(VISITOR))).text()).toBe(
    `healthy answered ${VISITOR}`,
  );
});

test("a connect function that answers after a newer session's mind is the link does not take the link back", async () => {
  const { boundary, dial } = stack();
  const slow = await dial();
  const answerNow = Promise.withResolvers<MindTarget>();
  // a function may answer a promise of the mind: capnweb waits for it
  const late = slow.session.provideExternalMind(() => answerNow.promise as unknown as MindTarget);
  await (await dial()).handIn(pretendMind("newer"));

  answerNow.resolve(pretendMind("slow") as unknown as MindTarget);
  await expect(late).rejects.toThrow();
  expect(await slow.closed).toMatchObject({ code: MIND_TAKEN_OVER_CLOSE_CODE });
  expect(await (await boundary.fetch(new Request(VISITOR))).text()).toBe(
    `newer answered ${VISITOR}`,
  );
});

test("the link ends with its socket", async () => {
  const { boundary, dial } = stack();
  const home = await dial();
  await home.handIn(pretendMind("home"));
  home.socket.close(1000, "the home lab stops");
  await vi.waitFor(async () =>
    expect(await boundary.fetch(new Request(VISITOR))).toMatchObject({ status: 503 }),
  );
});

test("a session that breaks with a long error is no link from that moment, and its close reason fits a close frame", async () => {
  const { boundary, dial } = stack();
  const home = await dial();
  await home.handIn(pretendMind("home"));
  // capnweb's own word that the session failed, with an error longer than a close frame takes
  home.socket.send(JSON.stringify(["abort", ["error", "Error", "x".repeat(500)]]));
  // capnweb closes a session that it aborts, with its own code and the error cut to fit
  const { code, reason } = await home.closed;
  expect([code, new TextEncoder().encode(reason).length <= 123]).toEqual([3000, true]);
  expect(await boundary.fetch(new Request(VISITOR))).toMatchObject({ status: 503 });
});

test("the link ends when its token does", async () => {
  const { boundary, dial } = stack({ homeLabTokenEndsIn: 30 });
  const home = await dial();
  await home.handIn(pretendMind("home"));
  expect(await home.closed).toEqual({
    code: 1008,
    reason: "the sign-in for this session ended: authenticate again",
  });
  expect(await boundary.fetch(new Request(VISITOR))).toMatchObject({ status: 503 });
});

test("the door ends when the token does, also for a mind whose connect function has not answered yet", async () => {
  const { dial, door } = stack({ homeLabTokenEndsIn: 120 });
  const home = await dial();
  let held: RpcStub<Door> | undefined;
  // the function has the door from its first moment, and never answers
  const pending = home.session.provideExternalMind((handed) => {
    held = (handed as unknown as RpcStub<Door>).dup();
    return new Promise(() => {}) as unknown as MindTarget;
  });
  pending.catch(() => {});
  await vi.waitFor(() => expect(held).toBeDefined(), { interval: 5 });
  expect(await held!.isMember("ada@example.com")).toBe(true);

  expect(await home.closed).toMatchObject({ code: 1008 });
  await expect(held!.isMember("ada@example.com")).rejects.toThrow();
  // the one call before the end, and none after it
  expect(door).toMatchObject({ asked: 1 });
});

test("a stack whose mind is a Worker reaches it by its binding, and has no link to give", async () => {
  const mind = pretendMind("worker");
  const boundary = mindTransportOf({
    ITERATE: JSON.stringify({ ...CONFIG, topology: "full-cloudflare" }),
    MIND: mind as unknown as MindTarget,
  } as Parameters<typeof mindTransportOf>[0]);
  expect(await (await boundary.fetch(new Request(VISITOR))).text()).toBe(
    `worker answered ${VISITOR}`,
  );
  expect(boundary.link).toBeUndefined();
});

test("a deploy without the binding of its topology says which one is missing", () => {
  expect(() =>
    mindTransportOf({ ITERATE: JSON.stringify(CONFIG) } as Parameters<typeof mindTransportOf>[0]),
  ).toThrow(
    "the boundary of a external-mind-connects-into-cloudflare-boundary stack has no PROVIDED_MIND binding",
  );
});

const CONFIG = {
  mindId: "a".repeat(64),
  controlPlaneHostname: "iterate.example.com",
  zones: ["example.com"],
  ownerEmails: ["ada@elsewhere.example"],
  topology: "external-mind-connects-into-cloudflare-boundary",
};
/** A token that is live for the right to hand in a mind, and one that is live for the API. */
const HOME_LAB = "the-home-lab's-token";
const MEMBER = "a-member's-token";
/** Who the mind hears that the member's token is. */
const MEMBER_IS = { principal: { actor: "user_ada" }, grant: "grant_1" };

const apiRequest = (headers: Record<string, string>, method = "GET") =>
  new Request("https://iterate.example.com/api", { method, headers });

/** The socket of an upgrade's answer, accepted. */
function acceptedSocketOf(answer: Response) {
  const socket = answer.webSocket!;
  socket.accept();
  return socket;
}

/** THE BOUNDARY OF A STACK WHOSE MIND RUNS ELSEWHERE: its handler (`answered`), its way to the
 *  mind (`boundary`) and one real `ProvidedMind`. `dial` is a home lab's session, let in by the
 *  handler as the launcher asks for it. `door` counts the calls that reached the boundary's Door,
 *  and `reachedObject` is the headers of each dial that reached the object. */
function stack({ homeLabTokenEndsIn = 60_000 } = {}) {
  const door = {
    asked: 0,
    props: [] as object[],
    isMember: async () => {
      door.asked += 1;
      return true;
    },
  };
  const reachedObject: Record<string, string>[] = [];
  // as the auth Worker answers: a token is live for one audience
  const whoIs: AuthService["whoIs"] = async (token, resource) => {
    const audience = { [HOME_LAB]: "/api/provide-connect", [MEMBER]: "/api" }[token];
    if (resource !== `https://iterate.example.com${audience}`) return null;
    return {
      principal: { actor: "user_ada" },
      grant: "grant_1",
      expiresAt: (Date.now() + homeLabTokenEndsIn) / 1000,
      member: true,
    };
  };
  // the object asks the auth Worker itself: it has the boundary's own bindings
  const bindings = { ITERATE: JSON.stringify(CONFIG), AUTH: { whoIs } };
  const object = new ProvidedMind(
    // the Door is minted with the props of a provided one (./rpc.ts `DoorProps`)
    {
      exports: {
        Door: ({ props }: { props: object }) => {
          door.props.push(props);
          return door;
        },
      },
    } as unknown as DurableObjectState,
    bindings as unknown as ConstructorParameters<typeof ProvidedMind>[1],
  );
  const env = {
    ...bindings,
    PROVIDED_MIND: {
      // the object's own methods, called on the object, as a Durable Object's stub calls them
      getByName: (): Pick<
        ProvidedMind,
        "fetch" | "api" | "append" | "runAct" | "receiveEmail"
      > => ({
        fetch: (request) => {
          if (request.headers.has(PROVIDED_MIND_DIAL_HEADER))
            reachedObject.push(Object.fromEntries(request.headers));
          return object.fetch(request);
        },
        api: (who) => object.api(who),
        append: (...call) => object.append(...call),
        runAct: (held) => object.runAct(held),
        receiveEmail: (mail) => object.receiveEmail(mail),
      }),
    },
  } as unknown as Parameters<typeof mindTransportOf>[0];
  const boundary = mindTransportOf(env);
  const invocation = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const answered = (request: Request) => boundaryResponse(request, env, invocation, boundary);
  return {
    answered,
    boundary,
    door,
    reachedObject,
    /** A session whose dial says that it hands in a mind, authenticated with `token` in the
     *  call, as a home lab's launcher does. */
    async dial(more: Record<string, string> = {}, token = HOME_LAB) {
      const answer = await answered(
        apiRequest({ upgrade: "websocket", [MIND_PROVIDE_EXTERNAL_MIND_HEADER]: "1", ...more }),
      );
      const socket = acceptedSocketOf(answer);
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        socket.addEventListener("close", ({ code, reason }) => resolve({ code, reason })),
      );
      const api = newWebSocketRpcSession<ControlPlaneApi>(socket);
      // not awaited: a call on the session goes with it. The cast: a client's type of the
      // session names `mind` alone.
      const session = api.authenticate(token) as unknown as RpcStub<ControlPlaneSession>;
      let kept: RpcStub<Door> | undefined;
      return {
        session,
        socket,
        closed,
        door: () => kept!,
        handIn: (mind: RpcTarget) =>
          session.provideExternalMind((handed) => {
            kept = (handed as unknown as RpcStub<Door>).dup();
            return mind as unknown as MindTarget;
          }),
      };
    },
  };
}

/** A mind that says what it was asked. `marks`: the dial's mark on each request it got. Its own
 *  API for a session says who the session is. */
function pretendMind(name: string) {
  class Api extends RpcTarget {
    readonly #who: ApiCaller;
    constructor(who: ApiCaller) {
      super();
      this.#who = who;
    }
    whoami() {
      return { mind: name, who: this.#who };
    }
    // the boundary's question of a session's mind, every ten seconds
    sessionLives() {
      return true;
    }
  }
  class Mind extends RpcTarget {
    calls: unknown[][] = [];
    marks: (string | null)[] = [];
    sessions: ApiCaller[] = [];
    fetch(request: Request) {
      this.calls.push(["fetch", request.url]);
      this.marks.push(request.headers.get(PROVIDED_MIND_DIAL_HEADER));
      if (request.headers.get("upgrade") !== "websocket")
        return new Response(`${name} answered ${request.url}`);
      const pair = new WebSocketPair();
      pair[1].accept();
      return upgradeWebSocketResponse(pair[0]);
    }
    api(who: ApiCaller) {
      this.sessions.push(who);
      return new Api(who);
    }
    append(...call: unknown[]) {
      this.calls.push(["append", ...call]);
    }
    runAct(...call: unknown[]) {
      this.calls.push(["runAct", ...call]);
    }
    receiveEmail(...call: unknown[]) {
      this.calls.push(["receiveEmail", ...call]);
    }
  }
  return new Mind();
}
