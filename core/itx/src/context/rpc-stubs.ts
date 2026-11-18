import { failureKind } from "iterate/platform-retry";
import { codedError, errorCode, ITERATE_CAUSE_HEADER } from "iterate/lib";
import { ITERATE_ROUTING_SLUG_HEADER } from "iterate/mind-ingress";
import { ITX_PERSON_HEADER, ITX_PRINCIPAL_HEADER } from "iterate/principal";
import type { StreamEventInput } from "iterate/stream/processor";
import type { RewriteRuleConfigured } from "iterate/api";
import {
  canonicalItxExpressionPrefix,
  normalizedItxExpression,
  parse,
  print,
  type ItxExpression,
  type ItxExpressionInput,
} from "iterate/expression";
import { z } from "zod";
import { causeHeader } from "../cause.ts";
import {
  ITX_APP_HEADER,
  ITX_CALLER_PATH_HEADER,
  ITX_RUNS_ROW_HEADER,
  ITX_GRANT_HEADER,
  type Caller,
} from "../caller.ts";
import { OnBehalfOfStamp, PrincipalStamp } from "../on-behalf-of.ts";
import {
  FETCH_UPGRADE_EYEBALL_HEADER,
  FETCH_UPGRADE_SOCKET_HEADER,
  type RpcStubFetchServer,
  type RpcStubFetchTransport,
} from "./fetch-upgrade.ts";
import {
  type ItxExpressionRewriteRule,
  normalizeRewriteRuleConfigured,
} from "./itx-expression-rewriting.ts";

export const RPC_STUB_PAGER_WEBSOCKET_HEADER = "x-itx-rpc-stub-pager";
// `redial`: the lender's session lost its pager and dials again, with the events of its first dial.
// `onlyFrom`: the lender (a row's `lentBy`) this attach may take the name's lend from, on a lend
// that takes a lent name only from itself (`appendAtAttach`).
// `lenderStamp`: who lends, as the lender's session knows its caller; the attach stamps each event
// it appends with it, as an append by that caller is stamped (caller.ts `stampCaller`).
export type RpcStubPagerAttachRequest = {
  rpcStubKey: string;
  appendEvents: StreamEventInput[];
  redial?: boolean;
  onlyFrom?: string;
  lenderStamp?: LenderStamp;
};
/** The part of a `Caller` that names who it is, and nothing that gives it power (`platform`,
 *  `app`, `config`, `signer`, `approvedAct`, `runsRow`, `path`, `delivery`). */
export type LenderStamp = Pick<Caller, "principal" | "grant" | "via" | "onBehalfOf">;
const LenderStampHeader = z.object({
  principal: PrincipalStamp.nullable(),
  grant: z.string().optional(),
  via: z.object({ appPage: z.string() }).optional(),
  onBehalfOf: OnBehalfOfStamp.optional(),
});
/** WHETHER AN EVENT IS A LEND'S OWN ROW, one that its attach may set and stamp with its lender
 *  (iterate-context.ts `provide` and `subscribe` write no other): the rule at the key whose target
 *  is the stub under it, the subscription `subscription:<name>` that delivers to the stub under
 *  it, or a fetch route whose target is the key's own name. The attach stamps what it appends
 *  with who lends, and readers trust that stamp by the event's type (a run's requester, a
 *  message's speaker): so an attach appends nothing else. */
