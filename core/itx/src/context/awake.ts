// awake.ts — WHICH CONTEXTS OF THE MIND ARE AWAKE NOW. A context that has work holds one WebSocket
// into the context at `AWAKE_CONTEXT_PATH`, which accepts it with the hibernation API. So the list
// of awake contexts is that context's list of open sockets: no storage, no query, no event. A
// context that dies takes its socket with it, so nothing has to say "asleep".
//
// What it costs (Cloudflare's Durable Objects pricing, read 2026-11-13):
// - An open OUTBOUND socket keeps its Durable Object in memory, billed for duration. So a context
//   holds its socket only while it has work, plus `AWAKE_QUIET_MS`, and never longer than
//   `AWAKE_MAX_HOLD_MS` after its last entry. The socket never makes a context stay awake.
// - The accepting context hibernates under its sockets and is billed only for the turns that
//   accept one or see one close. Neither turn writes a wake record, appends an event or runs a
//   timer.
// - One Durable Object accepts 32,768 sockets. A dial refused past that is logged, and that
//   context is missing from the list: nothing else depends on the socket.
//
// The same socket carries what a context says about itself (context-summary.ts), at most once per
// 15 s while it works and once before it closes. The accepting context keeps the newest of each in
// one SQLite row (context-catalog.ts): one row written per wake of a context, beside the rows that
// wake writes in its own log.
//
// The accepting context is not `/`: every wake of `/` restarts the root's facets, and the root
// would wake twice for each wake of any other context.

import type { ContextActivity } from "iterate/api";

export const AWAKE_CONTEXT_PATH = "/awake";
export const AWAKE_WEBSOCKET_HEADER = "x-itx-awake";
const AWAKE_WEBSOCKET_TAG = "awake";

/** How long a context with no work in flight still counts as awake. It is billed: 1 s of an idle
 *  128 MB object is 1.6 USD per million quiet periods. A dial is 0.15 USD per million. */
export const AWAKE_QUIET_MS = 1_000;
/** The longest a socket stays open after the context's last entry, work in flight or not. A count
 *  of work in flight that never comes back to zero is then a bounded cost. */
export const AWAKE_MAX_HOLD_MS = 5 * 60_000;
/** While a context works, its summary is sent again at most this often. */
export const AWAKE_SUMMARY_EVERY_MS = 15_000;
/** Coalesces rapid activity push/pop bursts before sending an updated summary down the socket. */
export const AWAKE_ACTIVITY_DEBOUNCE_MS = 100;
/** After a dial that failed, no other dial for this long. */
export const AWAKE_REDIAL_AFTER_MS = 10_000;

export type AwakeContext = {
  path: string;
  since: number;
  updatedAt?: number;
  activities?: ContextActivity[];
};

export type AwakeContextState = {
  since: number;
  activities?: ContextActivity[];
};

