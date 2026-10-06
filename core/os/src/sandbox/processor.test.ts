// src/sandbox/processor.test.ts — the SandboxProcessor's executable spec: the reduce as `{ events →
// state }` rows, and the check saga against fake deps (what the container says, whether a park or a
// checkpoint happened, the schedule it sets). The facet and its container are pinned end to end in
// test/vitest/os/sandboxes.e2e.test.ts, which runs on a deployment, or locally with a Docker engine.
import { expect, test, vi } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import type { StreamEvent } from "iterate/stream/processor";
import {
  SANDBOX_CHECKPOINT_AFTER_MS,
  SANDBOX_IDLE_CHECK,
  SandboxContract,
  type SandboxState,
} from "./contract.ts";
import { SandboxProcessor, type SandboxCheckDeps } from "./processor.ts";

const IDLE_AFTER_MS = 300_000;
const NOW = Date.parse("2026-10-06T12:00:00Z");

const requested = { type: "events.iterate.com/sandbox/create-requested", payload: {} };
const created = { type: "events.iterate.com/sandbox/created", payload: { path: "/sandboxes/x" } };
const stopped = { type: "events.iterate.com/sandbox/stopped", payload: { reason: "idle" } };
const born = { creation: { status: "created" as const, offset: 2 }, deletion: null };
const aNumber = expect.any(Number);

const rows: {
  name: string;
  events: { type: string; payload: object }[];
  state: Record<string, unknown>;
}[] = [
  {
    name: "a started container is running, from the image: no disk yet, a start time",
    events: [requested, created, started()],
    state: { ...born, running: true, snapshot: null, savedAt: aNumber },
  },
  {
    name: "a snapshot is the disk the next start restores, and when it was saved; the container goes on running",
    events: [requested, created, started(), snapshotted("a")],
    state: {
      ...born,
      running: true,
      snapshot: { id: "a", size: 10 },
      savedAt: aNumber,
    },
  },
  {
    name: "a stop ends the run and keeps the disk",
    events: [requested, created, started(), snapshotted("a"), stopped],
    state: { ...born, running: false, snapshot: { id: "a", size: 10 }, savedAt: null },
  },
  {
    name: "a stop for a reason no verb saw ends the run the same way",
    events: [requested, created, started(), { type: stopped.type, payload: { reason: "unknown" } }],
    state: { ...born, running: false },
  },
  {
    name: "a later snapshot replaces the earlier one",
    events: [requested, created, started(), snapshotted("a"), snapshotted("b")],
    state: {
      ...born,
      running: true,
      snapshot: { id: "b", size: 10 },
      savedAt: aNumber,
    },
  },
  {
    name: "a start from an image on request, naming the snapshot it leaves behind, forgets it",
    events: [
      requested,
      created,
      started(),
      snapshotted("a"),
      stopped,
      started({ from: "image", discardedSnapshotId: "a" }),
    ],
    state: { ...born, running: true, snapshot: null, savedAt: aNumber },
  },
  {
    name: "a start that discarded some other snapshot keeps the current one",
    events: [
      requested,
      created,
      started(),
      snapshotted("b"),
      stopped,
      started({ from: "snapshot", snapshotId: "b", discardedSnapshotId: "a" }),
    ],
    state: {
      ...born,
      running: true,
      snapshot: { id: "b", size: 10 },
      savedAt: aNumber,
    },
  },
  {
    name: "configured patches the idle period; a field left out stays",
    events: [
      requested,
      created,
      { type: "events.iterate.com/sandbox/configured", payload: { idleAfterMs: 60_000 } },
      { type: "events.iterate.com/sandbox/configured", payload: {} },
    ],
    state: { ...born, idleAfterMs: 60_000 },
  },
  {
    name: "an exec fact and a check are not state",
    events: [
      requested,
      created,
      started(),
      {
        type: "events.iterate.com/sandbox/exec-finished",
        payload: { command: "ls", exitCode: 0, durationMs: 5, stdoutBytes: 1, stderrBytes: 0 },
      },
      { type: SANDBOX_IDLE_CHECK, payload: {} },
    ],
    state: { ...born, running: true, snapshot: null, savedAt: aNumber },
  },
];
for (const { name, events, state } of rows)
  test(`the sandbox's reduce: ${name}`, () => {
    using sandbox = harness();
    expect(reduceProcessor(sandbox.processor, events)).toEqual({
      ...SandboxContract.initialState(),
      ...state,
    });
  });

test("the check saga: a running sandbox gets one check, and a second delivery sets no other", async () => {
  using sandbox = harness();
  const { processor, schedules } = sandbox;
  await deliver(processor, { running: true }, null);
  await deliver(processor, { running: true }, null);
  expect(schedules).toEqual([{ key: "idle", afterMs: IDLE_AFTER_MS }]);
});

test("the check saga: the first check is the checkpoint period away when that comes before the idle period", async () => {
  using sandbox = harness();
  const { processor, schedules } = sandbox;
  await deliver(processor, { running: true, idleAfterMs: 3_600_000 }, null);
  expect(schedules).toEqual([{ key: "idle", afterMs: SANDBOX_CHECKPOINT_AFTER_MS }]);
});

