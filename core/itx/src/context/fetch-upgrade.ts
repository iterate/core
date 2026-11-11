// Workaround: Workers RPC cannot serialize a Response that carries a WebSocket (DataCloneError), so
// a lent stub's upgrade rides a dedicated fetch "leg" into the DO. Delete this file once it can.
import { z } from "zod";
import type { ItxExpression } from "iterate/expression";
import {
  contextAbortedOffsetOf,
  FETCH_UPGRADE_CONTEXT_ABORTED_OFFSET_HEADER,
  FETCH_UPGRADE_DEPLOY_ID_HEADER,
  FetchUpgradeSpliceEnd,
  reportFetchUpgradeSpliceEvent,
  type SpliceSocket,
  visitorEndOfSplice,
} from "./fetch-upgrade-splice.ts";
import { relayedCloseCode, truncateCloseReason } from "./websocket-close.ts";

export const FETCH_UPGRADE_SOCKET_HEADER = "x-itx-fetch-upgrade";
export const FETCH_UPGRADE_EYEBALL_HEADER = "x-itx-fetch-upgrade-eyeball";
// The edge's ask; the transport strips it before the provider sees the Request.
export const FETCH_UPGRADE_RESUMABLE_HEADER = "x-itx-fetch-upgrade-resumable";
const FETCH_UPGRADE_RESUME_HEADER = "x-itx-fetch-upgrade-resume";
const FetchUpgradeResume = z.object({
  upgradeId: z.string().min(1),
  path: z.string().startsWith("/"),
  deployId: z.string(),
});
type FetchUpgradeResume = z.infer<typeof FetchUpgradeResume>;

// Survives hibernation, so the upgrade does too. `replaced`: a re-dial of the same side took over,
// so this socket is neither a peer nor closes one.
type FetchUpgradeAttachment = {
  fetchUpgrade: { upgradeId: string; side: "eyeball" | "leg"; replaced?: true };
};
const upgradeTag = (side: "eyeball" | "leg", upgradeId: string) =>
  `itx-fetch-upgrade-${side}:${upgradeId}`;

type FetchUpgradeMarker = {
  webSocketUpgrade: true;
  headers: [name: string, value: string][];
};

// A browser that asked for a subprotocol fails the handshake on a 101 that names none. The runtime
// negotiates extensions and the accept key itself.
const FETCH_UPGRADE_RESPONSE_HEADERS = ["sec-websocket-protocol"];

export type RpcStubFetchTransport = {
  fetch(upgradeId: string, itxExpressionSteps: ItxExpression, request: Request): Promise<unknown>;
};

type ClientWebSocket = {
  accept?(): void;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    cb: (ev: { data?: unknown; code?: number; reason?: string }) => void,
  ): void;
};