export function isRowOfLend(event: unknown, rpcStubKey: string): boolean {
  const row = RowOfLend.safeParse(event);
  if (!row.success) return false;
  const { type, payload } = row.data;
  const targets = (expected: ItxExpressionInput) =>
    print(normalizedItxExpression(payload.target)) === print(normalizedItxExpression(expected));
  const stub: ItxExpression = ["itx", "builtins", "rpcStubs", ["get", rpcStubKey]];
  try {
    if (type === "events.iterate.com/itx/rewrite-rule-configured")
      return canonicalItxExpressionPrefix(payload.match) === rpcStubKey && targets(stub);
    if (type === "events.iterate.com/itx/subscription-configured")
      return rpcStubKey === `subscription:${payload.name}` && targets(stub);
    return targets(rpcStubKey);
  } catch {
    // a match or a target that is no expression is no row of the lend
    return false;
  }
}
// An expression as a row's payload holds one, its text or its steps: the codec says whether it
// is one (as fetch-routes.ts `FetchRouteTarget` does).
const ExpressionInput = z.custom<ItxExpressionInput>((value) => {
  try {
    // the cast: the codec checks what it is given, and throws on anything that is no expression
    normalizedItxExpression(value as ItxExpressionInput);
    return true;
  } catch {
    return false;
  }
});
const RowOfLend = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("events.iterate.com/itx/rewrite-rule-configured"),
    payload: z.looseObject({ match: ExpressionInput, target: ExpressionInput }),
  }),
  z.object({
    type: z.literal("events.iterate.com/itx/subscription-configured"),
    payload: z.looseObject({ name: z.string(), target: ExpressionInput }),
  }),
  z.object({
    type: z.literal("events.iterate.com/itx/fetch-route-configured"),
    payload: z.looseObject({ target: ExpressionInput }),
  }),
]);

// URI-encoded (rpc-stub-relay.ts): a header is a ByteString, and a key or an event is not.
// Only the kernel's own pager dial sets this header: every hop that forwards a Request strips it
// (`stampCallerHeaders`), and the boundary strips every `x-itx-*` a caller sends. So a header
// that does not read as the kernel writes it is a defect, and throws: the attach answers 400.
function decodeRpcStubPagerAttachRequest(header: string): RpcStubPagerAttachRequest {
  const decoded = JSON.parse(decodeURIComponent(header)) as Partial<RpcStubPagerAttachRequest>;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of JSON.parse output; the `Partial<...>` cast is a claim, not a guarantee
  if (typeof decoded?.rpcStubKey !== "string" || !Array.isArray(decoded.appendEvents))
    throw new Error("expected { rpcStubKey: string, appendEvents: [] }");
  const { rpcStubKey } = decoded;
  const foreign = decoded.appendEvents.findIndex((event) => !isRowOfLend(event, rpcStubKey));
  if (foreign !== -1)
    throw new Error(
      `appendEvents[${foreign}] is no row of the lend ${JSON.stringify(rpcStubKey)}: an attach appends its lend's own rows alone`,
    );
  // An absent stamp is a lender's session from before the stamp (the attach then stamps nobody);
  // one that is present and does not parse is never taken for an absent one.
  const lenderStamp = LenderStampHeader.optional().safeParse(decoded.lenderStamp);
  if (!lenderStamp.success)
    throw new Error(
      `a lenderStamp that names nobody the context can stamp: ${z.prettifyError(lenderStamp.error)}`,
    );
  return {
    rpcStubKey,
    appendEvents: decoded.appendEvents,
    redial: decoded.redial === true,
    // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of JSON.parse output, as above: a present non-string is dropped, never coerced
    ...(typeof decoded.onlyFrom === "string" && { onlyFrom: decoded.onlyFrom }),
    lenderStamp: lenderStamp.data,
  };
}

/** What a pager's close un-set for one lent key, as the context records it until the key's next
 *  attach: the rules by their match, the subscriptions and the fetch routes by their name. */
export type UnsetByClose = { rules: string[]; subscriptions: string[]; fetchRoutes: string[] };

/** The record as stored. A list alone is a record from before it held more than rules. */
export function unsetByClose(stored: UnsetByClose | string[] | undefined): UnsetByClose {
  if (Array.isArray(stored)) return { rules: stored, subscriptions: [], fetchRoutes: [] };
  return stored || { rules: [], subscriptions: [], fetchRoutes: [] };
}

/** WHAT A REDIAL SETS AGAIN: its events, less each row that is not this lend's to set. A lend's
 *  rows are its rule, the subscription that delivers to its callback, and its fetch route. A row
 *  that names something else now stays as it is: someone pointed the name elsewhere or masked it
 *  while the pager was down. A name with no row takes the row only when the context itself un-set
 *  it at the pager's close (`unset`, the context's own record): with no such record somebody
 *  removed the row, and that is their word too. The lend then comes back without it, and its
 *  lender lends again to ask for it. A row that is still this lend's is set again. */
