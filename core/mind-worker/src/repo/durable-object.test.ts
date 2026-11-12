// The repo facet follows `repo/pushed`, the boundary's fact of a push to the repo's Artifacts remote
// (core/boundary-worker/src/artifacts-events.ts): a push to main lands the tip's
// `repo/commit-completed` once, so `/repos/config` publishes. The facet runs here on node:sqlite
// storage, with the repo's log and `/`'s log in memory and its git log given by the test.
import type { RepoLogEntry } from "iterate/api";
import {
  committedEvent,
  memoryStream,
  nodeSqliteDurableObjectStorage,
  settle,
} from "iterate/stream/test-support";
import { expect, test, vi } from "vitest";
import { RepoContract } from "./contract.ts";
import { RepoFacet } from "./durable-object.ts";

const PATH = "/repos/config";
const TIP = "a".repeat(40);
const PARENT = "b".repeat(40);
const ZERO = "0".repeat(40);

test("a push to main lands one `repo/commit-completed` for the tip, on the repo's path and on /", async () => {
  const repo = repoWith([TIP, PARENT]);
  await repo.pushed({ ref: "refs/heads/main", after: TIP });
  expect(repo.factsOn(PATH)).toEqual([
    { path: PATH, commitOid: TIP, message: `commit ${TIP}`, changedPaths: [] },
  ]);
  expect(repo.factsOn("/")).toEqual(repo.factsOn(PATH));
});

test("the same push seen again, as a new incarnation's pass over the log, adds nothing", async () => {
  const repo = repoWith([TIP, PARENT]);
  await repo.pushed({ ref: "refs/heads/main", after: TIP });
  await repo.restarted();
  expect(repo.factsOn(PATH)).toHaveLength(1);
  expect(repo.factsOn("/")).toHaveLength(1);
});

test("a push of a commit whose fact the facet landed itself adds nothing", async () => {
  const repo = repoWith([TIP, PARENT]);
  // `announceTip`, as `commitFiles` and `pull`, lands its fact before its push's event arrives
  await repo.facet.announceTip();
  await repo.pushed({ ref: "refs/heads/main", after: TIP });
  expect(repo.factsOn(PATH)).toHaveLength(1);
  expect(repo.factsOn("/")).toHaveLength(1);
});

test("a push that a later push overtook lands the newest commit: the tip is what publishes", async () => {
  const repo = repoWith([TIP, PARENT]);
  await repo.pushed({ ref: "refs/heads/main", after: PARENT });
  expect(repo.factsOn(PATH)).toMatchObject([{ commitOid: TIP }]);
});

test.for([
  ["a push to another branch", { ref: "refs/heads/probe-branch", after: TIP }],
  ["a delete of main", { ref: "refs/heads/main", after: ZERO }],
  ["a push with no ref", { ref: null, after: TIP }],
] as const)("%s lands nothing", async ([, push]) => {
  const repo = repoWith([TIP, PARENT]);
  await repo.pushed(push);
  expect(repo.factsOn(PATH)).toEqual([]);
  expect(repo.factsOn("/")).toEqual([]);
});

test("a push that could not be published is one fact on the repo's log, and the next pass publishes it", async () => {
  const repo = repoWith([TIP, PARENT]);
  repo.gitLogFailures = Infinity;
  await repo.pushed({ ref: "refs/heads/main", after: TIP });
  expect(repo.factsOn(PATH)).toEqual([]);
  expect(repo.notPublished()).toEqual([
    {
      idempotencyKey: `repo/push-not-published:${PATH}:${TIP}`,
      payload: { commitOid: TIP, error: "Artifacts did not answer" },
    },
  ]);
  // a second failed round, with other words, adds no second fact and reports the push's error
  const reported = vi.spyOn(console, "error").mockImplementation(() => {});
  repo.gitLogError = "Artifacts answered 503";
  await repo.restarted();
  expect(repo.notPublished()).toHaveLength(1);
  expect(reported.mock.calls.map(([line]) => line.error?.message)).toContain(
    "Artifacts answered 503",
  );
  expect(JSON.stringify(reported.mock.calls)).not.toMatch(/idempotency/i);
  expect(repo.factsOn(PATH)).toEqual([]);
  // the git log answers again: the next pass publishes the tip
  repo.gitLogFailures = 0;
  await repo.restarted();
  expect(repo.factsOn(PATH)).toHaveLength(1);
  expect(repo.notPublished()).toHaveLength(1);
});

test("a git log read that fails twice and then answers lands the fact, with no further event", async () => {
  const repo = repoWith([TIP, PARENT]);
  repo.gitLogFailures = 2;
  await repo.pushed({ ref: "refs/heads/main", after: TIP });
  expect(repo).toMatchObject({ logReads: 3 });
  expect(repo.factsOn(PATH)).toHaveLength(1);
});

test("a settled push is not read again: a new incarnation's pass reads no git log", async () => {
  const repo = repoWith([TIP, PARENT]);
  await repo.facet.announceTip();
  // the push of an older commit, settled by the newer tip's fact
  await repo.pushed({ ref: "refs/heads/main", after: PARENT });
  const reads = repo.logReads;
  await repo.restarted();
  expect(repo).toMatchObject({ logReads: reads });
  expect(repo.factsOn(PATH)).toHaveLength(1);
});

