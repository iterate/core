// Each end is the platform's own stateless invocation, which outlives a DO reset (every deploy): it
// numbers its frames, keeps them until acknowledged, re-dials after a drop and resends the rest.
import { redial } from "./redial.ts";
import { DROPPED_CLOSE_CODE, relayedCloseCode, truncateCloseReason } from "./websocket-close.ts";

const FETCH_UPGRADE_RESUME_DEADLINE_MS = 30_000;
/** The runtime resets a context again after a deploy's first reset (seen 5 s to 90 s later). */
const DEPLOY_SETTLE_MS = 180_000;
const FETCH_UPGRADE_UNACKED_MAX_BYTES = 16 * 1024 * 1024;
const ACK_EVERY_BYTES = 256 * 1024;

// Wire, all binary: data [1 text|2 binary][seq f64][payload]; resume [3][received f64][1 reply|0 ask];
// ack [4][received f64]; close [5][code u16][reason]. A DO socket closed without `close` is a drop.
const KIND = { text: 1, binary: 2, resume: 3, ack: 4, close: 5 } as const;

export const FETCH_UPGRADE_DEPLOY_ID_HEADER = "x-itx-deploy-id";
export const FETCH_UPGRADE_CONTEXT_ABORTED_OFFSET_HEADER = "x-itx-context-aborted-offset";
export function contextAbortedOffsetOf(response: Pick<Response, "headers">): number | null {
  const offset = response.headers.get(FETCH_UPGRADE_CONTEXT_ABORTED_OFFSET_HEADER);
  return offset ? Number(offset) : null;
}

export type SpliceSocket = {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: Event) => void): void;
};

type SocketEventFields = { data?: unknown; code?: number; reason?: string };

type FetchUpgradeSpliceEvent =
  | {
      type: "resumed";
      side: FetchUpgradeSide;
      upgradeId: string;
      downMs: number;
      dials: number;
      resent: number;
      deployReset: boolean;
      contextAbortedOffset: number | null;
    }
  | {
      type: "gave-up";
      side: FetchUpgradeSide;
      upgradeId: string;
      downMs: number;
      dials: number;
      why: string;
    }
  | {
      type: "local-gone";
      side: FetchUpgradeSide;
      upgradeId: string;
      // undefined: it failed
      code: number | undefined;
    };

type FetchUpgradeSide = "eyeball" | "leg";

export class FetchUpgradeSpliceEnd {
  readonly #side: FetchUpgradeSide;
  readonly #upgradeId: string;
  readonly #local: SpliceSocket;
  readonly #localGoneReason: string;
  readonly #dial: () => Promise<Response>;
  readonly #report: (event: FetchUpgradeSpliceEvent) => void;

  #socket: SpliceSocket | null = null;
  #deployId: string | null;
  #contextAbortedOffset: number | null;
  #ended = false;

  #sentThrough = 0;
  readonly #unacked: { seq: number; frame: ArrayBuffer }[] = [];
  #unackedBytes = 0;

  #receivedThrough = 0;
  #receivedSinceAck = 0;
  #bytesSinceAck = 0;

