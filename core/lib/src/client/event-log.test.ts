// client/event-log.test.ts — the log half of useIterateContext over a fake context whose
// `readEvents` answers as core/itx/src/stream/stream.ts `read` does: at most `limit` rows (capped
// at 1000) and a byte budget (here: at most 300 rows a page), `atHead` once the scan ran out,
// `scannedThroughOffset` the last row read or, at the head, the durable mark. Offsets have gaps, as
// a log whose ephemerals took offsets has.

import { expect, test, vi } from "vitest";
import type { StreamEvent } from "../stream/processor.ts";
import { committedEvent } from "../stream/test-support.ts";
import { connectEventLog, type EventLogItx } from "./event-log.ts";

test("tail: probes the head, reads the page of offsets below it, and is caught up holding only that", async () => {
  const context = fakeContext(offsetsWithGaps(5000));
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail" });
  await settle();
  const held = log.get();
  expect(held).toMatchObject({
    caughtUp: true,
    head: context.head,
    older: { loading: false, exhausted: false },
  });
  expect(offsetsOf(held.events)).toEqual(context.offsets.filter((o) => o > context.head - 1000));
  // the probe, then the page (cut by the budget: read on to the head)
  expect(context.reads[0]).toEqual([Number.MAX_SAFE_INTEGER, 1]);
  log.dispose();
});

test("tail on a log shorter than a page: the log is held from its first event", async () => {
  const context = fakeContext(offsetsWithGaps(200));
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail" });
  await settle();
  expect(log.get()).toMatchObject({ caughtUp: true, older: { exhausted: true } });
  expect(offsetsOf(log.get().events)).toEqual(context.offsets);
  log.dispose();
});

test("since within the newest page: the read starts at since - 1 and holds the event at since and every newer one", async () => {
  const context = fakeContext(offsetsWithGaps(5000));
  const since = context.offsets.at(-11)!;
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail", since });
  await settle();
  expect(context).toMatchObject({
    reads: [
      [Number.MAX_SAFE_INTEGER, 1],
      [since - 1, 1000],
    ],
  });
  expect(log.get()).toMatchObject({ caughtUp: true, head: context.head });
  expect(offsetsOf(log.get().events)).toEqual(context.offsets.filter((o) => o >= since));
  log.dispose();
});

test("since older than the newest page: the read is exactly the one without since", async () => {
  const plain = fakeContext(offsetsWithGaps(5000));
  const withSince = fakeContext(offsetsWithGaps(5000));
  const a = connectEventLog(plain.itx, { consumes: ["*"], history: "tail" });
  const b = connectEventLog(withSince.itx, { consumes: ["*"], history: "tail", since: 10 });
  await settle();
  expect(withSince).toMatchObject({ reads: plain.reads });
  expect(offsetsOf(b.get().events)).toEqual(offsetsOf(a.get().events));
  expect(b.get()).toMatchObject({ caughtUp: true });
  a.dispose();
  b.dispose();
});

test("since above the head (the log is shorter than the caller's copy): the read is exactly the one without since", async () => {
  const plain = fakeContext(offsetsWithGaps(5000));
  const withSince = fakeContext(offsetsWithGaps(5000));
  const a = connectEventLog(plain.itx, { consumes: ["*"], history: "tail" });
  const b = connectEventLog(withSince.itx, {
    consumes: ["*"],
    history: "tail",
    since: withSince.head + 50,
  });
  await settle();
  expect(withSince).toMatchObject({ reads: plain.reads });
  expect(offsetsOf(b.get().events)).toEqual(offsetsOf(a.get().events));
  expect(b.get()).toMatchObject({ caughtUp: true });
  a.dispose();
  b.dispose();
});

test("since equal to the head: the read returns the one event at the head", async () => {
  const context = fakeContext(offsetsWithGaps(5000));
  const log = connectEventLog(context.itx, {
    consumes: ["*"],
    history: "tail",
    since: context.head,
  });
  await settle();
  expect(context.reads[1]).toEqual([context.head - 1, 1000]);
  expect(offsetsOf(log.get().events)).toEqual([context.head]);
  expect(log.get()).toMatchObject({ caughtUp: true, older: { exhausted: false } });
  log.dispose();
});

