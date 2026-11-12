// An ephemeral takes an offset but is never stored, so a later incarnation, which resumes from the
// last durable mark, may hand its offset to a durable. So `read()` never proves a scan past the
// durable mark, and nothing a reader persists can name an ephemeral's offset.

import { codedError, errorCode, reportIssue } from "iterate/lib";
import type { ItxExpressionInput } from "iterate/expression";
import type { StreamPage, WaitForEventFilter } from "iterate/api";
import {
  idempotencyConflictMessage,
  sameIdempotentEvent,
  type StreamEvent,
  type StreamEventInput,
  ReduceCheckpointTable,
  type SqlStorageHandle,
} from "iterate/stream/processor";
import { newChain, recordRefusal, refuseActPastLimit, storedCause, type Cause } from "../cause.ts";
import type { Caller } from "../caller.ts";
import { reduceScheduledAppends } from "./scheduled-appends.ts";
import { eventsOwedAtWake } from "./wake-events.ts";
import {
  CoreContract,
  STREAM_RECORD_TYPES,
  reduceCoreEventBatch,
  type CoreState,
} from "./core-processor.ts";

// In JS chars. Workers RPC caps one message at 32 MiB, and a 128 MiB isolate holds about four
// copies of a body while it reads it back.
const EVENT_BODY_MAX_CHARS = 8 * 1024 * 1024;
// In UTF-8 bytes as SQLite counts them. A page always carries at least one row.
const READ_PAGE_BUDGET_BYTES = 8 * 1024 * 1024;
// This incarnation's recent ephemerals, in serialized JS chars, oldest out first. An event over the
// whole budget is kept alone until the next arrives.
export const RECENT_EPHEMERALS_BUDGET_CHARS = 1024 * 1024;

// A paused stream must still accept its own resume, record its wake, be reset and learn its children.
const PAUSE_EXEMPT_EVENT_TYPES = new Set([
  ...STREAM_RECORD_TYPES,
  "events.iterate.com/itx/paused",
  "events.iterate.com/itx/resumed",
  "events.iterate.com/itx/aborted",
  "events.iterate.com/itx/facet-aborted",
  "events.iterate.com/itx/schedule-cancelled",
  "events.iterate.com/itx/child-created",
]);

