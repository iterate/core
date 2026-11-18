import { expect, test, vi } from "vitest";
import { SILENCE } from "./end-when-silent.ts";
import { endedByFrames, serveSession, SessionTeardown } from "./session.ts";

test("a lend that registers after the session's end is closed as it registers, and its lease closes nothing twice", () => {
  const teardown = new SessionTeardown();
  const closed: string[] = [];
  const pager = (name: string) => ({ dispose: () => void closed.push(name) });
  teardown.add("early", pager("early"));
  teardown.disposeAll();
  expect(closed).toEqual(["early"]);

  // a lend whose attach was still on its way at the end
  const lease = teardown.add("late", pager("late"));
  expect(closed).toEqual(["early", "late"]);
  lease.dispose();
  teardown.disposeAll();
  expect(closed).toEqual(["early", "late"]);
});

test("before the session's end, adding a key again closes the lend before it, and a stale lease closes nothing", () => {
  const teardown = new SessionTeardown();
  const closed: string[] = [];
  const first = teardown.add("key", { dispose: () => void closed.push("first") });
  teardown.add("key", { dispose: () => void closed.push("second") });
  expect(closed).toEqual(["first"]);
  first.dispose();
  expect(closed).toEqual(["first"]);
});

// A SESSION'S WATCHER (./session.ts): the frames that end one.
// The end of a WebSocket session whose peer went silent: the socket closes with 4000 and the
// teardown runs here, once. A Node test with a socket pair that never answers, the way a socket
// stays half open: what workerd does with a close frame nobody receives is out of scope.
test("a watcher's reason ends the session with 1008, and no reason lets it go on", async () => {
  const socket = fakeSocket();
  const answers: (string | undefined)[] = [undefined, "this sandbox's session ended: a rule"];
  endedByFrames(socket, async () => answers.shift(), socket.close);
  socket.message();
  await settled();
  expect(socket).toMatchObject({ closed: [] });
  socket.message();
  await settled();
  expect(socket).toMatchObject({ closed: [[1008, "this sandbox's session ended: a rule"]] });
});

test("a watcher that throws ends nothing, and a long reason is cut to what a close frame holds", async () => {
  const socket = fakeSocket();
  const frames: (() => string)[] = [
    () => {
      throw new Error("the table could not be read");
    },
    () => "é".repeat(200),
  ];
  endedByFrames(socket, () => frames.shift()!(), socket.close);
  socket.message();
  await settled();
  expect(socket).toMatchObject({ closed: [] });
  socket.message();
  await settled();
  expect(socket).toMatchObject({ closed: [[1008, "é".repeat(61)]] });
});

test("a close that throws, on a socket that is closing already, is nobody's unhandled rejection", async () => {
  const socket = fakeSocket();
  const rejections: unknown[] = [];
  const seen = (reason: unknown) => void rejections.push(reason);
  process.on("unhandledRejection", seen);
  using _listening = { [Symbol.dispose]: () => void process.off("unhandledRejection", seen) };
  endedByFrames(
    socket,
    () => "a rule",
    () => {
      throw new Error("the socket is closing");
    },
  );
  socket.message();
  await settled();
  expect(rejections).toEqual([]);
});

test("a silent peer's session is torn down once with a 4000 close, and a later close event ends nothing", async () => {
  using pair = silentSocketPair();
  let disposals = 0;
  serveSession(
    // only `waitUntil` is read
    { waitUntil: () => {} } as unknown as ExecutionContext,
    {
      caller: { principal: null },
      endsAt: null,
      endReason: "unused: the session has no end time",
      root: (context, teardown) => {
        teardown.add("a lend", { dispose: () => (disposals += 1) });
        return context;
      },
    },
  );
  await vi.advanceTimersByTimeAsync(SILENCE.silentMs + SILENCE.answerWithinMs);
  expect({
    probes: pair.server.sent.filter((frame) => frame.includes("itxLivenessProbe")).length,
    disposals,
    closes: pair.server.closes,
  }).toEqual({
    probes: 1,
    disposals: 1,
    closes: [{ code: 4000, reason: "the peer went silent: dial again" }],
  });
  pair.server.dispatchEvent(Object.assign(new Event("close"), { code: 4000, reason: "" }));
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect({ disposals }).toEqual({ disposals: 1 });
});

/** Workers' `WebSocketPair` and its 101 `Response`, faked in fake time. The server end records
 *  each frame sent and each close, and delivers nothing: the peer sends no frame and answers no probe. Node's
 *  `Response` refuses the status 101, so the fake keeps what it is given. */
function silentSocketPair() {
  vi.useFakeTimers();
  const server = Object.assign(new EventTarget(), {
    readyState: 1,
    binaryType: "arraybuffer",
    sent: [] as string[],
    closes: [] as { code: number; reason: string }[],
    accept: () => {},
    send: (frame: string) => server.sent.push(frame),
    close(code: number, reason: string) {
      server.closes.push({ code, reason });
    },
  });
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = {};
      1 = server;
    },
  );
  vi.stubGlobal(
    "Response",
    class {
      constructor(_body: unknown, init: object) {
        Object.assign(this, init);
      }
    },
  );
  return {
    server,
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeSocket() {
  const listeners: (() => void)[] = [];
  const closed: [number, string][] = [];
  return {
    closed,
    message: () => listeners.forEach((listener) => listener()),
    addEventListener: ((_type: string, listener: () => void) =>
      void listeners.push(listener)) as WebSocket["addEventListener"],
    close: (code: number, reason: string) => void closed.push([code, reason]),
  };
}
