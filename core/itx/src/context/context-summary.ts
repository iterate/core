// context-summary.ts — WHAT A CONTEXT SAYS ABOUT ITSELF: a few facts folded from its own log, which
// it sends down its awake socket (awake.ts) so the mind can list its contexts without waking them.
// Every fact is a fold of durable events in offset order, so a summary that is lost or behind is
// made again from the log.
import { z } from "zod";
import type { StreamEvent } from "iterate/stream/processor";
import { CoreEventCatalog } from "../stream/core-events.ts";

/** A context's own word about what it is for: the newest one stands. An absent field keeps what
 *  stood; `null` clears it. */
export const CONTEXT_DESCRIBED_TYPE = "events.iterate.com/itx/described";
const ContextDescribed = CoreEventCatalog.events[CONTEXT_DESCRIBED_TYPE].payloadSchema;

/** More distinct event types than this are counted under `EVENT_TYPES_OMITTED`. */
const EVENT_TYPES_MAX = 200;
export const EVENT_TYPES_OMITTED = "…";
/** A `metadata` that prints longer is not kept: the summary crosses a socket at every wake. */
const METADATA_MAX_CHARS = 4_000;

export const ContextSummary = z.object({
  /** The offset the fold has reached. An ephemeral takes an offset too, so this is no count. */
  throughOffset: z.number().int().nonnegative(),
  /** How many durable events the fold has seen. */
  eventCount: z.number().int().nonnegative(),
  createdAt: z.string().optional(),
  lastEventAt: z.string().optional(),
  /** The newest event that is not the kernel's own (`itx/*`): a wake alone is no activity. */
  lastActivityAt: z.string().optional(),
  /** How many durable events of each type the log holds. */
  eventTypes: z.record(z.string(), z.number()),
  /** The last few types that are not the kernel's own, newest last. */
  recentTypes: z.array(z.string()),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ContextSummary = z.infer<typeof ContextSummary>;

export const EMPTY_CONTEXT_SUMMARY: ContextSummary = {
  throughOffset: 0,
  eventCount: 0,
  eventTypes: {},
  recentTypes: [],
};

/** `summary` with `events` folded in. The events are durable, in offset order, and start right
 *  after `summary.throughOffset`: one that does not is the caller's to read again from the log. */
export function foldContextSummary(
  summary: ContextSummary,
  events: readonly Pick<StreamEvent, "offset" | "type" | "createdAt" | "payload">[],
): ContextSummary {
  if (events.length === 0) return summary;
  const next: ContextSummary = {
    ...summary,
    eventTypes: { ...summary.eventTypes },
    recentTypes: [...summary.recentTypes],
  };
  for (const event of events) {
    next.throughOffset = event.offset;
    next.eventCount += 1;
    next.createdAt ||= event.createdAt;
    next.lastEventAt = event.createdAt;
    const counted =
      Object.hasOwn(next.eventTypes, event.type) ||
      Object.keys(next.eventTypes).length < EVENT_TYPES_MAX
        ? event.type
        : EVENT_TYPES_OMITTED;
    next.eventTypes[counted] = (next.eventTypes[counted] || 0) + 1;
    if (event.type === CONTEXT_DESCRIBED_TYPE) {
      const described = ContextDescribed.safeParse(event.payload);
      if (!described.success) continue;
      const { description, metadata } = described.data;
      // oxlint-disable-next-line iterate/simple-truthiness-check -- the event's protocol: an absent field keeps what stood, null clears it
      if (description !== undefined) next.description = description || undefined;
      // oxlint-disable-next-line iterate/simple-truthiness-check -- as the description: absent keeps, null clears
      if (metadata !== undefined)
        next.metadata =
          metadata && JSON.stringify(metadata).length <= METADATA_MAX_CHARS ? metadata : undefined;
      continue;
    }
    if (event.type.startsWith("events.iterate.com/itx/")) continue;
    next.lastActivityAt = event.createdAt;
    next.recentTypes = [...next.recentTypes, event.type].slice(-5);
  }
  return next;
}

/** How many events one catch-up reads at most: a context with a long log that never had a summary
 *  reaches its head over several wakes, each a bounded read. */
export const CATCH_UP_MAX_EVENTS = 5_000;
const STORAGE_KEY = "context-summary";

type ContextSummaryTrackerDeps = {
  kv: Pick<SyncKvStorage, "get" | "put">;
  /** A page of durable events after `afterOffset` (the stream's own `read`). */
  read: (
    afterOffset: number,
    limit: number,
  ) => { events: StreamEvent[]; scannedThroughOffset: number; atHead: boolean };
};

/** One per context: the summary in memory, folded at each commit once it has reached the head,
 *  read from and written to the context's own kv. */
export class ContextSummaryTracker {
  readonly #deps: ContextSummaryTrackerDeps;
  #summary: ContextSummary | undefined;
  #storedThroughOffset = -1;
  #atHead = false;

  constructor(deps: ContextSummaryTrackerDeps) {
    this.#deps = deps;
  }

  #loaded(): ContextSummary {
    if (this.#summary) return this.#summary;
    const stored = ContextSummary.safeParse(this.#deps.kv.get(STORAGE_KEY));
    this.#summary = stored.success ? stored.data : EMPTY_CONTEXT_SUMMARY;
    if (stored.success) this.#storedThroughOffset = stored.data.throughOffset;
    return this.#summary;
  }

  /** A commit's fresh events, in order. Before the summary has reached the head they are left to
   *  `current`, which reads them from the log. An ephemeral is in no log and in no summary. */
  committed(events: readonly StreamEvent[]): void {
    if (!this.#atHead) return;
    this.#summary = foldContextSummary(
      this.#loaded(),
      events.filter((event) => !event.ephemeral),
    );
  }

  /** The summary as far as one bounded catch-up brings it, stored when it moved. */
  current(): ContextSummary {
    let summary = this.#loaded();
    for (let read = 0; !this.#atHead && read < CATCH_UP_MAX_EVENTS;) {
      const page = this.#deps.read(summary.throughOffset, 1_000);
      summary = {
        ...foldContextSummary(summary, page.events),
        throughOffset: page.scannedThroughOffset,
      };
      this.#atHead = page.atHead;
      read += Math.max(1, page.events.length);
    }
    this.#summary = summary;
    if (summary.throughOffset !== this.#storedThroughOffset) {
      this.#deps.kv.put(STORAGE_KEY, summary);
      this.#storedThroughOffset = summary.throughOffset;
    }
    return summary;
  }
}
