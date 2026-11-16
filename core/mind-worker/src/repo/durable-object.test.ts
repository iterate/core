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
import {
  buildPack,
  encodeCommit,
  hashObject,
  treeObjectsOf,
  type GitObjectType,
} from "./git-wire.ts";

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
  // Publishing runs in the background: wait for the exhausted round's fact before restarting.
  await expect
    .poll(() => repo.notPublished())
    .toEqual([
      {
        idempotencyKey: `repo/push-not-published:${PATH}:${TIP}`,
        payload: { commitOid: TIP, error: "Artifacts did not answer" },
      },
    ]);
  expect(repo.factsOn(PATH)).toEqual([]);
  // a second failed round, with other words, adds no second fact and reports the push's error
  const reported = vi.spyOn(console, "error").mockImplementation(() => {});
  repo.gitLogError = "Artifacts answered 503";
  await repo.restarted();
  await expect
    .poll(() => reported.mock.calls.map(([line]) => line.error?.message))
    .toContain("Artifacts answered 503");
  expect(repo.notPublished()).toHaveLength(1);
  expect(JSON.stringify(reported.mock.calls)).not.toMatch(/idempotency/i);
  expect(repo.factsOn(PATH)).toEqual([]);
  // the git log answers again: the next pass publishes the tip
  repo.gitLogFailures = 0;
  await repo.restarted();
  await expect.poll(() => repo.factsOn(PATH)).toHaveLength(1);
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

// ── whole-tip fetches: a pack with every file of one commit ──

test.for([
  { name: "a read of the tip and a read of its oid, made at once, make one whole-tip fetch" },
  {
    name: "a read of the tip's oid joins the tip read whose whole-tip fetch is in flight",
    oidReadAfterFetch: true,
  },
])("$name", async ({ oidReadAfterFetch }) => {
  const [newest] = await commitsOf(["one"]);
  const repo = repoWith([]);
  const git = serveGit(repo.storage, [newest!], { artifacts: newest!.oid });
  const release = git.hold();
  const tipRead = repo.facet.files();
  if (oidReadAfterFetch) await vi.waitFor(() => expect(git).toMatchObject({ packs: 1 }));
  const oidRead = repo.facet.files({ commitOid: newest!.oid });
  await vi.waitFor(() => expect(git).toMatchObject({ lsRefs: 1 }));
  // outlasts each read's steps from its last answer to a whole-tip fetch of its own
  await settle(25);
  release();
  expect(await Promise.all([tipRead, oidRead])).toEqual([
    { "notes.md": "one" },
    { "notes.md": "one" },
  ]);
  expect(git).toMatchObject({ packs: 1 });
});

test("reads of two commits, made at once, never have two whole-tip fetches in flight", async () => {
  const [newer, older] = await commitsOf(["two", "one"]);
  const repo = repoWith([]);
  const git = serveGit(repo.storage, [newer!, older!], { artifacts: newer!.oid });
  expect(
    await Promise.all([
      repo.facet.files({ commitOid: newer!.oid }),
      repo.facet.files({ commitOid: older!.oid }),
    ]),
  ).toEqual([{ "notes.md": "two" }, { "notes.md": "one" }]);
  expect(git).toMatchObject({ packs: 2, mostPacksInFlight: 1 });
});

test("a whole-tip fetch that fails does not stop the next: the read queued behind answers", async () => {
  const [newer, older] = await commitsOf(["two", "one"]);
  const repo = repoWith([]);
  const git = serveGit(repo.storage, [newer!, older!], { artifacts: newer!.oid });
  git.failPacks = 1;
  expect(
    await Promise.allSettled([
      repo.facet.files({ commitOid: newer!.oid }),
      repo.facet.files({ commitOid: older!.oid }),
    ]),
  ).toMatchObject([
    { status: "rejected", reason: { message: expect.stringContaining("responded 400") } },
    { status: "fulfilled", value: { "notes.md": "one" } },
  ]);
  expect(git).toMatchObject({ packs: 2, mostPacksInFlight: 1 });
});

