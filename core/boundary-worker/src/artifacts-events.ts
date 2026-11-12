// Pure (binds nothing, calls nobody) and one file, like ./mail-outcomes.ts.
import { z } from "zod";
import type { CloudflareEventRow } from "./cloudflare-events.ts";

/** Each push keeps this many of its commits; the payload keeps Cloudflare's count of all. */
const MAX_COMMITS = 50;
/** git's oid for "no commit": the `before` of a new ref, the `after` of a deleted one. */
const ZERO_OID = "0".repeat(40);

const Text = z.string().nullable().catch(null);
const Person = z.object({ name: z.string(), email: z.string() }).nullable().catch(null);
const Commit = z.object({
  id: z.string(),
  message: z.string().catch(""),
  messageTruncated: z.boolean().catch(false),
  timestamp: Text,
  author: Person,
  committer: Person,
  parents: z.array(z.string()).catch([]),
});

/** One Artifacts repo event as Cloudflare puts it on the queue (Artifacts docs, "Event
 *  subscriptions"). Only the type, the namespace and the repo name are required: every other
 *  field is read when it is there. */
const RepoEvent = z.object({
  type: z.enum([
    "cf.artifacts.repo.pushed",
    "cf.artifacts.repo.cloned",
    "cf.artifacts.repo.fetched",
    "cf.artifacts.repo.token.created",
    "cf.artifacts.repo.token.revoked",
  ]),
  source: z.object({ namespace: z.string(), repoName: z.string() }),
  payload: z
    .object({
      ref: Text,
      before: Text,
      after: Text,
      commits: z.array(z.unknown()).catch([]),
      totalCommitsCount: z.number().nullable().catch(null),
      commitsTruncated: z.boolean().nullable().catch(null),
      tokenId: Text,
      scope: Text,
      expiresAt: Text,
    })
    .catch({
      ref: null,
      before: null,
      after: null,
      commits: [],
      totalCommitsCount: null,
      commitsTruncated: null,
      tokenId: null,
      scope: null,
      expiresAt: null,
    }),
  metadata: z.object({ eventTimestamp: Text }).catch({ eventTimestamp: null }),
});

/** The context path of an Artifacts repo: the inverse of core/mind-worker's `repoArtifactName`
 *  (src/context/cf-artifacts.ts), which joins a path's segments with `--`. A name with three or
 *  more dashes in a row has more than one path (`a---b` is `/a-/b` and `/a/-b`), so it has none
 *  here. Null for a name that no path gives. */
export function repoPathOf(repoName: string): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(repoName) || repoName.includes("---")) return null;
  const segments = repoName.split("--");
  if (segments.some((segment) => segment === "")) return null;
  return `/${segments.join("/")}`;
}

/** The rows of the table (./cloudflare-events.ts) for the Artifacts events of one repo: each
 *  becomes a fact on the repo's own context, for a repo of the stack's own namespace alone. The
 *  fact's idempotency key is made from the message alone, so a redelivery lands nothing new. A
 *  clone or a fetch with no event time has nothing that tells two of them apart: it makes nothing. */
export function artifactsRows(input: { namespace: string }): Record<string, CloudflareEventRow> {
  const row: CloudflareEventRow = (body) => {
    const parsed = RepoEvent.safeParse(body);
    if (!parsed.success) return null;
    const { type, source, payload, metadata } = parsed.data;
    if (source.namespace !== input.namespace) return null;
    // A write token is a right to publish the mind with a push. A read token's making is no fact:
    // the mind's own reads make several a minute.
    if (type === "cf.artifacts.repo.token.created" && payload.scope !== "write") return null;
    const path = repoPathOf(source.repoName);
    if (!path) return null;
    const at = metadata.eventTimestamp;
    const { ref, before, after, tokenId } = payload;
    const fact = {
      "cf.artifacts.repo.pushed": {
        name: "repo/pushed",
        unique: at ? `${at}:${ref}:${after}` : after && `${ref}:${before}:${after}`,
        payload: pushedPayload(payload),
      },
      "cf.artifacts.repo.cloned": { name: "repo/cloned", unique: at, payload: {} },
      "cf.artifacts.repo.fetched": { name: "repo/fetched", unique: at, payload: {} },
      "cf.artifacts.repo.token.created": {
        name: "repo/token-created",
        unique: at || tokenId,
        payload: { tokenId, scope: payload.scope, expiresAt: payload.expiresAt },
      },
      "cf.artifacts.repo.token.revoked": {
        name: "repo/token-revoked",
        unique: at || tokenId,
        payload: { tokenId },
      },
    }[type];
    if (!fact.unique) return null;
    return {
      path,
      event: {
        type: `events.iterate.com/${fact.name}`,
        idempotencyKey: `${fact.name}:${source.namespace}/${source.repoName}:${fact.unique}`,
        payload: fact.payload,
      },
    };
  };
  return Object.fromEntries(RepoEvent.shape.type.options.map((type) => [type, row]));
}

function pushedPayload(payload: z.infer<typeof RepoEvent>["payload"]) {
  const commits = payload.commits.flatMap((each) => {
    const parsed = Commit.safeParse(each);
    if (!parsed.success) return [];
    const { messageTruncated, ...commit } = parsed.data;
    return [messageTruncated ? { ...commit, messageTruncated } : commit];
  });
  const truncated = payload.commitsTruncated || commits.length > MAX_COMMITS;
  const forced = forcedOf(payload.before, payload.after, commits, truncated);
  return {
    ref: payload.ref,
    before: payload.before,
    after: payload.after,
    commits: commits.slice(0, MAX_COMMITS),
    totalCommitsCount: payload.totalCommitsCount,
    commitsTruncated: truncated,
    forced,
    // the commit a force push left behind: push it back to bring back what it held
    ...(forced && { leftBehind: payload.before }),
  };
}

/** Whether a push moved its ref to a commit that does not hold the old one: a force push, which
 *  leaves the old commit and every commit after it behind. Cloudflare's message lists the new
 *  tip's history, so the old commit is a parent in that list unless the push was forced. A new
 *  ref or a deleted one is no force push. With a cut list that does not hold the old commit, it
 *  cannot be told: null. */
function forcedOf(
  before: string | null,
  after: string | null,
  commits: { parents: string[] }[],
  truncated: boolean,
): boolean | null {
  if (!before || !after || before === ZERO_OID || after === ZERO_OID || before === after)
    return false;
  if (commits.some((commit) => commit.parents.includes(before))) return false;
  return truncated ? null : true;
}