// In memory only. A call on an instance the platform replaced never sees the new one's appends and
// times out, so a caller that must not miss a fact waits in slices.
type WaitForEventWaiter = {
  matches: (event: StreamEvent) => boolean;
  afterOffset: number;
  resolve: (event: StreamEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Wake =
  | { cause: "call"; caller?: "loaded" | "context" | "other"; call?: string }
  | { cause: "alarm"; due: ("schedule" | "retry" | "claim" | "run")[] };

interface StreamDeps {
  storage: DurableObjectStorageSlice;
  path: string;
  birthEvents?: readonly StreamEventInput[];
  // Asked at every wake, the birth too: each lands once (./wake-events.ts).
  wakeEvents?: () => readonly StreamEventInput[];
  // Once per offset-advancing commit, ephemerals included, after the waiters settle.
  onCommit: (freshEvents: StreamEvent[], afterOffset: number, throughOffset: number) => void;
  wakeRecordDetail?: () => Record<string, unknown>;
  cause?: () => Cause | undefined;
  // A fan-out lease names the deploy, so a lease that other code left behind is no death of its call.
  deployId?: string;
}

export class Stream {
  readonly storage: StreamStorage;
  readonly #path: string;
  readonly #birthEvents: readonly StreamEventInput[];
  readonly #wakeEvents: NonNullable<StreamDeps["wakeEvents"]>;
  readonly #onCommit: StreamDeps["onCommit"];
  readonly #wakeRecordDetail: StreamDeps["wakeRecordDetail"];
  readonly #ambientCause: StreamDeps["cause"];
  // Ephemerals included: an ephemeral-only batch advances this alone.
  #highestAssignedOffset: number;
  // The core checkpoint's offset, so there is no separate mark to write.
  #highestDurableOffset: number;
  readonly #waitForEventWaiters: WaitForEventWaiter[] = [];
  readonly #recentEphemerals: { event: StreamEvent; chars: number }[] = [];
  #recentEphemeralsChars = 0;
  readonly #evictedEphemeralThroughOffsetByType = new Map<string, number>();
  #coreReducedState: CoreState;
  #coreReducedThroughOffset: number;

  constructor(deps: StreamDeps) {
    this.storage = new StreamStorage(deps.storage, deps.deployId || "this deploy");
    this.#path = deps.path;
    this.#birthEvents = deps.birthEvents || [];
    this.#wakeEvents = deps.wakeEvents || (() => []);
    this.#onCommit = deps.onCommit;
    this.#wakeRecordDetail = deps.wakeRecordDetail;
    this.#ambientCause = deps.cause;
    // Read whatever version wrote it: a version bump still recovers the head.
    const checkpoint = this.storage.reduceCheckpoints.read<CoreState>(CoreContract.slug);
    // The log is the truth and the checkpoint its cache: a lost checkpoint is re-derived, never fatal.
    const highestDurableOffset = checkpoint
      ? checkpoint.reducedThroughOffset
      : this.storage.highestEventOffset();
    if (!checkpoint && highestDurableOffset > 0)
      reportIssue(
        "stream.core-checkpoint-missing",
        new Error(
          `stream ${this.#path}: the log holds rows through offset ${highestDurableOffset} but no core checkpoint — re-deriving the mark and the state from the log`,
        ),
        { highestDurableOffset },
      );
    this.#highestDurableOffset = highestDurableOffset;
    this.#highestAssignedOffset = highestDurableOffset;
    if (checkpoint?.reducerVersion === CoreContract.version) {
      this.#coreReducedState = checkpoint.state || CoreContract.initialState();
      this.#coreReducedThroughOffset = checkpoint.reducedThroughOffset;
    } else {
      this.#coreReducedState = CoreContract.initialState();
      this.#coreReducedThroughOffset = 0;
      // In the DO constructor a page that did not fit the isolate would be a reboot loop.
      while (this.#coreReducedThroughOffset < this.#highestDurableOffset) {
        let page: StreamPage;
        try {
          page = this.read(this.#coreReducedThroughOffset, 500);
        } catch (error) {
          // An unreadable row must not brick the context on every wake: report it and skip it.
          if (errorCode(error) !== "EVENT_UNREADABLE") throw error;
          const { offset } = (error as { data: { offset: number } }).data;
          reportIssue("stream.core-rereduce", error, { offset });
          this.#coreReducedThroughOffset = offset;
          continue;
        }
        this.#coreReducedState = this.#reduceEventsIntoCoreReducedState(
          page.events,
          this.#coreReducedState,
        );
        if (page.scannedThroughOffset <= this.#coreReducedThroughOffset) break; // nothing left
        this.#coreReducedThroughOffset = page.scannedThroughOffset;
      }
    }
  }

  #wakeRecorded = false;

  // A fresh store's birth is always a call's: nothing has an alarm before it exists.
  appendBirthRecord(cause?: Cause, wake: Wake = { cause: "call" }): void {
    if (this.#highestDurableOffset !== 0) return;
    const source = cause && { cause };
    this.append(
      {
        type: "events.iterate.com/itx/created",
        payload: { path: this.#path },
        source,
      },
      {
        type: "events.iterate.com/itx/woken",
        payload: { incarnation: this.storage.incarnation, ...wake },
        source,
      },
      ...this.#birthEvents.map((event) => ({ ...event, source })),
    );
    this.#wakeRecorded = true;
    this.#appendOwedAtWake(source);
  }

  // Every run the last incarnation left open is settled `interrupted` in the same batch: a run is
  // never re-run.
  appendWakeRecord(wake: Wake, cause?: Cause): void {
    if (this.#wakeRecorded) return;
    if (wake.cause === "call")
      refuseActPastLimit(
        cause,
        this.#highestDurableOffset === 0 ? `a birth of ${this.#path}` : `waking ${this.#path}`,
      );
    // Workers Logs stamps a Durable Object's RPC call with no ray: the chain's ray joins it to the edge.
    console.log({
      event: "context.woken",
      path: this.#path,
      incarnation: this.storage.incarnation,
      ...wake,
      ...(cause && storedCause(cause)),
    });
    if (this.#highestDurableOffset === 0) return this.appendBirthRecord(cause, wake);
    const interrupted = Object.entries(this.#coreReducedState.scriptRuns).map(
      ([requestOffset, run]): StreamEventInput => ({
        type: "events.iterate.com/itx/run-settled",
        idempotencyKey: `itx/run-settled:${requestOffset}`,
        source: run.cause && { cause: run.cause },
        payload: {
          requestOffset: Number(requestOffset),
          settlement: {
            status: "failed",
            error:
              "the context restarted before the script's result was recorded; it may have partly or fully run, and it is not run again",
            failureKind: "interrupted",
          },
        },
      }),
    );
    this.append(
      {
        type: "events.iterate.com/itx/woken",
        payload: { incarnation: this.storage.incarnation, ...wake, ...this.#wakeRecordDetail?.() },
        source: cause && { cause },
      },
      ...interrupted,
    );
    this.#wakeRecorded = true;
    this.#appendOwedAtWake(cause && { cause });
  }

  /** The host's wake events that this context has not had (./wake-events.ts), appended AFTER the
   *  wake record and by themselves: a host's event that the stream refuses (a pause that came
   *  between, a payload the reducer throws on) must never fail a wake, or the context could not
   *  be reached at all, its own resume included. They go to the log as birth events do, with no
   *  `normalizeControlEvent`: a host's event that needs it must come normalized. */
  #appendOwedAtWake(source: StreamEventInput["source"]): void {
    try {
      const owed = eventsOwedAtWake(
        this.#wakeEvents(),
        (key) => !!this.storage.readEventByIdempotencyKey(key),
        Object.keys(this.#coreReducedState.subscriptions),
        !!this.#coreReducedState.paused,
      );
      if (owed.length === 0) return;
      this.append(...owed.map((event) => ({ ...event, source })));
      for (const event of owed)
        console.log({
          event: "context.wake-event-appended",
          namespace: "stream",
          message: "a context got an event its host wants on every context, at this wake",
          path: this.#path,
          type: event.type,
          idempotencyKey: event.idempotencyKey,
        });
    } catch (error) {
      console.error({
        event: "context.wake-event-refused",
        namespace: "stream",
        message:
          "a host's wake event was not appended; the wake went on, and the next wake asks again",
        path: this.#path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #refusePastLoopLimit(cause: Cause, act: string): void {
    try {
      refuseActPastLimit(cause, act);
    } catch (error) {
      recordRefusal(error, (refused, message) => this.recordLoopLimit(refused, message));
      throw error;
    }
  }

  recordLoopLimit(cause: Cause, error: string): void {
    const idempotencyKey = `itx/loop-limit:${cause.chain}`;
    if (this.storage.readEventByIdempotencyKey(idempotencyKey)) return;
    this.append({
      type: "events.iterate.com/itx/loop-limit",
      idempotencyKey,
      payload: { chain: cause.chain, depth: cause.depth, error: error.slice(0, 1024) },
      source: { cause: storedCause(cause) },
    });
  }

  wakeRecorded(): boolean {
    return this.#wakeRecorded;
  }

  #rememberEphemeral(event: StreamEvent, chars: number) {
    this.#recentEphemerals.push({ event, chars });
    this.#recentEphemeralsChars += chars;
    while (
      this.#recentEphemeralsChars > RECENT_EPHEMERALS_BUDGET_CHARS &&
      this.#recentEphemerals.length > 1
    ) {
      const oldest = this.#recentEphemerals.shift()!;
      this.#recentEphemeralsChars -= oldest.chars;
      this.#evictedEphemeralThroughOffsetByType.set(oldest.event.type, oldest.event.offset);
    }
  }

  recentEphemeralsChars() {
    return this.#recentEphemeralsChars;
  }

  evictedEphemeralThroughOffset(type: string) {
    return this.#evictedEphemeralThroughOffsetByType.get(type);
  }

  highestAssignedOffset(): number {
    return this.#highestAssignedOffset;
  }

  highestDurableOffset(): number {
    return this.#highestDurableOffset;
  }

  get coreReducedState(): CoreState {
    return this.#coreReducedState;
  }

  coreReducedStateSnapshot(): { offset: number; state: CoreState } {
    return { offset: this.#coreReducedThroughOffset, state: this.#coreReducedState };
  }

  // Synchronous end to end, and every refusal happens before a single write. The marks move only
  // after the transaction returns, so a throw leaves them true.
  append(...events: StreamEventInput[]): StreamEvent[] {
    if (events.length === 0) return [];
    for (const event of events) {
      // oxlint-disable-next-line iterate/simple-truthiness-check -- append is the SOLE enforcement point (no boundary validator); event.type arrives from callers/the wire, so the static string type is not a runtime guarantee
      if (typeof event.type !== "string" || event.type.trim() === "")
        throw new Error("append: every event needs a non-empty type");
    }
    const paused = this.#coreReducedState.paused;
    const afterOffset = this.#highestAssignedOffset;
    const createdAt = new Date().toISOString();
    const committedEvents: StreamEvent[] = []; // a dedupe hit echoes the existing event
    const freshEvents: StreamEvent[] = [];
    const eventsByIdempotencyKey = new Map<string, StreamEvent>();
    const freshDurables: { event: StreamEvent; serializedBody: string }[] = [];
    const freshEphemerals: { event: StreamEvent; chars: number }[] = [];
    let throughOffset = afterOffset;
    let ambientCause: Cause | undefined;
    for (const event of events) {
      const { offset: expectedOffset, ...input } = event;
      const cause =
        input.source?.cause ||
        (ambientCause ||= this.#ambientCause?.() || newChain("a context's own work"));
      const eventInput = {
        ...input,
        source: {
          ...input.source,
          origin: input.source?.origin || this.#path,
          cause: storedCause(cause),
        },
      };
      let existingEvent = eventInput.idempotencyKey
        ? eventsByIdempotencyKey.get(eventInput.idempotencyKey)
        : undefined;
      if (eventInput.idempotencyKey && !existingEvent) {
        const row = this.storage.readEventByIdempotencyKey(eventInput.idempotencyKey);
        if (row)
          existingEvent = {
            ...(JSON.parse(row.body) as object),
            offset: row.offset,
            path: this.#path,
          } as StreamEvent;
      }
      if (existingEvent) {
        if (!sameIdempotentEvent(existingEvent, eventInput))
          throw codedError(
            "IDEMPOTENCY_CONFLICT",
            idempotencyConflictMessage(eventInput.idempotencyKey!, existingEvent.offset),
            { existingOffset: existingEvent.offset },
          );
        committedEvents.push(existingEvent);
        continue;
      }
      if (paused && !PAUSE_EXEMPT_EVENT_TYPES.has(eventInput.type))
        throw codedError("STREAM_PAUSED", `stream paused: ${paused.reason}`);
      // Past the loop limit the platform's records still land.
      if (!STREAM_RECORD_TYPES.has(eventInput.type))
        this.#refusePastLoopLimit(cause, `an append of ${eventInput.type} to ${this.#path}`);
      const offset = throughOffset + 1;
      if (expectedOffset !== undefined && expectedOffset !== offset)
        throw codedError(
          "OFFSET_CONFLICT",
          `expected offset ${expectedOffset}, but the next offset is ${offset}`,
          { expected: expectedOffset, actual: offset },
        );
      throughOffset = offset;
      // Measured for an ephemeral too: it rides every push over the same 32 MiB RPC.
      const serializedBody = JSON.stringify({ ...eventInput, createdAt });
      if (serializedBody.length > EVENT_BODY_MAX_CHARS)
        throw codedError(
          "EVENT_TOO_LARGE",
          `append: the ${JSON.stringify(eventInput.type)} event that would land at offset ${offset} serializes to ${serializedBody.length} chars, over the ${EVENT_BODY_MAX_CHARS / (1024 * 1024)} MiB ceiling — Workers RPC caps a message at 32 MiB and a read holds several copies; store the payload elsewhere and let the event name it. Nothing was appended`,
          {
            type: eventInput.type,
            offset,
            chars: serializedBody.length,
            maxChars: EVENT_BODY_MAX_CHARS,
          },
        );
      const committedEvent = { ...eventInput, offset, createdAt, path: this.#path } as StreamEvent;
      if (eventInput.idempotencyKey)
        eventsByIdempotencyKey.set(eventInput.idempotencyKey, committedEvent);
      committedEvents.push(committedEvent);
      freshEvents.push(committedEvent);
      if (committedEvent.ephemeral)
        freshEphemerals.push({ event: committedEvent, chars: serializedBody.length });
      else freshDurables.push({ event: committedEvent, serializedBody });
    }
    if (freshEvents.length === 0) return committedEvents;
    // Folded here, before any write: `reduceCoreEventBatch` skips a throwing event, never refuses.
    if (freshEvents.some((event) => event.type === "events.iterate.com/itx/schedule-set")) {
      const scheduledAppends = freshEvents.reduce(
        reduceScheduledAppends,
        this.#coreReducedState.schedules,
      );
      if (
        Object.keys(scheduledAppends).length > 100 ||
        JSON.stringify(
          Object.fromEntries(
            Object.entries(scheduledAppends).map(([key, { failure: _failure, ...definition }]) => [
              key,
              definition,
            ]),
          ),
        ).length >
          1024 * 1024
      )
        throw codedError(
          "SCHEDULE_LIMIT",
          "a context may retain at most 100 schedules and 1,048,576 serialized characters; cancel failed definitions before adding more",
        );
    }
    if (freshDurables.length === 0) {
      // An ephemeral-only batch leaves SQLite untouched.
      this.#highestAssignedOffset = throughOffset;
    } else {
      let reducedState = this.#coreReducedState;
      this.storage.transactionSync(() => {
        for (const { event, serializedBody } of freshDurables)
          this.storage.insertEvent(event.offset, serializedBody, event.idempotencyKey || null);
        // Into a local: a failed write must leave no phantom core state in memory.
        reducedState = this.#reduceEventsIntoCoreReducedState(freshEvents, reducedState);
        this.storage.reduceCheckpoints.write(
          CoreContract.slug,
          { reducerVersion: CoreContract.version, reducedThroughOffset: throughOffset },
          reducedState,
          reducedState !== this.#coreReducedState,
        );
      });
      this.#coreReducedState = reducedState;
      this.#coreReducedThroughOffset = throughOffset;
      this.#highestAssignedOffset = throughOffset;
      this.#highestDurableOffset = throughOffset;
    }
    // Only once the batch has landed: a refusal would leave a phantom at an offset a later batch reuses.
    for (const { event, chars } of freshEphemerals) this.#rememberEphemeral(event, chars);
    this.#resolveWaitForEventWaiters(freshEvents); // waiters first: onCommit may append again (a nested commit)
    this.#onCommit(freshEvents, afterOffset, throughOffset);
    return committedEvents;
  }

  #reduceEventsIntoCoreReducedState(events: StreamEvent[], state: CoreState): CoreState {
    return reduceCoreEventBatch(events, state, (error, event) =>
      reportIssue("stream.core-reduce", error, { offset: event.offset, type: event.type }),
    );
  }

  // `scannedThroughOffset` never names an ephemeral: persist it, never an event's offset.
  // Synchronous: the stream's own single-turn scans call it inline.
  read(afterOffset = 0, limit = 500, options: { includeEphemeral?: boolean } = {}): StreamPage {
    // At most 1000: the object overhead of tiny events, which the byte budget cannot see.
    limit = Math.min(Math.max(1, limit), 1000);
    const { rows, nextRowDidNotFit } = this.storage.readEventPage(
      afterOffset,
      limit,
      READ_PAGE_BUDGET_BYTES,
    );
    const events: StreamEvent[] = rows.map((row) => {
      let body: Omit<StreamEvent, "offset" | "path">;
      try {
        body = JSON.parse(row.body) as Omit<StreamEvent, "offset" | "path">;
      } catch (error) {
        throw codedError(
          "EVENT_UNREADABLE",
          `read: the stored body at offset ${row.offset} is not JSON (${error instanceof Error ? error.message : String(error)}) — read on from that offset to skip it`,
          { offset: row.offset },
        );
      }
      return { ...body, offset: row.offset, path: this.#path };
    });
    // An exact-`limit` page whose last row is the durable mark is at the head too.
    const highestDurableOffset = this.highestDurableOffset();
    const lastOffset = events.length ? events[events.length - 1].offset : afterOffset;
    const atHead =
      !nextRowDidNotFit && (events.length < limit || lastOffset >= highestDurableOffset);
    const scannedThroughOffset = atHead ? highestDurableOffset : lastOffset;
    if (options.includeEphemeral) {
      const ceiling = atHead ? Infinity : scannedThroughOffset;
      for (const { event } of this.#recentEphemerals)
        if (event.offset > afterOffset && event.offset <= ceiling) events.push(event);
      events.sort((a, b) => a.offset - b.offset);
    }
    return { events, scannedThroughOffset, atHead };
  }

  // No await between the log scan and the waiter's registration, or a racing commit is lost.
  waitForEvent(filter: WaitForEventFilter = {}): Promise<StreamEvent> {
    const types = filter.type ? [filter.type].flat() : [];
    const payload = Object.entries(filter.payload || {});
    const matches = (event: StreamEvent) =>
      (types.length === 0 || types.includes(event.type)) &&
      payload.every(
        ([field, value]) => (event.payload as Record<string, unknown>)?.[field] === value,
      );
    const afterOffset = filter.afterOffset ?? this.highestAssignedOffset();
    const timeoutMs = Math.min(filter.timeoutMs ?? 30_000, 120_000);
    let cursor = afterOffset;
    for (;;) {
      const page = this.read(cursor, 500);
      for (const event of page.events) if (matches(event)) return Promise.resolve(event);
      if (page.atHead) break;
      cursor = page.scannedThroughOffset;
    }
    return new Promise<StreamEvent>((resolve, reject) => {
      const waiter: WaitForEventWaiter = {
        matches,
        afterOffset,
        resolve,
        reject,
        timer: setTimeout(() => {
          const at = this.#waitForEventWaiters.indexOf(waiter);
          if (at !== -1) this.#waitForEventWaiters.splice(at, 1);
          reject(
            codedError(
              "WAIT_TIMEOUT",
              `waitForEvent: no ${types.length === 0 ? "" : `${types.map((type) => `"${type}"`).join(" | ")} `}event after offset ${afterOffset} within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs),
      };
      this.#waitForEventWaiters.push(waiter);
    });
  }

  // An explicit afterOffset ahead of the head must not be satisfied by an earlier fresh event.
  #resolveWaitForEventWaiters(freshEvents: StreamEvent[]): void {
    for (const event of freshEvents) {
      if (this.#waitForEventWaiters.length === 0) return;
      for (const w of [...this.#waitForEventWaiters]) {
        if (!w.matches(event) || event.offset <= w.afterOffset) continue;
        this.#waitForEventWaiters.splice(this.#waitForEventWaiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(event);
      }
    }
  }

  // None while paused: pause holds every scheduled append.
  nextScheduledAppendAt(): number | null {
    if (this.#coreReducedState.paused) return null;
    let earliest: number | null = null;
    for (const row of Object.values(this.#coreReducedState.schedules)) {
      if (row.failure) continue;
      const at = Date.parse(row.nextAt);
      earliest = earliest === null ? at : Math.min(earliest, at);
    }
    return earliest;
  }
}

type DurableObjectStorageSlice = {
  sql: SqlStorageHandle;
  transactionSync<T>(closure: () => T): T;
};

// A SQLite TEXT cell caps around 2 MB (SQLITE_TOOBIG).
const EVENT_CHUNK_SIZE = 512 * 1024;

export type SubscriptionCursor = {
  confirmedOffset: number;
  attempt: number;
  nextAttemptAtMs?: number;
  resumeAppliedAtOffset?: number;
  failingOffsets?: number[];
  parkedProbes?: number;
  // Kept across incarnations so a re-point while the context slept is seen by the next one.
  route?: string;
};

export type FanOutDeliveryRecord = {
  offset: number;
  attempt: number;
  nextAttemptAtMs: number | null;
  // Stored as the deploy's id, so a lease another deploy left is none.
  leased: boolean;
  error: string | null;
};

type StoredEventRow = { offset: number; body: string };

class StreamStorage {
  readonly #storage: DurableObjectStorageSlice;
  readonly #sql: SqlStorageHandle;
  readonly reduceCheckpoints: ReduceCheckpointTable;
  readonly incarnation: number;

  readonly #deployId: string;
  constructor(storage: DurableObjectStorageSlice, deployId: string) {
    this.#deployId = deployId;
    this.#storage = storage;
    this.#sql = storage.sql;
    // The other tables only on a virgin store: they are never dropped.
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS stream_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const prior = this.#sql
      .exec<{ value: string }>("SELECT value FROM stream_meta WHERE key = 'incarnation'")
      .toArray()[0];
    if (!prior) {
      this.#sql.exec(
        `CREATE TABLE IF NOT EXISTS events (
           offset INTEGER PRIMARY KEY,
           body TEXT NOT NULL,
           idempotency_key TEXT UNIQUE
         )`,
      );
      this.#sql.exec(
        `CREATE TABLE IF NOT EXISTS event_chunks (
           offset INTEGER NOT NULL,
           chunk_index INTEGER NOT NULL,
           chunk TEXT NOT NULL,
           PRIMARY KEY (offset, chunk_index)
         )`,
      );
      this.#sql.exec(
        "CREATE TABLE IF NOT EXISTS subscription_cursors (name TEXT PRIMARY KEY, cursor TEXT NOT NULL)",
      );
      this.#sql.exec(
        `CREATE TABLE IF NOT EXISTS subscription_deliveries (
           name TEXT NOT NULL,
           offset INTEGER NOT NULL,
           attempt INTEGER NOT NULL,
           next_attempt_at_ms INTEGER,
           leased TEXT NOT NULL,
           error TEXT,
           PRIMARY KEY (name, offset)
         )`,
      );
      ReduceCheckpointTable.createTable(this.#sql);
    }
    this.reduceCheckpoints = new ReduceCheckpointTable(this.#sql, { createTable: false });
    this.incarnation = (prior ? Number(prior.value) : 0) + 1;
  }

  countIncarnation(): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO stream_meta (key, value) VALUES ('incarnation', ?)",
      String(this.incarnation),
    );
  }

  transactionSync<T>(closure: () => T): T {
    return this.#storage.transactionSync(closure);
  }

  highestEventOffset(): number {
    const row = this.#sql
      .exec<{ offset: number | null }>("SELECT MAX(offset) AS offset FROM events")
      .toArray()[0];
    return row?.offset === null || row?.offset === undefined ? 0 : Number(row.offset);
  }

  // A cut never splits a surrogate pair: a lone surrogate becomes U+FFFD on the SQLite TEXT bind.
  insertEvent(offset: number, serializedBody: string, idempotencyKey: string | null): void {
    if (serializedBody.length <= EVENT_CHUNK_SIZE) {
      this.#sql.exec(
        "INSERT INTO events (offset, body, idempotency_key) VALUES (?, ?, ?)",
        offset,
        serializedBody,
        idempotencyKey,
      );
      return;
    }
    this.#sql.exec(
      "INSERT INTO events (offset, body, idempotency_key) VALUES (?, '', ?)",
      offset,
      idempotencyKey,
    );
    for (let start = 0, idx = 0; start < serializedBody.length; idx++) {
      let end = Math.min(start + EVENT_CHUNK_SIZE, serializedBody.length);
      if (end < serializedBody.length) {
        const c = serializedBody.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end -= 1;
      }
      this.#sql.exec(
        "INSERT INTO event_chunks (offset, chunk_index, chunk) VALUES (?, ?, ?)",
        offset,
        idx,
        serializedBody.slice(start, end),
      );
      start = end;
    }
  }

  readEventByIdempotencyKey(idempotencyKey: string): StoredEventRow | undefined {
    const row = this.#sql
      .exec<{ offset: number; body: string }>(
        "SELECT offset, body FROM events WHERE idempotency_key = ?",
        idempotencyKey,
      )
      .toArray()[0];
    if (!row) return undefined;
    const offset = Number(row.offset);
    return { offset, body: this.#reassembleBody(offset, String(row.body)) };
  }

  readEventPage(
    afterOffset: number,
    limit: number,
    budgetBytes: number,
  ): { rows: StoredEventRow[]; nextRowDidNotFit: boolean } {
    const rows: StoredEventRow[] = [];
    let pageBytes = 0;
    for (const row of this.#sql.exec<{ offset: number; body: string; body_bytes: number }>(
      `SELECT offset, body,
              length(CAST(body AS BLOB)) + COALESCE((SELECT SUM(length(CAST(chunk AS BLOB)))
                FROM event_chunks WHERE event_chunks.offset = events.offset), 0) AS body_bytes
         FROM events WHERE offset > ? ORDER BY offset LIMIT ?`,
      afterOffset,
      limit,
    )) {
      if (rows.length > 0 && pageBytes + Number(row.body_bytes) > budgetBytes)
        return { rows, nextRowDidNotFit: true };
      pageBytes += Number(row.body_bytes);
      const offset = Number(row.offset);
      rows.push({ offset, body: this.#reassembleBody(offset, String(row.body)) });
    }
    return { rows, nextRowDidNotFit: false };
  }

  listSubscriptionCursors(): [name: string, cursor: SubscriptionCursor][] {
    return this.#sql
      .exec<{ name: string; cursor: string }>("SELECT name, cursor FROM subscription_cursors")
      .toArray()
      .map((row) => [String(row.name), JSON.parse(String(row.cursor)) as SubscriptionCursor]);
  }

  writeSubscriptionCursor(name: string, cursor: SubscriptionCursor): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO subscription_cursors (name, cursor) VALUES (?, ?)",
      name,
      JSON.stringify(cursor),
    );
  }

  deleteSubscriptionCursor(name: string): void {
    this.#sql.exec("DELETE FROM subscription_cursors WHERE name = ?", name);
  }

  listSubscriptionDeliveries(): [name: string, record: FanOutDeliveryRecord][] {
    return this.#sql
      .exec<{
        name: string;
        offset: number;
        attempt: number;
        next_attempt_at_ms: number | null;
        leased: string;
        error: string | null;
      }>(
        "SELECT name, offset, attempt, next_attempt_at_ms, leased, error FROM subscription_deliveries",
      )
      .toArray()
      .map((row) => [
        String(row.name),
        {
          offset: Number(row.offset),
          attempt: Number(row.attempt),
          nextAttemptAtMs: row.next_attempt_at_ms === null ? null : Number(row.next_attempt_at_ms),
          leased: String(row.leased) === this.#deployId,
          error: row.error || null,
        },
      ]);
  }

  writeSubscriptionDelivery(name: string, record: FanOutDeliveryRecord): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO subscription_deliveries (name, offset, attempt, next_attempt_at_ms, leased, error) VALUES (?, ?, ?, ?, ?, ?)",
      name,
      record.offset,
      record.attempt,
      record.nextAttemptAtMs,
      record.leased ? this.#deployId : "",
      record.error,
    );
  }

  deleteSubscriptionDelivery(name: string, offset: number): void {
    this.#sql.exec(
      "DELETE FROM subscription_deliveries WHERE name = ? AND offset = ?",
      name,
      offset,
    );
  }

  deleteSubscriptionDeliveries(name: string): void {
    this.#sql.exec("DELETE FROM subscription_deliveries WHERE name = ?", name);
  }

  // An empty cell is the chunked marker: a real body is never empty JSON.
  #reassembleBody(offset: number, cell: string): string {
    if (cell !== "") return cell;
    return this.#sql
      .exec<{ chunk: string }>(
        "SELECT chunk FROM event_chunks WHERE offset = ? ORDER BY chunk_index",
        offset,
      )
      .toArray()
      .map((r) => String(r.chunk))
      .join("");
  }
}

export interface ReachableContext {
  fetch(request: Request): Promise<Response>;
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  read(
    afterOffset?: number,
    limit?: number,
    options?: { includeEphemeral?: boolean },
  ): Promise<StreamPage>;
  reserveSend(key: string): Promise<{ recorded?: StreamEvent; reserved: boolean }>;
  releaseSend(key: string): Promise<void>;
  invoke(call: ItxExpressionInput, args?: unknown[], caller?: Caller): Promise<unknown>;
}
