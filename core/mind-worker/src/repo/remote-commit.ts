// remote-commit.ts — ONE COMMIT ON A GIT REMOTE'S `main`, WITH NO REPO OF THIS MIND: read the tip,
// change some files, push. `itx.git.commitFiles` is this (../library.ts). Nothing is kept here: no
// context, no copy of the remote's files, no event. A mind uses it to write into a repo it does
// not hold, such as the config repo of another mind, with a credential in the remote's URL.
//
// The push is compare-and-swapped on the tip that was read, so a commit that landed meanwhile
// refuses it, and nothing is ever forced. A remote whose `main` has no commit is refused: the
// first commit of a repo is its owner's. Both are refusals with a code, as an empty change list is:
// outcomes a caller acts on, not failures of this mind.
import type { RepoFileChange } from "iterate/api";
import { codedError } from "iterate/lib";
import { PLATFORM_AUTHOR } from "./contract.ts";
import {
  buildPack,
  createGitWireTransport,
  encodeCommit,
  gitRemoteOf,
  type GitObjectType,
  hashObject,
  manifestOf,
  parseCommit,
  parseTree,
  type RawGitObject,
  redactRemote,
  treeObjectsOf,
} from "./git-wire.ts";

const REF = "refs/heads/main";
const textEncoder = new TextEncoder();

/** A change's path, as a repo names a file: no empty part, no `.` and no `..`. */
export function filePath(path: string): string {
  const refusal = `repo: not a repo-relative path (${JSON.stringify(path)})`;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of a wire-fed argument (its static type is a claim, not a guarantee, across RPC)
  if (typeof path !== "string") throw new Error(refusal);
  if (path.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(refusal);
  return path;
}

/** A change's blob: its text, or the bytes it names. */
export function blobOf(change: Exclude<RepoFileChange, { delete: true }>): Uint8Array {
  if ("content" in change) return textEncoder.encode(change.content);
  if (change.bytes instanceof Uint8Array) return change.bytes;
  if (change.bytes instanceof ArrayBuffer) return new Uint8Array(change.bytes);
  throw new Error(
    `repo.commitFiles: ${JSON.stringify(change.path)} needs "content" (text) or "bytes" (a Uint8Array)`,
  );
}

/** Reads the tip of `remote`'s `main`, applies `changes` to its files, and pushes the commit.
 *  Answers the new commit, its parent and the paths that changed; with no path changed, nothing is
 *  pushed and `commitOid` is the tip. `fetch` sends each request: the caller's own egress, so a
 *  secret placeholder in the remote's userinfo is filled on the way out. An error names the remote
 *  without its credential. */
export async function commitFilesToRemote(input: {
  remote: string;
  message: string;
  changes: RepoFileChange[];
  author?: { name: string; email: string };
  fetch: (request: Request) => Promise<Response>;
}): Promise<{ commitOid: string; parent: string; changedPaths: string[] }> {
  if (input.changes.length === 0)
    throw codedError("INVALID_INPUT", "git.commitFiles: changes must name a file");
  const { url, authorization } = gitRemoteOf(input.remote);
  const named = redactRemote(input.remote);
  const transport = createGitWireTransport({ remote: url, authorization, fetch: input.fetch });
  const tip = await transport.tipOf(REF);
  if (!tip)
    throw codedError(
      "NOT_CREATED",
      `git.commitFiles: ${named} has no commit on main: the first commit of a repo is its owner's`,
    );
  const fetched = await transport.fetchObjects({ wants: [tip], deepen: 1 });
  const objects = new Map<string, RawGitObject>(fetched.map((object) => [object.oid, object]));
  const commit = objects.get(tip);
  if (commit?.type !== "commit")
    throw new Error(`git.commitFiles: ${named} sent no commit for its tip ${tip}`);
  const tree = objects.get(parseCommit(commit.payload).tree);
  if (tree?.type !== "tree")
    throw new Error(`git.commitFiles: ${named} sent no tree for its tip ${tip}`);
  const manifest = manifestOf(parseTree(tree.payload), objects);

  const toPush: { payload: Uint8Array; type: GitObjectType }[] = [];
  const changedPaths: string[] = [];
  // Deletes first: a write may take a path that a delete in the same batch frees.
  for (const change of input.changes) {
    if (!("delete" in change)) continue;
    const file = filePath(change.path);
    if (manifest.delete(file)) changedPaths.push(file);
  }
  for (const change of input.changes) {
    if ("delete" in change) continue;
    const file = filePath(change.path);
    for (const existing of manifest.keys())
      if (existing.startsWith(`${file}/`) || file.startsWith(`${existing}/`))
        throw new Error(`git.commitFiles: "${file}" collides with "${existing}"`);
    const blob = blobOf(change);
    const oid = await hashObject("blob", blob);
    const current = manifest.get(file);
    if (current?.oid === oid) continue;
    manifest.set(file, { oid, mode: current ? current.mode : "100644" });
    if (!objects.has(oid)) toPush.push({ payload: blob, type: "blob" });
    changedPaths.push(file);
  }
  if (changedPaths.length === 0) return { commitOid: tip, parent: tip, changedPaths };

  const { rootOid, trees } = await treeObjectsOf(manifest);
  for (const made of trees)
    if (!objects.has(made.oid)) toPush.push({ payload: made.payload, type: "tree" });
  const commitBytes = encodeCommit({
    author: { ...(input.author || PLATFORM_AUTHOR), date: new Date() },
    committer: PLATFORM_AUTHOR,
    message: input.message,
    parents: [tip],
    tree: rootOid,
  });
  const commitOid = await hashObject("commit", commitBytes);
  toPush.push({ payload: commitBytes, type: "commit" });
  const refused = await transport.push({
    newOid: commitOid,
    oldOid: tip,
    pack: await buildPack(toPush),
    ref: REF,
  });
  // oxlint-disable-next-line iterate/simple-truthiness-check -- push() answers null only on success; an empty refusal reason is still a refusal
  if (refused !== null)
    throw codedError(
      "NOT_FAST_FORWARD",
      `git.commitFiles: ${named} refused the commit onto ${tip}: ${refused || "no reason given"}. Call again: the tip is read anew.`,
    );
  return { commitOid, parent: tip, changedPaths };
}
