// seed-repos.ts — THE REPOS A NEW MIND STARTS WITH beside its config repo. The build bundles them
// when the deploy names them (scripts/build.ts, `ITERATE_SEED_REPOS`): the kernel names no repo
// of its own. The processor seeds them after the config repo's seed, each one best effort.
import type { ItxExpression } from "iterate/expression";

/** The repos a build bundles to seed beside the config repo (the generated config-templates.js
 *  `seedRepos`): each by its path in the mind, with its files. Empty when the deploy named none. */
export type SeedRepos = Record<string, { path: string; content: string }[]>;

/** A call of the repo facet of the repo at `path`, as `configRepoCall` is for `/repos/config`. */
const repoCall = (path: string, verb: string, ...args: unknown[]): ItxExpression => [
  "itx",
  "builtins",
  ["cd", path],
  "builtins",
  "facets",
  ["get", "repo"],
  [verb, ...args],
];

/** Makes each repo of `repos` and commits its files as its first commit. A repo whose `main` has
 *  a commit already is left as it is. A failure is one warning with the repo's path: it never
 *  throws, so the mind's birth and the config's seed never fail for it. */
export async function seedRepos(
  call: (expression: ItxExpression) => Promise<unknown>,
  repos: SeedRepos,
): Promise<void> {
  for (const [path, files] of Object.entries(repos)) {
    try {
      await call(["itx", "builtins", "repos", ["create", path]]);
      if (await call(repoCall(path, "tip"))) continue;
      // `parent: null`: only on an unborn `main`, so a commit that got there first is never
      // written over.
      await call(
        repoCall(path, "commitFiles", {
          message: `seed: ${path}`,
          changes: files,
          parent: null,
        }),
      );
    } catch (error) {
      console.warn({
        event: "mind.seed-repo-failed",
        namespace: "mind",
        message: "a repo the build names to seed was not seeded; the mind is born without it",
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
