// Retries ride the DO's own alarm because facets have none (workerd#6810). At-least-once survives an
// eviction because a cursor row's claim on the alarm is exactly its persisted `nextAttemptAtMs`,
// written before any read or call: nothing in memory is a reason to wake.

import type { ItxExpression } from "iterate/expression";
import { codedError, errorCode, jsonEqual, reportIssue, withTimeout } from "iterate/lib";
import {
  durableLadderDelayMs,
  failureKind,
  isPlatformFailureKind,
  logPlatformFailure,
} from "iterate/platform-retry";
import type { StreamPage } from "iterate/api";
import { type StreamEvent, consumesEvent, type ScannedRange } from "iterate/stream/processor";
import { deepestCause, recordRefusal, type Cause } from "../cause.ts";
import { callOn, walkSteps, FacetHandle, RpcStubHandle } from "../context/dispatch.ts";
import type { Metrics } from "../metrics.ts";
import {
  type CoreState,
  type EventCopy,
  rowsPushingFacet,
  type Subscription,
  targetIsAnotherService,
  targetOwnsProgress,
} from "./core-processor.ts";
import { evaluateFilter, evaluatePayload } from "./event-expressions.ts";
import {
  RECENT_EPHEMERALS_BUDGET_CHARS,
  type Stream,
  type SubscriptionCursor,
  type FanOutDeliveryRecord,
} from "./stream.ts";

// Also how far ahead a row behind the durable mark claims the alarm.
const CURSOR_DELIVERY_CALL_WATCHDOG_MS = 20_000;
// Claims, leases and failures count together.
const DELIVERY_MAX_ATTEMPTS = 15;

// All rows together: a push's arguments live in this isolate until the RPC returns. A facet push is a
// loopback RPC that holds about twice its chars (e2e LARGE EPHEMERAL FAN-OUT reset the parent at 16 MiB).
const DELIVERY_IN_FLIGHT_BUDGET_CHARS = 8 * 1024 * 1024;
// READ_PAGE_BUDGET_BYTES of bodies; with each event's offset and path a page serializes to slightly more.
const CURSOR_READ_PAGE_CHARS = 8 * 1024 * 1024;
// Apart from the push budget, so a cursor reserving a worst-case page never drops a live-client push.
// The extra 1 MiB lets small batches flow beside a full read.
const CURSOR_READ_BUDGET_CHARS =
  CURSOR_READ_PAGE_CHARS + RECENT_EPHEMERALS_BUDGET_CHARS + 1024 * 1024;
// Past it the oldest events of the largest queue are dropped, and the facet heals that span from the log.
const PENDING_PUSHES_TOTAL_BUDGET_CHARS = 8 * 1024 * 1024;

const FAN_OUT_CALLS_IN_FLIGHT = 8;
// For a webhook or Basin Pipelines: 25 attempts are about 44 h, as Svix retries webhooks for about
// 42 h (https://docs.svix.com/retries).
const LONG_LADDER_CAP_MS = 4 * 60 * 60_000;
// Distinct events: one event failing fifteen times counts once.
const FAN_OUT_PAUSE_AFTER_DISTINCT_FAILURES = 3;

// Never NO_ITX_EXPRESSION_MATCH: a target nothing resolves dangles, it is not halted.
const deterministicFailure = (error: unknown): boolean =>
  [
    "PERMANENT_FAILURE",
    "NOT_A_METHOD",
    "REDUCE_CHECKPOINT_TOO_LARGE",
    "EVENT_TOO_LARGE",
    "FORBIDDEN", // a retry cannot change who the caller is
  ].includes(errorCode(error) ?? "");

// A handler's own refusal is its event's failure instead (built-ins.ts `workers.get`'s recoding).
export const TARGET_FAILURE_CODES: ReadonlySet<string> = new Set([
  "NO_ITX_EXPRESSION_MATCH",
  "NOT_A_METHOD",
  "FORBIDDEN",
  "GONE",
]);

// `chars` is measured only once something has folded in.
type PendingPush = {
  events: StreamEvent[];
  range: ScannedRange;
  chars?: number;
  droppedEvents: number;
};

const serializedChars = (events: StreamEvent[]): number =>
  events.reduce((n, event) => n + JSON.stringify(event).length, 0);

type FanOutRow = {
  configuredAtOffset: number;
  // Every event the row takes through here is settled or has a record.
  admittedThroughOffset: number;
  slots: Set<number>;
  overdue: Set<number>;
  outcomes: Set<Promise<void>>;
  // Nothing else is admitted until this suspect's outcome is in.
  aloneOffset: number | undefined;
  dangling: boolean;
  refusedUntil: number | undefined;
  pumping: boolean;
  pumpAgain: boolean;
  waitingForRoom: boolean;
  // Alternates a due record and a new event, so neither starves the other.
  preferRetry: boolean;
  deliveredSinceTiming: number;
  longestWaitMs: number;
};

type FanOutCall = { event: StreamEvent; chars: number; attempt: number };

type FanOutFailure = { type: string; offset: number; attempts: number; error: unknown };

type SubscriptionDeliveryRecord = {
  // A slow target never lets a later batch overtake an earlier one.
  deliveryChain: Promise<unknown>;
  // A commit landing while one waits folds into it. Its presence means a delivery closure is coming.
  pendingPush?: PendingPush;
  // A batch the filter skipped rides inside the next range.
  lastDeliveredThroughOffset?: number;
  // The truth for this incarnation; the table mirrors it at durable boundaries only.
  cursor?: SubscriptionCursor;
  // Valid while the row and the rule table are unchanged and no rule snapshot it read has expired.
  evaluatedTargetHead?: {
    configuredAtOffset: number;
    rewriteRulesRef: object;
  } & EvaluatedTargetHead;
  deliveries: Map<number, FanOutDeliveryRecord>;
  fanOut?: FanOutRow;
};

type EvaluatedTargetHead = {
  head: unknown;
  validUntil: number;
  // A head evaluated again that resolves elsewhere is a moved target.
  routedTo: string;
  call: (events: StreamEvent[], range: ScannedRange) => Promise<void>;
  // A copy row appends its copy at its path instead.
  deliverEvent: (event: StreamEvent) => Promise<void>;
};

// A call larger than the whole budget takes it when nothing is held, so it never deadlocks.
class DeliveryCharsBudget {
  readonly #budgetChars: number;
  #heldChars = 0;
  readonly #waiters: (() => void)[] = [];

  constructor(budgetChars: number) {
    this.#budgetChars = budgetChars;
  }

  get heldChars(): number {
    return this.#heldChars;
  }