// A native provider's socket answer still dies on its own RPC leg. A fix must not hand the
// upgradeId over in the Request headers: a provider that forwards its Request would smuggle it back.
export async function dialRpcStubFetch(
  providerFetch: (request: Request) => Promise<unknown>,
  request: Request,
  upgradeId: string,
  durableObjectStub: () => { fetch(url: string, init?: RequestInit): Promise<Response> },
): Promise<Response | FetchUpgradeMarker> {
  const resumable = request.headers.has(FETCH_UPGRADE_RESUMABLE_HEADER);
  if (resumable) {
    const headers = new Headers(request.headers);
    headers.delete(FETCH_UPGRADE_RESUMABLE_HEADER);
    request = new Request(request, { headers });
  }
  const response = (await providerFetch(request)) as {
    status?: number;
    headers?: Headers;
    webSocket?: ClientWebSocket | null;
  };
  const providerSocket = response?.webSocket;
  if (!providerSocket) return response as unknown as Response;
  // Leg first, listeners second, accept last: accepting before the leg's round trip would drop a
  // frame the provider sends at once (a server hello). The DO serves this upgrade mid-dial.
  const dialLeg = () =>
    durableObjectStub().fetch("https://fetch-upgrade.internal/", {
      headers: { Upgrade: "websocket", [FETCH_UPGRADE_SOCKET_HEADER]: upgradeId },
    });
  const legResponse = await dialLeg();
  const leg = legResponse.webSocket;
  if (!leg) throw new Error(`fetch-upgrade leg returned ${legResponse.status} without a WebSocket`);
  // Before `accept()`: the runtime's default is a Blob, and `send(blob)` writes "[object Blob]".
  (leg as { binaryType?: string }).binaryType = "arraybuffer";
  leg.accept();
  if (resumable) {
    new FetchUpgradeSpliceEnd({
      side: "leg",
      upgradeId,
      local: providerSocket as unknown as SpliceSocket,
      // the provider's socket closes without a status when the tunnel's session ends
      localGoneReason: "tunnel disconnected",
      socket: leg,
      deployId: legResponse.headers.get(FETCH_UPGRADE_DEPLOY_ID_HEADER),
      contextAbortedOffset: contextAbortedOffsetOf(legResponse),
      dial: dialLeg,
      report: reportFetchUpgradeSpliceEvent,
    });
  } else {
    const wire = (from: ClientWebSocket, to: ClientWebSocket) => {
      from.addEventListener("message", (ev) => {
        try {
          to.send(ev.data as string | ArrayBuffer);
        } catch {
          // peer closing: its close event tears the pair down
        }
      });
      from.addEventListener("close", (ev) => {
        try {
          to.close(relayedCloseCode(ev.code), truncateCloseReason(ev.reason || ""));
        } catch {
          // already closing
        }
      });
    };
    if ("binaryType" in providerSocket)
      (providerSocket as { binaryType?: string }).binaryType = "arraybuffer";
    wire(providerSocket, leg as unknown as ClientWebSocket);
    wire(leg as unknown as ClientWebSocket, providerSocket);
  }
  providerSocket.accept?.();
  const headers: [string, string][] = [];
  for (const name of FETCH_UPGRADE_RESPONSE_HEADERS) {
    const value = response.headers?.get(name);
    if (value) headers.push([name, value]);
  }
  return { webSocketUpgrade: true, headers };
}

export function spliceEyeballAnswer(
  answer: Response,
  contextOf: (path: string) => { fetch(url: string, init?: RequestInit): Promise<Response> },
): Response {
  const header = answer.headers.get(FETCH_UPGRADE_RESUME_HEADER);
  const eyeball = answer.webSocket;
  if (answer.status !== 101 || !eyeball || !header) return answer;
  const resume = FetchUpgradeResume.parse(JSON.parse(header));
  const headers = new Headers(answer.headers);
  headers.delete(FETCH_UPGRADE_RESUME_HEADER);
  headers.delete(FETCH_UPGRADE_CONTEXT_ABORTED_OFFSET_HEADER);
  const visitor = visitorEndOfSplice((local) => {
    eyeball.accept();
    new FetchUpgradeSpliceEnd({
      side: "eyeball",
      upgradeId: resume.upgradeId,
      local,
      localGoneReason: "visitor disconnected",
      socket: eyeball,
      deployId: resume.deployId,
      contextAbortedOffset: contextAbortedOffsetOf(answer),
      dial: () =>
        contextOf(resume.path).fetch("https://fetch-upgrade.internal/", {
          headers: { Upgrade: "websocket", [FETCH_UPGRADE_EYEBALL_HEADER]: resume.upgradeId },
        }),
      report: reportFetchUpgradeSpliceEvent,
    });
  });
  return new Response(null, { status: 101, webSocket: visitor, headers });
}

export class RpcStubFetchServer {
  readonly #ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;
  readonly #deployId: string;
  readonly #path: string;
  // read per answer: the wake record lands after construction
  readonly #contextAbortedOffset: () => number | null;

  constructor(
    ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">,
    context: { deployId: string; path: string; contextAbortedOffset: () => number | null },
  ) {
    this.#ctx = ctx;
    this.#deployId = context.deployId;
    this.#path = context.path;
    this.#contextAbortedOffset = context.contextAbortedOffset;
  }

  async serve(
    transport: RpcStubFetchTransport,
    itxExpressionSteps: ItxExpression,
    request: Request,
  ): Promise<unknown> {
    const upgradeId = crypto.randomUUID();
    const result = await transport.fetch(upgradeId, itxExpressionSteps, request);
    const marker = result as Partial<FetchUpgradeMarker> | null;
    if (marker?.webSocketUpgrade !== true) return result;
    const headers = [...(marker.headers || [])];
    if (request.headers.has(FETCH_UPGRADE_RESUMABLE_HEADER))
      headers.push([
        FETCH_UPGRADE_RESUME_HEADER,
        JSON.stringify({
          upgradeId,
          path: this.#path,
          deployId: this.#deployId,
        } satisfies FetchUpgradeResume),
      ]);
    return this.#acceptUpgradeSocket("eyeball", upgradeId, headers);
  }

