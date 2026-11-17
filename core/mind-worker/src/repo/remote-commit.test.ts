// ONE COMMIT ON A GIT REMOTE (./remote-commit.ts), against a remote that speaks git's wire
// protocol v2 in memory: it serves its tip's objects and takes a push only onto the tip it holds.
import { expect, test } from "vitest";
import {
  buildPack,
  encodeCommit,
  type GitObjectType,
  hashObject,
  manifestOf,
  parseCommit,
  parsePack,
  parseTree,
  type RawGitObject,
  treeObjectsOf,
} from "./git-wire.ts";
import { commitFilesToRemote } from "./remote-commit.ts";

const REMOTE = "https://x:the-git-token@artifacts.example/git/space/config.git";

test("the tip is read, one file is added beside the others, and the commit is pushed onto that tip", async () => {
  const remote = await remoteWith({ "worker.ts": "export default 1;\n", "apps/a.ts": "a\n" });
  const before = remote.tip();
  const answer = await commitFilesToRemote({
    remote: REMOTE,
    message: "Add the transcript",
    changes: [{ path: "onboarding-transcript.md", content: "# The chat\n" }],
    fetch: remote.fetch,
  });
  expect(answer).toEqual({
    commitOid: remote.tip(),
    parent: before,
    changedPaths: ["onboarding-transcript.md"],
  });
  expect(remote.tip()).not.toBe(before);
  // the files that were there stay as they were, and the new commit's parent is the tip read
  expect(await remote.files()).toEqual({
    "apps/a.ts": "a\n",
    "onboarding-transcript.md": "# The chat\n",
    "worker.ts": "export default 1;\n",
  });
  expect(remote.parentOfTip()).toBe(before);
  // the credential leaves the URL and goes as a Basic header, on every request
  expect(new Set(remote.asked.map((request) => request.url.split("/git-")[0]))).toEqual(
    new Set(["https://artifacts.example/git/space/config.git"]),
  );
  expect(new Set(remote.asked.map((request) => request.authorization))).toEqual(
    new Set([`Basic ${btoa("x:the-git-token")}`]),
  );
});

test("a file that is as it was makes no commit and no push", async () => {
  const remote = await remoteWith({ "notes.md": "same\n" });
  const before = remote.tip();
  expect(
    await commitFilesToRemote({
      remote: REMOTE,
      message: "Nothing new",
      changes: [{ path: "notes.md", content: "same\n" }],
      fetch: remote.fetch,
    }),
  ).toEqual({ commitOid: before, parent: before, changedPaths: [] });
  expect(remote).toMatchObject({ pushes: 0 });
});

test("a commit that landed after the tip was read refuses the push, and nothing is forced", async () => {
  const remote = await remoteWith({ "notes.md": "one\n" });
  remote.moveBeforePush({ "notes.md": "two\n" });
  await expect(
    commitFilesToRemote({
      remote: REMOTE,
      message: "Add a file",
      changes: [{ path: "added.md", content: "x\n" }],
      fetch: remote.fetch,
    }),
  ).rejects.toThrow(/refused the commit/);
  expect(await remote.files()).toEqual({ "notes.md": "two\n" });
});

test("a remote with no commit is refused, and an error never names the credential", async () => {
  const remote = await remoteWith(null);
  const refused = commitFilesToRemote({
    remote: REMOTE,
    message: "First",
    changes: [{ path: "a.md", content: "a\n" }],
    fetch: remote.fetch,
  });
  await expect(refused).rejects.toThrow(/has no commit on main/);
  await expect(refused).rejects.not.toThrow(/the-git-token/);
  expect(remote).toMatchObject({ pushes: 0 });
});

/** A git remote in memory whose `main` holds `files`, or no commit for null. */
async function remoteWith(files: Record<string, string> | null) {
  const objects = new Map<string, { payload: Uint8Array; type: GitObjectType }>();
  let tip: string | null = null;
  let moved: Record<string, string> | null = null;
  const commitOf = async (content: Record<string, string>, parent: string | null) => {
    const manifest = new Map<string, { oid: string; mode: string }>();
    for (const [path, text] of Object.entries(content)) {
      const payload = new TextEncoder().encode(text);
      const oid = await hashObject("blob", payload);
      objects.set(oid, { payload, type: "blob" });
      manifest.set(path, { oid, mode: "100644" });
    }
    const { rootOid, trees } = await treeObjectsOf(manifest);
    for (const tree of trees) objects.set(tree.oid, { payload: tree.payload, type: "tree" });
    const owner = { name: "owner", email: "owner@example.com" };
    const payload = encodeCommit({
      author: { ...owner, date: new Date(0) },
      committer: owner,
      message: "the owner's commit",
      parents: parent ? [parent] : [],
      tree: rootOid,
    });
    const oid = await hashObject("commit", payload);
    objects.set(oid, { payload, type: "commit" });
    return oid;
  };
  if (files) tip = await commitOf(files, null);
  const remote = {
    asked: [] as { url: string; authorization: string | null }[],
    pushes: 0,
    tip: () => tip,
    parentOfTip: () => parseCommit(objects.get(tip!)!.payload).parents[0],
    /** The next push finds `main` moved to a commit of `content`. */
    moveBeforePush(content: Record<string, string>) {
      moved = content;
    },
    async files() {
      const all = new Map<string, RawGitObject>(
        [...objects].map(([oid, object]) => [oid, { oid, ...object }]),
      );
      const tree = all.get(parseCommit(all.get(tip!)!.payload).tree)!;
      const texts: Record<string, string> = {};
      for (const [path, entry] of [...manifestOf(parseTree(tree.payload), all)].sort())
        texts[path] = new TextDecoder().decode(all.get(entry.oid)!.payload);
      return texts;
    },
    async fetch(request: Request): Promise<Response> {
      remote.asked.push({ url: request.url, authorization: request.headers.get("authorization") });
      const bytes = new Uint8Array(await request.arrayBuffer());
      const body = new TextDecoder().decode(bytes);
      if (request.url.endsWith("/git-receive-pack")) {
        remote.pushes += 1;
        if (moved) {
          tip = await commitOf(moved, tip);
          moved = null;
        }
        const [, oldOid, newOid] = /^[0-9a-f]{4}([0-9a-f]{40}) ([0-9a-f]{40}) /.exec(body) || [];
        if (oldOid !== tip)
          return gitAnswer([pktLine("unpack ok"), pktLine("ng refs/heads/main fetch first")]);
        const pack = bytes.subarray(indexOfPack(bytes));
        for (const object of await parsePack(pack, {
          maxObjectBytes: 1 << 24,
          maxTotalObjectBytes: 1 << 24,
        }))
          objects.set(object.oid, { payload: object.payload, type: object.type });
        tip = newOid!;
        return gitAnswer([pktLine("unpack ok"), pktLine("ok refs/heads/main")]);
      }
      if (body.includes("command=ls-refs"))
        return gitAnswer(tip ? [pktLine(`${tip} refs/heads/main`)] : []);
      const pack = await buildPack([...objects.values()]);
      return gitAnswer([pktLine("packfile"), pktBytes(Uint8Array.of(1, ...pack))]);
    },
  };
  return remote;
}

/** Where the pack starts in a push's body: after the flush that ends its commands. */
function indexOfPack(bytes: Uint8Array): number {
  for (let at = 0; at + 4 <= bytes.length; at += 1)
    if (
      bytes[at] === 0x50 &&
      bytes[at + 1] === 0x41 &&
      bytes[at + 2] === 0x43 &&
      bytes[at + 3] === 0x4b
    )
      return at;
  throw new Error("the push holds no pack");
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
