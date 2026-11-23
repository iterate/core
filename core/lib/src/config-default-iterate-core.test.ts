// The default config's local mirror of github.com/iterate/core
// (core/configs/default/iterate-core.ts, init.ts, worker.ts): created and scheduled on
// mind/worker-updated, and pulled in its own delivery on iterate-core/sync-requested.
import { expect, test, vi } from "vitest";
import {
  ensureIterateCoreRepo,
  ITERATE_CORE_ORIGIN,
  ITERATE_CORE_REPO,
  ITERATE_CORE_SYNC_REQUESTED,
  iterateCoreSyncEvent,
} from "../../configs/default/iterate-core.ts";
import Config from "../../configs/default/worker.ts";

test("ensureIterateCoreRepo creates /repos/github.com/iterate/core, sets origin, schedules daily sync, and queues an initial pull when empty", async () => {
  const harness = harnessOf({ origin: null, tip: null });
  await ensureIterateCoreRepo(harness.itx as never);
  expect(harness).toMatchObject({
    created: [ITERATE_CORE_REPO],
    originsSet: [[ITERATE_CORE_REPO, ITERATE_CORE_ORIGIN]],
    schedules: [
      {
        path: ITERATE_CORE_REPO,
        spec: {
          key: "iterate-core-sync",
          when: { everyMs: 24 * 60 * 60 * 1_000 },
          events: [{ type: ITERATE_CORE_SYNC_REQUESTED }],
        },
      },
    ],
    appended: [
      {
        path: ITERATE_CORE_REPO,
        event: {
          type: ITERATE_CORE_SYNC_REQUESTED,
          payload: {},
          idempotencyKey: "iterate-core/initial-sync",
        },
      },
    ],
  });
});

test("ensureIterateCoreRepo is idempotent once origin and tip exist", async () => {
  const harness = harnessOf({ origin: ITERATE_CORE_ORIGIN, tip: "abc123" });
  await ensureIterateCoreRepo(harness.itx as never);
  expect(harness).toMatchObject({
    created: [ITERATE_CORE_REPO],
    originsSet: [],
    appended: [],
  });
  expect(harness.schedules).toHaveLength(1);
});

test("worker.ts handles iterate-core/sync-requested on /repos/github.com/iterate/core and ignores other paths", async () => {
  const harness = harnessOf({ origin: ITERATE_CORE_ORIGIN, tip: null });
  const config = Object.create(Config.prototype) as {
    processEvent(args: unknown): Promise<void>;
  };

  // Other paths are ignored.
  await iterateCoreSyncEvent(harness.itx as never, { path: "/" });
  await iterateCoreSyncEvent(harness.itx as never, { path: "/repos/config" });
  expect(harness).toMatchObject({ pulls: [] });

  // Sync event on the repo's own context pulls from ITERATE_CORE_ORIGIN.
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await config
    .processEvent({
      event: { type: ITERATE_CORE_SYNC_REQUESTED, path: ITERATE_CORE_REPO, offset: 1, payload: {} },
      itx: harness.itx,
    })
    .catch(() => {});
  errors.mockRestore();
  expect(harness).toMatchObject({
    pulls: [[ITERATE_CORE_REPO, { remote: ITERATE_CORE_ORIGIN }]],
  });
});

// ── helpers ──

function harnessOf(state: { origin: string | null; tip: string | null }) {
  const created: string[] = [];
  const originsSet: [string, string][] = [];
  const pulls: [string, unknown][] = [];
  const schedules: { path: string; spec: unknown }[] = [];
  const appended: { path: string; event: unknown }[] = [];

  const itx = {
    repos: {
      create: async (path: string) => {
        created.push(path);
        return { path };
      },
      get: (path: string) => ({
        origin: async () => state.origin,
        setOrigin: async (url: string) => {
          state.origin = url;
          originsSet.push([path, url]);
          return { origin: url };
        },
        tip: async () => state.tip,
        pull: async (options?: unknown) => {
          pulls.push([path, options]);
          return { status: "updated", commitOid: "def456", previousOid: state.tip };
        },
      }),
    },
    cd: (path: string) => ({
      schedules: {
        set: async (spec: unknown) => {
          schedules.push({ path, spec });
        },
      },
      append: async (event: unknown) => {
        appended.push({ path, event });
      },
      facets: {
        get: () => {
          throw new Error("no facets in harness");
        },
      },
    }),
  };

  return { itx, created, originsSet, pulls, schedules, appended };
}
