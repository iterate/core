// A PUSH TO A FACET THAT FAILS, on a real Stream, the real SubscriptionDelivery and the SDK's real
// ProcessorEngine as the facet: over an in-memory SQLite, with the alarm stood in for by a clock
// that the test moves and the pass an alarm runs (`deliverEveryCursorSubscription`).
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import {
  ProcessorEngine,
  StreamProcessor,
  defineProcessorContract,
  type ProcessEventArgs,
  type ReduceArgs,
  type StreamEvent,
} from "iterate/stream/processor";
import { memoryStorage } from "iterate/stream/test-support";
import { z } from "zod";
import { codedError } from "iterate/lib";
import { FacetHandle } from "../context/dispatch.ts";
import { defineItxHost } from "../host.ts";
import { normalizeControlEvent } from "./core-processor.ts";
import { Stream } from "./stream.ts";
import { SubscriptionDelivery } from "./subscription-delivery.ts";

const TICKED = "events.iterate.com/test/counter-ticked";
test("a push that fails on an idle context is delivered by the alarm, with no further append", async () => {
  using context = await contextWithCounterFacet();
  const first = context.tick();
  await context.settled();
  expect(context.trace()).toEqual([`event ${first}`, "at head: 1 ticks"]);

  context.failPushes(1);
  const missed = context.tick();
  await context.settled();
  // the facet was shown nothing, and the context now owes it a catch-up, on its alarm
  expect(context.trace()).toHaveLength(2);
  expect(context.delivery.deadlines()).toMatchObject([{ name: "counter", attempt: 0 }]);

  await context.alarmAt(context.delivery.deadlines()[0]!.at);
  expect(context.trace().slice(2)).toEqual([`event ${missed}`, "at head: 2 ticks"]);
  expect(context.delivery.deadlines()).toEqual([]);
  expect(context.storedClaims()).toEqual([]);
});

test("an append before the alarm delivers the missed events in order and once, and the claim is spent", async () => {
  using context = await contextWithCounterFacet();
  context.failPushes(1);
  const missed = context.tick();
  await context.settled();
  expect(context.delivery.deadlines()).toHaveLength(1);

  const next = context.tick();
  await context.settled();
  expect(context.trace()).toEqual([`event ${missed}`, `event ${next}`, "at head: 2 ticks"]);
  expect(context.delivery.deadlines()).toEqual([]);

  // an alarm that was already on its way finds nothing owed
  await context.alarmAt(Date.now() + 60_000);
  expect(context.trace()).toHaveLength(3);
});

test("the claim outlives the incarnation: the next one catches the facet up", async () => {
  using context = await contextWithCounterFacet();
  context.failPushes(1);
  const missed = context.tick();
  await context.settled();
  const claims = context.delivery.deadlines();
  expect(claims).toHaveLength(1);

  const next = await context.nextIncarnation();
  expect(next.delivery.deadlines()).toEqual(claims);
  await next.alarmAt(claims[0]!.at);
  expect(next.trace()).toEqual([`event ${missed}`, "at head: 1 ticks"]);
  expect(next.delivery.deadlines()).toEqual([]);
});

test("a catch-up that keeps failing is tried 15 times, later each time, and then given up: the row is not halted", async () => {
  using context = await contextWithCounterFacet();
  context.failPushes(Infinity);
  const missed = context.tick();
  await context.settled();

  const waits: number[] = [];
  for (let deadline; (deadline = context.delivery.deadlines()[0]);) {
    waits.push(deadline.at - Date.now());
    await context.alarmAt(deadline.at);
  }
  expect(waits).toHaveLength(15);
  // 1 s doubling to 30 minutes, each within the ladder's 20% of jitter
  waits.forEach((wait, index) => {
    const rung = Math.min(1_000 * 2 ** index, 30 * 60_000);
    expect(wait).toBeGreaterThanOrEqual(rung * 0.8);
    expect(wait).toBeLessThanOrEqual(rung * 1.2);
  });
  expect(context.storedClaims()).toEqual([]);
  expect(context.events("events.iterate.com/itx/subscription-delivery-halted")).toEqual([]);
  expect(context.issues().at(-1)).toContain("subscription-delivery.catch-up-given-up");

  // the row is pushed as before: the first push that succeeds delivers what was missed
  context.failPushes(0);
  const later = context.tick();
  await context.settled();
  expect(context.trace()).toEqual([`event ${missed}`, `event ${later}`, "at head: 2 ticks"]);
});