  #downSince: number | null = null;
  #dials = 0;
  #deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(input: {
    side: FetchUpgradeSide;
    upgradeId: string;
    local: SpliceSocket;
    // given when the local socket's far side is gone (closed with no status, or failed)
    localGoneReason: string;
    socket: SpliceSocket;
    deployId: string | null;
    contextAbortedOffset: number | null;
    dial: () => Promise<Response>;
    report: (event: FetchUpgradeSpliceEvent) => void;
  }) {
    this.#side = input.side;
    this.#upgradeId = input.upgradeId;
    this.#local = input.local;
    this.#localGoneReason = input.localGoneReason;
    this.#dial = input.dial;
    this.#report = input.report;
    this.#deployId = input.deployId;
    this.#contextAbortedOffset = input.contextAbortedOffset;
    preferArrayBuffers(this.#local);
    this.#local.addEventListener("message", (event) =>
      this.#inOrder((event as SocketEventFields).data, (data) => this.#sendData(data)),
    );
    this.#local.addEventListener("close", (event) => {
      const { code, reason } = event as SocketEventFields;
      if (code === undefined || code === 1005 || code === 1006) this.#localGone(code);
      else this.#endLocally(code, reason);
    });
    this.#local.addEventListener("error", () => this.#localGone(undefined));
    // The first socket waits for the other end as a re-dialed one does: the relay's leg is up
    // before the edge's socket exists, and neither end may wait forever.
    this.#downSince = Date.now();
    this.#armDeadline();
    this.#attach(input.socket);
  }

  // A binary message the runtime hands over as a Blob is read first; every later message waits.
  #pending: Promise<void> | null = null;
  #inOrder(data: unknown, handle: (data: unknown) => void): void {
    if (!this.#pending && !(data instanceof Blob)) return handle(data);
    const previous = this.#pending || Promise.resolve();
    const next = previous
      .then(async () => handle(data instanceof Blob ? await data.arrayBuffer() : data))
      .catch(() => undefined)
      .finally(() => {
        if (this.#pending === next) this.#pending = null;
      });
    this.#pending = next;
  }

  #sendData(data: unknown): void {
    if (this.#ended || this.#closeFrame) return;
    const payload =
      typeof data === "string"
        ? { kind: KIND.text, bytes: new TextEncoder().encode(data) }
        : { kind: KIND.binary, bytes: bytesOf(data) };
    if (!payload.bytes) return;
    const seq = ++this.#sentThrough;
    const frame = new Uint8Array(9 + payload.bytes.byteLength);
    frame[0] = payload.kind;
    new DataView(frame.buffer).setFloat64(1, seq);
    frame.set(payload.bytes, 9);
    this.#unacked.push({ seq, frame: frame.buffer });
    this.#unackedBytes += frame.byteLength;
    if (this.#unackedBytes > FETCH_UPGRADE_UNACKED_MAX_BYTES) {
      this.#giveUp(
        `more than ${FETCH_UPGRADE_UNACKED_MAX_BYTES} bytes sent and not acknowledged by the other end`,
      );
      return;
    }
    this.#sendOnSocket(frame.buffer);
  }

  // Said in-band once the splice is whole, after everything sent before it.
  #endLocally(code: number | undefined, reason: string | undefined): void {
    if (this.#ended || this.#closeFrame) return;
    const reasonBytes = new TextEncoder().encode(truncateCloseReason(reason || ""));
    const frame = new Uint8Array(3 + reasonBytes.byteLength);
    frame[0] = KIND.close;
    new DataView(frame.buffer).setUint16(1, relayedCloseCode(code));
    frame.set(reasonBytes, 3);
    this.#closeFrame = frame.buffer;
    if (this.#downSince === null) this.#sendClose();
  }

  // Left open, the runtime's pump of the visitor's socket waits on it for good and fails the edge's
  // invocation as "hung".
  #localGone(code: number | undefined): void {
    if (this.#ended || this.#closeFrame) return;
    this.#report({ type: "local-gone", side: this.#side, upgradeId: this.#upgradeId, code });
    this.#endLocally(DROPPED_CLOSE_CODE, this.#localGoneReason);
    closeQuietly(this.#local, DROPPED_CLOSE_CODE, this.#localGoneReason);
  }

  #closeFrame: ArrayBuffer | null = null;

  #sendClose(): void {
    this.#ended = true;
    this.#clearDeadline();
    this.#sendOnSocket(this.#closeFrame!);
    closeQuietly(this.#socket, 1000, "closed");
    this.#socket = null;
  }

  #attach(socket: SpliceSocket): void {
    this.#socket = socket;
    preferArrayBuffers(socket);
    socket.addEventListener("message", (event) => {
      this.#inOrder((event as SocketEventFields).data, (data) => {
        if (this.#socket === socket) this.#receive(data);
      });
    });
    const dropped = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (!this.#ended) void this.#redialAfterDrop();
    };
    socket.addEventListener("close", dropped);
    socket.addEventListener("error", dropped);
    this.#sendOnSocket(controlFrame(KIND.resume, this.#receivedThrough, 0));
  }

  #receive(data: unknown): void {
    if (this.#ended) return;
    const bytes = bytesOf(data);
    if (!bytes || bytes.byteLength < 1) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kind = bytes[0];
    if (kind === KIND.text || kind === KIND.binary) {
      if (bytes.byteLength < 9) return;
      const seq = view.getFloat64(1);
      // a resend of a frame already delivered, or a live frame that overtook an earlier one's resend
      if (seq !== this.#receivedThrough + 1) return;
      this.#receivedThrough = seq;
      const payload = bytes.subarray(9);
      try {
        this.#local.send(
          kind === KIND.text ? new TextDecoder().decode(payload) : payload.slice().buffer,
        );
      } catch {
        // the local socket is closing: its close ends this end
      }
      this.#receivedSinceAck += 1;
      this.#bytesSinceAck += bytes.byteLength;
      if (this.#receivedSinceAck >= 32 || this.#bytesSinceAck >= ACK_EVERY_BYTES)
        this.#acknowledge();
      return;
    }
    if (kind === KIND.ack) {
      if (bytes.byteLength >= 9) this.#forgetThrough(view.getFloat64(1));
      return;
    }
    if (kind === KIND.resume) {
      if (bytes.byteLength < 10) return;
      this.#forgetThrough(view.getFloat64(1));
      for (const { frame } of this.#unacked) this.#sendOnSocket(frame);
      if (bytes[9] === 0) this.#sendOnSocket(controlFrame(KIND.resume, this.#receivedThrough, 1));
      this.#resumed();
      if (this.#closeFrame) this.#sendClose();
      return;
    }
    if (kind === KIND.close) {
      if (bytes.byteLength < 3) return;
      const code = view.getUint16(1);
      const reason = new TextDecoder().decode(bytes.subarray(3));
      this.#ended = true;
      this.#clearDeadline();
      closeQuietly(this.#local, relayedCloseCode(code), reason);
      closeQuietly(this.#socket, 1000, "closed");
      this.#socket = null;
    }
  }

  #acknowledge(): void {
    this.#receivedSinceAck = 0;
    this.#bytesSinceAck = 0;
    this.#sendOnSocket(controlFrame(KIND.ack, this.#receivedThrough));
  }

  #forgetThrough(seq: number): void {
    while (this.#unacked.length > 0 && this.#unacked[0]!.seq <= seq) {
      this.#unackedBytes -= this.#unacked.shift()!.frame.byteLength;
    }
  }

  #sendOnSocket(frame: ArrayBuffer): void {
    try {
      this.#socket?.send(frame);
    } catch {
      // the DO socket is closing: its close starts the re-dial, and the frame is still kept
    }
  }

  // The first resume after the first socket is the start, not a recovery.
  #resumed(): void {
    if (this.#downSince === null) return;
    const downMs = Date.now() - this.#downSince;
    const recovered = this.#dials > 0;
    this.#clearDeadline();
    this.#downSince = null;
    if (recovered)
      this.#report({
        type: "resumed",
        side: this.#side,
        upgradeId: this.#upgradeId,
        downMs,
        dials: this.#dials,
        resent: this.#unacked.length,
        deployReset:
          this.#deployReset ||
          (this.#deployChangedAt !== null && Date.now() - this.#deployChangedAt < DEPLOY_SETTLE_MS),
        contextAbortedOffset: this.#contextAbortReset,
      });
    this.#dials = 0;
    this.#deployReset = false;
    this.#contextAbortReset = null;
  }

  #deployReset = false;
  #deployChangedAt: number | null = null;
  #contextAbortReset: number | null = null;

  async #redialAfterDrop(): Promise<void> {
    if (this.#downSince === null) {
      this.#downSince = Date.now();
      this.#armDeadline();
    }
    const redialed = await redial(
      () => {
        this.#dials += 1;
        return this.#dial();
      },
      () => this.#ended,
      FETCH_UPGRADE_RESUME_DEADLINE_MS,
    );
    if (!redialed) return;
    if ("gaveUp" in redialed) {
      this.#giveUp(`the context answered no re-dial (${redialed.gaveUp})`);
      return;
    }
    const deployId = redialed.answer.headers.get(FETCH_UPGRADE_DEPLOY_ID_HEADER);
    const contextAbortedOffset = contextAbortedOffsetOf(redialed.answer);
    if (deployId !== this.#deployId) {
      this.#deployReset = true;
      this.#deployChangedAt = Date.now();
    }
    this.#deployId = deployId;
    if (contextAbortedOffset !== null && contextAbortedOffset !== this.#contextAbortedOffset)
      this.#contextAbortReset = contextAbortedOffset;
    this.#contextAbortedOffset = contextAbortedOffset;
    this.#attach(redialed.socket);
  }

  #armDeadline(): void {
    this.#clearDeadline();
    const downSince = this.#downSince!;
    this.#deadline = setTimeout(
      () => {
        this.#deadline = null;
        if (this.#downSince === downSince)
          this.#giveUp(
            `the other end did not resume within ${FETCH_UPGRADE_RESUME_DEADLINE_MS / 1000} s`,
          );
      },
      downSince + FETCH_UPGRADE_RESUME_DEADLINE_MS - Date.now(),
    );
  }

  #clearDeadline(): void {
    if (this.#deadline !== null) clearTimeout(this.#deadline);
    this.#deadline = null;
  }

  #giveUp(why: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#clearDeadline();
    this.#report({
      type: "gave-up",
      side: this.#side,
      upgradeId: this.#upgradeId,
      downMs: this.#downSince === null ? 0 : Date.now() - this.#downSince,
      dials: this.#dials,
      why,
    });
    closeQuietly(this.#local, DROPPED_CLOSE_CODE, truncateCloseReason(why));
    closeQuietly(this.#socket, DROPPED_CLOSE_CODE, "gave up");
    this.#socket = null;
  }
}

