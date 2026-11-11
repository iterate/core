import { newWebSocketRpcSession, newWorkersRpcResponse, type RpcTarget } from "capnweb";
import type { Caller } from "./caller.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import { contexts } from "./host.ts";
import { IterateContextRpcTarget } from "./iterate-context.ts";

// The longest delay a timer takes (2^31 − 1 ms).
const MAX_TIMER_MS = 2 ** 31 - 1;

// A socket closes with 1008 (policy violation, RFC 6455 7.4.1) when the caller's credential ends.
export async function serveSession(
  request: Request,
  ctx: ExecutionContext,
  session: {
    caller: Caller;
    endsAt: number | null;
    endReason: string;
    root?: (context: IterateContextRpcTarget) => RpcTarget;
  },
): Promise<Response> {
  const teardown = new SessionTeardown();
  const context = new IterateContextRpcTarget(
    contexts(),
    DurableObjectNameCodec.address("/"),
    teardown,
    (promise) => ctx.waitUntil(promise),
    session.caller,
  );
  const root = session.root?.(context) ?? context;
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    try {
      return await newWorkersRpcResponse(request, root);
    } finally {
      teardown.disposeAll();
    }
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  newWebSocketRpcSession(server, root);
  const { endsAt, endReason } = session;
  const timer =
    endsAt &&
    setTimeout(
      () => server.close(1008, endReason),
      Math.max(0, Math.min(endsAt - Date.now(), MAX_TIMER_MS)),
    );
  const end = () => {
    if (timer) clearTimeout(timer);
    teardown.disposeAll();
  };
  server.addEventListener("close", end, { once: true });
  server.addEventListener("error", end, { once: true });
  return new Response(null, { status: 101, webSocket: client });
}

// Holds each lend relay so it is not GC'd. Re-adding a key is a reconnect: the incumbent is
// disposed, and the lease a stale handle holds cannot tear down its replacement.
export class SessionTeardown {
  readonly #undoByKey = new Map<string, { dispose(): void }>();
  add(key: string, undo: { dispose(): void }): { dispose(): void } {
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
    for (const undo of this.#undoByKey.values()) undo.dispose();
    this.#undoByKey.clear();
  }
}