test("after a since read, loadOlder reads below since - 1, and the log ends as the whole log, sorted, once", async () => {
  const context = fakeContext(offsetsWithGaps(5000));
  const since = context.offsets.at(-11)!;
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail", since });
  await settle();
  log.loadOlder();
  await settle();
  expect(context.reads[2]).toEqual([since - 1 - 1000, 1000]);
  for (let i = 0; i < 20 && !log.get().older.exhausted; i += 1) {
    log.loadOlder();
    await settle();
  }
  expect(log.get()).toMatchObject({ older: { loading: false, exhausted: true } });
  expect(offsetsOf(log.get().events)).toEqual(context.offsets);
  log.dispose();
});

test("a push that arrives during a since read is held once", async () => {
  const context = fakeContext(offsetsWithGaps(5000));
  const since = context.offsets.at(-11)!;
  const read = context.itx.readEvents.bind(context.itx);
  context.itx.readEvents = async (after, limit) => {
    // the subscription re-delivers the head and delivers a new event while the page is read
    if (after === since - 1) context.push([context.head, context.head + 1]);
    return read(after, limit);
  };
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail", since });
  await settle();
  expect(offsetsOf(log.get().events)).toEqual([
    ...context.offsets.filter((o) => o >= since),
    context.head + 1,
  ]);
  expect(log.get()).toMatchObject({ caughtUp: true, head: context.head + 1 });
  log.dispose();
});

test("all ignores since: it reads from the first event", async () => {
  const context = fakeContext(offsetsWithGaps(3000));
  const log = connectEventLog(context.itx, {
    consumes: ["*"],
    history: "all",
    since: context.head - 5,
  });
  await settle();
  expect(context.reads[0]).toEqual([0, 1000]);
  expect(log.get()).toMatchObject({ caughtUp: true, older: { exhausted: true } });
  expect(offsetsOf(log.get().events)).toEqual(context.offsets);
  log.dispose();
});

test("loadOlder reads window after window down to offset 0, and the log is the whole log, sorted, once", async () => {
  const context = fakeContext(offsetsWithGaps(5000));
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail" });
  await settle();
  for (let i = 0; i < 20 && !log.get().older.exhausted; i += 1) {
    log.loadOlder();
    log.loadOlder(); // one read in flight: a second call is a no-op
    expect(log.get().older.loading || context.pendingOlder()).toBe(true);
    await settle();
  }
  const held = log.get();
  expect(held).toMatchObject({ older: { loading: false, exhausted: true } });
  expect(offsetsOf(held.events)).toEqual(context.offsets);
  log.dispose();
});

test("a sparse log: loadOlder reads on (doubling the window) until it found a quarter page of events", async () => {
  // 20,000 offsets, one durable event in every hundred
  const offsets = Array.from({ length: 200 }, (_, i) => (i + 1) * 100);
  const context = fakeContext(offsets);
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail" });
  await settle();
  expect(log.get().events).toHaveLength(10);
  log.loadOlder();
  await settle();
  // 10 + 10 + 20 + 40 + 80 < 250: the fifth window (capped at 16,000 offsets) reaches offset 0
  expect(log.get().events).toHaveLength(200);
  expect(log.get()).toMatchObject({ older: { loading: false, exhausted: true } });
  expect(context.reads.slice(2).map(([after]) => after)).toEqual([18000, 16000, 12000, 4000, 0]);
  log.dispose();
});

test("pushes and pages dedupe by offset, and a push past the head appends", async () => {
  const context = fakeContext(offsetsWithGaps(1500));
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail" });
  await settle();
  const before = log.get().events.length;
  // the subscription re-delivers the newest event and delivers two new ones
  context.push([context.head, context.head + 3, context.head + 5]);
  await settle();
  const held = log.get();
  expect(held.events).toHaveLength(before + 2);
  expect(held).toMatchObject({ head: context.head + 5 });
  expect(offsetsOf(held.events.slice(-3))).toEqual([
    context.head,
    context.head + 3,
    context.head + 5,
  ]);
  log.dispose();
});

test("a push that lands before the first read: the older events read as loading, never as the start of the log", async () => {
  const context = fakeContext(offsetsWithGaps(3000));
  const read = context.itx.readEvents.bind(context.itx);
  let release = () => {};
  const firstRead = new Promise<void>((resolve) => (release = resolve));
  context.itx.readEvents = async (...args) => {
    await firstRead;
    return read(...args);
  };
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "tail" });
  await settle();
  // the live subscription delivers the newest event while the head probe is still unanswered
  context.push([context.head + 1]);
  await settle();
  expect(log.get()).toMatchObject({ caughtUp: false, older: { loading: true, exhausted: false } });
  release();
  await settle();
  expect(log.get()).toMatchObject({ caughtUp: true, older: { loading: false, exhausted: false } });
  log.dispose();
});

