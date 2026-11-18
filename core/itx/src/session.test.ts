// A SESSION'S ROOT AND ITS WATCHER (./session.ts): the context that a session with a `path` is
// rooted at, and the frames that end one.
// The end of a WebSocket session whose peer went silent: the socket closes with 4000 and the
// teardown runs here, once. A Node test with a socket pair that never answers, the way a socket
// stays half open: what workerd does with a close frame nobody receives is out of scope.
import { env } from "cloudflare:workers";
import { newHttpBatchRpcSession } from "capnweb";
import { expect, test, vi } from "vitest";
import type { Caller } from "./caller.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import { SILENCE } from "./end-when-silent.ts";
import { endedByFrames, serveSession } from "./session.ts";

const BOX = "/agents/ada/box";

test.for<{ name: string; path: string | undefined; rootedAt: string }>([
  { name: "no path", path: undefined, rootedAt: "/" },
  { name: "a sandbox's context", path: BOX, rootedAt: BOX },
])("a session with $name is rooted at $rootedAt, as its caller", async ({ path, rootedAt }) => {
  using contexts = contextsThatAnswerTheirPath();
  const caller: Caller = { principal: null, app: true };
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    serveSession(new Request(input, init), { waitUntil() {} } as unknown as ExecutionContext, {
      caller,
      endsAt: null,
      endReason: "",
      path,
    }),
  );
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- one call, and a test has no WebSocketPair to serve a socket with
  const session = newHttpBatchRpcSession<{ whoami(): Promise<{ path: string }> }>(
    "https://iterate.example.com/api",
  );
  expect(await session.whoami()).toEqual({ path: rootedAt });
  expect(contexts).toMatchObject({
    calls: [
      {
        name: DurableObjectNameCodec.address(rootedAt).name,
        expression: ["itx", ["whoami"]],
        caller,
      },
    ],
  });
});

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
  await serveSession(
    new Request("https://mind.example/itx", { headers: { upgrade: "websocket" } }),
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

/** The host's contexts for one test: each answers a call with its own path, and records it. */
function contextsThatAnswerTheirPath() {
  const host = env as { CONTEXTS?: unknown };
  const calls: { name: string; expression: unknown; caller: Caller }[] = [];
  host.CONTEXTS = {
    getByName: (name: string) => ({
      invokeSafe: async (expression: unknown, _args: unknown[], caller: Caller) => {
        calls.push({ name, expression, caller });
        return { ok: true, data: { path: DurableObjectNameCodec.parse(name).path } };
      },
    }),
  };
  return {
    calls,
    [Symbol.dispose]: () => void delete host.CONTEXTS,
  };
}

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
