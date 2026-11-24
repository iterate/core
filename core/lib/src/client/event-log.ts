// client/event-log.ts — a context's log held in memory, the log half of `useIterateContext`
// (client/react.tsx), framework-free like client/live-state.ts. Subscribe first, then read: every
// committed event (or `consumes`) the subscription pushes and every page the reads return merge into
// ONE array sorted by offset, deduped by offset, published at most once per animation frame.
//
// BUILT FOR A LOG OF 100,000 EVENTS: `history: "tail"` reads only the newest page to be caught up
// (the head from a one-row probe, then the page below it) and reads older pages when asked
// (`loadOlder`); `"all"` reads every page from the first, for a consumer that folds the whole log
// (a tree of every context). A batch merges without copying what is held but once per frame (an append is
// a concat, a prepend too; only a batch landing inside the held range re-sorts), each wire batch
// is cloned once, and who acted and the processors table's version are kept as events arrive
// rather than recomputed from the whole log.
import type { StreamEvent } from "../stream/processor.ts";
import type { LiveStateItx } from "./live-state.ts";
import { retryWhileUnavailable, versionEndedBy, versionStartedBy } from "./new-version.ts";

/** How much of the log to read: the newest page, older ones on request — or all of it. */
export type EventLogHistory = "tail" | "all";

/** The slice of a context the log reads: its subscription and its pages. */
export type EventLogItx = LiveStateItx & {
  readEvents(
    afterOffset?: number,
    limit?: number,
  ): Promise<{
    events: unknown[];
    atHead: boolean;
    scannedThroughOffset: number;
    version?: number;
    versionStartedAtOffset?: number;
  }>;
};

/** One presence: who acted on the context and when last, from the log's stamps. */
export type IterateContextPresence = {
  actor: string;
  email?: string;
  grant?: string;
  lastSeenAt: string;
};

/** The log as a render reads it: a new object whenever anything in it changed, so it can be a
 *  `useSyncExternalStore` snapshot. */
export type EventLogSnapshot = {
  /** Every event held, sorted by offset. */
  events: StreamEvent[];
  /** The first read reached the head: everything since then arrives by the subscription. */
  caughtUp: boolean;
  error?: string;
  /** The highest offset known: the head the probe read, or the newest event since. */
  head: number;
  /** Reading older pages: one in flight; none left (the log is held from its first event). */
  older: { loading: boolean; exhausted: boolean };
  /** Every principal that acted on an event held, newest first. */
  actors: IterateContextPresence[];
  /** The offset of the newest subscription change held — what the processors table is as of —
   *  or of the newest version's start, whichever is higher: a new version empties the table. */
  tableVersion: number;
  /** The version of the context that the log holds (1 for a first version): every event held is
   *  of it. A view resets what it keeps beside the log (a title, a scroll position) when it
   *  changes. */
  version: number;
  /** The name of this log's own row in the context's subscriptions table, once the context has
   *  answered it: what a page's own events name to say which open page they are of. */
  subscription?: string;
};

export const EMPTY_EVENT_LOG: EventLogSnapshot = {
  events: [],
  caughtUp: false,
  head: 0,
  older: { loading: false, exhausted: false },
  actors: [],
  tableVersion: 0,
  version: 1,
};

/** Offsets per read: the platform's page cap (core/itx/src/stream/stream.ts `read`). */
const PAGE = 1000;

export type EventLogConnection = {
  get(): EventLogSnapshot;
  subscribe(listener: () => void): () => void;
  /** Read the page of offsets below the lowest held (and on, while a page of a sparse log holds
   *  few events). One read in flight; a no-op once exhausted or before the first read is done. */
  loadOlder(): void;
  /** Stop publishing and release the server-side subscription. */
  dispose(): void;
};