test("a facet that restarts under the alarm's catch-up fails that attempt: the next one waits its rung", async () => {
  using context = await contextWithCounterFacet();
  context.failPushes(1);
  const missed = context.tick();
  await context.settled();

  context.failPushes(1, codedError("FACET_RESTARTED", "the facet restarted"));
  await context.alarmAt(context.delivery.deadlines()[0]!.at);
  expect(context.trace()).toEqual([]);
  expect(context.delivery.deadlines()).toMatchObject([{ name: "counter", attempt: 1 }]);
  expect(context.delivery.deadlines()[0]!.at).toBeGreaterThan(Date.now() + 1_500);

  await context.alarmAt(context.delivery.deadlines()[0]!.at);
  expect(context.trace()).toEqual([`event ${missed}`, "at head: 1 ticks"]);
});

test("attempts that died with the context count: the claim is given up without one more call", async () => {
  using context = await contextWithCounterFacet();
  context.failPushes(1);
  context.tick();
  await context.settled();
  const [name, claim] = context.storedClaims()[0]!;
  context.stream.storage.writeSubscriptionCursor(name, { ...claim, attempt: 15 });

  const next = await context.nextIncarnation();
  await next.alarmAt(claim.nextAttemptAtMs!);
  expect(next.storedClaims()).toEqual([]);
  expect(next.trace()).toEqual([]);
  expect(context.issues().at(-1)).toContain("subscription-delivery.catch-up-given-up");
});

test("a push that the platform failed is logged with the context's path, so /exceptions can say which context", async () => {
  using context = await contextWithCounterFacet();
  context.tick();
  await context.settled();
  const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // as the runtime stamps a CPU kill of the facet's Worker (iterate/lib platform-retry.ts)
  context.failPushes(
    1,
    Object.assign(new Error("Worker exceeded CPU time limit."), { overloaded: true }),
  );
  context.tick();
  await context.settled();
  expect(warned.mock).toMatchObject({
    calls: [
      [
        {
          event: "subscription-delivery.platform-failure-deliver",
          kind: "overloaded",
          name: "counter",
          path: "/x",
          message: "Error: Worker exceeded CPU time limit.",
        },
      ],
    ],
  });
});

test("a push of ephemerals alone that fails owes nothing: the log could not return them", async () => {
  using context = await contextWithCounterFacet();
  context.failPushes(1);
  context.stream.append({ type: TICKED, ephemeral: true });
  await context.settled();
  expect(context.delivery.deadlines()).toEqual([]);
});

const CounterContract = defineProcessorContract({
  slug: "counter",
  version: "1.0.0",
  description: "counts ticks",
  stateSchema: z.object({ ticks: z.number().default(0) }),
  consumes: [TICKED],
  emits: [],
});

/** Says each event it is given and each at-head pass, in the order it was given them. */
class CounterProcessor extends StreamProcessor<{ ticks: number }> {
  readonly contract = CounterContract;
  readonly trace: string[] = [];

  override reduce({ event, state }: ReduceArgs<{ ticks: number }>) {
    return event.type === TICKED ? { ticks: state.ticks + 1 } : undefined;
  }

  override processEvent({
    event,
    state,
    delivery,
  }: ProcessEventArgs<{ ticks: number }>): undefined {
    if (event) this.trace.push(`event ${event.offset}`);
    if (delivery.caughtUp) this.trace.push(`at head: ${state.ticks} ticks`);
  }
}

/** A context at `/x` whose row `counter` pushes the facet `counter`, once the row's first catch-up
 *  has ended. The test moves its clock, and the issues that a failed push reports are not printed. */
async function contextWithCounterFacet() {
  vi.useFakeTimers({ toFake: ["Date"] });
  const issues = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return {
    ...(await incarnation(new DatabaseSync(":memory:"), memoryStorage())),
    /** Each issue that was reported, as its JSON. */
    issues: () => issues.mock.calls.map((call) => JSON.stringify(call)),
    [Symbol.dispose]() {
      vi.useRealTimers();
      vi.restoreAllMocks();
    },
  };
}

