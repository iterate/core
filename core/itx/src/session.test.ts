// The end of a WebSocket session whose peer went silent: the socket closes with 4000 and the
// teardown runs here, once. A Node test with a socket pair that never answers, the way a socket
// stays half open: what workerd does with a close frame nobody receives is out of scope.
import { expect, test, vi } from "vitest";
import { SILENCE } from "./end-when-silent.ts";
import { serveSession } from "./session.ts";

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
