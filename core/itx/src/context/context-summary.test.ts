// The fold of a context's log into what it says about itself, and the tracker that keeps it across
// wakes. The row the mind stores from it is the deployed stack's (core/alchemy/scripts/smoke).
import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import {
  CATCH_UP_MAX_EVENTS,
  CONTEXT_DESCRIBED_TYPE,
  ContextSummaryTracker,
  EMPTY_CONTEXT_SUMMARY,
  EVENT_TYPES_OMITTED,
  foldContextSummary,
} from "./context-summary.ts";

test("a fold counts every type, and only what is not the kernel's own is activity", () => {
  expect(
    foldContextSummary(EMPTY_CONTEXT_SUMMARY, [
      event(1, "events.iterate.com/itx/created", "2026-11-13T10:00:00.000Z"),
      event(2, "events.iterate.com/agent/turn-started", "2026-11-13T10:00:01.000Z"),
      event(3, "demo/ping", "2026-11-13T10:00:02.000Z"),
      event(5, "events.iterate.com/itx/woken", "2026-11-13T11:00:00.000Z"),
    ]),
  ).toEqual({
    throughOffset: 5,
    eventCount: 4,
    createdAt: "2026-11-13T10:00:00.000Z",
    lastEventAt: "2026-11-13T11:00:00.000Z",
    lastActivityAt: "2026-11-13T10:00:02.000Z",
    eventTypes: {
      "events.iterate.com/itx/created": 1,
      "events.iterate.com/agent/turn-started": 1,
      "demo/ping": 1,
      "events.iterate.com/itx/woken": 1,
    },
    recentTypes: ["events.iterate.com/agent/turn-started", "demo/ping"],
  });
});

test.for([
  {
    name: "the newest description stands, and an absent field keeps what stood",
    payloads: [{ description: "first", metadata: { owner: "a" } }, { description: "second" }],
    expected: { description: "second", metadata: { owner: "a" } },
  },
  {
    name: "null clears a field",
    payloads: [{ description: "first", metadata: { owner: "a" } }, { metadata: null }],
    expected: { description: "first", metadata: undefined },
  },
  {
    name: "a payload that is no description changes nothing",
    payloads: [{ description: "first" }, { description: 7 }],
    expected: { description: "first" },
  },
  {
    name: "a metadata too long to send at every wake is not kept",
    payloads: [{ metadata: { blob: "x".repeat(5_000) } }],
    expected: { metadata: undefined },
  },
])("$name", ({ payloads, expected }) => {
  const summary = foldContextSummary(
    EMPTY_CONTEXT_SUMMARY,
    payloads.map((payload, index) =>
      event(index + 1, CONTEXT_DESCRIBED_TYPE, "2026-11-13T10:00:00.000Z", payload),
    ),
  );
  expect(summary).toMatchObject(expected);
  // a description is the context's word about itself, not activity on it
  expect(summary).toMatchObject({ recentTypes: [] });
  expect(summary).not.toHaveProperty("lastActivityAt");
});

test("more distinct types than the limit are counted together, so a summary stays small", () => {
  const summary = foldContextSummary(
    EMPTY_CONTEXT_SUMMARY,
    Array.from({ length: 250 }, (_, index) =>
      event(index + 1, `demo/type-${String(index)}`, "2026-11-13T10:00:00.000Z"),
    ),
  );
  expect(Object.keys(summary.eventTypes)).toHaveLength(201);
  expect(summary).toMatchObject({ eventCount: 250, eventTypes: { [EVENT_TYPES_OMITTED]: 50 } });
});

test("a tracker reads the log once, then folds each commit, and stores only what moved", () => {
  const log = memoryLog([event(1, "events.iterate.com/itx/created"), event(2, "demo/ping")]);
  const tracker = new ContextSummaryTracker(log);
  // before its first read, a commit is left to the log
  tracker.committed([event(2, "demo/ping")]);
  expect(tracker.current()).toMatchObject({ throughOffset: 2, eventCount: 2 });
  tracker.committed([event(3, "demo/ping"), { ...event(4, "demo/typing"), ephemeral: true }]);
  expect(tracker.current()).toMatchObject({ eventCount: 3, eventTypes: { "demo/ping": 2 } });
  tracker.current();
  expect(log).toMatchObject({ reads: 1, puts: 2 });
});

test("the next incarnation starts from the stored summary and reads only what came after", () => {
  const log = memoryLog([event(1, "events.iterate.com/itx/created"), event(2, "demo/ping")]);
  new ContextSummaryTracker(log).current();
  log.events.push(event(3, "demo/ping"));
  expect(new ContextSummaryTracker(log).current()).toMatchObject({
    throughOffset: 3,
    eventCount: 3,
  });
  expect(log).toMatchObject({ readAfter: [0, 2] });
});

test("a long log with no summary is caught up over several wakes, each a bounded read", () => {
  const log = memoryLog(
    Array.from({ length: CATCH_UP_MAX_EVENTS + 1_500 }, (_, index) =>
      event(index + 1, "demo/ping"),
    ),
  );
  expect(new ContextSummaryTracker(log).current()).toMatchObject({
    eventCount: CATCH_UP_MAX_EVENTS,
  });
  expect(new ContextSummaryTracker(log).current()).toMatchObject({
    eventCount: CATCH_UP_MAX_EVENTS + 1_500,
  });
});

function event(
  offset: number,
  type: string,
  createdAt = "2026-11-13T10:00:00.000Z",
  payload?: StreamEvent["payload"],
): StreamEvent {
  return { offset, type, createdAt, payload, path: "/a", source: { origin: "/a" } };
}

/** A context's log and kv, as the tracker reads and writes them. */
function memoryLog(events: StreamEvent[]) {
  const kv = new Map<string, unknown>();
  const log = {
    events,
    reads: 0,
    puts: 0,
    readAfter: [] as number[],
    kv: {
      // the one cast: the kv's `get` is generic over what a caller says it stored
      get: ((key: string) => kv.get(key)) as SyncKvStorage["get"],
      put: (key: string, value: unknown) => {
        log.puts += 1;
        kv.set(key, structuredClone(value));
      },
    },
    read: (afterOffset: number, limit: number) => {
      log.reads += 1;
      log.readAfter.push(afterOffset);
      const page = log.events.filter((each) => each.offset > afterOffset).slice(0, limit);
      const last = page.at(-1)?.offset ?? afterOffset;
      const atHead = last >= (log.events.at(-1)?.offset ?? 0);
      return { events: page, scannedThroughOffset: last, atHead };
    },
  };
  return log;
}