/** One incarnation of the context over `db`, with the facet's checkpoint in `checkpoints`. */
async function incarnation(db: DatabaseSync, checkpoints: ReturnType<typeof memoryStorage>) {
  let failures = 0;
  let failure = new Error(
    "Subrequest depth limit exceeded. This request looped back into the Workers runtime too many times.",
  );
  const counter = new CounterProcessor();
  const stream = new Stream({
    // The cast: the stream's own storage type is not exported, and this has its two members.
    storage: storageOf(db) as never,
    path: "/x",
    onCommit: (events, after, through) => void delivery.onCommit(events, after, through),
  });
  const engine = new ProcessorEngine(counter, {
    stream: {
      append: (...events) => stream.append(...events),
      read: async (afterOffset, limit) => stream.read(afterOffset, limit),
      claim: async () => undefined,
    },
    storage: checkpoints,
    fedByPushes: true,
  });
  const throughTheFailingHop = <T>(call: () => Promise<T>): Promise<T> =>
    failures-- > 0 ? Promise.reject(failure) : call();
  const delivery = new SubscriptionDelivery({
    stream,
    evaluateItxExpression: async (expression) => ({
      value: new FacetHandle(() => {}),
      validUntil: Infinity,
      routedTo: JSON.stringify(expression),
    }),
    refuseHeldVerb: async () => {},
    pushEventBatchToFacet: (_facet, events, range) =>
      throughTheFailingHop(() => engine.processEventBatch(events, range)),
    catchUpFacetFromLog: () => throughTheFailingHop(() => engine.catchUpFromLog()),
    reconcileAlarm: () => {},
    runAsDelivery: (_events, call) => call(),
    appendCopy: async () => {},
    abortIncarnation: () => {},
    metrics: () => {},
  });
  stream.appendWakeRecord({ cause: "alarm", due: ["retry"] });
  if (!stream.coreReducedState.subscriptions.counter)
    stream.append(
      normalizeControlEvent(
        {
          type: "events.iterate.com/itx/subscription-configured",
          payload: {
            name: "counter",
            target: "itx.builtins.facets.get('counter').processEventBatch",
            consumes: [TICKED],
          },
        },
        "/x",
      ),
    );
  /** Every push and catch-up that a commit started has ended. */
  const settled = async () => {
    for (let turn = 0; turn < 20; turn++) await delivery.deliveriesQueuedFor("counter");
  };
  await settled();
  counter.trace.length = 0;
  return {
    stream,
    delivery,
    /** What the facet was given, in order: each event, and each pass at the head. */
    trace: () => counter.trace,
    /** Appends a tick and answers its offset. */
    tick: () => stream.append({ type: TICKED })[0]!.offset,
    /** The next `count` pushes and catch-ups fail, with the depth-limit error unless `error` is given. */
    failPushes: (count: number, error = failure) => {
      failures = count;
      failure = error;
    },
    settled,
    /** The alarm's pass at `time`. */
    alarmAt: async (time: number) => {
      vi.setSystemTime(time);
      await delivery.deliverEveryCursorSubscription();
    },
    events: (type: string): StreamEvent[] =>
      stream.read(0, 1000).events.filter((event) => event.type === type),
    storedClaims: () => stream.storage.listSubscriptionCursors(),
    /** The same storage under a new Stream, delivery and facet instance. */
    nextIncarnation: () => incarnation(db, checkpoints),
  };
}

/** A context's storage over `db`: a read answers its rows, a write answers none. */
function storageOf(db: DatabaseSync) {
  return {
    sql: {
      exec(query: string, ...params: unknown[]) {
        const statement = db.prepare(query);
        const rows = /^\s*(select|with|pragma)/i.test(query)
          ? (statement.all(...(params as never[])) as Record<string, unknown>[])
          : (statement.run(...(params as never[])), []);
        return {
          toArray: () => rows,
          one: () => rows[0],
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync<T>(closure: () => T): T {
      db.exec("BEGIN");
      try {
        const out = closure();
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

// the kernel's reducer reads the host's roots when it resolves a row's target
defineItxHost({ firstPartyFacets: {} });