// Accept the DO socket in `splice` too: its frames wait unread until then.
export function visitorEndOfSplice(splice: (local: WebSocket) => void): WebSocket {
  const pair = new WebSocketPair();
  pair[1].accept();
  splice(pair[1]);
  return pair[0];
}

function preferArrayBuffers(socket: SpliceSocket): void {
  if ("binaryType" in socket) (socket as { binaryType: string }).binaryType = "arraybuffer";
}

function controlFrame(kind: number, seq: number, reply?: 0 | 1): ArrayBuffer {
  const frame = new Uint8Array(reply === undefined ? 9 : 10);
  frame[0] = kind;
  new DataView(frame.buffer).setFloat64(1, seq);
  if (reply !== undefined) frame[9] = reply;
  return frame.buffer;
}

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function closeQuietly(socket: SpliceSocket | null, code: number, reason: string): void {
  try {
    socket?.close(code, reason);
  } catch {
    // already closing
  }
}

// The prd fault alarm pages on a burst of `platform-failure` heals.
export function reportFetchUpgradeSpliceEvent(event: FetchUpgradeSpliceEvent): void {
  const { type, side, ...fields } = event;
  if (type === "local-gone") {
    console.info({
      event: "fetch-upgrade.local-gone",
      name: `fetch-upgrade-${side}`,
      message:
        side === "eyeball"
          ? "the visitor's connection ended without a close frame: the upgrade is closed"
          : "the provider's socket ended without a close frame (its tunnel's session ended): the upgrade is closed",
      ...fields,
    });
    return;
  }
  if (type === "gave-up") {
    console.warn({
      event: "fetch-upgrade.resume-gave-up",
      name: `fetch-upgrade-${side}`,
      message: "a resumable upgrade could not be resumed: its socket is closed",
      ...fields,
    });
    return;
  }
  if (event.deployReset)
    console.info({
      event: "fetch-upgrade.deploy-reset-resumed",
      name: `fetch-upgrade-${side}`,
      message: "a deploy reset the context's sockets; the upgrade resumed",
      ...fields,
    });
  else if (event.contextAbortedOffset !== null)
    console.info({
      event: "fetch-upgrade.context-abort-resumed",
      name: `fetch-upgrade-${side}`,
      message: "itx.abort() reset the context's sockets; the upgrade resumed",
      ...fields,
    });
  else
    console.warn({
      event: "fetch-upgrade.platform-failure-resumed",
      name: `fetch-upgrade-${side}`,
      message: "a context's socket dropped without a deploy; the upgrade resumed",
      ...fields,
    });
}