/** The accepting side. Null: not a dial. Only the context at `AWAKE_CONTEXT_PATH` accepts. */
export function acceptAwakeWebSocket(
  ctx: Pick<DurableObjectState, "acceptWebSocket">,
  ownPath: string,
  request: Request,
): Response | null {
  const header = request.headers.get(AWAKE_WEBSOCKET_HEADER);
  // oxlint-disable-next-line iterate/simple-truthiness-check -- an absent header (null) means "not this request"; a present and empty one is a malformed dial, refused below
  if (header === null) return null;
  if (ownPath !== AWAKE_CONTEXT_PATH)
    return new Response(`only ${AWAKE_CONTEXT_PATH} accepts an awake socket\n`, { status: 404 });
  let path: string;
  try {
    path = decodeURIComponent(header);
  } catch {
    path = "";
  }
  if (!path.startsWith("/"))
    return new Response(`malformed ${AWAKE_WEBSOCKET_HEADER} header\n`, { status: 400 });
  const pair = new WebSocketPair();
  try {
    ctx.acceptWebSocket(pair[1], [AWAKE_WEBSOCKET_TAG]);
  } catch (error) {
    // the limit of sockets on one Durable Object
    return new Response(`${error instanceof Error ? error.message : String(error)}\n`, {
      status: 503,
    });
  }
  pair[1].serializeAttachment({ path, since: Date.now() } satisfies AwakeContext);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export function isAwakeWebSocket(ctx: Pick<DurableObjectState, "getTags">, ws: WebSocket): boolean {
  return ctx.getTags(ws).includes(AWAKE_WEBSOCKET_TAG);
}

/** What `acceptAwakeWebSocket` attached to a socket under the awake tag. */
export function awakeContextOf(ws: WebSocket): AwakeContext {
  // the one reader of the attachment that `acceptAwakeWebSocket` and `setAwakeActivities` alone write
  return ws.deserializeAttachment() as AwakeContext;
}

/** Updates the live `activities` carried on an accepted awake socket's attachment (never SQLite),
 *  so closing or crashing the socket clears its activities automatically. */
export function setAwakeActivities(
  ws: Pick<WebSocket, "deserializeAttachment" | "serializeAttachment">,
  activities: ContextActivity[] | undefined,
): void {
  // Written by `acceptAwakeWebSocket` on the same tagged socket.
  const current = ws.deserializeAttachment() as AwakeContext;
  const next: AwakeContext = {
    path: current.path,
    since: current.since,
    updatedAt: Date.now(),
    ...(activities && activities.length > 0 && { activities }),
  };
  ws.serializeAttachment(next);
}

/** Every context with an open socket here, by path, with when it woke and its latest live
 *  activities. A context that dialed twice (its first socket's close has not arrived) is there
 *  once, with its earlier wake time and the newest socket state. */
export function awakeContexts(
  ctx: Pick<DurableObjectState, "getWebSockets">,
): Map<string, AwakeContextState> {
  const byPath = new Map<string, AwakeContextState & { updatedAt: number }>();
  for (const ws of ctx.getWebSockets(AWAKE_WEBSOCKET_TAG)) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const { path, since, updatedAt, activities } = awakeContextOf(ws);
    const rank = updatedAt ?? since;
    const prior = byPath.get(path);
    if (!prior) {
      byPath.set(path, {
        since,
        updatedAt: rank,
        ...(activities && activities.length > 0 && { activities }),
      });
      continue;
    }
    const newer = rank >= prior.updatedAt;
    const chosenActivities = newer ? activities : prior.activities;
    byPath.set(path, {
      since: Math.min(since, prior.since),
      updatedAt: Math.max(rank, prior.updatedAt),
      ...(chosenActivities && chosenActivities.length > 0 && { activities: chosenActivities }),
    });
  }
  const states = new Map<string, AwakeContextState>();
  for (const [path, { since, activities }] of byPath) {
    states.set(path, activities ? { since, activities } : { since });
  }
  return states;
}

/** What the dialing side does when its timer fires. */
export function decideAwakeSocket(input: {
  now: number;
  lastEntryAt: number;
  busy: boolean;
}): { action: "close" } | { action: "hold"; recheckInMs: number } {
  const sinceEntry = input.now - input.lastEntryAt;
  if (sinceEntry >= AWAKE_MAX_HOLD_MS) return { action: "close" };
  if (input.busy) return { action: "hold", recheckInMs: AWAKE_QUIET_MS };
  if (sinceEntry < AWAKE_QUIET_MS)
    return { action: "hold", recheckInMs: AWAKE_QUIET_MS - sinceEntry };
  return { action: "close" };
}

type AwakeDialedSocket = Pick<WebSocket, "accept" | "close" | "addEventListener" | "send">;

type AwakeSocketDeps = {
  path: string;
  /** The upgrade request to the accepting context. */
  dial: () => Promise<{ status: number; webSocket?: AwakeDialedSocket | null }>;
  /** Work in flight: while true the socket stays, up to `AWAKE_MAX_HOLD_MS` after an entry. */
  busy: () => boolean;
  /** What the context says about itself now (context-summary.ts), as text. It is sent down the
   *  socket before the socket closes, and while the context works, whenever it differs from what
   *  was sent last. */
  summary?: () => string;
};

