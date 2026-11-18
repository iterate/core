import { newWebSocketRpcSession, type RpcTarget } from "capnweb";
import type { Caller } from "./caller.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import { disposeRpcStub } from "./context/rpc-stubs.ts";
import { endWhenSilent } from "./end-when-silent.ts";
import { truncateCloseReason } from "./context/websocket-close.ts";
import { contexts } from "./host.ts";
import { IterateContextRpcTarget } from "./iterate-context.ts";

// The longest delay a timer takes (2^31 − 1 ms).
const MAX_TIMER_MS = 2 ** 31 - 1;

// A SESSION THAT ENDS IN THE MIND'S OWN WORKER: a page of one of the mind's hostnames opens it
// (./serve-host.ts `itxSession`, ./person-context.ts), and each caller has checked that the request
// is a WebSocket upgrade. A session of the API ends in the boundary (./iterate-context.ts
// `sessionContext`). The socket closes with 1008 (policy violation, RFC 6455 7.4.1) when the
// caller's credential ends.
export function serveSession(
  ctx: ExecutionContext,
  session: {
    caller: Caller;
    endsAt: number | null;
    endReason: string;
    // The context the session's root is, `/` with none. A `cd` from `/` is not the same: the first
    // hop would stamp `/` as the origin of what the session writes.
    path?: string;
    // Told of each message the client sends on a socket. A reason it answers ends the session.
    onFrame?: () => string | void | Promise<string | void>;
    // `teardown` ends with the session: a lend made through another caller on it ends with it too.
    root?: (context: IterateContextRpcTarget, teardown: SessionTeardown) => RpcTarget;
  },
): Response {
  const teardown = new SessionTeardown();
  const context = new IterateContextRpcTarget(
    contexts(),
    DurableObjectNameCodec.address(session.path || "/"),
    teardown,
    (promise) => ctx.waitUntil(promise),
    session.caller,
  );
  const root = session.root?.(context, teardown) ?? context;
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  // The peer's main: a stub here only to probe (`silence` below). The cast: capnweb types an
  // untyped peer's main with no members, and the probe calls one that no peer need have.
  const peer = newWebSocketRpcSession(server, root) as unknown as {
    itxLivenessProbe(): Promise<unknown>;
  };
  const { endsAt, endReason, onFrame } = session;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    silence.stop();
    teardown.disposeAll();
  };
  // A socket this side closes may be half open, and then its `close` event never comes: the
  // session ends here, and the later event finds it ended.
  const closeAndEnd = (code: number, reason: string) => {
    end();
    server.close(code, reason);
  };
  if (onFrame) endedByFrames(server, onFrame, closeAndEnd);
  const timer =
    endsAt &&
    setTimeout(
      () => closeAndEnd(1008, endReason),
      Math.max(0, Math.min(endsAt - Date.now(), MAX_TIMER_MS)),
    );
  const silence = endWhenSilent({
    // Any answer is a frame from the peer, a rejection too: a capnweb peer answers a member it
    // has not got, or a call on a main it never gave, with an error. Each answer is heard below.
    probe: () =>
      void Promise.resolve()
        .then(() => peer.itxLivenessProbe())
        .then(disposeRpcStub, () => {}),
    end: (silentMs) => {
      console.info({
        event: "session-silent-ended",
        namespace: "session",
        message: "a session's peer sent nothing and answered no probe; the session ended",
        silentMs,
      });
      // Not 1008, which a page reads as the end of its sign-in: a page that is still there dials
      // again.
      closeAndEnd(4000, "the peer went silent: dial again");
    },
  });
  // capnweb has its own listener: this one only marks the time
  server.addEventListener("message", () => silence.heard());
  server.addEventListener("close", end, { once: true });
  server.addEventListener("error", end, { once: true });
  return new Response(null, { status: 101, webSocket: client });
}

// A watcher that throws ends nothing: the session goes on, and the next frame asks again. Nor does
// a close that throws: a socket that is closing already takes no second close.
export function endedByFrames(
  socket: Pick<WebSocket, "addEventListener">,
  onFrame: () => string | void | Promise<string | void>,
  close: (code: number, reason: string) => void,
): void {
  socket.addEventListener("message", () => {
    void Promise.resolve()
      .then(onFrame)
      .then((reason) => reason && close(1008, truncateCloseReason(reason)))
      .catch(() => undefined);
  });
}

// Holds each lend relay so it is not GC'd. Re-adding a key is a reconnect: the incumbent is
// disposed, and the lease a stale handle holds cannot tear down its replacement.
//
// `disposeAll` is the session's end, and it is final: a lend whose attach was still on its way
// then (./iterate-context.ts `provide` awaits the pager's dial) registers after it, with nothing
// left to close its pager. Such a lend is closed as it registers.
export class SessionTeardown {
  readonly #undoByKey = new Map<string, { dispose(): void }>();
  #over = false;
  add(key: string, undo: { dispose(): void }): { dispose(): void } {
    if (this.#over) {
      undo.dispose();
      return { dispose: () => {} };
    }
    this.#undoByKey.get(key)?.dispose();
    this.#undoByKey.set(key, undo);
    return {
      dispose: () => {
        if (this.#undoByKey.get(key) !== undo) return;
        this.#undoByKey.delete(key);
        undo.dispose();
      },
    };
  }
  dispose(key: string): void {
    const undo = this.#undoByKey.get(key);
    if (!undo) return;
    this.#undoByKey.delete(key);
    undo.dispose();
  }
  disposeAll(): void {
    this.#over = true;
    for (const undo of this.#undoByKey.values()) undo.dispose();
    this.#undoByKey.clear();
  }
}