test("the check saga: a sandbox that is not running sets none, and one that stops is armed again when it next runs", async () => {
  using sandbox = harness();
  const { processor, schedules } = sandbox;
  await deliver(processor, { running: false }, null);
  expect(schedules).toEqual([]);
  await deliver(processor, { running: true }, null);
  await deliver(processor, { running: false }, null);
  await deliver(processor, { running: true }, null);
  expect(schedules).toHaveLength(2);
});

test("the check saga: a check that finds the container idle parks it, and sets nothing", async () => {
  using sandbox = harness({ usedAt: async () => NOW - IDLE_AFTER_MS - 1 });
  const { processor, schedules, calls } = sandbox;
  await deliver(processor, { running: true }, check());
  expect({ calls, schedules }).toEqual({ calls: ["park"], schedules: [] });
});

test("the check saga: a check that finds the container used sets the next check for the time left", async () => {
  using sandbox = harness({ usedAt: async () => NOW - 100_000 });
  const { processor, schedules, calls } = sandbox;
  await deliver(processor, { running: true, savedAt: NOW - 100_000 }, check());
  expect({ calls, schedules }).toEqual({
    calls: [],
    schedules: [{ key: "idle", afterMs: IDLE_AFTER_MS - 100_000 }],
  });
});

test("the check saga: a sandbox in use whose disk has gone unsaved for the checkpoint period is checkpointed, and the container goes on", async () => {
  using sandbox = harness({
    usedAt: async () => NOW - 60_000,
  });
  const { processor, schedules, calls } = sandbox;
  await deliver(
    processor,
    {
      running: true,
      idleAfterMs: 3_600_000,
      savedAt: NOW - SANDBOX_CHECKPOINT_AFTER_MS - 60_000 - 1,
    },
    check(),
  );
  expect(calls).toEqual(["checkpoint"]);
  expect(schedules).toEqual([{ key: "idle", afterMs: SANDBOX_CHECKPOINT_AFTER_MS }]);
});

test("the check saga: no checkpoint when the container was not used since its disk was saved, or the save is recent", async () => {
  using unusedSandbox = harness({ usedAt: async () => NOW - 120_000 });
  await deliver(
    unusedSandbox.processor,
    {
      running: true,
      idleAfterMs: 3_600_000,
      savedAt: NOW - 100_000,
    },
    check(),
  );
  using recentSandbox = harness({ usedAt: async () => NOW - 1_000 });
  await deliver(
    recentSandbox.processor,
    {
      running: true,
      idleAfterMs: 3_600_000,
      savedAt: NOW - 60_000,
    },
    check(),
  );
  expect([unusedSandbox.calls, recentSandbox.calls]).toEqual([[], []]);
});

test("the check saga: a park that finds the sandbox busy sets the next check a whole period out", async () => {
  using sandbox = harness({
    usedAt: async () => NOW - IDLE_AFTER_MS,
    park: async () => false,
  });
  const { processor, schedules } = sandbox;
  await deliver(processor, { running: true }, check());
  expect(schedules).toEqual([{ key: "idle", afterMs: IDLE_AFTER_MS }]);
});

test("the check saga: a container that is not running is parked (the stop is recorded)", async () => {
  using sandbox = harness({ usedAt: async () => null });
  const { processor, calls } = sandbox;
  await deliver(processor, { running: true }, check());
  expect(calls).toEqual(["park"]);
});

test("the check saga: a deleted sandbox is never armed (its lifecycle saga is the entity test's)", async () => {
  using sandbox = harness();
  const { processor, schedules } = sandbox;
  await deliver(processor, { running: true, deletion: { status: "deleted", offset: 9 } }, null);
  expect(schedules).toEqual([]);
});

/** The scheduled checks the processor set, and what it was asked of the container. */
function harness(overrides: Partial<SandboxCheckDeps> = {}) {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  const schedules: { key: unknown; afterMs: number }[] = [];
  const calls: string[] = [];
  const processor = new SandboxProcessor(
    SandboxContract,
    () =>
      ({
        schedules: {
          set: async (input: { key: unknown; when: { afterMs: number } }) => {
            schedules.push({ key: input.key, afterMs: input.when.afterMs });
          },
        },
        [Symbol.dispose]: () => undefined,
      }) as never,
    () => "/sandboxes/x",
    {},
    {
      usedAt: async () => NOW,
      park: async () => {
        calls.push("park");
        return true;
      },
      checkpoint: async () => {
        calls.push("checkpoint");
      },
      ...overrides,
    },
  );
  return { processor, schedules, calls, [Symbol.dispose]: () => vi.useRealTimers() };
}

const check = () => ({ type: SANDBOX_IDLE_CHECK, payload: {} });

function started(payload: object = { from: "image" }) {
  return { type: "events.iterate.com/sandbox/started", payload };
}
function snapshotted(id: string) {
  return { type: "events.iterate.com/sandbox/snapshotted", payload: { id, size: 10 } };
}

/** One delivery to `processEvent`, answering the background work it started. */
async function deliver(
  processor: SandboxProcessor,
  state: Partial<SandboxState>,
  event: { type: string; payload: object } | null,
) {
  const work: Promise<unknown>[] = [];
  processor.processEvent({
    state: { ...SandboxContract.initialState(), ...born, ...state },
    event: event as StreamEvent | null,
    delivery: { caughtUp: true },
    runInBackground: (attempt: () => Promise<unknown>) => work.push(attempt()),
    blockProcessorWhile: () => undefined,
    append: async () => [],
  } as never);
  await Promise.all(work);
}