export function eventsOfARedial(
  events: StreamEventInput[],
  rows: {
    rules: readonly ItxExpressionRewriteRule[];
    subscriptionTargets: Readonly<Record<string, ItxExpression>>;
    fetchRouteTargets: Readonly<Record<string, ItxExpression>>;
  },
  unset: UnsetByClose,
): StreamEventInput[] {
  /** Whether the row is this lend's to set: the same target still, or gone by the close alone. */
  const own = (row: ItxExpression | null | undefined, target: unknown, unsetHere: boolean) =>
    // oxlint-disable-next-line iterate/simple-truthiness-check -- undefined is no row; null is a mask, which is a row and somebody's word
    row === undefined
      ? unsetHere
      : !!row &&
        !!target &&
        // `target` is the target of one of the lender's own events (WHY THE CASTS ARE SAFE,
        // below): an expression, in any of its spellings
        print(row) === print(normalizedItxExpression(target as ItxExpressionInput));
  return events.filter((event) => {
    // WHY THE CASTS ARE SAFE, here and in `own`: the lender's own session wrote each event
    // (iterate-context.ts `provide` and `subscribe`), as a row of the kind its type names.
    if (event.type === "events.iterate.com/itx/rewrite-rule-configured") {
      const { match, target } = normalizeRewriteRuleConfigured(
        event.payload as RewriteRuleConfigured,
      );
      const row = rows.rules.find((rule) => print(rule.match) === print(match));
      return own(row && row.target, target, unset.rules.includes(print(match)));
    }
    if (event.type === "events.iterate.com/itx/subscription-configured") {
      // the lender's own row of this type (above)
      const { name, target } = event.payload as { name: string; target: unknown };
      const row = Object.hasOwn(rows.subscriptionTargets, name)
        ? rows.subscriptionTargets[name]
        : undefined;
      return own(row, target, unset.subscriptions.includes(name));
    }
    if (event.type === "events.iterate.com/itx/fetch-route-configured") {
      // the lender's own row of this type (above)
      const { fetchRouteName, target } = event.payload as {
        fetchRouteName: string;
        target: unknown;
      };
      const row = Object.hasOwn(rows.fetchRouteTargets, fetchRouteName)
        ? rows.fetchRouteTargets[fetchRouteName]
        : undefined;
      return own(row, target, unset.fetchRoutes.includes(fetchRouteName));
    }
    return true;
  });
}
/** WHAT AN ATTACH APPENDS, AND WHEN THE RECORD OF THE LAST CLOSE ENDS. The record (what the key's
 *  last close un-set) speaks for one attach that lands. It is ended only after the append came
 *  back: an attach that the stream refuses (a paused stream, a 5xx to the lender) changed
 *  nothing, the lender dials again, and that redial must still find the record, or it would take
 *  a row for one that somebody removed and come back without it.
 *
 *  WHO MAY TAKE A LENT NAME. A first dial with `onlyFrom` (a key's lend) is refused where the
 *  name's own lend (a row at the match with the same target) records another lender: the key
 *  takes a lent name only from itself. The check is here, in the one turn that reads the rows and
 *  appends the rule, because a read of the table and a lend after it are two steps, and a lend
 *  between them would be replaced (the newest pager wins). A row with no lender, the key's own
 *  row, and no row at all leave the name free. A redial is not checked: it is the lend that held
 *  the name before the platform dropped its pager, and a refusal there would page as a failed
 *  redial. The key's program cannot cause a redial: closing its own connection ends the lend. */