  async acquire(chars: number): Promise<void> {
    while (!this.tryTake(chars)) await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  release(chars: number): void {
    this.#heldChars -= chars;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  tryTake(chars: number): boolean {
    if (this.#heldChars > 0 && this.#heldChars + chars > this.#budgetChars) return false;
    this.#heldChars += chars;
    return true;
  }

  whenReleased(): Promise<void> {
    return new Promise<void>((resolve) => this.#waiters.push(resolve));
  }
}

type SubscriptionDeliveryDeps = {
  stream: Stream;
  // `validUntil`: when the first rule snapshot of another context it read expires. `routedTo` moves
  // when a rule re-points what it names.
  evaluateItxExpression: (
    expression: ItxExpression,
  ) => Promise<{ value: unknown; validUntil: number; routedTo: string }>;
  pushEventBatchToFacet: (
    facetHandle: FacetHandle,
    events: StreamEvent[],
    range: ScannedRange,
  ) => Promise<unknown>;
  catchUpFacetFromLog: (facetHandle: FacetHandle, cause: Cause | undefined) => Promise<unknown>;
  // For a claim changed off the commit path (a commit's own tail reconciles).
  reconcileAlarm: () => void;
  runAsDelivery: <T>(
    events: StreamEvent[],
    call: () => Promise<T>,
    delivery?: string,
  ) => Promise<T>;
  appendCopy: (path: string, copy: EventCopy) => Promise<void>;
  abortIncarnation: (reason: string) => void;
  metrics: Metrics;
};

export type DeliveryDeadline = { name: string; at: number; attempt: number };

export class SubscriptionDelivery {
  readonly #stream: Stream;
  readonly #evaluateItxExpression: SubscriptionDeliveryDeps["evaluateItxExpression"];
  readonly #pushEventBatchToFacet: SubscriptionDeliveryDeps["pushEventBatchToFacet"];
  readonly #catchUpFacetFromLog: SubscriptionDeliveryDeps["catchUpFacetFromLog"];
  readonly #reconcileAlarm: SubscriptionDeliveryDeps["reconcileAlarm"];
  readonly #runAsDelivery: SubscriptionDeliveryDeps["runAsDelivery"];
  readonly #appendCopy: SubscriptionDeliveryDeps["appendCopy"];
  readonly #abortIncarnation: SubscriptionDeliveryDeps["abortIncarnation"];
  readonly #metrics: Metrics;
  readonly #deliveryRecordByName = new Map<string, SubscriptionDeliveryRecord>();
  // Per name and outside the record: the loop that was draining a replaced row goes on to deliver the
  // replacement, so the lock outlives `#forgetSubscription`. A second kick joins the running loop.
  readonly #cursorDeliveryLoops = new Map<string, Promise<void>>();
  readonly #deliveryCharsInFlight = new DeliveryCharsBudget(DELIVERY_IN_FLIGHT_BUDGET_CHARS);
  readonly #cursorReadCharsInFlight = new DeliveryCharsBudget(CURSOR_READ_BUDGET_CHARS);

  constructor(deps: SubscriptionDeliveryDeps) {
    this.#stream = deps.stream;
    this.#evaluateItxExpression = deps.evaluateItxExpression;
    this.#pushEventBatchToFacet = deps.pushEventBatchToFacet;
    this.#catchUpFacetFromLog = deps.catchUpFacetFromLog;
    this.#reconcileAlarm = deps.reconcileAlarm;
    this.#runAsDelivery = deps.runAsDelivery;
    this.#appendCopy = deps.appendCopy;
    this.#abortIncarnation = deps.abortIncarnation;
    this.#metrics = deps.metrics;
    // After this, memory is the one truth.
    for (const [name, cursor] of this.#stream.storage.listSubscriptionCursors())
      this.#deliveryRecordFor(name).cursor = cursor;
    for (const [name, delivery] of this.#stream.storage.listSubscriptionDeliveries())
      this.#deliveryRecordFor(name).deliveries.set(delivery.offset, delivery);
  }

  #deliveryRecordFor(name: string): SubscriptionDeliveryRecord {
    let record = this.#deliveryRecordByName.get(name);
    if (!record) {
      record = { deliveryChain: Promise.resolve(), deliveries: new Map() };
      this.#deliveryRecordByName.set(name, record);
    }
    return record;
  }

  // Exactly the persisted times, so a fresh incarnation reports the claims its predecessor did. Memory
  // only withdraws a fan-out record's claim while its call is out past its time.
  deadlines(): DeliveryDeadline[] {
    const state = this.#stream.coreReducedState;
    const now = Date.now();
    const deadlines: DeliveryDeadline[] = [];
    for (const [name, record] of this.#deliveryRecordByName) {
      const row = state.subscriptions[name];
      if (!row || row.halted) continue;
      const at = record.cursor?.nextAttemptAtMs;
      if (at !== undefined) deadlines.push({ name, at, attempt: record.cursor!.attempt });
      for (const delivery of record.deliveries.values()) {
        const claim = fanOutClaim(record, delivery, now);
        if (claim !== undefined) deadlines.push({ name, at: claim, attempt: delivery.attempt });
      }
    }
    return deadlines.sort((a, b) => a.at - b.at);
  }

  // Only what is due: one deep obligation later never deepens a wake for another. The clock restarts:
  // time spent waiting to retry takes no step off, or a handler failing on every wake would run for ever.
  owedCause(dueBy: number): Cause | undefined {
    const state = this.#stream.coreReducedState;
    const now = Date.now();
    let owed: Cause | undefined;
    const owe = (events: StreamEvent[]) => {
      owed = deepestCause([owed, ...events.map((event) => event.source?.cause)]);
    };
    for (const [name, record] of this.#deliveryRecordByName) {
      const row = state.subscriptions[name];
      if (!row || row.halted) continue;
      const cursor = record.cursor;
      if (
        cursor &&
        (cursor.nextAttemptAtMs ?? 0) <= dueBy &&
        cursor.confirmedOffset < this.#stream.highestDurableOffset()
      )
        try {
          owe(this.#stream.read(cursor.confirmedOffset, 100).events);
        } catch {
          // an unreadable batch halts its row when the pass reaches it
        }
      for (const delivery of record.deliveries.values()) {
        const claim = fanOutClaim(record, delivery, now);
        if (claim !== undefined && claim <= dueBy) owe(this.#readFanOutEvent(delivery.offset));
      }
    }
    return owed && { ...owed, at: now };
  }

  // Answers whether it may have written a claim in this turn, which the commit's alarm reconcile arms.
  onCommit(freshEvents: StreamEvent[], afterOffset: number, throughOffset: number): boolean {
    const state = this.#stream.coreReducedState;
    const rows = state.subscriptions;
    const durable = freshEvents.some((event) => !event.ephemeral);
    let mayHaveClaimed = false;
    for (const event of freshEvents) {
      switch (event.type) {
        case "events.iterate.com/itx/subscription-delivery-resumed": {
          mayHaveClaimed = true;
          // A resume is itself the wake: deliver now, whatever `consumes` says (a halted row has no retry armed).
          const name = (event.payload as { name: string }).name;
          const row = rows[name];
          // A fan-out row is pumped by every durable commit (below), this one included.
          if (!row || isFanOutRow(state, row)) break;
          void (
            targetOwnsProgress(state, row)
              ? this.#catchUpFacetRow(name, row)
              : this.#deliverFromCursor(name)
          ).catch((error) => this.#reportFacetRowFailure("resume", name, row, error));
          break;
        }
        case "events.iterate.com/itx/subscription-configured": {
          mayHaveClaimed = true;
          // A row that owns its progress is evaluated now, whatever its `consumes` says, so `itx.facets.get(name)`
          // answers before its first consumed event. A cursor row that asked for history is delivered now.
          const name = (event.payload as { name: string }).name;
          this.#forgetSubscription(name);
          const row = rows[name];
          if (!row) break;
          if (targetOwnsProgress(state, row))
            this.#deliveryRecordFor(name).deliveryChain = this.#catchUpFacetRow(name, row).catch(
              (error) => {
                // NO_FACET on the row still in place addresses a facet no longer hosted.
                if (errorCode(error) === "NO_FACET" && this.#isStillTheRow(name, row)) return;
                this.#reportFacetRowFailure("configured", name, row, error);
              },
            );
          else if (row.afterOffset !== undefined && !isFanOutRow(state, row))
            void this.#deliverFromCursor(name).catch((error) =>
              reportIssue("subscription-delivery.configured", error, { name }),
            );
          break;
        }
      }
    }
    for (const [name, row] of Object.entries(rows)) {
      if (row.halted) continue;
      const record = this.#deliveryRecordFor(name);
      const events = freshEvents.filter((event) => rowTakes(row, event));
      if (targetOwnsProgress(state, row)) {
        // Re-pointed at a target that owns its progress: the stream's cursor is nothing of the target's.
        if (record.cursor) {
          record.cursor = undefined;
          this.#stream.storage.deleteSubscriptionCursor(name);
        }
        if (record.deliveries.size > 0) {
          record.deliveries.clear();
          this.#stream.storage.deleteSubscriptionDeliveries(name);
        }
        // A skipped batch rides inside the next delivered range.
        if (events.length === 0) continue;
        const after = record.lastDeliveredThroughOffset ?? afterOffset;
        record.lastDeliveredThroughOffset = throughOffset;
        this.#queuePushBehindInFlightDelivery(name, events, { after, through: throughOffset });
        continue;
      }
      if (row.ordered === false) {
        // Ephemerals are never a fan-out row's: nothing could deliver one again after an eviction. Any durable
        // commit may land the rule a dangling target waits for.
        if (!durable) continue;
        this.#fanOutRowFor(name, row).dangling = false;
        this.#pumpFanOut(name);
        continue;
      }
      if (events.length === 0) {
        // A caught-up idle row is moved along here, as an ack would, saving a page read. A row still owed a
        // ring ephemeral reads.
        const cursor = record.cursor || {
          confirmedOffset: row.afterOffset ?? row.configuredAtOffset,
          attempt: 0,
        };
        if (
          !this.#cursorDeliveryLoops.has(name) &&
          cursor.nextAttemptAtMs === undefined &&
          cursor.confirmedOffset >= afterOffset
        ) {
          this.#adoptCursor(name, { ...cursor, confirmedOffset: throughOffset }, durable);
          continue;
        }
        if (!durable) continue;
      }
      mayHaveClaimed = true;
      void this.#deliverFromCursor(name).catch((error) =>
        reportIssue("subscription-delivery.cursor", error, { name }),
      );
    }
    return mayHaveClaimed;
  }

  async #catchUpFacetRow(name: string, row: Subscription): Promise<void> {
    const { head } = await this.#evaluateItxExpressionTargetHead(name, row);
    if (!this.#isStillTheRow(name, row)) return;
    if (!(head instanceof FacetHandle)) return;
    try {
      await this.#catchUpFacetFromLog(head, this.#causeAt(row.configuredAtOffset));
    } catch (error) {
      // Halted, or the row is re-pushed into the same wall on every commit.
      if (deterministicFailure(error)) {
        this.#haltRow(name, row.configuredAtOffset, row.configuredAtOffset, 1, error);
        return;
      }
      // Cut off by an abort or a platform restart: the fresh instance owes it.
      const code = errorCode(error);
      if (code === "FACET_ABORTED" || code === "FACET_RESTARTED")
        return this.#catchUpFacetRow(name, row);
      throw error;
    }
  }

  #queuePushBehindInFlightDelivery(name: string, events: StreamEvent[], range: ScannedRange): void {
    const record = this.#deliveryRecordFor(name);
    const pending = record.pendingPush;
    if (pending) {
      pending.chars = (pending.chars ?? serializedChars(pending.events)) + serializedChars(events);
      pending.events = pending.events.concat(events); // the old array may be an in-flight call's argument
      pending.range.through = range.through;
      this.#dropPendingEventsOverTotalBudget();
      return;
    }
    record.pendingPush = { events, range, droppedEvents: 0 };
    record.deliveryChain = record.deliveryChain
      .then(async () => {
        const current = this.#deliveryRecordByName.get(name);
        const push = current?.pendingPush;
        if (current) current.pendingPush = undefined;
        const row = this.#stream.coreReducedState.subscriptions[name];
        // A push already waiting into a halted row would stack a second halt on the first.
        if (!push || !row || row.halted) return;
        if (push.droppedEvents > 0)
          console.warn({
            event: "delivery.pending-push.dropped",
            namespace: "subscription-delivery",
            message:
              "a subscriber did not keep up: the oldest pending events were dropped (a facet heals durables from the log; the span's ephemerals are lost)",
            name,
            droppedEvents: push.droppedEvents,
            healFromOffset: push.range.after,
          });
        await this.#pushEventBatch(name, row, push.events, push.range);
      })
      .catch(() => undefined);
  }

  #dropOldestPendingEvents(pending: PendingPush, keepUnderChars: number): void {
    let dropCount = 0;
    while (pending.chars! > keepUnderChars && dropCount < pending.events.length - 1)
      pending.chars! -= JSON.stringify(pending.events[dropCount++]).length;
    if (dropCount === 0) return;
    pending.range.after = pending.events[dropCount - 1].offset;
    pending.events = pending.events.slice(dropCount);
    pending.droppedEvents += dropCount;
  }

  // An unmeasured queue counts as nothing: it is at most one commit's batch.
  #dropPendingEventsOverTotalBudget(): void {
    for (;;) {
      let total = 0;
      let largest: PendingPush | undefined;
      for (const { pendingPush } of this.#deliveryRecordByName.values()) {
        if (pendingPush?.chars === undefined) continue;
        total += pendingPush.chars;
        if (pendingPush.events.length > 1 && (!largest || pendingPush.chars > largest.chars!))
          largest = pendingPush;
      }
      const excess = total - PENDING_PUSHES_TOTAL_BUDGET_CHARS;
      if (excess <= 0 || !largest) return;
      this.#dropOldestPendingEvents(largest, largest.chars! - excess);
    }
  }

  // A row a loop already holds is joined, so the pass ends with every loop drained.
  async deliverEveryCursorSubscription(): Promise<void> {
    const state = this.#stream.coreReducedState;
    const cursorRows = Object.entries(state.subscriptions).filter(
      ([, row]) => !targetOwnsProgress(state, row),
    );
    const rows = cursorRows.filter(([, row]) => !row.halted);
    for (const [name, row] of rows)
      if (isFanOutRow(state, row)) {
        this.#fanOutRowFor(name, row).dangling = false;
        this.#pumpFanOut(name);
      }
    await Promise.all(
      rows.map(([name, row]) =>
        isFanOutRow(state, row)
          ? Promise.all([...(this.#deliveryRecordByName.get(name)?.fanOut?.outcomes ?? [])])
          : this.#deliverFromCursor(name).catch((error) =>
              reportIssue("subscription-delivery.cursor", error, { name }),
            ),
      ),
    );
    // A halted row's backlog too: the pass delivers it nothing.
    const head = this.#stream.highestDurableOffset();
    for (const [name] of cursorRows) {
      const record = this.#deliveryRecordByName.get(name);
      const watermark = record?.fanOut?.admittedThroughOffset ?? record?.cursor?.confirmedOffset;
      if (!record || watermark === undefined) continue;
      const backlog = Math.max(0, head - watermark) + record.deliveries.size;
      this.#metrics("subscription.backlog", backlog, name);
    }
  }

  // Read-your-writes: a facet's engine trusts the head a push last showed it, so the facet host holds
  // a read back until every delivery already queued for it has settled. The chains never reject.
  deliveriesQueuedFor(facetName: string): Promise<unknown> {
    return Promise.all(
      rowsPushingFacet(this.#stream.coreReducedState, facetName).map(
        (name) => this.#deliveryRecordByName.get(name)?.deliveryChain,
      ),
    );
  }

  cursor(name: string): SubscriptionCursor | undefined {
    return this.#deliveryRecordByName.get(name)?.cursor;
  }

  #forgetSubscription(name: string): void {
    this.#stream.storage.deleteSubscriptionCursor(name);
    this.#stream.storage.deleteSubscriptionDeliveries(name);
    this.#deliveryRecordByName.delete(name);
    this.#reconcileAlarm();
  }

  // The table never names an offset past the durable mark: memory may stand on a head ephemeral,
  // whose number a later incarnation can hand to a durable.
  #adoptCursor(name: string, cursor: SubscriptionCursor, persist: boolean): void {
    this.#deliveryRecordFor(name).cursor = cursor;
    if (persist)
      this.#stream.storage.writeSubscriptionCursor(name, {
        ...cursor,
        confirmedOffset: Math.min(cursor.confirmedOffset, this.#stream.highestDurableOffset()),
      });
  }

  async #pushEventBatch(
    name: string,
    row: Subscription,
    events: StreamEvent[],
    range: ScannedRange,
  ): Promise<void> {
    try {
      // Checked on both sides of the evaluation: evaluating a load chain materializes its facet, and a
      // push racing a disable must not resurrect it.
      if (!this.#isStillTheRow(name, row)) return;
      const { head, call } = await this.#evaluateTargetHeadForRow(name, row);
      if (!this.#isStillTheRow(name, row)) return;
      if (head instanceof RpcStubHandle) {
        // A live client owns its offset: fire-and-forget, and RPC_STUB_OFFLINE is the benign heal-by-read case.
        const chars = serializedChars(events);
        if (!this.#deliveryCharsInFlight.tryTake(chars)) {
          console.warn({
            event: "delivery.push.dropped",
            namespace: "subscription-delivery",
            message:
              "push delivery dropped: the context's in-flight budget is full (the subscriber heals by read)",
            name,
            healFromOffset: range.after,
            inFlightChars: this.#deliveryCharsInFlight.heldChars,
          });
          return;
        }
        void call(events, range)
          .catch((error) => {
            if (errorCode(error) !== "RPC_STUB_OFFLINE")
              console.warn({
                event: "delivery.push.dropped",
                namespace: "subscription-delivery",
                message: "push delivery dropped",
                name,
                error: String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
              });
          })
          .finally(() => this.#deliveryCharsInFlight.release(chars));
        return;
      }
      // Awaited, so this facet's batches stay in order.
      try {
        const chars = serializedChars(events);
        await this.#deliveryCharsInFlight.acquire(chars);
        try {
          await call(events, range);
        } finally {
          this.#deliveryCharsInFlight.release(chars);
        }
      } catch (error) {
        if (deterministicFailure(error)) {
          this.#haltRow(name, row.configuredAtOffset, range.after, 1, error);
          return;
        }
        // A push the watchdog timed out, an abort or a platform restart cut off was never checkpointed and
        // nothing else redelivers it: the restarted facet catches up from the log, once per such push.
        const code = errorCode(error);
        if (code === "TIMEOUT" || code === "FACET_ABORTED" || code === "FACET_RESTARTED")
          this.#catchUpAfterPushTimeout(name, row);
        throw error;
      }
    } catch (error) {
      // A dangling row errors until its rule lands, so a push into it is no issue.
      const code = errorCode(error);
      if (code === "NO_ITX_EXPRESSION_MATCH" || code === "FACET_ABORTED") return;
      if (code === "FACET_RESTARTED") {
        console.log({
          event: "delivery.facet-restarted-in-flight",
          namespace: "subscription-delivery",
          failureSite: "subscription-delivery.deliver",
          name,
          code,
        });
        return;
      }
      if (code === "NO_FACET" && this.#isStillTheRow(name, row)) return;
      this.#reportFacetRowFailure("deliver", name, row, error);
    }
  }

  // NO_FACET once the row is gone is the removal it raced. A platform failure is logged, not reported:
  // the facet reads what it missed from the log at its next push.
  #reportFacetRowFailure(
    action: "resume" | "configured" | "deliver" | "catch-up-after-timeout",
    name: string,
    row: Subscription,
    error: unknown,
  ): void {
    const failureSite = `subscription-delivery.${action}`;
    if (errorCode(error) === "NO_FACET" && !this.#isStillTheRow(name, row)) {
      console.log({
        event: "delivery.facet-removed-in-flight",
        namespace: "subscription-delivery",
        failureSite,
        name,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const kind = failureKind(error);
    if (isPlatformFailureKind(kind)) {
      logPlatformFailure("subscription-delivery", action, kind, { name, message: String(error) });
      return;
    }
    reportIssue(failureSite, error, { name });
  }

  #isStillTheRow(name: string, row: Subscription): boolean {
    return (
      this.#stream.coreReducedState.subscriptions[name]?.configuredAtOffset ===
      row.configuredAtOffset
    );
  }

  // Chained after this row's in-flight delivery; a catch-up that fails is reported, never retried.
  #catchUpAfterPushTimeout(name: string, row: Subscription): void {
    const record = this.#deliveryRecordFor(name);
    record.deliveryChain = record.deliveryChain.then(() =>
      this.#catchUpFacetRow(name, row).catch((error) =>
        this.#reportFacetRowFailure("catch-up-after-timeout", name, row, error),
      ),
    );
  }

  // Append is synchronous, so the check and the fact are one turn: a replacement never inherits its
  // predecessor's refusal, and two refusals append one fact.
  #haltRow(
    name: string,
    configuredAtOffset: number,
    afterOffset: number,
    attempts: number,
    error: unknown,
  ): void {
    const current = this.#stream.coreReducedState.subscriptions[name];
    if (current?.configuredAtOffset !== configuredAtOffset || current.halted) return;
    this.#stream.append({
      type: "events.iterate.com/itx/subscription-delivery-halted",
      payload: {
        name,
        afterOffset,
        attempts,
        error: errorMessage(error),
      },
      source: { cause: this.#causeAt(afterOffset + 1) },
    });
    this.#metrics("subscription.halts", 1, name);
  }

  #causeAt(offset: number): Cause | undefined {
    return this.#readFanOutEvent(offset)[0]?.source?.cause;
  }