test("a pull's merge fetches its two tips one after the other", async () => {
  const [theirs, ours] = await commitsOf(["two", "one"]);
  const repo = repoWith([]);
  const git = serveGit(repo.storage, [theirs!, ours!], {
    artifacts: ours!.oid,
    origin: theirs!.oid,
  });
  expect(await repo.facet.pull({ remote: "https://origin.example/config.git" }, git.fetch)).toEqual(
    { status: "updated", commitOid: theirs!.oid, previousOid: ours!.oid },
  );
  expect(git).toMatchObject({ packs: 2, mostPacksInFlight: 1 });
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
    storage,
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

type Commit = { oid: string; objects: { payload: Uint8Array; type: GitObjectType }[] };

/** Commits of one file each, newest first, each the child of the next: `notes.md` is its word. */
async function commitsOf(words: string[]): Promise<Commit[]> {
  const commits: Commit[] = [];
  let parent: string | undefined;
  for (const word of words.toReversed()) {
    const blob = new TextEncoder().encode(word);
    const oid = await hashObject("blob", blob);
    const manifest = new Map([["notes.md", { oid, mode: "100644" }]]);
    const { rootOid, trees } = await treeObjectsOf(manifest);
    const probe = { name: "probe", email: "probe@example.com" };
    const commit = encodeCommit({
      author: { ...probe, date: new Date(0) },
      committer: probe,
      message: word,
      parents: parent ? [parent] : [],
      tree: rootOid,
    });
    parent = await hashObject("commit", commit);
    commits.unshift({
      oid: parent,
      objects: [
        { payload: commit, type: "commit" },
        ...trees.map(({ payload }) => ({ payload, type: "tree" as const })),
        { payload: blob, type: "blob" },
      ],
    });
  }
  return commits;
}

/**
 * Git's wire protocol v2 for `history` (newest first), as the facet's transport speaks it: the
 * repo's Artifacts remote is the stubbed global fetch, and `fetch` is an origin's egress. A
 * whole-tip fetch (`deepen 1`) is counted while it is in flight; `hold` keeps them open.
 */
function serveGit(
  storage: ReturnType<typeof facetStorage>,
  history: Commit[],
  tips: { artifacts: string; origin?: string },
) {
  const until = Date.now() + 3_600_000;
  void storage.put("git-remote", "https://artifacts.example/config.git");
  void storage.put("git-token:read", { token: "read-token", until });
  void storage.put("git-token:write", { token: "write-token", until });
  let held = Promise.resolve();
  const git = {
    lsRefs: 0,
    packs: 0,
    packsInFlight: 0,
    mostPacksInFlight: 0,
    failPacks: 0,
    hold() {
      let release!: () => void;
      held = new Promise((resolve) => (release = resolve));
      return release;
    },
    async fetch(request: Request): Promise<Response> {
      const body = new TextDecoder().decode(await request.arrayBuffer());
      if (request.url.endsWith("/git-receive-pack"))
        return gitAnswer([pktLine("unpack ok"), pktLine("ok refs/heads/main")]);
      const tip = new URL(request.url).hostname === "origin.example" ? tips.origin : tips.artifacts;
      if (body.includes("command=ls-refs")) {
        git.lsRefs += 1;
        return gitAnswer([pktLine(`${tip} refs/heads/main`)]);
      }
      const want = history.findIndex(({ oid }) => body.includes(`want ${oid}`));
      if (body.includes("deepen 1\n")) {
        git.packs += 1;
        git.packsInFlight += 1;
        git.mostPacksInFlight = Math.max(git.mostPacksInFlight, git.packsInFlight);
        try {
          await held;
          // an answer a moment later, so a second fetch made meanwhile is in flight with it
          await settle(1);
          if (git.failPacks > 0) {
            git.failPacks -= 1;
            return new Response("upload-pack failed", { status: 400 });
          }
        } finally {
          git.packsInFlight -= 1;
        }
      }
      const pack = await buildPack(history.slice(want).flatMap(({ objects }) => objects));
      return gitAnswer([pktLine("packfile"), pktBytes(Uint8Array.of(1, ...pack))]);
    },
  };
  vi.stubGlobal("fetch", git.fetch);
  return git;
}

function gitAnswer(lines: Uint8Array[]): Response {
  return new Response(new Blob([...lines, new TextEncoder().encode("0000")]));
}

function pktLine(line: string): Uint8Array {
  return pktBytes(new TextEncoder().encode(`${line}\n`));
}

function pktBytes(payload: Uint8Array): Uint8Array {
  const length = new TextEncoder().encode((payload.length + 4).toString(16).padStart(4, "0"));
  return Uint8Array.of(...length, ...payload);
}
