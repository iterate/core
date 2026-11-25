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
import { codedError } from "iterate/lib";
import { expect, onTestFinished, test, vi } from "vitest";
import { boundaryResponse } from "./http.ts";
import { receivedMail } from "./mail.ts";
import { mindTransportOf } from "./mind-transport.ts";
import { KEPT_FACTS_MAX, PROVIDED_MIND_DIAL_HEADER, ProvidedMind } from "./provided-mind.ts";

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
    boundary.emailForwardRequest({ raw: "/email/key/hello@example.com.eml", timeoutMs: 10 }),
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

test("the boundary's ask for the mind's next forward request reaches a mind at home, and the answer crosses back", async () => {
  const { boundary, dial } = stack();
  const home = await dial();
  const mind = pretendMind("home");
  await home.handIn(mind);
  const wait = { raw: "/email/key/hello@example.com.eml", afterOffset: 4, timeoutMs: 10 };
  expect(await boundary.emailForwardRequest(wait)).toEqual({
    offset: 5,
    to: "a@elsewhere.example",
    origin: "/",
  });
  expect(mind).toMatchObject({ calls: [["emailForwardRequest", wait]] });
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
    message: expect.stringContaining("connect answers the mind"),
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

test("the link breaks while the boundary waits for the mind's forward requests: the mail is on the log, its requests are not closed, and the delivery fails so that the next one serves them", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const { boundary, dial } = stack();
  const home = await dial();
  const away = pretendMind("home", { requestHangs: true });
  await home.handIn(away);
  const delivery = receivedMail(
    mailMessage(),
    { AUTH: { isMember: async () => false } },
    boundary,
    {
      requestMs: 200,
      forwardAnswerMs: 50,
      factsMs: 50,
    },
  );
  await vi.waitFor(() =>
    expect(away.calls.map((call) => call[0])).toEqual(["receiveEmail", "emailForwardRequest"]),
  );
  home.socket.close(1001, "the home lab stops");
  await expect(delivery).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(logged).toHaveBeenCalledWith(
    expect.objectContaining({ event: "mail.forward-requests-not-read" }),
  );
  logged.mockRestore();
});

test("facts kept while the mind is away are appended in the order they happened", async () => {
  const { boundary, dial } = stack();
  await boundary.appendOrKeep!("/integrations/email", fact("first"));
  await boundary.appendOrKeep!("/integrations/email", fact("second"));
  const back = pretendMind("back");
  await (await dial()).handIn(back);
  await vi.waitFor(() => expect([...back.log.keys()]).toEqual(["first", "second"]));
  expect(back.calls.map((call) => (call[2] as Fact[])[0]!.idempotencyKey)).toEqual([
    "first",
    "second",
  ]);
});

test("past the bound the oldest kept fact is dropped, and the next fact appended says how many were", async () => {
  const { boundary, dial, storage } = stack();
  for (let index = 0; index <= KEPT_FACTS_MAX; index += 1)
    await boundary.appendOrKeep!("/integrations/email", fact(`fact-${index}`));
  expect(keptTypes(storage)).toHaveLength(KEPT_FACTS_MAX);
  const back = pretendMind("back");
  await (await dial()).handIn(back);
  await vi.waitFor(() => expect(back.log).toMatchObject({ size: KEPT_FACTS_MAX }));
  expect(back.log.has("fact-0")).toBe(false);
  const [oldest, next] = back.calls.map((call) => (call[2] as Fact[])[0]!);
  expect(oldest).toMatchObject({
    idempotencyKey: "fact-1",
    payload: { recordedLate: { droppedBefore: 1 } },
  });
  expect(next!.payload).not.toHaveProperty("recordedLate.droppedBefore");
});

test("a fact that reached the mind before its link broke is not written twice", async () => {
  const { boundary, dial, storage } = stack();
  const log = new Map<string, unknown>();
  const home = await dial();
  await home.handIn(pretendMind("home", { log, appendHangs: true }));
  const appended = boundary.appendOrKeep!("/integrations/email", fact("forwarded"));
  await vi.waitFor(() => expect(log.has("forwarded")).toBe(true));
  home.socket.close(1001, "the home lab stops");
  await appended;
  expect(keptTypes(storage)).toHaveLength(1);

  const back = pretendMind("back", { log });
  await (await dial()).handIn(back);
  await vi.waitFor(() => expect(keptTypes(storage)).toEqual([]));
  // the late copy was refused for its key, and the mind's log holds the first one alone
  expect(back.calls).toHaveLength(1);
  expect([...log.entries()]).toEqual([["forwarded", { to: "a@elsewhere.example" }]]);
});

test("a kept fact that the mind refuses is dropped and does not hold back the next", async () => {
  const { boundary, dial, storage } = stack();
  await boundary.appendOrKeep!("/integrations/email", fact("refused"));
  await boundary.appendOrKeep!("/integrations/email", fact("taken"));
  const back = pretendMind("back", {
    refuse: ({ idempotencyKey }) =>
      idempotencyKey === "refused" ? codedError("INVALID_INPUT", "not this one") : undefined,
  });
  await (await dial()).handIn(back);
  await vi.waitFor(() => expect([...back.log.keys()]).toEqual(["taken"]));
  expect(keptTypes(storage)).toEqual([]);
});

test.for([
  [
    "a platform failure",
    () =>
      codedError("UNAVAILABLE", "the mind's log is resetting", {
        kind: "disconnected",
        retryAfterMs: 1_000,
      }),
  ],
  ["an unclassified failure", () => new Error("the mind's process ran out of memory")],
] as const)(
  "a kept fact that meets %s in a drain stays, with every one after it, for the next drain",
  async ([, failure]) => {
    const { boundary, dial, storage } = stack();
    await boundary.appendOrKeep!("/integrations/email", fact("first"));
    await boundary.appendOrKeep!("/integrations/email", fact("second"));
    const failing = pretendMind("failing", { refuse: failure });
    await (await dial()).handIn(failing);
    await vi.waitFor(() => expect(failing.calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failing.calls).toHaveLength(1);
    expect(keptTypes(storage)).toHaveLength(2);
    const back = pretendMind("back");
    await (await dial()).handIn(back);
    await vi.waitFor(() => expect([...back.log.keys()]).toEqual(["first", "second"]));
  },
);

test("one drain at a time: keeps while a drain waits queue no other, and a drain that fails is not run again for them", async () => {
  const { boundary, dial, storage } = stack();
  await boundary.appendOrKeep!("/integrations/email", fact("first"));
  let release!: () => void;
  const unavailable = () =>
    codedError("UNAVAILABLE", "the mind's log is resetting", {
      kind: "overloaded",
      retryAfterMs: 1_000,
    });
  // every append of a kept fact waits, then fails; every live append fails at once
  const replay = new Promise<void>((_resolve, reject) => (release = () => reject(unavailable())));
  replay.catch(() => {});
  const home = pretendMind("home", {
    waits: (fact) => (fact.payload.recordedLate ? replay : undefined),
    refuse: () => unavailable(),
  });
  await (await dial()).handIn(home);
  await vi.waitFor(() => expect(home.calls).toHaveLength(1));
  for (const key of ["second", "third", "fourth"])
    await boundary.appendOrKeep!("/integrations/email", fact(key));
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const replays = home.calls.filter(
    (call) => (call[2] as Fact[])[0]!.payload.recordedLate !== undefined,
  );
  expect(replays).toHaveLength(1);
  expect(keptTypes(storage)).toHaveLength(4);
});

test("nothing is kept for a mind that is connected: a fact it takes is appended once, and one it refuses throws", async () => {
  const { boundary, dial, storage } = stack();
  const home = pretendMind("home", {
    refuse: ({ idempotencyKey }) =>
      idempotencyKey === "refused" ? codedError("INVALID_INPUT", "not this one") : undefined,
  });
  await (await dial()).handIn(home);
  await boundary.appendOrKeep!("/integrations/email", fact("taken"));
  await expect(
    boundary.appendOrKeep!("/integrations/email", fact("refused")),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(keptTypes(storage)).toEqual([]);
  expect([...home.log.keys()]).toEqual(["taken"]);
});

test.for([
  [
    "a platform failure",
    () =>
      codedError("UNAVAILABLE", "the mind's log is resetting", {
        kind: "deploy-reset",
        retryAfterMs: 1_000,
      }),
  ],
  ["an unclassified failure", () => new Error("the mind's process ran out of memory")],
] as const)(
  "a live append that meets %s, while its link stays, is kept and not thrown, not tried again on that link at once, and appended after the next live append lands",
  async ([, failure]) => {
    const { boundary, dial, storage } = stack();
    let failures = 1;
    const home = pretendMind("home", {
      refuse: () => (failures-- > 0 ? failure() : undefined),
    });
    await (await dial()).handIn(home);
    await expect(
      boundary.appendOrKeep!("/integrations/email", fact("forwarded")),
    ).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(home.calls).toHaveLength(1);
    expect(keptTypes(storage)).toHaveLength(1);
    await boundary.appendOrKeep!("/integrations/email", fact("next"));
    await vi.waitFor(() => expect([...home.log.keys()]).toEqual(["next", "forwarded"]));
    await vi.waitFor(() => expect(keptTypes(storage)).toEqual([]));
  },
);

test("a newer link's hand-in while an older link's replay is pending drains once more when that replay fails: the kept facts reach the newer link with no further trigger", async () => {
  const { boundary, dial, storage } = stack();
  await boundary.appendOrKeep!("/integrations/email", fact("kept"));
  let release!: () => void;
  const replay = new Promise<void>(
    (_resolve, reject) => (release = () => reject(new Error("the older link broke"))),
  );
  replay.catch(() => {});
  const older = pretendMind("older", { waits: () => replay });
  await (await dial()).handIn(older);
  await vi.waitFor(() => expect(older.calls).toHaveLength(1));
  const newer = pretendMind("newer");
  await (await dial()).handIn(newer);
  release();
  await vi.waitFor(() => expect([...newer.log.keys()]).toEqual(["kept"]));
  await vi.waitFor(() => expect(keptTypes(storage)).toEqual([]));
});

test("an append to an older link that fails after a newer link's hand-in is kept, and appended to the newer link without another hand-in", async () => {
  const { boundary, dial, storage } = stack();
  const older = pretendMind("older", { appendHangs: true });
  await (await dial()).handIn(older);
  const appended = boundary.appendOrKeep!("/integrations/email", fact("forwarded"));
  await vi.waitFor(() => expect(older.log.has("forwarded")).toBe(true));
  // the newer hand-in drains what is kept (nothing yet), then the older link's call fails
  const newer = pretendMind("newer");
  await (await dial()).handIn(newer);
  await appended;
  await vi.waitFor(() => expect([...newer.log.keys()]).toEqual(["forwarded"]));
  await vi.waitFor(() => expect(keptTypes(storage)).toEqual([]));
});

/** One fact of a mail, by its key. */
type Fact = { type: string; idempotencyKey?: string; payload: Record<string, unknown> };
const fact = (idempotencyKey: string) => ({
  type: "events.iterate.com/email/forwarded",
  idempotencyKey,
  payload: { to: "a@elsewhere.example" },
});

/** The type of each fact that the object keeps, in its order. */
function keptTypes(storage: ReturnType<typeof fakeKv>) {
  return [...storage.list({ prefix: "kept-fact:" })].map(
    ([, kept]) => (kept as { fact: Fact }).fact.type,
  );
}

/** A Durable Object's synchronous KV, ordered as SQLite's. */
function fakeKv() {
  const store = new Map<string, unknown>();
  return {
    get: (key: string) => structuredClone(store.get(key)),
    put: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
    delete: (key: string) => store.delete(key),
    list: ({ prefix = "", limit = Infinity }: { prefix?: string; limit?: number } = {}) =>
      [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit)
        .map(([key, value]): [string, unknown] => [key, structuredClone(value)]),
  };
}

/** One mail as Cloudflare hands it to the boundary. */
function mailMessage() {
  return {
    from: "ada@sender.example",
    to: "hello@example.com",
    raw: new TextEncoder().encode("From: ada@sender.example\r\nSubject: hello\r\n\r\nhi\r\n")
      .buffer,
    headers: new Headers(),
    forward: async () => {},
  } as unknown as ForwardableEmailMessage;
}

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
  const storage = fakeKv();
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
      storage: { kv: storage },
    } as unknown as DurableObjectState,
    bindings as unknown as ConstructorParameters<typeof ProvidedMind>[1],
  );
  const env = {
    ...bindings,
    PROVIDED_MIND: {
      // the object's own methods, called on the object, as a Durable Object's stub calls them
      getByName: (): Pick<
        ProvidedMind,
        | "fetch"
        | "api"
        | "append"
        | "runAct"
        | "receiveEmail"
        | "emailForwardRequest"
        | "emailForwardClaim"
        | "appendOrKeep"
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
        emailForwardRequest: (wait) => object.emailForwardRequest(wait),
        emailForwardClaim: (claim) => object.emailForwardClaim(claim),
        appendOrKeep: (path, fact) => object.appendOrKeep(path, fact),
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
    /** The object's storage: the facts it keeps. */
    storage,
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
function pretendMind(
  name: string,
  {
    log = new Map<string, unknown>(),
    refuse,
    appendHangs = false,
    requestHangs = false,
    waits,
  }: {
    /** The mind's log: each fact's payload by its idempotency key, as the mind's stream keeps it. */
    log?: Map<string, unknown>;
    /** The mind's refusal of a fact, if any. */
    refuse?: (fact: Fact) => Error | undefined;
    /** What the mind's append of a fact answers instead, before anything else, if anything. */
    waits?: (fact: Fact) => Promise<void> | undefined;
    /** The mind takes each fact and never answers: its link breaks under the call. */
    appendHangs?: boolean;
    /** The mind never answers the ask for its next forward request. */
    requestHangs?: boolean;
  } = {},
) {
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
    log = log;
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
    // As the mind's stream: a key it has, with another payload, is IDEMPOTENCY_CONFLICT.
    append(...call: unknown[]) {
      this.calls.push(["append", ...call]);
      for (const fact of call[1] as Fact[]) {
        const waiting = waits?.(fact);
        if (waiting) return waiting;
        const refusal = refuse?.(fact);
        if (refusal) throw refusal;
        if (!fact.idempotencyKey) continue;
        const before = log.get(fact.idempotencyKey);
        if (before !== undefined && JSON.stringify(before) !== JSON.stringify(fact.payload))
          throw codedError("IDEMPOTENCY_CONFLICT", `${fact.idempotencyKey} is on the log already`);
        log.set(fact.idempotencyKey, fact.payload);
      }
      if (appendHangs) return new Promise(() => {});
    }
    runAct(...call: unknown[]) {
      this.calls.push(["runAct", ...call]);
    }
    receiveEmail(...call: unknown[]) {
      this.calls.push(["receiveEmail", ...call]);
      return { offset: 1 };
    }
    // The mind's next request to forward the mail: one, right after the offset asked for.
    emailForwardRequest(wait: { afterOffset?: number }) {
      this.calls.push(["emailForwardRequest", wait]);
      if (requestHangs) return new Promise(() => {});
      return { offset: (wait.afterOffset ?? 0) + 1, to: "a@elsewhere.example", origin: "/" };
    }
  }
  return new Mind();
}
