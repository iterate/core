import { z } from "zod";
import { defineProcessorContract } from "iterate/stream/processor";
import { EntityCreationAndDeletionState, entityLifecycle } from "../project/entity-lifecycle.ts";

export const CommitCompleted = z.object({
  path: z.string().min(1),
  commitOid: z.string().min(1),
  message: z.string(),
  changedPaths: z.array(z.string()),
});
export type CommitCompleted = z.infer<typeof CommitCompleted>;

export const OriginSet = z.object({ origin: z.string().nullable() });

export const RepoState = EntityCreationAndDeletionState.extend({
  origin: z.string().nullable().default(null),
});
export type RepoState = z.infer<typeof RepoState>;

const lifecycle = entityLifecycle("repo");

export const RepoContract = defineProcessorContract({
  ...lifecycle,
  stateSchema: RepoState,
  consumes: [...lifecycle.consumes, "events.iterate.com/repo/origin-set"],
  version: "3",
  description:
    "A repo: its creation and deletion, the commits that landed through it, and its origin.",
  events: {
    ...lifecycle.events,
    "events.iterate.com/repo/origin-set": {
      description:
        "The remote the repo remembers as origin (`repo.setOrigin(url)`), which `pull()` and `push()` default to; null forgets it. A git URL whose userinfo may hold a secret placeholder, never a token.",
      payloadSchema: OriginSet,
    },
    "events.iterate.com/repo/commit-completed": {
      description:
        "A commit landed on the repo's main through the repo facet: on the repo's path, and cross-posted to / — hence it names the path — where the project processor follows the config repo's commits with the apex (a commit to /repos/config IS its publication).",
      payloadSchema: CommitCompleted,
    },
  },
});

/** The author of a commit nobody asked for by name: the seed, a template's update, a member's own
 *  commit that names no author. */
export const PLATFORM_AUTHOR = { email: "config@iterate.com", name: "iterate" };
