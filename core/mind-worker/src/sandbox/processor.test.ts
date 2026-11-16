// The sandbox's processor and its `idle` schedule, which lives on the sandbox's context and so
// outlives the processor that `deleted` turns off. The processor runs on the in-memory stream and the
// real checkpoint table; the context's schedules are a map. The idle check itself is out of scope.
import type { ItxEntrypointScope } from "core-itx";
import { ProcessorEngine } from "iterate/stream/processor";
import { memoryStorage, memoryStream } from "iterate/stream/test-support";
import { expect, test, vi } from "vitest";
import { SandboxContract } from "./contract.ts";
import { SandboxProcessor } from "./processor.ts";

test("a sandbox deleted by a fresh incarnation leaves no idle schedule on its context", async () => {
  const sandbox = sandboxOf();
  sandbox.log.stream.append(
    { type: "events.iterate.com/sandbox/created", payload: { path: sandbox.path } },
    { type: "events.iterate.com/sandbox/started", payload: { from: "image" } },
  );
  // the first incarnation reaches the head and sets the clock
  await sandbox.incarnation().catchUpFromLog();
  await vi.waitFor(() => expect(sandbox).toMatchObject({ schedules: ["idle"] }));
  // the object slept: the delete wakes a new incarnation on the same storage, with no clock in memory
  sandbox.log.engines.push(sandbox.incarnation());
  sandbox.log.stream.append({ type: "events.iterate.com/sandbox/delete-requested", payload: {} });
  await vi.waitFor(() => expect(sandbox).toMatchObject({ deleted: 1 }));
  // exact: no schedule at all may stay on a deleted sandbox's context
  expect({ schedules: sandbox.schedules, deleted: sandbox.deleted }).toEqual({
    schedules: [],
    deleted: 1,
  });
});

/** A sandbox's log, its context's schedules, and a new processor incarnation on demand, each on the
 *  same checkpoint table, as an object that wakes again finds its storage. */
function sandboxOf() {
  const path = "/sandbox";
  const log = memoryStream(path);
  const storage = memoryStorage();
  const schedules = new Map<string, unknown>();
  // The members of the context's `itx` that the processor reaches: its schedules, and `cd("/")` for
  // the certificate it cross-posts to the mind catalog, which this test does not read.
  const itx = {
    schedules: {
      set: async (schedule: { key: string }) => void schedules.set(schedule.key, schedule),
      cancel: async (key: string) => void schedules.delete(key),
    },
    cd: () => ({ append: async () => [] }),
    [Symbol.dispose]() {},
  } as unknown as ItxEntrypointScope & Disposable;
  return {
    path,
    log,
    incarnation: () =>
      new ProcessorEngine(
        new SandboxProcessor(
          SandboxContract,
          () => itx,
          () => path,
          // the container's erase
          { teardown: async () => {} },
          { usedAt: async () => null, park: async () => true, checkpoint: async () => {} },
        ),
        { stream: log.stream, storage },
      ),
    get schedules() {
      return [...schedules.keys()];
    },
    get deleted() {
      return log.events.filter((event) => event.type === "events.iterate.com/sandbox/deleted")
        .length;
    },
  };
}
