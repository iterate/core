// The WebSocket opens through egress (`itx.fetch` with Upgrade), so secret headers substitute.
// A held WebSocket pins this context awake for its life; a batch connection pins nothing.
import { RpcSession, newWebSocketRpcSession, type RpcStub, type RpcTransport } from "capnweb";
import { InvokeHandle, walkStepsOnRpcStub } from "iterate/expression";
import type { CapnwebConnectOptions } from "iterate/api";
import type { LibraryItx } from "core-itx";
import { refuseUnlessOk, responseRefusal } from "./connection.ts";

type RemoteMain = RpcStub<any>;

/** The batch transport opens one session per chain: a capnweb batch is one POST and dies with it. */
export async function connectToCapnweb(
  itx: LibraryItx,
  url: string,
  options: CapnwebConnectOptions = {},
): Promise<CapnwebConnection> {
  const headers = options.headers || {};
  if (options.transport === "batch")
    return new CapnwebConnection(
      () => batchSessionOverEgress(itx, url, headers),
      () => undefined,
    );
  // A session gone (disposed or broken) reopens on the next call, so a held connection is never a
  // dead socket.
  type SessionStub = RemoteMain & { onRpcBroken?: (cb: () => void) => void };
  let session: SessionStub | undefined;
  // One reopen in flight at a time: each opening its own would leak every socket but the last.
  let reopening: Promise<SessionStub> | undefined;
  // A reopen that lands after a close disposes what it opened.
  let generation = 0;
  const dispose = (stub: SessionStub | undefined) =>
    (stub as unknown as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]?.();
  const open = async (): Promise<SessionStub> => {
    const stub = (await webSocketSessionOverEgress(itx, url, headers)) as SessionStub;
    stub.onRpcBroken?.(() => {
      if (session === stub) session = undefined;
    });
    return stub;
  };
  const reopen = async (): Promise<SessionStub> => {
    const startedIn = generation;
    try {
      const opened = await open();
      if (startedIn !== generation) {
        dispose(opened);
        throw new Error("capnweb connection closed while it was reconnecting");
      }
      session = opened;
      return opened;
    } finally {
      reopening = undefined;
    }
  };
  session = await open();
  return new CapnwebConnection(
    () => session ?? (reopening ||= reopen()),
    () => {
      generation += 1;
      const gone = session;
      session = undefined;
      dispose(gone);
    },
  );
}

export class CapnwebConnection extends InvokeHandle {
  readonly #closeSession: () => void;
  /** `remoteMain` answers synchronously while a session is open, so the walk queues the whole chain
   *  before any batch fires. */
  constructor(remoteMain: () => RemoteMain | Promise<RemoteMain>, closeSession: () => void) {
    super((steps) => {
      const main = remoteMain();
      return main instanceof Promise
        ? main.then((stub) => walkStepsOnRpcStub(stub, steps))
        : walkStepsOnRpcStub(main, steps);
    });
    this.#closeSession = closeSession;
  }
  /** Declared on purpose: the dotted fallback answers every unknown name remotely, and the pins'
   *  release probes for `close`. */
  close(): void {
    this.#closeSession();
  }
  [Symbol.dispose](): void {
    this.close();
  }
}

async function webSocketSessionOverEgress(
  itx: LibraryItx,
  url: string,
  headers: Record<string, string>,
): Promise<RemoteMain> {
  const httpUrl = url.replace(/^ws(s?):/i, "http$1:");
  const response = await itx.fetch(
    new Request(httpUrl, { headers: { ...headers, upgrade: "websocket" } }),
  );
  const webSocket = response.webSocket;
  if (response.status !== 101 || !webSocket)
    throw await responseRefusal(response, `connectToCapnweb: ${url} (no WebSocket)`);
  webSocket.accept();
  return newWebSocketRpcSession(webSocket as unknown as WebSocket);
}

function batchSessionOverEgress(
  itx: LibraryItx,
  url: string,
  headers: Record<string, string>,
): RemoteMain {
  const transport = new EgressBatchTransport(async (batch) => {
    const response = await itx.fetch(
      new Request(url, { method: "POST", headers, body: batch.join("\n") }),
    );
    await refuseUnlessOk(response, `connectToCapnweb: batch to ${url}`);
    const text = await response.text();
    return text === "" ? [] : text.split("\n");
  });
  return new RpcSession(transport).getRemoteMain();
}

/** capnweb's HTTP batch client transport, over `itx.fetch` instead of the global fetch. */
class EgressBatchTransport implements RpcTransport {
  #messagesToSend: string[] | null = [];
  #abortReason: unknown;
  readonly #answersReceived: Promise<string[]>;
  constructor(sendBatch: (batch: string[]) => Promise<string[]>) {
    this.#answersReceived = (async () => {
      // one macrotask, so every `.then()` on the pipelined promises registers before the batch goes
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.#abortReason !== undefined) throw this.#abortReason;
      const batch = this.#messagesToSend!;
      this.#messagesToSend = null;
      return sendBatch(batch);
    })();
  }
  async send(message: string) {
    if (this.#messagesToSend !== null) this.#messagesToSend.push(message);
  }
  async receive() {
    const received = await this.#answersReceived;
    const message = received.shift();
    // oxlint-disable-next-line iterate/simple-truthiness-check -- receive() is capnweb's RpcTransport contract: shift() returning undefined is the "batch drained" signal (throw), distinct from a frame value
    if (message === undefined) throw new Error("Batch RPC request ended.");
    return message;
  }
  abort(reason: unknown): void {
    this.#abortReason = reason;
  }
}
