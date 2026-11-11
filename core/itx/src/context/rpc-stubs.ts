import { failureKind } from "iterate/platform-retry";
import { codedError, errorCode, ITERATE_CAUSE_HEADER } from "iterate/lib";
import { ITERATE_ROUTING_SLUG_HEADER } from "iterate/mind-ingress";
import { ITX_PRINCIPAL_HEADER } from "iterate/principal";
import type { StreamEventInput } from "iterate/stream/processor";
import { parse, type ItxExpression } from "iterate/expression";
import { causeHeader } from "../cause.ts";
import {
  ITX_APP_HEADER,
  ITX_CALLER_PATH_HEADER,
  ITX_GRANT_HEADER,
  type Caller,
} from "../caller.ts";
import {
  FETCH_UPGRADE_EYEBALL_HEADER,
  FETCH_UPGRADE_SOCKET_HEADER,
  type RpcStubFetchServer,
  type RpcStubFetchTransport,
} from "./fetch-upgrade.ts";

export const RPC_STUB_PAGER_WEBSOCKET_HEADER = "x-itx-rpc-stub-pager";
export type RpcStubPagerAttachRequest = { rpcStubKey: string; appendEvents: StreamEventInput[] };
// URI-encoded (rpc-stub-relay.ts): a header is a ByteString, and a key or an event is not.
function decodeRpcStubPagerAttachRequest(header: string): RpcStubPagerAttachRequest {
  const decoded = JSON.parse(decodeURIComponent(header)) as Partial<RpcStubPagerAttachRequest>;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of JSON.parse output; the `Partial<...>` cast is a claim, not a guarantee
  if (typeof decoded?.rpcStubKey !== "string" || !Array.isArray(decoded.appendEvents))
    throw new Error("expected { rpcStubKey: string, appendEvents: [] }");
  return { rpcStubKey: decoded.rpcStubKey, appendEvents: decoded.appendEvents };
}
const RPC_STUB_PAGER_WEBSOCKET_TAG = "itx-rpc-stub-pager-websocket";
// Distinctive literals: the auto-response is DO-wide (fetch-upgrade sockets too), so a plain "ping"
// would hijack any client frame equal to it.
export const RPC_STUB_PAGER_KEEPALIVE_REQUEST = "itx-pager-keepalive";
export const RPC_STUB_PAGER_KEEPALIVE_RESPONSE = "itx-pager-keepalive-ack";
// The relay answers a page at once, so 10 s is a dead relay, not a slow one.
const RPC_STUB_PAGE_TIMEOUT_MS = 10_000;

export type BorrowedRpcStub = RpcStubFetchTransport & {
  invoke(itxExpressionSteps: ItxExpression): Promise<unknown>;
  dup?(): BorrowedRpcStub;
};

type RpcStubPagerRecord = { rpcStubKey: string };

export function disposeRpcStub(x: unknown): void {
  (x as Partial<Disposable> | null)?.[Symbol.dispose]?.();
}

export class RpcStubDirectory {
  readonly #ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;
  readonly #onPresence: (kind: "attached" | "detached", rpcStubKey: string) => void;
  readonly #rpcStubFetch: RpcStubFetchServer;

  // A borrowed stub pins the DO awake: stubs go back at the pins' release, never per call and never
  // on a timer of their own (a pending timer pins the DO out of hibernation too).
  readonly #borrowedRpcStubs = new Map<string, BorrowedRpcStub>();

  // concurrent cold invokes share one page: a second caller must never replace the first's resolver
  readonly #rpcStubPagesInFlight = new Map<
    string,
    {
      resolve(): void;
      reject(e: Error): void;
      timer: ReturnType<typeof setTimeout>;
      arrived: Promise<void>;
    }
  >();
  // workerd may deliver both webSocketError and webSocketClose for one drop
  readonly #closedRpcStubPagerSockets = new WeakSet<WebSocket>();

  readonly #appendEvents: (events: StreamEventInput[]) => void;

  constructor(deps: {
    ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;
    onPresence: (kind: "attached" | "detached", rpcStubKey: string) => void;
    rpcStubFetch: RpcStubFetchServer;
    appendEvents: (events: StreamEventInput[]) => void;
  }) {
    this.#ctx = deps.ctx;
    this.#onPresence = deps.onPresence;
    this.#rpcStubFetch = deps.rpcStubFetch;
    this.#appendEvents = deps.appendEvents;
  }