export function appendAtAttach(input: {
  events: StreamEventInput[];
  redial: boolean;
  /** The lender this first dial may take the name's lend from; with none, it takes it from any. */
  onlyFrom?: string;
  rows: Parameters<typeof eventsOfARedial>[1];
  record: { read(): UnsetByClose | string[] | undefined; end(): void };
  /** Appends, and throws when the stream refuses. */
  append: (events: StreamEventInput[]) => void;
}): void {
  const { events, redial, onlyFrom, rows, record } = input;
  if (!redial && onlyFrom)
    for (const event of events) {
      if (event.type !== "events.iterate.com/itx/rewrite-rule-configured") continue;
      // the lender's own session wrote the event (WHY THE CASTS ARE SAFE, in `eventsOfARedial`)
      const { match, target } = normalizeRewriteRuleConfigured(
        event.payload as RewriteRuleConfigured,
      );
      const row = rows.rules.find((rule) => print(rule.match) === print(match));
      if (
        row?.target &&
        target &&
        print(row.target) === print(target) &&
        row.lentBy &&
        row.lentBy !== onlyFrom
      )
        throw codedError(
          "FORBIDDEN",
          `${print(match)} is lent by another lender, and this lend takes the name only from itself: stop that lend, then lend again`,
        );
    }
  const kept = redial ? eventsOfARedial(events, rows, unsetByClose(record.read())) : events;
  if (kept.length > 0) input.append(kept);
  record.end();
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

  readonly #appendEvents: (
    events: StreamEventInput[],
    lend: { rpcStubKey: string; redial: boolean; onlyFrom?: string; lenderStamp?: LenderStamp },
  ) => void;

  constructor(deps: {
    ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;
    onPresence: (kind: "attached" | "detached", rpcStubKey: string) => void;
    rpcStubFetch: RpcStubFetchServer;
    appendEvents: (
      events: StreamEventInput[],
      lend: {
        rpcStubKey: string;
        redial: boolean;
        onlyFrom?: string;
        lenderStamp?: LenderStamp;
      },
    ) => void;
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
    const { rpcStubKey, appendEvents, redial, onlyFrom, lenderStamp } = attachRequest;
    const hadPager = this.#rpcStubPagerFor(rpcStubKey) !== undefined;
    const pair = new WebSocketPair();
    this.#ctx.acceptWebSocket(pair[1], [RPC_STUB_PAGER_WEBSOCKET_TAG]);
    pair[1].serializeAttachment({ rpcStubKey } satisfies RpcStubPagerRecord);
    // The set half, with the pager already accepted, so a push the commit fans out finds it.
    try {
      // also with nothing to append: the attach ends the record of what the last close un-set
      this.#appendEvents(appendEvents, {
        rpcStubKey,
        redial: redial === true,
        onlyFrom,
        lenderStamp,
      });
    } catch (error) {
      this.#closedRpcStubPagerSockets.add(pair[1]); // its close must not report a presence it never had
      try {
        pair[1].close(1011, "attach refused");
      } catch {
        // already closing
      }
      // 409 = a coded refusal (STREAM_PAUSED, or FORBIDDEN from `appendAtAttach`), which the relay
      // re-throws to the caller; 500 = uncoded. The pager that holds the name is not dropped: that
      // happens only after an append that lands, below.
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
// DO's fetch trusts never survives. `null`: loaded code's own Request, or one leaving the platform.
// Only `null` drops the edge's `x-itx-person`: no `Caller` carries the person, so a hop with a
// caller keeps the stamp for the app that reads it (iterate/sdk `auth.person`).
export function stampCallerHeaders(headers: Headers, caller: Caller | null): void {
  for (const name of [
    ITX_PRINCIPAL_HEADER,
    ITX_GRANT_HEADER,
    ITX_CALLER_PATH_HEADER,
    ITX_APP_HEADER,
    ITX_RUNS_ROW_HEADER,
    RPC_STUB_PAGER_WEBSOCKET_HEADER,
    FETCH_UPGRADE_SOCKET_HEADER,
    FETCH_UPGRADE_EYEBALL_HEADER,
    ITERATE_CAUSE_HEADER,
    ITX_EXPRESSION_FETCH_HEADER,
  ])
    headers.delete(name);
  if (!caller) {
    headers.delete(ITERATE_ROUTING_SLUG_HEADER);
    headers.delete(ITX_PERSON_HEADER);
    return;
  }
  if (caller.cause) headers.set(ITERATE_CAUSE_HEADER, causeHeader(caller.cause));
  if (caller.principal) headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(caller.principal));
  if (caller.grant) headers.set(ITX_GRANT_HEADER, caller.grant);
  if (caller.path) headers.set(ITX_CALLER_PATH_HEADER, caller.path);
  if (caller.app) headers.set(ITX_APP_HEADER, "1");
  if (caller.runsRow) headers.set(ITX_RUNS_ROW_HEADER, "1");
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