  // The claim is spent first, so a resume starts a fresh ladder.
  #haltCursorRow(
    name: string,
    row: Subscription,
    cursor: SubscriptionCursor,
    attempts: number,
    error: unknown,
  ): void {
    if (!this.#isStillTheRow(name, row)) return;
    const { nextAttemptAtMs: _spent, ...settled } = cursor;
    this.#adoptCursor(name, { ...settled, attempt: 0 }, true);
    this.#haltRow(name, row.configuredAtOffset, cursor.confirmedOffset, attempts, error);
  }

  // A fan-out row whose head now resolves elsewhere than its cursor's `route` says tries its pending
  // deliveries at once: each context learns of a re-point lazily, and nothing is appended to tell it.
  async #evaluateTargetHeadForRow(name: string, row: Subscription): Promise<EvaluatedTargetHead> {
    const rewriteRulesRef = this.#stream.coreReducedState.itxExpressionRewriteRules;
    const cached = this.#deliveryRecordByName.get(name)?.evaluatedTargetHead;
    if (
      cached &&
      cached.configuredAtOffset === row.configuredAtOffset &&
      cached.rewriteRulesRef === rewriteRulesRef &&
      Date.now() < cached.validUntil
    )
      return cached;
    const evaluated = await this.#evaluateItxExpressionTargetHead(name, row);
    if (!this.#isStillTheRow(name, row)) return evaluated;
    this.#deliveryRecordFor(name).evaluatedTargetHead = {
      configuredAtOffset: row.configuredAtOffset,
      rewriteRulesRef,
      ...evaluated,
    };
    if (isFanOutRow(this.#stream.coreReducedState, row)) {
      const record = this.#deliveryRecordFor(name);
      const route = routeDigestOf(evaluated.routedTo);
      const lastRoute = record.cursor?.route;
      if (lastRoute !== route) {
        const fanOut = this.#fanOutRowFor(name, row);
        this.#adoptCursor(name, { ...this.#fanOutCursor(name, fanOut), route }, true);
        if (lastRoute) this.#retryPendingNow(name, row);
      }
    }
    return evaluated;
  }

  async #evaluateItxExpressionTargetHead(
    name: string,
    { target, copy }: Subscription,
  ): Promise<EvaluatedTargetHead> {
    const last = target.at(-1);
    // A two-step target (`itx.<alias>`) is the callee itself: peeling its name would leave the bare root.
    const method = typeof last === "string" && target.length > 2 ? last : undefined;
    const {
      value: head,
      validUntil,
      routedTo,
    } = await this.#evaluateItxExpression(method ? target.slice(0, -1) : target);
    // A Workers-RPC or capnweb result pins the callee's export table until disposed; a live client's push
    // runs on every commit, so leaving each result to GC would leak a slot per batch.
    const invoke = async (args: unknown[]): Promise<void> => {
      const walked = method
        ? (await walkSteps({ value: head, receiver: undefined }, [[method, ...args]])).value
        : await callOn(head, undefined, args);
      // A pipelined call answers with a promise the step walk hands back unawaited: settle it before the
      // dispose, or a hop's refusal is disposed unseen and the batch acked.
      const result = await walked;
      if (typeof result === "object" && result && Symbol.dispose in result)
        (result as Disposable)[Symbol.dispose]();
    };
    const call = async (events: StreamEvent[], range: ScannedRange): Promise<void> => {
      if (head instanceof FacetHandle && method === "processEventBatch") {
        await this.#pushEventBatchToFacet(head, events, range);
        return;
      }
      await invoke([events, range]);
    };
    // Only the call that carries the log's own event runs with delivery authority, so a target spelling
    // `deliverEvent(<its own event>)` is refused.
    return {
      head,
      validUntil,
      routedTo,
      call,
      // the same key on every attempt
      deliverEvent: async (event) => {
        const key = `${name}:${event.path}@${event.offset}`;
        if (copy) {
          // An operator's resume gets here without `fanOutAdmits`.
          if (event.type.startsWith("events.iterate.com/itx/"))
            throw codedError("PERMANENT_FAILURE", `${event.type} is never copied`);
          const evaluated = evaluatePayload(copy.payload || "{}", event);
          if ("error" in evaluated) throw evaluated.error;
          const toSend: EventCopy = {
            type: copy.type || event.type,
            payload: evaluated.payload,
            metadata: event.metadata,
            copiedFrom: {
              path: event.path,
              offset: event.offset,
              createdAt: event.createdAt,
              type: event.type,
              subscription: name,
            },
          };
          // The head (`itx.cd(path)`) was evaluated only so this context's rules can stop a copy.
          await this.#runAsDelivery([event], () => this.#appendCopy(copy.path, toSend), key);
          return;
        }
        await this.#runAsDelivery([event], () => invoke([event]), key);
      },
    };
  }

  #deliverFromCursor(name: string): Promise<void> {
    const running = this.#cursorDeliveryLoops.get(name);
    if (running) return running;
    // Written before the drain's first turn and released by its own `finally`, never by a `.then`: a
    // release a microtask later would let a kick join a loop that delivers nothing more.
    let resolveLoop: (() => void) | undefined;
    let rejectLoop: ((error: unknown) => void) | undefined;
    const loop = new Promise<void>((resolve, reject) => {
      resolveLoop = resolve;
      rejectLoop = reject;
    });
    this.#cursorDeliveryLoops.set(name, loop);
    this.#drainCursor(name).then(resolveLoop, rejectLoop);
    return loop;
  }

  async #drainCursor(name: string): Promise<void> {
    // Only the claim a restart (below) causes arms the alarm itself; the others ride an existing arm.
    let claimArmsTheAlarm = false;
    try {
      for (;;) {
        const row = this.#stream.coreReducedState.subscriptions[name];
        if (!row) return this.#forgetSubscription(name);
        if (row.ordered === false || targetOwnsProgress(this.#stream.coreReducedState, row)) return;
        let cursor = this.cursor(name);
        if (!cursor) {
          // In memory only: the first durable delivery writes it.
          cursor = { confirmedOffset: row.afterOffset ?? row.configuredAtOffset, attempt: 0 };
          this.#adoptCursor(name, cursor, false);
        }
        if (row.resumed && row.resumed.atOffset !== cursor.resumeAppliedAtOffset) {
          cursor = {
            // Clamped to the durable mark: "resume from the end" is what a seek past it means.
            confirmedOffset: Math.min(
              row.resumed.afterOffset ?? cursor.confirmedOffset,
              this.#stream.highestDurableOffset(),
            ),
            attempt: 0,
            resumeAppliedAtOffset: row.resumed.atOffset,
          };
          this.#adoptCursor(name, cursor, true);
        }
        if (row.halted) return;
        // Not yet due: whatever kicked this loop reconciles the alarm to it.
        if (cursor.nextAttemptAtMs !== undefined && Date.now() < cursor.nextAttemptAtMs) return;
        // The claim, synchronous with the kicking commit, before any read or call: a death anywhere from
        // here is retried by the next incarnation, and fifteen deaths halt the row as fifteen refusals would.
        const cursorBeforeAttempt = cursor;
        const behindTheDurableMark = cursor.confirmedOffset < this.#stream.highestDurableOffset();
        if (behindTheDurableMark) {
          const attempt = cursor.attempt + 1;
          if (attempt > this.#ladder(row).maxAttempts) {
            this.#haltCursorRow(
              name,
              row,
              cursor,
              cursor.attempt,
              new Error(
                `${cursor.attempt} deliveries of this batch ended without an ack or a failure (the context died mid-call)`,
              ),
            );
            return;
          }
          cursor = {
            ...cursor,
            attempt,
            nextAttemptAtMs: Date.now() + CURSOR_DELIVERY_CALL_WATCHDOG_MS,
          };
          this.#adoptCursor(name, cursor, true);
          if (claimArmsTheAlarm) {
            claimArmsTheAlarm = false;
            this.#reconcileAlarm();
          }
        }
        // Room is held from before the read, which is what allocates, through the awaited call. A row behind
        // the mark reserves a worst-case page and the ring; a row at the mark reserves only the ring.
        let inFlightRoomHeld = 0;
        try {
          // The ring may hold one event as large as the append ceiling.
          const ringChars = Math.max(
            RECENT_EPHEMERALS_BUDGET_CHARS,
            this.#stream.recentEphemeralsChars(),
          );
          const reserveChars = behindTheDurableMark
            ? CURSOR_READ_PAGE_CHARS + ringChars
            : ringChars;
          await this.#cursorReadCharsInFlight.acquire(reserveChars);
          inFlightRoomHeld = reserveChars;
          // A durable or a larger ephemeral that landed during the wait changes what this row must reserve:
          // start the turn over.
          const behindNow = cursor.confirmedOffset < this.#stream.highestDurableOffset();
          if (
            !behindTheDurableMark &&
            (behindNow || this.#stream.recentEphemeralsChars() > ringChars)
          ) {
            claimArmsTheAlarm = behindNow;
            continue;
          }
          let page: StreamPage;
          try {
            page = this.#stream.read(cursor.confirmedOffset, 100, { includeEphemeral: true });
          } catch (error) {
            // EVENT_UNREADABLE can only repeat: halt now, never a retry into it.
            this.#haltCursorRow(name, row, cursor, cursorBeforeAttempt.attempt + 1, error);
            return;
          }
          const owedAfterOffset = Math.max(cursor.confirmedOffset, row.configuredAtOffset);
          const lostThroughOffset = Math.max(
            0,
            ...(row.consumes || []).map(
              (type) => this.#stream.evictedEphemeralThroughOffset(type) ?? 0,
            ),
          );
          if (lostThroughOffset > owedAfterOffset)
            console.warn({
              event: "delivery.cursor.ephemerals-evicted",
              namespace: "subscription-delivery",
              message:
                "a cursor subscriber did not keep up: the ring let go of ephemerals it had not read",
              name,
              owedAfterOffset,
              lostThroughOffset,
            });
          // The head ephemeral past the log's proof lives in memory only, which is where the cursor keeps it.
          const through = Math.max(page.scannedThroughOffset, page.events.at(-1)?.offset ?? 0);
          if (through <= cursor.confirmedOffset) {
            // Caught up: a wake that found nothing to do must not arm another, so a standing claim is spent.
            if (cursor.nextAttemptAtMs !== undefined) {
              const { nextAttemptAtMs: _spent, ...settled } = cursor;
              this.#adoptCursor(name, { ...settled, attempt: 0 }, true);
            }
            return;
          }
          const events = page.events.filter((event) => rowTakes(row, event));
          const range: ScannedRange = { after: cursor.confirmedOffset, through };
          // An ephemeral-only pass on a quiet row touches no storage.
          const persist =
            page.scannedThroughOffset > cursor.confirmedOffset ||
            cursor.nextAttemptAtMs !== undefined;
          // Only ever released here: acquiring an overshoot while holding the reserve could wait on this very
          // reservation for ever.
          const batchChars = serializedChars(events);
          if (batchChars < inFlightRoomHeld) {
            this.#cursorReadCharsInFlight.release(inFlightRoomHeld - batchChars);
            inFlightRoomHeld = batchChars;
          }
          // Replaced during the wait: advancing would write the old row's offset into the fresh row's cursor.
          if (!this.#isStillTheRow(name, row)) continue;
          if (events.length === 0) {
            // Advanced without a call or an attempt; a standing claim is spent.
            const { nextAttemptAtMs: _spent, ...settled } = cursor;
            this.#adoptCursor(
              name,
              { ...settled, attempt: cursorBeforeAttempt.attempt, confirmedOffset: through },
              persist,
            );
            continue;
          }
          const attemptStartedAt = Date.now();
          try {
            const { call } = await this.#evaluateTargetHeadForRow(name, row);
            // A row re-pointed at a target that owns its progress is the same row with its cursor dropped.
            if (!this.#isStillTheRow(name, row) || !this.cursor(name)) continue;
            await withTimeout(
              this.#runAsDelivery(events, () => call(events, range)).catch((error: unknown) =>
                this.#settleLoopLimit(error),
              ),
              CURSOR_DELIVERY_CALL_WATCHDOG_MS,
              `subscription "${name}"`,
            );
            if (!this.#isStillTheRow(name, row) || !this.cursor(name)) continue;
            // Memory takes a head ephemeral's offset too, so nothing is handed over twice.
            this.#adoptCursor(
              name,
              {
                confirmedOffset: through,
                attempt: 0,
                resumeAppliedAtOffset: cursor.resumeAppliedAtOffset,
              },
              persist,
            );
            // History the row asked for waited on no one.
            const live = events.filter((event) => event.offset > row.configuredAtOffset);
            if (live.length > 0) {
              this.#metrics(
                "subscription.lag_ms",
                Date.now() - Date.parse(live[0]!.createdAt),
                name,
              );
              this.#metrics("subscription.delivered", live.length, name);
            }
          } catch (error) {
            if (!this.#isStillTheRow(name, row) || !this.cursor(name)) continue;
            // Dangling: no rung, no halt, no attempt spent; the commit that lands the rule kicks the row. When
            // another context's snapshot read before this attempt refused it, the row claims until it expires.
            if (errorCode(error) === "NO_ITX_EXPRESSION_MATCH") {
              const { nextAttemptAtMs: _spent, ...settled } = cursorBeforeAttempt;
              const { readAt, validUntil } = refusalMarks(error);
              const staleUntil = readAt < attemptStartedAt ? validUntil : undefined;
              this.#adoptCursor(
                name,
                staleUntil === undefined ? settled : { ...settled, nextAttemptAtMs: staleUntil },
                true,
              );
              return;
            }
            // A resume that landed during this attempt is applied, never overridden by the old ladder or a halt.
            const latest = this.#stream.coreReducedState.subscriptions[name];
            if (latest?.resumed && latest.resumed.atOffset !== cursor.resumeAppliedAtOffset)
              continue;
            const attempt = cursorBeforeAttempt.attempt + 1;
            const ladder = this.#ladder(row);
            if (deterministicFailure(error) || attempt >= ladder.maxAttempts) {
              this.#haltCursorRow(name, row, cursor, attempt, error);
              return;
            }
            const nextAttemptAtMs = Date.now() + ladder.delayMs(attempt);
            this.#adoptCursor(name, { ...cursor, attempt, nextAttemptAtMs }, true);
            this.#metrics("subscription.retries", 1, name);
            return;
          }
        } finally {
          if (inFlightRoomHeld > 0) this.#cursorReadCharsInFlight.release(inFlightRoomHeld);
        }
      }
    } finally {
      this.#cursorDeliveryLoops.delete(name);
      this.#reconcileAlarm();
    }
  }

  // Each admitted event has a delivery record, written with the admission cursor before its call and
  // deleted when it settles. A wake has none: it is delivered at most once.

  #fanOutRowFor(name: string, row: Subscription): FanOutRow {
    const record = this.#deliveryRecordFor(name);
    if (record.fanOut?.configuredAtOffset === row.configuredAtOffset) return record.fanOut;
    const { cursor } = record;
    record.fanOut = {
      configuredAtOffset: row.configuredAtOffset,
      admittedThroughOffset: cursor?.confirmedOffset ?? row.afterOffset ?? row.configuredAtOffset,
      slots: new Set(),
      overdue: new Set(),
      outcomes: new Set(),
      aloneOffset: undefined,
      dangling: false,
      refusedUntil: undefined,
      pumping: false,
      pumpAgain: false,
      waitingForRoom: false,
      preferRetry: false,
      deliveredSinceTiming: 0,
      longestWaitMs: 0,
    };
    return record.fanOut;
  }

  // Synchronous, so a commit's pump writes in the commit's own turn. A kick while it runs runs it again.
  #pumpFanOut(name: string): void {
    const row = this.#stream.coreReducedState.subscriptions[name];
    if (!row || !isFanOutRow(this.#stream.coreReducedState, row)) return;
    const fanOut = this.#fanOutRowFor(name, row);
    if (fanOut.pumping) {
      fanOut.pumpAgain = true;
      return;
    }
    fanOut.pumping = true;
    try {
      do {
        fanOut.pumpAgain = false;
        this.#admitFanOut(name, row, fanOut);
      } while (fanOut.pumpAgain && this.#isStillTheRow(name, row));
    } finally {
      fanOut.pumping = false;
    }
    this.#reconcileAlarm();
  }

  #admitFanOut(name: string, row: Subscription, fanOut: FanOutRow): void {
    const record = this.#deliveryRecordFor(name);
    const now = Date.now();
    // A fan-out row does not seek. A resume's `offset` delivers a dead letter again, never a wake.
    const { resumed } = row;
    if (resumed && resumed.atOffset !== record.cursor?.resumeAppliedAtOffset) {
      this.#adoptCursor(
        name,
        { ...this.#fanOutCursor(name, fanOut), resumeAppliedAtOffset: resumed.atOffset },
        true,
      );
      fanOut.dangling = false;
      if (
        resumed.offset !== undefined &&
        resumed.offset <= this.#stream.highestDurableOffset() &&
        !record.deliveries.has(resumed.offset) &&
        !this.#readFanOutEvent(resumed.offset).some(
          (event) => isWake(event) || isDeliveryFact(event),
        )
      )
        this.#writeFanOutDelivery(name, {
          offset: resumed.offset,
          attempt: 0,
          nextAttemptAtMs: now,
          leased: false,
          error: "delivered again by an operator's resume",
        });
    }
    if (row.halted || fanOut.dangling) return this.#persistFanOutCursor(name, fanOut);

    const ladder = this.#ladder(row);
    const writes: FanOutDeliveryRecord[] = [];
    const calls: FanOutCall[] = [];
    const deadLetters: FanOutFailure[] = [];
    const givenUp = new Set<number>();
    let outOfRoom = false;
    // Peeked until admitted, so an event left for lack of a slot or room is read again. An unreadable
    // row makes the rest of the turn read one row at a time, so it alone is dead-lettered.
    let page: StreamEvent[] = [];
    let pageIndex = 0;
    let pageProvesThroughOffset = fanOut.admittedThroughOffset;
    let onePerRead = false;
    const takesEverything = !row.consumes || row.consumes.includes("*");
    const peekNewEvent = (): StreamEvent | undefined => {
      for (;;) {
        for (; pageIndex < page.length; pageIndex++) {
          if (fanOutAdmits(row, page[pageIndex], this.#stream.storage.incarnation))
            return page[pageIndex];
          fanOut.admittedThroughOffset = page[pageIndex].offset;
        }
        fanOut.admittedThroughOffset = Math.max(
          fanOut.admittedThroughOffset,
          pageProvesThroughOffset,
        );
        if (fanOut.admittedThroughOffset >= this.#stream.highestDurableOffset()) return undefined;
        const limit = onePerRead
          ? 1
          : takesEverything
            ? FAN_OUT_CALLS_IN_FLIGHT - fanOut.slots.size
            : 100;
        let read: StreamPage;
        try {
          read = this.#stream.read(fanOut.admittedThroughOffset, limit);
        } catch (error) {
          if (errorCode(error) !== "EVENT_UNREADABLE") throw error;
          if (!onePerRead) {
            onePerRead = true;
            continue;
          }
          const { offset } = (error as { data: { offset: number } }).data;
          deadLetters.push({ type: "", offset, attempts: 0, error });
          page = [];
          pageProvesThroughOffset = offset;
          continue;
        }
        page = read.events;
        pageIndex = 0;
        pageProvesThroughOffset = read.scannedThroughOffset;
      }
    };
    // A paused row's probe is sent before any retry, so it is never crowded out.
    const paused = fanOutPaused(record.cursor);
    const probeDue = paused && (record.cursor?.nextAttemptAtMs ?? Infinity) <= now;
    if (probeDue) fanOut.preferRetry = false;
    // A suspect first, then the earliest due, the lowest offset breaking a tie.
    const dueRecord = (): FanOutDeliveryRecord | undefined => {
      let due: FanOutDeliveryRecord | undefined;
      for (const delivery of record.deliveries.values()) {
        if (fanOut.slots.has(delivery.offset) || givenUp.has(delivery.offset)) continue;
        if (delivery.nextAttemptAtMs !== null && delivery.nextAttemptAtMs > now) continue;
        const [at, dueAt] = [delivery.nextAttemptAtMs ?? 0, due?.nextAttemptAtMs ?? 0];
        if (
          !due ||
          (delivery.leased && !due.leased) ||
          (delivery.leased === due.leased &&
            (at < dueAt || (at === dueAt && delivery.offset < due.offset)))
        )
          due = delivery;
      }
      return due;
    };

    // A suspect runs alone, so an event that kills its caller is charged its deaths alone.
    while (fanOut.slots.size < FAN_OUT_CALLS_IN_FLIGHT && fanOut.aloneOffset === undefined) {
      const due = dueRecord();
      if (due?.leased && fanOut.slots.size > fanOut.overdue.size) break;
      const mayAdmitNew =
        !due?.leased &&
        (!paused || (fanOut.slots.size === 0 && (probeDue || record.deliveries.size === 0)));
      const next = mayAdmitNew ? peekNewEvent() : undefined;
      if (due && (due.leased || fanOut.preferRetry || !next)) {
        fanOut.preferRetry = false;
        const [event] = this.#readFanOutEvent(due.offset);
        const attempt = due.attempt + 1;
        if (!event || attempt > ladder.maxAttempts) {
          givenUp.add(due.offset);
          deadLetters.push({
            type: event?.type || "",
            offset: due.offset,
            attempts: due.attempt,
            error: event
              ? `${due.attempt} deliveries of this event ended without an ack or a failure (the context died mid-call)${due.error ? `; last error: ${due.error}` : ""}`
              : `the event at offset ${due.offset} cannot be read back`,
          });
          continue;
        }
        const chars = JSON.stringify(event).length;
        if (!this.#deliveryCharsInFlight.tryTake(chars)) {
          outOfRoom = true;
          break;
        }
        if (due.leased) fanOut.aloneOffset = due.offset;
        writes.push({
          ...due,
          attempt,
          nextAttemptAtMs: now + CURSOR_DELIVERY_CALL_WATCHDOG_MS,
          leased: true,
        });
        fanOut.slots.add(event.offset);
        calls.push({ event, chars, attempt });
        continue;
      }
      if (!next) break;
      fanOut.preferRetry = true;
      const chars = JSON.stringify(next).length;
      if (!this.#deliveryCharsInFlight.tryTake(chars)) {
        outOfRoom = true;
        break;
      }
      pageIndex++;
      fanOut.admittedThroughOffset = next.offset;
      fanOut.slots.add(next.offset);
      if (!isWake(next))
        writes.push({
          offset: next.offset,
          attempt: 1,
          nextAttemptAtMs: now + CURSOR_DELIVERY_CALL_WATCHDOG_MS,
          leased: true,
          error: null,
        });
      calls.push({ event: next, chars, attempt: 1 });
    }
    if (outOfRoom) {
      // A due record left for room gets a time a watchdog ahead, so the alarm never spins on it.
      this.#waitForFanOutRoom(name, fanOut);
      for (const delivery of record.deliveries.values())
        if (
          !fanOut.slots.has(delivery.offset) &&
          !givenUp.has(delivery.offset) &&
          delivery.nextAttemptAtMs !== null &&
          delivery.nextAttemptAtMs <= now
        )
          writes.push({ ...delivery, nextAttemptAtMs: now + CURSOR_DELIVERY_CALL_WATCHDOG_MS });
    }
    // Durable before any call.
    if (writes.length === 0) this.#persistFanOutCursor(name, fanOut);
    else
      this.#stream.storage.transactionSync(() => {
        for (const delivery of writes) this.#writeFanOutDelivery(name, delivery);
        this.#persistFanOutCursor(name, fanOut);
      });
    for (const call of calls) this.#startFanOutCall(name, row, fanOut, call);
    for (const failure of deadLetters) this.#deadLetter(name, row, failure);
  }

  #readFanOutEvent(offset: number): StreamEvent[] {
    try {
      return this.#stream.read(offset - 1, 1).events.filter((event) => event.offset === offset);
    } catch (error) {
      if (errorCode(error) !== "EVENT_UNREADABLE") throw error;
      return [];
    }
  }

  // The outcome is in by the watchdog; the slot and the room come back only when the call settles. A
  // copy row checks its filter again here: a retry or a resume skips admission.
  #startFanOutCall(name: string, row: Subscription, fanOut: FanOutRow, call: FanOutCall): void {
    const { offset } = call.event;
    let settled = false;
    // Resolves whether the target was handed the event.
    const operation = (async () => {
      const { deliverEvent } = await this.#evaluateTargetHeadForRow(name, row);
      if (!this.#isStillTheRow(name, row)) return false;
      const filtered = evaluateFilter(row.filter, call.event);
      if ("error" in filtered) throw filtered.error;
      if (!filtered.passes) return true;
      await deliverEvent(call.event).catch((error: unknown) => this.#settleLoopLimit(error));
      return true;
    })();
    // Registered before the watchdog's race, so an outcome sees `settled` true.
    const onSettled = (delivered: boolean) => {
      settled = true;
      fanOut.slots.delete(offset);
      fanOut.overdue.delete(offset);
      this.#deliveryCharsInFlight.release(call.chars);
      if (delivered && !isWake(call.event) && offset > row.configuredAtOffset) {
        fanOut.deliveredSinceTiming++;
        fanOut.longestWaitMs = Math.max(
          fanOut.longestWaitMs,
          Date.now() - Date.parse(call.event.createdAt),
        );
      }
      this.#pumpFanOut(name);
      // One `subscription.lag_ms` a burst, or each hundred events, so a row under load is timed too.
      if (
        fanOut.deliveredSinceTiming >= 100 ||
        (fanOut.deliveredSinceTiming > 0 && fanOut.slots.size === 0)
      ) {
        this.#metrics("subscription.lag_ms", fanOut.longestWaitMs, name);
        this.#metrics("subscription.delivered", fanOut.deliveredSinceTiming, name);
        fanOut.deliveredSinceTiming = 0;
        fanOut.longestWaitMs = 0;
      }
    };
    operation.then(onSettled, () => onSettled(false));
    const outcome = withTimeout(
      operation,
      CURSOR_DELIVERY_CALL_WATCHDOG_MS,
      () => `subscription "${name}", offset ${offset}`,
    )
      .finally(() => {
        if (fanOut.aloneOffset === offset) fanOut.aloneOffset = undefined;
      })
      .then(
        () => this.#fanOutDelivered(name, row, fanOut, call),
        (error: unknown) => {
          this.#fanOutFailed(name, row, fanOut, call, error);
          if (!settled) this.#fanOutOverdue(name, fanOut, offset);
        },
      );
    fanOut.outcomes.add(outcome);
    void outcome.finally(() => fanOut.outcomes.delete(outcome));
  }

  // Workers RPC cannot cancel a call in flight. Once every slot holds an overdue call the row is wedged:
  // end the incarnation, and the next one retries each record on its ladder.
  #fanOutOverdue(name: string, fanOut: FanOutRow, offset: number): void {
    fanOut.overdue.add(offset);
    if (fanOut.overdue.size < FAN_OUT_CALLS_IN_FLIGHT) return;
    console.warn({
      event: "delivery.fan-out.wedged",
      namespace: "subscription-delivery",
      message:
        "every call of this fan-out row is past its watchdog and unanswered: the context restarts",
      name,
    });
    this.#abortIncarnation(
      `subscription "${name}": ${FAN_OUT_CALLS_IN_FLIGHT} deliveries unanswered past the watchdog`,
    );
  }

  #fanOutDelivered(name: string, row: Subscription, fanOut: FanOutRow, call: FanOutCall): void {
    if (!this.#isStillTheRow(name, row) || isWake(call.event)) return;
    const record = this.#deliveryRecordFor(name);
    if (record.deliveries.delete(call.event.offset))
      this.#stream.storage.deleteSubscriptionDelivery(name, call.event.offset);
    const {
      failingOffsets: _lifted,
      parkedProbes: _startOver,
      ...cursor
    } = this.#fanOutCursor(name, fanOut);
    if (!jsonEqual(cursor, record.cursor || null)) this.#adoptCursor(name, cursor, true);
    this.#pumpFanOut(name);
  }

  #fanOutFailed(
    name: string,
    row: Subscription,
    fanOut: FanOutRow,
    { event, attempt }: FanOutCall,
    error: unknown,
  ): void {
    if (!this.#isStillTheRow(name, row) || isWake(event)) return;
    const record = this.#deliveryRecordFor(name);
    const delivery = record.deliveries.get(event.offset);
    if (!delivery) return this.#pumpFanOut(name);
    const code = errorCode(error);
    const { readAt, validUntil, unpublishedConfig } = refusalMarks(error);
    // A snapshot read before the event may predate a publication: the row waits it out and asks again.
    const readBeforeEvent = readAt < Date.parse(event.createdAt);
    if (code === "NO_ITX_EXPRESSION_MATCH" && unpublishedConfig && !readBeforeEvent) {
      // Nothing is owed to an unpublished config: the row delivers from the commit that publishes it.
      if (record.deliveries.delete(event.offset))
        this.#stream.storage.deleteSubscriptionDelivery(name, event.offset);
      return this.#pumpFanOut(name);
    }
    if (code && TARGET_FAILURE_CODES.has(code)) {
      this.#writeFanOutDelivery(name, {
        ...delivery,
        attempt: attempt - 1,
        nextAttemptAtMs: null,
        leased: false,
      });
      if (code === "NO_ITX_EXPRESSION_MATCH") {
        fanOut.dangling = true;
        fanOut.refusedUntil = Number.isFinite(validUntil) ? validUntil : undefined;
      } else
        this.#haltRow(name, row.configuredAtOffset, fanOut.admittedThroughOffset, attempt, error);
      return this.#pumpFanOut(name);
    }
    this.#noteFanOutFailure(name, fanOut, event.offset);
    const ladder = this.#ladder(row);
    if (deterministicFailure(error) || attempt >= ladder.maxAttempts)
      this.#deadLetter(name, row, {
        type: event.type,
        offset: event.offset,
        attempts: attempt,
        error,
      });
    else {
      this.#writeFanOutDelivery(name, {
        ...delivery,
        attempt,
        nextAttemptAtMs: Date.now() + ladder.delayMs(attempt),
        leased: false,
        error: errorMessage(error),
      });
      this.#metrics("subscription.retries", 1, name);
    }
    this.#pumpFanOut(name);
  }

  // A delivery refused as a loop is done: never retried nor dead-lettered.
  #settleLoopLimit(error: unknown): void {
    if (errorCode(error) !== "LOOP_LIMIT") throw error;
    recordRefusal(error, (cause, message) => this.#stream.recordLoopLimit(cause, message));
  }

  #ladder(row: Subscription): { maxAttempts: number; delayMs: (attempt: number) => number } {
    if (!targetIsAnotherService(this.#stream.coreReducedState, row))
      return { maxAttempts: DELIVERY_MAX_ATTEMPTS, delayMs: durableLadderDelayMs };
    return {
      maxAttempts: 25,
      delayMs: (attempt) => durableLadderDelayMs(attempt, LONG_LADDER_CAP_MS),
    };
  }

  #noteFanOutFailure(name: string, fanOut: FanOutRow, offset: number): void {
    const cursor = this.#fanOutCursor(name, fanOut);
    const failing = cursor.failingOffsets || [];
    if (failing.includes(offset)) return;
    this.#adoptCursor(
      name,
      {
        ...cursor,
        failingOffsets: [...failing, offset].slice(-FAN_OUT_PAUSE_AFTER_DISTINCT_FAILURES),
      },
      true,
    );
  }

  // Keyed by the row, the last resume and the offset: a replay after a death appends nothing, and an
  // event a resume delivers again is dead-lettered again.
  #deadLetter(name: string, row: Subscription, { offset, attempts, error }: FanOutFailure) {
    if (!this.#isStillTheRow(name, row)) return;
    const idempotencyKey = `itx/subscription-delivery-failed:${name}:${row.configuredAtOffset}:${row.resumed?.atOffset ?? 0}:${offset}`;
    if (!this.#stream.storage.readEventByIdempotencyKey(idempotencyKey)) {
      this.#stream.append({
        type: "events.iterate.com/itx/subscription-delivery-failed",
        idempotencyKey,
        payload: { name, offset, attempts, error: errorMessage(error) },
        source: { cause: this.#causeAt(offset) },
      });
      this.#metrics("subscription.dead_letters", 1, name);
    }
    const record = this.#deliveryRecordFor(name);
    if (record.deliveries.delete(offset))
      this.#stream.storage.deleteSubscriptionDelivery(name, offset);
  }

  #fanOutCursor(name: string, fanOut: FanOutRow): SubscriptionCursor {
    return {
      ...(this.#deliveryRecordFor(name).cursor || { confirmedOffset: 0, attempt: 0 }),
      confirmedOffset: fanOut.admittedThroughOffset,
      attempt: 0,
    };
  }

  // A dangling or paused row with a backlog keeps a probe time; a row with nothing to deliver keeps none.
  #persistFanOutCursor(name: string, fanOut: FanOutRow): void {
    const record = this.#deliveryRecordFor(name);
    const now = Date.now();
    const backlog =
      fanOut.admittedThroughOffset < this.#stream.highestDurableOffset() ||
      [...record.deliveries.values()].some((delivery) => delivery.nextAttemptAtMs === null);
    let nextAttemptAtMs: number | undefined;
    let probes = record.cursor?.parkedProbes ?? 0;
    if ((fanOut.dangling || fanOutPaused(record.cursor)) && backlog) {
      const standing = record.cursor?.nextAttemptAtMs;
      if (standing !== undefined && standing > now) nextAttemptAtMs = standing;
      else if (probes < DELIVERY_MAX_ATTEMPTS) {
        probes += 1;
        nextAttemptAtMs = Math.max(
          now + durableLadderDelayMs(probes),
          (fanOut.dangling && fanOut.refusedUntil) || 0,
        );
      }
    }
    const {
      nextAttemptAtMs: _spent,
      parkedProbes: _probes,
      ...kept
    } = this.#fanOutCursor(name, fanOut);
    const cursor: SubscriptionCursor = {
      ...kept,
      // oxlint-disable-next-line iterate/simple-truthiness-check -- the cursor row is compared with jsonEqual, which counts keys: an absent time must stay absent, not `nextAttemptAtMs: undefined`
      ...(nextAttemptAtMs !== undefined && { nextAttemptAtMs }),
      ...(probes > 0 && { parkedProbes: probes }),
    };
    if (!jsonEqual(cursor, record.cursor || null)) this.#adoptCursor(name, cursor, true);
  }

  #writeFanOutDelivery(name: string, delivery: FanOutDeliveryRecord): void {
    this.#deliveryRecordFor(name).deliveries.set(delivery.offset, delivery);
    this.#stream.storage.writeSubscriptionDelivery(name, delivery);
  }

  #waitForFanOutRoom(name: string, fanOut: FanOutRow): void {
    if (fanOut.waitingForRoom) return;
    fanOut.waitingForRoom = true;
    void this.#deliveryCharsInFlight.whenReleased().then(() => {
      fanOut.waitingForRoom = false;
      this.#pumpFanOut(name);
    });
  }

  // Its target resolves elsewhere now, so a fix is tried at once. The attempts stand.
  #retryPendingNow(name: string, row: Subscription): void {
    const now = Date.now();
    const record = this.#deliveryRecordFor(name);
    const fanOut = this.#fanOutRowFor(name, row);
    for (const delivery of record.deliveries.values())
      if (
        !fanOut.slots.has(delivery.offset) &&
        (delivery.nextAttemptAtMs === null || delivery.nextAttemptAtMs > now)
      )
        this.#writeFanOutDelivery(name, { ...delivery, nextAttemptAtMs: now });
    this.#pumpFanOut(name);
  }

  fanOutView(name: string): { pending: number; paused: boolean } | undefined {
    const record = this.#deliveryRecordByName.get(name);
    const row = this.#stream.coreReducedState.subscriptions[name];
    if (!record || !row || !isFanOutRow(this.#stream.coreReducedState, row)) return undefined;
    const slots = record.fanOut?.slots;
    return {
      pending: [...record.deliveries.keys()].filter((offset) => !slots?.has(offset)).length,
      paused: fanOutPaused(record.cursor),
    };
  }
}

// A facet or a lent stub is pushed whatever the row says.
function isFanOutRow(state: CoreState, row: Subscription): boolean {
  return row.ordered === false && !targetOwnsProgress(state, row);
}

// None once its time has come with its call still out: that call's settle runs the pump.
function fanOutClaim(
  record: SubscriptionDeliveryRecord,
  delivery: FanOutDeliveryRecord,
  now: number,
): number | undefined {
  const at = delivery.nextAttemptAtMs;
  if (at === null || (at <= now && record.fanOut?.slots.has(delivery.offset))) return undefined;
  return at;
}

function fanOutPaused(cursor: SubscriptionCursor | undefined): boolean {
  return (cursor?.failingOffsets?.length ?? 0) >= FAN_OUT_PAUSE_AFTER_DISTINCT_FAILURES;
}

// Never an ephemeral or a delivery fact, and a wake only in the incarnation it names: wakes a
// handler's work caused must not pile up behind a row that could not take them.
function fanOutAdmits(row: Subscription, event: StreamEvent, incarnation: number): boolean {
  if (event.ephemeral || isDeliveryFact(event) || !consumesEvent(row.consumes, event)) return false;
  if (row.copy) {
    // never a copy of an `itx/*` event (core-processor.ts `CopyTarget`)
    if (event.type.startsWith("events.iterate.com/itx/")) return false;
    // a filter that fails lets the event through, and the call fails with its error
    const filtered = evaluateFilter(row.filter, event);
    return "error" in filtered || filtered.passes;
  }
  return !isWake(event) || (event.payload as { incarnation?: number }).incarnation === incarnation;
}

// So a dead letter never has a dead letter of its own.
function isDeliveryFact(event: StreamEvent): boolean {
  return event.type.startsWith("events.iterate.com/itx/subscription-delivery-");
}

function isWake(event: StreamEvent): boolean {
  return event.type === "events.iterate.com/itx/woken";
}

// A refusal no snapshot gave is current and stands until something changes: `Infinity` both.
function refusalMarks(error: unknown): {
  readAt: number;
  validUntil: number;
  unpublishedConfig: boolean;
} {
  const marks = (error ?? {}) as {
    readAt?: unknown;
    validUntil?: unknown;
    unpublishedConfig?: unknown;
  };
  return {
    readAt: typeof marks.readAt === "number" ? marks.readAt : Infinity,
    validUntil: typeof marks.validUntil === "number" ? marks.validUntil : Infinity,
    unpublishedConfig: marks.unpublishedConfig === true,
  };
}

// Clipped: a target that throws a response body must not bloat a record or the core state.
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1024);
}

// `routedTo` may carry a whole worker source. A collision only delays a retry to its rung.
function routeDigestOf(routedTo: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < routedTo.length; index++) {
    hash ^= routedTo.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function rowTakes(row: Subscription, event: StreamEvent): boolean {
  return consumesEvent(row.consumes, event);
}