  lendRpcStub(input: { rpcStubKey: string; stub: BorrowedRpcStub }): void {
    const previous = this.#borrowedRpcStubs.get(input.rpcStubKey);
    this.#borrowedRpcStubs.set(input.rpcStubKey, input.stub.dup?.() ?? input.stub);
    if (previous) disposeRpcStub(previous);
    const page = this.#rpcStubPagesInFlight.get(input.rpcStubKey);
    if (page) {
      clearTimeout(page.timer);
      this.#rpcStubPagesInFlight.delete(input.rpcStubKey);
      page.resolve();
    }
  }

  async invokeRpcStub(rpcStubKey: string, itxExpressionSteps: ItxExpression): Promise<unknown> {
    let borrowed = this.#borrowedRpcStubs.get(rpcStubKey);
    if (!borrowed && this.#rpcStubPagerFor(rpcStubKey))
      borrowed = await this.#pageRpcStub(rpcStubKey);
    if (!borrowed)
      throw codedError("RPC_STUB_OFFLINE", `rpc stub ${JSON.stringify(rpcStubKey)} is offline`);
    try {
      const terminalFetch = terminalFetchOf(itxExpressionSteps, []);
      if (terminalFetch)
        return await this.#rpcStubFetch.serve(borrowed, terminalFetch.steps, terminalFetch.request);
      return await borrowed.invoke(itxExpressionSteps);
    } catch (error) {
      // A broken stub is dropped (the next call pages again), only if it is still the one this call
      // rode. A lost connection is the lender gone mid-call: coded offline, never an uncoded 500.
      const kind = failureKind(error);
      if (kind !== "disconnected" && kind !== "deploy-reset") throw error;
      if (this.#borrowedRpcStubs.get(rpcStubKey) === borrowed) {
        this.#borrowedRpcStubs.delete(rpcStubKey);
        disposeRpcStub(borrowed);
      }
      throw codedError(
        "RPC_STUB_OFFLINE",
        `rpc stub ${JSON.stringify(rpcStubKey)} went offline mid-call (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  hasBorrowedRpcStubs(): boolean {
    return this.#borrowedRpcStubs.size > 0;
  }

  returnBorrowedRpcStubs(): void {
    for (const rpcStubKey of this.#borrowedRpcStubs.keys()) this.#returnBorrowedRpcStub(rpcStubKey);
  }

  // Accept, append and stamp in one synchronous turn, so a refused append leaves no socket, no
  // presence and no row.
  acceptRpcStubPagerWebSocket(request: Request): Response | null {
    const header = request.headers.get(RPC_STUB_PAGER_WEBSOCKET_HEADER);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an ABSENT header (null) means "not this request"; a present-but-empty one is malformed input that must fall through to the parse/tag below and be refused, never quietly treated as absent (the same present-vs-absent distinction the DO's `fetch` keeps)
    if (header === null) return null;
    let attachRequest: RpcStubPagerAttachRequest;
    try {
      attachRequest = decodeRpcStubPagerAttachRequest(header);
    } catch (error) {
      return new Response(
        `malformed ${RPC_STUB_PAGER_WEBSOCKET_HEADER} header: ${error instanceof Error ? error.message : String(error)}\n`,
        { status: 400 },
      );
    }
    const { rpcStubKey, appendEvents } = attachRequest;
    const hadPager = this.#rpcStubPagerFor(rpcStubKey) !== undefined;
    const pair = new WebSocketPair();
    this.#ctx.acceptWebSocket(pair[1], [RPC_STUB_PAGER_WEBSOCKET_TAG]);
    pair[1].serializeAttachment({ rpcStubKey } satisfies RpcStubPagerRecord);
    // The set half, with the pager already accepted, so a push the commit fans out finds it.
    try {
      if (appendEvents.length > 0) this.#appendEvents(appendEvents);
    } catch (error) {
      this.#closedRpcStubPagerSockets.add(pair[1]); // its close must not report a presence it never had
      try {
        pair[1].close(1011, "attach refused");
      } catch {
        // already closing
      }
      // 409 = a coded refusal (STREAM_PAUSED), which the relay re-throws to the caller; 500 = uncoded.
      const code = errorCode(error);
      return Response.json(
        { code: code || null, message: error instanceof Error ? error.message : String(error) },
        { status: code ? 409 : 500 },
      );
    }
    // One pager per key, the newest winning, enforced once it is visible (a concurrent provide's is
    // not yet). A page in flight is the key's, so it is sent again down this pager.
    for (const ws of this.#rpcStubPagerSockets())
      if (ws !== pair[1] && this.#rpcStubPagerRecord(ws).rpcStubKey === rpcStubKey)
        this.#dropReplacedRpcStubPager(ws);
    if (this.#rpcStubPagesInFlight.has(rpcStubKey)) pair[1].send(JSON.stringify({ type: "page" }));
    if (!hadPager) this.#onPresence("attached", rpcStubKey);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Wire after the DO's own rpc-stub-fetch close routing.
  rpcStubPagerClosed(ws: WebSocket): void {
    if (this.#closedRpcStubPagerSockets.has(ws)) return;
    this.#closedRpcStubPagerSockets.add(ws);
    const { rpcStubKey } = this.#rpcStubPagerRecord(ws);
    if (this.#rpcStubPagerFor(rpcStubKey)) return;
    this.#returnRpcStubAndFailItsPage(rpcStubKey);
    this.#onPresence("detached", rpcStubKey);
  }

  #dropReplacedRpcStubPager(ws: WebSocket): void {
    this.#closedRpcStubPagerSockets.add(ws); // its late close event must not touch the key again
    try {
      ws.close(1000, "replaced");
    } catch {
      // already closing
    }
    this.#returnBorrowedRpcStub(this.#rpcStubPagerRecord(ws).rpcStubKey);
  }

  listRpcStubKeys(): string[] {
    return [
      ...new Set([
        ...this.#borrowedRpcStubs.keys(),
        ...this.#rpcStubPagerRecords().map((record) => record.rpcStubKey),
      ]),
    ];
  }

  #rpcStubPagerSockets(): WebSocket[] {
    return this.#ctx
      .getWebSockets(RPC_STUB_PAGER_WEBSOCKET_TAG)
      .filter((ws) => ws.readyState === WebSocket.OPEN);
  }
  #rpcStubPagerRecords(): RpcStubPagerRecord[] {
    return this.#rpcStubPagerSockets().map((ws) => this.#rpcStubPagerRecord(ws));
  }
  #rpcStubPagerFor(rpcStubKey: string): WebSocket | undefined {
    return this.#rpcStubPagerSockets().find(
      (ws) => this.#rpcStubPagerRecord(ws).rpcStubKey === rpcStubKey,
    );
  }
  #rpcStubPagerRecord(ws: WebSocket): RpcStubPagerRecord {
    return ws.deserializeAttachment() as RpcStubPagerRecord;
  }

  async #pageRpcStub(rpcStubKey: string): Promise<BorrowedRpcStub> {
    let page = this.#rpcStubPagesInFlight.get(rpcStubKey);
    if (!page) {
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const arrived = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const timer = setTimeout(() => {
        if (!this.#rpcStubPagesInFlight.delete(rpcStubKey)) return;
        // A push it carried is lost: delivery treats RPC_STUB_OFFLINE as heal-by-read, so this line
        // is the only trace of it.
        console.warn({
          event: "rpc-stub-page-timed-out",
          namespace: "rpc-stubs",
          message:
            "a paged relay did not lend within the page timeout: the calls waiting on it fail",
          rpcStubKey,
          waitedMs: RPC_STUB_PAGE_TIMEOUT_MS,
        });
        reject(
          codedError("RPC_STUB_OFFLINE", `rpc stub ${JSON.stringify(rpcStubKey)}: page timed out`),
        );
      }, RPC_STUB_PAGE_TIMEOUT_MS);
      page = { resolve, reject, timer, arrived };
      this.#rpcStubPagesInFlight.set(rpcStubKey, page);
      const ws = this.#rpcStubPagerFor(rpcStubKey)!;
      try {
        ws.send(JSON.stringify({ type: "page" }));
      } catch {
        ws.close(1011, "page send failed");
      }
    }
    await page.arrived;
    const borrowed = this.#borrowedRpcStubs.get(rpcStubKey);
    if (!borrowed)
      throw codedError(
        "RPC_STUB_OFFLINE",
        `rpc stub ${JSON.stringify(rpcStubKey)}: page answered empty`,
      );
    return borrowed;
  }

  #returnBorrowedRpcStub(rpcStubKey: string): void {
    const borrowed = this.#borrowedRpcStubs.get(rpcStubKey);
    if (!borrowed) return;
    this.#borrowedRpcStubs.delete(rpcStubKey);
    disposeRpcStub(borrowed);
  }

  #returnRpcStubAndFailItsPage(rpcStubKey: string): void {
    this.#returnBorrowedRpcStub(rpcStubKey);
    const page = this.#rpcStubPagesInFlight.get(rpcStubKey);
    if (page) {
      clearTimeout(page.timer);
      this.#rpcStubPagesInFlight.delete(rpcStubKey);
      page.reject(
        codedError("RPC_STUB_OFFLINE", `rpc stub ${JSON.stringify(rpcStubKey)} went offline`),
      );
    }
  }
}

export const ITX_EXPRESSION_FETCH_HEADER = "x-itx-expression";

// Every hop that forwards a Request stamps through here, so a Request's own copy of a header the
// DO's fetch trusts never survives. `null`: a Request leaving the platform.
export function stampCallerHeaders(headers: Headers, caller: Caller | null): void {
  for (const name of [
    ITX_PRINCIPAL_HEADER,
    ITX_GRANT_HEADER,
    ITX_CALLER_PATH_HEADER,
    ITX_APP_HEADER,
    RPC_STUB_PAGER_WEBSOCKET_HEADER,
    FETCH_UPGRADE_SOCKET_HEADER,
    FETCH_UPGRADE_EYEBALL_HEADER,
    ITERATE_CAUSE_HEADER,
    ITX_EXPRESSION_FETCH_HEADER,
  ])
    headers.delete(name);
  if (!caller) {
    headers.delete(ITERATE_ROUTING_SLUG_HEADER);
    return;
  }
  if (caller.cause) headers.set(ITERATE_CAUSE_HEADER, causeHeader(caller.cause));
  if (caller.principal) headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(caller.principal));
  if (caller.grant) headers.set(ITX_GRANT_HEADER, caller.grant);
  if (caller.path) headers.set(ITX_CALLER_PATH_HEADER, caller.path);
  if (caller.app) headers.set(ITX_APP_HEADER, "1");
}

// Untrusted: shape-checked by the resolver and walled before anything runs.
export function parseFetchExpression(header: string): ItxExpression {
  try {
    return header.trimStart().startsWith("[")
      ? (JSON.parse(header) as ItxExpression)
      : parse(header);
  } catch (error) {
    throw codedError(
      "INVALID_INPUT",
      `x-itx-expression ${JSON.stringify(header.slice(0, 200))} is no itx expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// JSON in an HTTP header must be ASCII; inline worker source may contain any Unicode text.
export function encodeFetchExpression(expression: ItxExpression): string {
  return JSON.stringify(expression).replace(
    /[\u0080-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function splitTerminalFetch(
  expression: ItxExpression,
): { steps: ItxExpression; fetchArgs: unknown[] } | null {
  const last = expression.at(-1);
  if (last === "fetch") return { steps: expression.slice(0, -1), fetchArgs: [] };
  if (Array.isArray(last) && last[0] === "fetch")
    return { steps: expression.slice(0, -1), fetchArgs: last.slice(1) };
  return null;
}

// The live Request always rides as the runtime arg, never as expression data.
export function itxExpressionEndingInFetch(expr: ItxExpression): ItxExpression {
  const terminal = splitTerminalFetch(expr);
  if (terminal && terminal.fetchArgs.length > 0)
    throw new Error(
      `fetch takes no expression args — the live Request rides in as the runtime arg (got ${JSON.stringify(terminal.fetchArgs)})`,
    );
  return [...(terminal?.steps || expr), "fetch"];
}

export function terminalFetchOf(
  expression: ItxExpression,
  args: unknown[],
): { steps: ItxExpression; request: Request } | null {
  const terminal = splitTerminalFetch(expression);
  if (!terminal) return null;
  const [request, ...rest] = [...terminal.fetchArgs, ...args];
  return rest.length === 0 && request instanceof Request
    ? { steps: terminal.steps, request }
    : null;
}