/** Subscribe to a context's log and read it — the newest page (`"tail"`) or all of it (`"all"`).
 *  `since`: the offset of the newest durable event the caller already holds. Within the newest
 *  page, a `"tail"` read starts there and returns that event again: a caller that gets it back,
 *  the same event, holds a copy that this read continues. Any other `since` reads the newest
 *  page, as without it, and returns no such event: the caller's copy is too old, or of another
 *  log (a context made again under the same path), or of an earlier version. `"all"` ignores it.
 *
 *  ONE VERSION OF THE LOG (`itx.newVersion`, core/lib/README.md "A new version of a context"):
 *  the log holds the context's current version only, from its `itx/created`, and no read goes
 *  below it. When the `itx/created` of a later version arrives (the kernel's last batch to the
 *  row, or a page), everything held below it goes, and the log subscribes again — the row went
 *  with the earlier version — and reads the new version from its start. */
export function connectEventLog(
  itx: EventLogItx,
  opts: { consumes: string[]; history: EventLogHistory; since?: number },
): EventLogConnection {
  let disposed = false;
  let subscription: { [Symbol.dispose](): void } | undefined;
  let subscriptionName: string | undefined;
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_EVENT_LOG;
  // what the next frame publishes
  const seen = new Set<number>();
  let events: StreamEvent[] = [];
  let pending: StreamEvent[] = [];
  let caughtUp = false;
  let error: string | undefined;
  let head = 0;
  /** Every durable event after this offset is held (or pending); 0 = the log from its first. */
  let floor = 0;
  /** The offset of the held version's `itx/created`: nothing below it is held or read. 0 = not
   *  known (a log with no `itx/created`). */
  let start = 0;
  let version = 1;
  /** How many later versions the log has followed. A subscribe or a read begun before the newest
   *  border answers into nothing: its row and its pages are of an earlier version. */
  let borders = 0;
  let loadingOlder = false;
  let tableVersion = 0;
  const byActor = new Map<string, IterateContextPresence & { offset: number }>();
  let actors: IterateContextPresence[] = [];
  let actorsChanged = false;
  let scheduled = false;
  /** The lowest `after` a read of the held version takes. */
  const lowest = () => Math.max(0, start - 1);
  /** The connection's first page says which version the log is in and where that version starts
   *  (a page of a first version says neither). Every later version comes by its border. */
  let versionHeld = false;
  const holdVersionOf = (page: { version?: number; versionStartedAtOffset?: number }) => {
    if (versionHeld) return;
    versionHeld = true;
    version = page.version ?? 1;
    start = page.versionStartedAtOffset ?? 0;
  };

  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    // a hidden tab runs no frames: what arrives meanwhile publishes as one when it is shown
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  };
  const flush = () => {
    scheduled = false;
    if (disposed) return;
    const fresh: StreamEvent[] = [];
    for (const event of pending) {
      if (seen.has(event.offset)) continue; // a committed offset never changes: the first copy stands
      seen.add(event.offset);
      fresh.push(event);
      if (event.offset > head) head = event.offset;
      if (event.type.startsWith("events.iterate.com/itx/subscription-"))
        tableVersion = Math.max(tableVersion, event.offset);
      const principal = event.source?.principal;
      const held = principal && byActor.get(principal.actor);
      if (principal && (!held || held.offset < event.offset)) {
        byActor.set(principal.actor, {
          actor: principal.actor,
          email: principal.email,
          grant: event.source?.grant,
          lastSeenAt: event.createdAt,
          offset: event.offset,
        });
        actorsChanged = true;
      }
    }
    pending = [];
    if (fresh.length > 0) {
      fresh.sort((a, b) => a.offset - b.offset);
      if (events.length === 0 || fresh[0]!.offset > events.at(-1)!.offset)
        events = events.concat(fresh);
      else if (fresh.at(-1)!.offset < events[0]!.offset) events = fresh.concat(events);
      else events = events.concat(fresh).sort((a, b) => a.offset - b.offset);
    }
    if (actorsChanged) {
      actorsChanged = false;
      actors = [...byActor.values()]
        .map(({ offset: _, ...presence }) => presence)
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    }
    snapshot = {
      events,
      caughtUp,
      error,
      head,
      // before the first read, `floor` is not known yet: what lies below a push that landed first
      // is loading, never the start of the log
      older: {
        loading: loadingOlder || (!caughtUp && !error),
        exhausted: caughtUp && floor <= lowest(),
      },
      actors,
      tableVersion,
      version,
      subscription: subscriptionName,
    };
    for (const listener of listeners) listener();
  };
  // `lastBatchOfTheRow`: the row delivered the `itx/version-ended` of its own version, which the
  // kernel sends only as that row's last batch. The row is gone whatever version the log holds: a
  // connect whose first read already answered the new version would otherwise keep a row of the
  // earlier one.
  const take = (incoming: StreamEvent[], lastBatchOfTheRow = false) => {
    for (const event of incoming) {
      if (event.type === "events.iterate.com/itx/created") {
        const next = versionStartedBy(event);
        if (next !== undefined && (next > version || lastBatchOfTheRow))
          startVersion(event.offset, next);
      }
      // an event of an earlier version (its `itx/version-ended` among them) is never held
      if (event.offset >= start) pending.push(event);
    }
    schedule();
  };
  const fail = (caught: unknown) => {
    if (disposed) return;
    error = caught instanceof Error ? caught.message : String(caught);
    schedule();
  };
  /** One page, asked again while the context restarts; undefined once the answer is of no use. */
  const readPage = (after: number, limit: number, of: number) =>
    retryWhileUnavailable(
      () => itx.readEvents(after, limit),
      () => disposed || borders !== of,
    );
  /** Subscribe the log's row. Its callback takes what the row delivers only while the row is of the
   *  held version: after a border, the earlier row's deliveries go nowhere. False when the row is
   *  of no use (disposed, or a later border while it was made). */
  const subscribeRow = async () => {
    const of = borders;
    // the version the log holds as it asks for the row: the row is of it, or of a later one
    const made = version;
    const handle = await retryWhileUnavailable(
      () =>
        itx.subscribe({
          consumes: opts.consumes,
          target: (batch) => {
            if (disposed || borders !== of) return;
            const delivered = toStreamEvents(batch);
            take(
              delivered,
              // of this row's version or a later one: an earlier version's is not this row's
              delivered.some((event) => (versionEndedBy(event) ?? 0) >= made),
            );
          },
        }),
      () => disposed || borders !== of,
    );
    if (!handle) return false;
    // disposed (or moved on) while the subscribe was pending: release it here, or the server keeps
    // delivering to nobody
    if (disposed || borders !== of) {
      handle[Symbol.dispose]();
      return false;
    }
    subscription = handle;
    // beside the first read, never before it: the name is one more answer of the context
    void Promise.resolve(handle.name).then(
      (name) => {
        if (disposed || borders !== of || !name) return;
        subscriptionName = name;
        schedule();
      },
      () => undefined,
    );
    return true;
  };
  /** Read every durable event in (after, through] — pages are cut by count AND bytes, and a log's
   *  offsets have gaps (ephemerals take offsets the log never stores), so read on until the scan
   *  reaches `through` (or the head). A page holds `limit` EVENTS, so under a gap it runs past
   *  `through`: what it holds above is already held. Returns how many events were in the window.
   *  A border met on the way ends it: the border reads the new version itself. */
  const readThrough = async (after: number, through: number): Promise<number> => {
    const of = borders;
    let taken = 0;
    for (;;) {
      const page = await readPage(after, Math.min(PAGE, through - after), of);
      if (!page || disposed || borders !== of) return taken;
      holdVersionOf(page);
      const inWindow = toStreamEvents(page.events).filter((event) => event.offset <= through);
      take(inWindow);
      taken += inWindow.length;
      if (page.atHead || page.scannedThroughOffset >= through || page.scannedThroughOffset <= after)
        return taken;
      after = page.scannedThroughOffset;
    }
  };
  /** A later version started at `offset`: what is held of the earlier one goes (its events, who
   *  acted only in it, the row's name), and the log subscribes again and reads on from the
   *  version's start, so that nothing between the border and the new row is missed. */
  const startVersion = (offset: number, next: number) => {
    borders += 1;
    versionHeld = true;
    version = next;
    start = offset;
    floor = offset - 1;
    caughtUp = false;
    // the processors table is read again: the earlier version's rows are gone
    tableVersion = Math.max(tableVersion, offset);
    events = events.filter((event) => event.offset >= offset);
    pending = pending.filter((event) => event.offset >= offset);
    for (const held of seen) if (held < offset) seen.delete(held);
    for (const [actor, presence] of byActor)
      if (presence.offset < offset) {
        byActor.delete(actor);
        actorsChanged = true;
      }
    subscriptionName = undefined;
    const earlier = subscription;
    subscription = undefined;
    try {
      earlier?.[Symbol.dispose]();
    } catch {
      // the row went with the earlier version
    }
    schedule();
    void (async () => {
      if (!(await subscribeRow())) return;
      const of = borders;
      await readThrough(offset - 1, Infinity);
      if (disposed || borders !== of) return;
      caughtUp = true;
      schedule();
    })().catch(fail);
  };

  (async () => {
    if (!(await subscribeRow())) return;
    const of = borders;
    if (opts.history === "tail") {
      // the head, from a one-row probe past it: an empty page at the head names the durable mark,
      // and the page says which version the log is in
      const probe = await readPage(Number.MAX_SAFE_INTEGER, 1, of);
      if (!probe || disposed || borders !== of) return;
      holdVersionOf(probe);
      floor = lowest();
      head = Math.max(head, probe.scannedThroughOffset);
      const newestPage = Math.max(lowest(), probe.scannedThroughOffset - PAGE);
      const { since } = opts;
      // a `since` at or below the newest page would leave a gap (one below the version's start
      // is of an earlier version), and one above the head means the log is shorter than the
      // caller's copy: all of these read the newest page
      floor =
        typeof since === "number" &&
        Number.isSafeInteger(since) &&
        since > newestPage &&
        since <= probe.scannedThroughOffset
          ? since - 1
          : newestPage;
    }
    await readThrough(floor, Infinity);
    if (disposed || borders !== of) return;
    caughtUp = true;
    schedule();
  })().catch(fail);

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadOlder() {
      if (disposed || !caughtUp || loadingOlder || floor <= lowest()) return;
      loadingOlder = true;
      schedule();
      const of = borders;
      (async () => {
        // a page of offsets at a time, and on while they hold few events (a log of mostly
        // ephemerals is sparse): the window doubles, to a cap that bounds one call's reads
        let window = PAGE;
        let taken = 0;
        while (floor > lowest() && taken < PAGE / 4) {
          const from = Math.max(lowest(), floor - window);
          taken += await readThrough(from, floor);
          if (disposed || borders !== of) return;
          floor = from;
          window = Math.min(window * 2, 16 * PAGE);
        }
      })()
        .catch(fail)
        .finally(() => {
          loadingOlder = false;
          schedule();
        });
    },
    dispose() {
      disposed = true;
      listeners.clear();
      subscription?.[Symbol.dispose]();
    },
  };
}

/** A wire batch (capnweb proxy values or plain objects) as `StreamEvent`s — one clone per batch,
 *  not per event — without the rows the view cannot place (no offset, type or time). Structural,
 *  not a schema: the transport validated them; the three fields checked are all the log indexes by. */
function toStreamEvents(batch: unknown[]): StreamEvent[] {
  const values = JSON.parse(JSON.stringify(batch)) as (Record<string, unknown> | null)[];
  return values.filter(
    (value) =>
      value &&
      typeof value.offset === "number" &&
      typeof value.type === "string" &&
      typeof value.createdAt === "string",
  ) as unknown as StreamEvent[];
}