  #acceptUpgradeSocket(
    side: "eyeball" | "leg",
    upgradeId: string,
    headers: [string, string][],
  ): Response {
    const pair = new WebSocketPair();
    this.#ctx.acceptWebSocket(pair[1], [upgradeTag(side, upgradeId)]);
    pair[1].serializeAttachment({
      fetchUpgrade: { upgradeId, side },
    } satisfies FetchUpgradeAttachment);
    const contextAbortedOffset = this.#contextAbortedOffset();
    const answerHeaders: [string, string][] =
      contextAbortedOffset === null
        ? headers
        : [...headers, [FETCH_UPGRADE_CONTEXT_ABORTED_OFFSET_HEADER, String(contextAbortedOffset)]];
    return new Response(null, { status: 101, webSocket: pair[0], headers: answerHeaders });
  }

  // The upgradeId, an unguessable UUID, is the only thing that gates a leg. The newest socket of a
  // side wins: an older one is replaced, closed without closing its peer.
  acceptFetchUpgradeLeg(request: Request): Response | null {
    const legUpgradeId = request.headers.get(FETCH_UPGRADE_SOCKET_HEADER);
    const eyeballUpgradeId = request.headers.get(FETCH_UPGRADE_EYEBALL_HEADER);
    if (!legUpgradeId && !eyeballUpgradeId) return null;
    const [side, upgradeId] = legUpgradeId
      ? ["leg" as const, legUpgradeId]
      : ["eyeball" as const, eyeballUpgradeId!];
    for (const older of this.#ctx.getWebSockets(upgradeTag(side, upgradeId))) {
      const attachment = older.deserializeAttachment() as FetchUpgradeAttachment;
      older.serializeAttachment({
        fetchUpgrade: { ...attachment.fetchUpgrade, replaced: true },
      } satisfies FetchUpgradeAttachment);
      try {
        older.close(1000, "replaced");
      } catch {
        // already closing
      }
    }
    return this.#acceptUpgradeSocket(side, upgradeId, [
      [FETCH_UPGRADE_DEPLOY_ID_HEADER, this.#deployId],
    ]);
  }

  handleWebSocketMessage(ws: WebSocket, data: string | ArrayBuffer): boolean {
    const peer = this.#peerOf(ws);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- #peerOf returns a real three-way: undefined = not ours, null = ours-but-peer-gone, WebSocket = live
    if (peer === undefined) return false;
    if (!peer) return true; // peer already gone — drop the frame; close handles teardown
    try {
      peer.send(data);
    } catch {
      // peer closing: its close event tears the pair down
    }
    return true;
  }

  handleWebSocketClose(ws: WebSocket, code = 1000, reason = ""): boolean {
    const peer = this.#peerOf(ws);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- #peerOf three-way: undefined = not ours (bail); null = ours-but-peer-gone (fall through to still close ws below)
    if (peer === undefined) return false;
    try {
      peer?.close(relayedCloseCode(code), truncateCloseReason(reason));
    } catch {
      // already closing
    }
    // workerd's hibernatable API does not echo a peer-initiated close: without this the initiator
    // never sees its close confirmed and hangs until its timeout.
    try {
      ws.close(relayedCloseCode(code), truncateCloseReason(reason));
    } catch {
      // already closing
    }
    return true;
  }

  // undefined: not ours; null: peer gone, or this socket was replaced
  #peerOf(ws: WebSocket): WebSocket | null | undefined {
    const upgrade = (ws.deserializeAttachment() as Partial<FetchUpgradeAttachment> | null)
      ?.fetchUpgrade;
    if (!upgrade) return undefined;
    if (upgrade.replaced) return null;
    const peerSide = upgrade.side === "eyeball" ? "leg" : "eyeball";
    return (
      this.#ctx
        .getWebSockets(upgradeTag(peerSide, upgrade.upgradeId))
        .find(
          (socket) =>
            !(socket.deserializeAttachment() as FetchUpgradeAttachment).fetchUpgrade.replaced,
        ) ?? null
    );
  }
}
