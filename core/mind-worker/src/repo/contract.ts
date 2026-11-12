import { z } from "zod";
import { defineProcessorContract } from "iterate/stream/processor";
import { EntityCreationAndDeletionState, entityLifecycle } from "../mind/entity-lifecycle.ts";

export const CommitCompleted = z.object({
  path: z.string().min(1),
  commitOid: z.string().min(1),
  message: z.string(),
  changedPaths: z.array(z.string()),
});
export type CommitCompleted = z.infer<typeof CommitCompleted>;

export const OriginSet = z.object({ origin: z.string().nullable() });

const Person = z.object({ name: z.string(), email: z.string() }).nullable();
export const RepoPushed = z.object({
  ref: z.string().nullable(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  commits: z.array(
    z.object({
      id: z.string(),
      message: z.string(),
      messageTruncated: z.literal(true).optional(),
      timestamp: z.string().nullable(),
      author: Person,
      committer: Person,
      parents: z.array(z.string()),
    }),
  ),
  totalCommitsCount: z.number().nullable(),
  commitsTruncated: z.boolean().nullable(),
  /** A force push: the ref moved to a commit that does not hold `before`. Null when the
   *  boundary could not tell (a cut list of commits); absent in facts made before it was read. */
  forced: z.boolean().nullable().optional(),
  /** The commit a force push left behind, with every commit after it: push it back to restore. */
  leftBehind: z.string().optional(),
});
const PushNotPublished = z.object({ commitOid: z.string(), error: z.string() });
const RepoToken = z.object({
  tokenId: z.string().nullable(),
  scope: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

export const RepoState = EntityCreationAndDeletionState.extend({
  origin: z.string().nullable().default(null),
  /** The commit that the newest `repo/pushed` put on main: owed its `repo/commit-completed` until
   *  one has landed for it or for a newer tip. */
  mainPushedTo: z.string().nullable().default(null),
  /** The offset of that `repo/pushed` on the repo's log: each push is owed on its own, so a force
   *  push back to a commit pushed before is owed again. */
  mainPushedAt: z.number().nullable().default(null),
});
export type RepoState = z.infer<typeof RepoState>;

const lifecycle = entityLifecycle("repo");

export const RepoContract = defineProcessorContract({
  ...lifecycle,
  stateSchema: RepoState,
  consumes: [
    ...lifecycle.consumes,
    "events.iterate.com/repo/origin-set",
    "events.iterate.com/repo/pushed",
  ],
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
        "A commit landed on the repo's main through the repo facet: on the repo's path, and cross-posted to / — hence it names the path — where the mind processor follows the config repo's commits with the apex (a commit to /repos/config IS its publication).",
      payloadSchema: CommitCompleted,
    },
    "events.iterate.com/repo/pushed": {
      description:
        "Cloudflare's word that a git client pushed to the repo's Artifacts remote: the ref, its old and new oid (all zeros for none), and its first 50 commits with Cloudflare's count of all. A push to main lands the tip's commit-completed, once, unless the repo facet landed it already.",
      payloadSchema: RepoPushed,
    },
    "events.iterate.com/repo/push-not-published": {
      description:
        "The repo facet tried three times to land the tip's commit-completed for a push to main, and could not: the pushed commit and the last error. Once for each pushed commit. The repo tries again at its next event and at its next incarnation, and `announceTip()` publishes the tip by hand.",
      payloadSchema: PushNotPublished,
    },
    "events.iterate.com/repo/cloned": {
      description: "Cloudflare's word that a git client cloned the repo's Artifacts remote.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/repo/fetched": {
      description: "Cloudflare's word that a git client fetched from the repo's Artifacts remote.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/repo/token-created": {
      description:
        "Cloudflare's word that a WRITE token for the repo's Artifacts remote was made, a right for its holder to publish the mind with a `git push`, at once and with no itx call, until it expires: its id, its scope and when it expires. Never the token itself. A read token's making is no fact.",
      payloadSchema: RepoToken,
    },
    "events.iterate.com/repo/token-revoked": {
      description: "Cloudflare's word that a token for the repo's Artifacts remote was revoked.",
      payloadSchema: RepoToken.pick({ tokenId: true }),
    },
  },
});

/** The author of a commit nobody asked for by name: the seed, a template's update, a member's own
 *  commit that names no author. */
export const PLATFORM_AUTHOR = { email: "config@iterate.com", name: "iterate" };