test("a force push back to a commit pushed before publishes it again, after the mind committed past it", async () => {
  const main = [TIP];
  const repo = repoWith(main);
  await repo.pushed({ ref: "refs/heads/main", after: TIP });
  // the mind commits past it (a template update, `commitFiles`)
  main.unshift(PARENT);
  await repo.facet.announceTip();
  // a force push of main back to the commit pushed first
  main.shift();
  await repo.pushed({ ref: "refs/heads/main", after: TIP });
  expect(repo.factsOn(PATH).map((fact) => fact?.commitOid)).toEqual([TIP, PARENT, TIP]);
  expect(repo.factsOn("/")).toEqual(repo.factsOn(PATH));
});

test("a `repo/pushed` whose payload does not parse is ignored by the reduce, which never throws", () => {
  const repo = repoWith([TIP]);
  const state = RepoContract.initialState();
  for (const payload of [{ ref: 7 }, null, "refs/heads/main"])
    expect(
      repo.facet.processor.reduce({
        event: committedEvent(1, "events.iterate.com/repo/pushed", payload as never),
        state,
      }),
    ).toBeUndefined();
});

/** A created repo at PATH whose main holds `oids`, newest first, and a facet that hosts it. */
function repoWith(oids: string[]) {
  const own = memoryStream(PATH);
  const root = memoryStream("/");
  const storage = facetStorage();
  const state = { gitLogFailures: 0, gitLogError: "Artifacts did not answer", logReads: 0 };
  let pushes = 0;
  const scope = {
    append: (...events: Parameters<typeof own.stream.append>) => own.stream.append(...events),
    readEvents: (after: number, limit: number) => own.stream.read(after, limit),
    processors: { claim: async () => {} },
    cd: () => ({
      append: (...events: Parameters<typeof root.stream.append>) => root.stream.append(...events),
    }),
  };
  class Repo extends RepoFacet {
    protected override readonly pushRetryWaitsMs = [1, 1];
    override async log(): Promise<RepoLogEntry[]> {
      state.logReads += 1;
      if (state.gitLogFailures > 0) {
        state.gitLogFailures -= 1;
        throw new Error(state.gitLogError);
      }
      return oids.slice(0, 1).map((oid, at) => ({
        oid,
        message: `commit ${oid}`,
        author: { name: "probe", email: "probe@example.com" },
        committer: { name: "probe", email: "probe@example.com" },
        timestamp: 0,
        parents: oids.slice(at + 1, at + 2),
      }));
    }
  }
  const host = () => {
    // The casts: the Durable Object state and the env, as far as the facet reads them.
    const facet = new Repo(
      { props: { iterateContextName: PATH }, storage } as unknown as DurableObjectState,
      { ITX: { get: () => scope } } as never,
    );
    own.engines.splice(0, own.engines.length, facet as never);
    return facet;
  };
  own.stream.append({ type: "events.iterate.com/repo/created", payload: { path: PATH } });
  const repo = {
    facet: host(),
    set gitLogError(words: string) {
      state.gitLogError = words;
    },
    set gitLogFailures(failures: number) {
      state.gitLogFailures = failures;
    },
    get logReads() {
      return state.logReads;
    },
    async pushed(push: { ref: string | null; after: string }) {
      own.stream.append({
        type: "events.iterate.com/repo/pushed",
        // as the boundary keys it: by the message, so two pushes of one commit are two facts
        idempotencyKey: `repo/pushed:${push.ref}:${push.after}:${(pushes += 1)}`,
        payload: {
          ref: push.ref,
          before: PARENT,
          after: push.after,
          commits: [],
          totalCommitsCount: 0,
          commitsTruncated: false,
        },
      });
      await settle(50);
    },
    /** A new incarnation on the same storage: its revive reads the log and runs the pass at the head. */
    async restarted() {
      repo.facet = host();
      await repo.facet.revive();
      await settle(50);
    },
    notPublished() {
      return own.events
        .filter((event) => event.type === "events.iterate.com/repo/push-not-published")
        .map(({ idempotencyKey, payload }) => ({ idempotencyKey, payload }));
    },
    factsOn(path: string) {
      return (path === "/" ? root : own).events
        .filter((event) => event.type === "events.iterate.com/repo/commit-completed")
        .map((event) => event.payload);
    },
  };
  return repo;
}

/** A Durable Object's storage as the facet uses it: its SQL, its synchronous KV, and the async
 *  key-value calls. */
function facetStorage() {
  const values = new Map<string, unknown>();
  const kv = new Map<string, unknown>();
  return {
    ...nodeSqliteDurableObjectStorage(),
    kv: {
      get: (key: string) => kv.get(key),
      put: (key: string, value: unknown) => void kv.set(key, value),
      delete: (key: string) => kv.delete(key),
    },
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => void values.set(key, value),
    delete: async (key: string) => values.delete(key),
  };
}
