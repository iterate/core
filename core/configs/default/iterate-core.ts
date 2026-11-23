// iterate-core.ts — A LOCAL COPY OF THE PLATFORM'S PUBLIC SOURCE (github.com/iterate/core), at
// /repos/github.com/iterate/core. Every new mind creates the repo on its first publish, points
// its origin at https://github.com/iterate/core.git, pulls it in a delivery of its own (so
// `mind/worker-updated` stays fast), and refreshes it once a day on a schedule. Agents can read
// `itx.repos.get("/repos/github.com/iterate/core")` directly instead of fetching GitHub over HTTP,
// and call `.pull()` whenever they want the newest `main`.
import type { IterateConfigProcessEventArgs } from "iterate/sdk";

export const ITERATE_CORE_REPO = "/repos/github.com/iterate/core";
export const ITERATE_CORE_ORIGIN = "https://github.com/iterate/core.git";
export const ITERATE_CORE_SYNC_REQUESTED = "iterate-core/sync-requested";

const SYNC_EVERY_MS = 24 * 60 * 60 * 1_000;

/** Ensures `/repos/github.com/iterate/core` exists, points at `ITERATE_CORE_ORIGIN`, has its daily
 *  refresh schedule, and queues an initial pull when the repo is still empty. Idempotent: runs
 *  inside `init` on every `mind/worker-updated` without blocking on the pull itself. */
export async function ensureIterateCoreRepo(
  itx: IterateConfigProcessEventArgs<"agents">["itx"],
): Promise<void> {
  await itx.repos.create(ITERATE_CORE_REPO);
  const repo = itx.repos.get(ITERATE_CORE_REPO);
  if ((await repo.origin()) !== ITERATE_CORE_ORIGIN) await repo.setOrigin(ITERATE_CORE_ORIGIN);
  const context = itx.cd(ITERATE_CORE_REPO);
  await context.schedules.set({
    key: "iterate-core-sync",
    when: { everyMs: SYNC_EVERY_MS },
    events: [{ type: ITERATE_CORE_SYNC_REQUESTED }],
  });
  if (!(await repo.tip()))
    await context.append({
      type: ITERATE_CORE_SYNC_REQUESTED,
      payload: {},
      idempotencyKey: "iterate-core/initial-sync",
    });
}

/** Pulls the latest `main` of `github.com/iterate/core` into `/repos/github.com/iterate/core`.
 *  Only acts on events appended to that repo's own context, and always pulls from
 *  `ITERATE_CORE_ORIGIN`. */
export async function iterateCoreSyncEvent(
  itx: IterateConfigProcessEventArgs<"agents">["itx"],
  event: { path: string },
): Promise<void> {
  if (event.path !== ITERATE_CORE_REPO) return;
  await itx.repos.create(ITERATE_CORE_REPO);
  const repo = itx.repos.get(ITERATE_CORE_REPO);
  if ((await repo.origin()) !== ITERATE_CORE_ORIGIN) await repo.setOrigin(ITERATE_CORE_ORIGIN);
  await repo.pull({ remote: ITERATE_CORE_ORIGIN });
}
