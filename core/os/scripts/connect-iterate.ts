// connect-iterate.ts — A NODE PROGRAM'S CONNECTION TO THIS PLATFORM'S /api, as iterate/node had it
// before the project stack (whose iterate/node connects to a project): core/os's scripts and CI's.
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";
import type { IterateApi, SessionCredentials } from "iterate/api";
import { withTimeout } from "iterate/lib";

/** One connection to an Iterate deployment. Dispose the owner to close every child capability and its socket.
 * Operations are never retried: replaying a script could duplicate its effects. */
export type IterateConnection = Disposable & {
  session: Awaited<ReturnType<RpcStub<IterateApi>["authenticate"]>>;
  closed: Promise<{ code: number; reason: string }>;
};

// Explicit return type keeps declaration emit from expanding capnweb's recursive mapped types.
export async function connectIterate(input: {
  baseUrl: string;
  auth: SessionCredentials;
  /** the heartbeat's timing — a test's, `HEARTBEAT` below otherwise */
  heartbeat?: { intervalMs: number; deadAfterMs: number };
}): Promise<IterateConnection> {
  const url = new URL("/api", input.baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Iterate URL must use http or https.");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url.href, { handshakeTimeout: 15_000 });
  // ws implements the DOM event/send/close interface consumed by capnweb.
  const root = newWebSocketRpcSession<IterateApi>(socket as unknown as globalThis.WebSocket);
  let dead = "";
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => {
      resolve({ code, reason: dead || reason.toString() });
    });
  });
  // The transport surfaces failures through RPC and `closed`; ws also emits an EventEmitter error.
  socket.on("error", () => {});
  try {
    const session = await withTimeout(
      root.authenticate(input.auth),
      20_000,
      "Iterate authentication",
    );
    const heartbeat = startHeartbeat({
      beat: () => session.whoami(),
      onDead: (reason) => {
        dead = reason;
        socket.terminate();
      },
      timing: input.heartbeat,
    });
    void closed.then(() => heartbeat.stop());
    return {
      session,
      closed,
      [Symbol.dispose]() {
        try {
          session[Symbol.dispose]();
        } finally {
          try {
            root[Symbol.dispose]();
          } finally {
            socket.close();
          }
        }
      },
    };
  } catch (error) {
    try {
      root[Symbol.dispose]();
    } finally {
      socket.terminate();
    }
    throw error;
  }
}

/** THE CONNECTION'S HEARTBEAT: a cheap call on the session every `intervalMs` — `whoami()`, which
 *  the stateless Worker answers itself — and a socket that leaves one unanswered for `deadAfterMs`
 *  is dead (`onDead`), so its owner can reconnect.
 *
 *  It does two jobs. Cloudflare sheds a stateless Worker's WebSocket that it counts as idle: the
 *  runtime holds a request "in use" while its code handles a message from the socket, and a
 *  WebSocket ping never reaches that code, nor does a Worker's own timer count
 *  (tasks/complete/2026-11-05-api-websockets-load-shed.md). And a network that vanishes without a
 *  close — a laptop asleep, a NAT mapping expired, a shed whose close never arrives — otherwise
 *  leaves a socket that never sends, never receives and never closes. The beats are also the
 *  traffic that keeps a NAT mapping from expiring. */
const HEARTBEAT = { intervalMs: 30_000, deadAfterMs: 15_000 };

type Heartbeat = {
  /** A beat now, unless one is in flight: a page back from the background or a network that came
   *  back checks its socket before the person's next action hangs on a dead one. */
  beatNow(): void;
  stop(): void;
};

function startHeartbeat(input: {
  beat: () => PromiseLike<unknown>;
  onDead: (reason: string) => void;
  timing?: { intervalMs: number; deadAfterMs: number };
}): Heartbeat {
  const timing = input.timing || HEARTBEAT;
  let stopped = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const beatNow = () => {
    if (stopped || deadline) return;
    deadline = setTimeout(() => {
      stop();
      input.onDead(`no answer to a heartbeat for ${timing.deadAfterMs / 1000} s`);
    }, timing.deadAfterMs);
    unref(deadline);
    // A refused beat is an answer: the socket carried it both ways.
    void Promise.resolve(input.beat())
      .catch(() => {})
      .then(() => {
        clearTimeout(deadline);
        deadline = undefined;
      });
  };
  const interval = setInterval(beatNow, timing.intervalMs);
  unref(interval);
  function stop() {
    stopped = true;
    clearInterval(interval);
    clearTimeout(deadline);
  }
  return { beatNow, stop };
}

/** The heartbeat never keeps a finished script's process alive (Node; a browser's timers have no
 *  `unref`). */
function unref(timer: unknown) {
  (timer as { unref?: () => void }).unref?.();
}