/** The dialing side: one per context. `entered()` at every entry that is work; the socket and the
 *  timer are this class's own, and both end when the context is quiet. Nothing awaits a dial: a
 *  context works the same with no socket. */
export class AwakeSocket {
  readonly #deps: AwakeSocketDeps;
  #socket: AwakeDialedSocket | undefined;
  #dialing = false;
  #noDialBefore = 0;
  #lastEntryAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #activityTimer: ReturnType<typeof setTimeout> | undefined;
  #activityDirty = false;
  #sentSummary: string | undefined;
  #sentSummaryAt = 0;

  constructor(deps: AwakeSocketDeps) {
    this.#deps = deps;
  }

  entered(): void {
    if (this.#deps.path === AWAKE_CONTEXT_PATH) return;
    this.#lastEntryAt = Date.now();
    this.#open();
    if (this.#timer === undefined) this.#recheckIn(AWAKE_QUIET_MS);
  }

  /** Coalesces rapid activity stack mutations and pushes the updated summary while the context
   *  is awake, without holding an idle context open or leaving a timer after close. */
  activityChanged(): void {
    if (this.#deps.path === AWAKE_CONTEXT_PATH || this.#timer === undefined) return;
    this.#activityDirty = true;
    if (this.#activityTimer !== undefined) return;
    this.#activityTimer = setTimeout(() => {
      this.#activityTimer = undefined;
      if (this.#timer === undefined) return;
      if (this.#socket) {
        this.#activityDirty = false;
        this.#sendSummary();
      }
    }, AWAKE_ACTIVITY_DEBOUNCE_MS);
  }

  #recheckIn(ms: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const decision = decideAwakeSocket({
        now: Date.now(),
        lastEntryAt: this.#lastEntryAt,
        busy: this.#deps.busy(),
      });
      if (decision.action === "close") return this.#close();
      // again, when the far end closed it under a context that still works
      this.#open();
      if (this.#activityDirty || Date.now() - this.#sentSummaryAt >= AWAKE_SUMMARY_EVERY_MS) {
        this.#activityDirty = false;
        this.#sendSummary();
      }
      this.#recheckIn(decision.recheckInMs);
    }, ms);
  }

  // Wanted exactly while the timer runs: a dial that lands after the context went quiet is closed.
  #open(): void {
    if (this.#socket || this.#dialing || Date.now() < this.#noDialBefore) return;
    this.#dialing = true;
    this.#deps
      .dial()
      .then((response) => {
        const socket = response.webSocket;
        if (response.status !== 101 || !socket)
          throw new Error(`the dial was answered ${response.status}`);
        socket.accept();
        this.#socket = socket;
        // the context went quiet while the dial was on its way: its summary still goes
        if (this.#timer === undefined) return this.#close();
        if (this.#activityDirty && this.#activityTimer === undefined) {
          this.#activityDirty = false;
          this.#sendSummary();
        }
        const gone = () => {
          if (this.#socket === socket) this.#socket = undefined;
        };
        socket.addEventListener("close", gone);
        socket.addEventListener("error", gone);
      })
      .catch((error: unknown) => {
        this.#noDialBefore = Date.now() + AWAKE_REDIAL_AFTER_MS;
        console.info({
          event: "context.awake-dial-failed",
          path: this.#deps.path,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.#dialing = false;
      });
  }

  // A summary that fails to be made or sent is sent at a later wake: the log it folds stays.
  #sendSummary(): void {
    if (!this.#socket || !this.#deps.summary) return;
    try {
      const summary = this.#deps.summary();
      if (summary === this.#sentSummary) return;
      this.#socket.send(summary);
      this.#sentSummary = summary;
      this.#sentSummaryAt = Date.now();
    } catch (error) {
      console.info({
        event: "context.awake-summary-failed",
        path: this.#deps.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #close(): void {
    if (this.#activityTimer !== undefined) {
      clearTimeout(this.#activityTimer);
      this.#activityTimer = undefined;
    }
    this.#activityDirty = false;
    this.#sendSummary();
    const socket = this.#socket;
    this.#socket = undefined;
    try {
      socket?.close(1000, "quiet");
    } catch {
      // already closing
    }
  }
}
