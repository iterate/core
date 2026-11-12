// WHAT A SMOKE RUN WRITES TO A MIND'S CONFIG REPO, AND HOW IT LEAVES. Two checks commit to
// /repos/config: one changes the homepage's text, one adds a file that is not text. Each change
// carries the run's marker, and each is taken out again whatever the check found (`withChange`): a
// commit is in the repo from the moment it lands, whether or not the mind then publishes it. A run
// that was killed between the two commits leaves its change behind, so the next run takes out
// whatever carries a smoke's marker before it reads the repo (`leftoverChanges`).
import type { RepoFileChange } from "iterate/api";

/** The homepage text of the default config's worker.ts (core/configs/default). */
export const HOMEPAGE = "Homepage of mind ";
/** The homepage text a run with `marker` commits in its place. */
export const markedHomepage = (marker: string) => `Homepage (smoke ${marker}) of mind `;
/** The file that is not text which a run with `marker` commits. */
export const markedFile = (marker: string) => `smoke-${marker}.bin`;

// a marker is the first eight digits of a random UUID
const MARKER = "[0-9a-f]{8}";
const LEFT_FILE = new RegExp(`^${markedFile(MARKER).replace(".", "\\.")}$`);
const LEFT_HOMEPAGE = new RegExp(
  markedHomepage(MARKER).replace("(", "\\(").replace(")", "\\)"),
  "g",
);

/** The changes that take out of a config repo what earlier smoke runs left in it: each marked
 *  file deleted, and worker.ts with its homepage text back. Empty when nothing is left. */
export function leftoverChanges(repo: {
  /** Every path in the repo. */
  paths: string[];
  /** worker.ts, or undefined when the repo has none. */
  worker: string | undefined;
}): RepoFileChange[] {
  const changes: RepoFileChange[] = repo.paths
    .filter((path) => LEFT_FILE.test(path))
    .map((path) => ({ path, delete: true }));
  const worker = repo.worker?.replaceAll(LEFT_HOMEPAGE, HOMEPAGE);
  if (worker && worker !== repo.worker) changes.push({ path: "worker.ts", content: worker });
  return changes;
}

/**
 * Commits `change`, waits for its publication, runs `during`, and commits `back`, which undoes
 * it. `back` is committed once `change` has landed, whatever came after: a publication that failed
 * (a config repo whose tip does not load publishes no commit), or a `during` that threw. The way
 * back's own publication is waited for only after a pass: after a failure the repo has its files
 * back, and the failure is the one to report.
 */
export async function withChange<T>(input: {
  /** Commits to the repo's tip and answers the commit's id. The commit is in the repo from then. */
  land: (message: string, changes: RepoFileChange[]) => Promise<string>;
  /** Waits for a commit's publication, and throws when the mind did not publish it. */
  published: (commitOid: string) => Promise<void>;
  change: { message: string; changes: RepoFileChange[] };
  back: { message: string; changes: RepoFileChange[] };
  /** What the check reads while the change is live, given the change's commit. */
  during: (commitOid: string) => Promise<T>;
}): Promise<T> {
  const { land, published, change, back } = input;
  const commitOid = await land(change.message, change.changes);
  let passed = false;
  try {
    await published(commitOid);
    const result = await input.during(commitOid);
    passed = true;
    return result;
  } finally {
    const undone = await land(back.message, back.changes);
    if (passed) await published(undone);
  }
}