test("all: reads every page from the first and is exhausted at once", async () => {
  const context = fakeContext(offsetsWithGaps(3000));
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "all" });
  await settle();
  const held = log.get();
  expect(held).toMatchObject({ caughtUp: true, older: { exhausted: true } });
  expect(offsetsOf(held.events)).toEqual(context.offsets);
  log.dispose();
});

test("who acted and the processors table's version follow the events held", async () => {
  const context = fakeContext([1, 2, 3, 4], (offset) => ({
    ...(offset === 2 && { type: "events.iterate.com/itx/subscription-configured" }),
    ...(offset !== 3 && {
      source: { origin: "/", principal: { actor: offset === 4 ? "user_b" : "user_a" } },
    }),
  }));
  const log = connectEventLog(context.itx, { consumes: ["*"], history: "all" });
  await settle();
  const held = log.get();
  expect(held).toMatchObject({ tableVersion: 2 });
  expect(held.actors.map((actor) => actor.actor)).toEqual(["user_b", "user_a"]);
  expect(held.actors[1]).toMatchObject({ lastSeenAt: "1970-01-01T00:00:02.000Z" });
  log.dispose();
});

test("the log holds the name of its own subscription row, as a handle or an RPC stub answers it", async () => {
  for (const name of ["sub-1a2b3c4d", Promise.resolve("sub-1a2b3c4d")]) {
    const context = fakeContext([1, 2]);
    const log = connectEventLog(
      {
        ...context.itx,
        subscribe: async (input) => ({ ...(await context.itx.subscribe(input)), name }),
      },
      { consumes: ["*"], history: "tail" },
    );
    await vi.waitFor(() => expect(log.get()).toMatchObject({ subscription: "sub-1a2b3c4d" }));
    log.dispose();
  }
  // a context that names none: the log is read as before
  const unnamed = fakeContext([1, 2]);
  const log = connectEventLog(unnamed.itx, { consumes: ["*"], history: "tail" });
  await vi.waitFor(() => expect(log.get()).toMatchObject({ caughtUp: true }));
  expect(log.get()).not.toHaveProperty("subscription", expect.anything());
  log.dispose();
});

// ── the fake context ──
function fakeContext(
  offsets: number[],
  extra: (offset: number) => Partial<StreamEvent> = () => ({}),
) {
  const head = offsets.at(-1) ?? 0;
  const eventAt = (offset: number) => ({
    ...committedEvent(offset, "test.example.com/thing", { offset }),
    ...extra(offset),
  });
  let target: ((batch: unknown[]) => void) | undefined;
  const reads: [number, number][] = [];
  let inFlight = 0;
  const itx: EventLogItx = {
    async subscribe(input) {
      target = (batch) => input.target(batch, undefined);
      return { [Symbol.dispose]() {} };
    },
    async readEvents(after = 0, limit = 500) {
      reads.push([after, limit]);
      inFlight += 1;
      await Promise.resolve();
      inFlight -= 1;
      const cap = Math.min(Math.max(1, limit), 1000, 300); // 300: the byte budget's cut
      const rows = offsets.filter((offset) => offset > after).slice(0, cap);
      const last = rows.at(-1) ?? after;
      const atHead = rows.length < cap || last >= head;
      return {
        events: rows.map(eventAt),
        atHead,
        scannedThroughOffset: atHead ? head : last,
      };
    },
  };
  return {
    itx,
    head,
    offsets,
    reads,
    pendingOlder: () => inFlight > 0,
    push: (pushed: number[]) => target!(pushed.map(eventAt)),
  };
}

/** `count` durable offsets from 1, skipping every seventh (the gaps ephemerals leave). */
function offsetsWithGaps(count: number) {
  const offsets: number[] = [];
  for (let offset = 1; offsets.length < count; offset += 1)
    if (offset % 7 !== 0) offsets.push(offset);
  return offsets;
}

const offsetsOf = (events: StreamEvent[]) => events.map((event) => event.offset);

/** Let every read resolve and the next publish (a 16 ms timer outside a browser) run. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
}
