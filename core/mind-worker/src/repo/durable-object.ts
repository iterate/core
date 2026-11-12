// `pull` and `push` forward the pack one side's upload-pack answers, unchanged, to the other side's
// receive-pack, so commits keep their oids. The remote is reached through the caller's egress, so a
// secret placeholder in its userinfo is substituted there and never enters this facet.
import { z } from "zod";
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type {
  CfArtifactRepoApi,
  CfArtifactsApi,
  RepoFileChange,
  RepoLogEntry,
  RepoSyncResult,
} from "iterate/api";
import { codedError } from "iterate/lib";
import { SECRET_PLACEHOLDER } from "iterate/secret-placeholder";
import type { EventInput, ReduceArgs } from "iterate/stream/processor";
import {
  DurableObjectNameCodec,
  refuseActPastLimit,
  runningCause,
  type Cause,
  type ItxEntrypointScope,
  verifyOnBehalfOf,
} from "core-itx";
import { env } from "cloudflare:workers";
import { assertCreated, EntityLifecycleProcessor } from "../mind/entity-lifecycle.ts";
import {
  ZERO_OID,
  buildPack,
  basicAuthorization,
  commitReaches,
  createGitWireTransport,
  encodeCommit,
  hashObject,
  manifestOf,
  gitRemoteOf,
  MAX_INFLATED_BYTES,
  parseCommit,
  parsePack,
  parseTree,
  redactRemote,
  treeObjectsOf,
  type GitObjectType,
  type RawGitObject,
  type RepoManifest,
} from "./git-wire.ts";
import {
  OriginSet,
  RepoContract,
  type CommitCompleted,
  type RepoState,
  PLATFORM_AUTHOR,
} from "./contract.ts";

const REF = "refs/heads/main";
const TOKEN_TTL_SECONDS = 300;
/** An operation must not outlive its token. */
const TOKEN_REUSE_MARGIN_MS = 60_000;
const textEncoder = new TextEncoder();

type Transport = ReturnType<typeof createGitWireTransport>;
type StoredToken = { token: string; until: number };
type TipSnapshot = { manifest: RepoManifest; objects: Map<string, RawGitObject> };
// A file is its text when it is text, else its bytes.
type FileContent = string | Uint8Array;
type Snapshot = { tip: string | null; files: Record<string, FileContent> };
// "snapshot" held every file decoded as text, a binary one mangled.
const KEPT_SNAPSHOT = "snapshot-2";
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

// Git's own test first (a NUL byte), then whether the bytes are UTF-8 at all.
function contentOf(payload: Uint8Array): FileContent {
  if (payload.includes(0)) return payload;
  try {
    return strictTextDecoder.decode(payload);
  } catch {
    return payload;
  }
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
// a submodule pointer has no text
const SUBMODULE_MODE = "160000";
type Egress = (request: Request) => Promise<Response>;
// Owed from the moment its push is sent until both appends have landed, under the key of that one
// update of main: main can return to a commit published before, and each update is published again.
type OwedFact = CommitCompleted & { key?: string };

function filePath(path: string): string {
  const refusal = `repo: not a repo-relative path (${JSON.stringify(path)})`;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of a wire-fed argument (its static type is a claim, not a guarantee, across the capability boundary)
  if (typeof path !== "string") throw new Error(refusal);
  if (path.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(refusal);
  return path;
}

// A change's blob: its text, or the bytes it names.
function blobOf(change: Exclude<RepoFileChange, { delete: true }>): Uint8Array {
  if ("content" in change) return textEncoder.encode(change.content);
  if (change.bytes instanceof Uint8Array) return change.bytes;
  if (change.bytes instanceof ArrayBuffer) return new Uint8Array(change.bytes);
  throw new Error(
    `repo.commitFiles: ${JSON.stringify(change.path)} needs "content" (text) or "bytes" (a Uint8Array)`,
  );
}

export const repoVerbs = [
  "tip",
  "announceTip",
  "readFile",
  "readBytes",
  "modules",
  "files",
  "listFiles",
  "commitFiles",
  "writeFile",
  "log",
  "origin",
  "setOrigin",
  "pull",
  "push",
] as const;

class RepoProcessor extends EntityLifecycleProcessor<RepoState> {
  override reduce(args: ReduceArgs<RepoState>): RepoState | undefined {
    if (args.event.type !== "events.iterate.com/repo/origin-set") return super.reduce(args);
    const { origin } = OriginSet.parse(args.event.payload);
    // a fact appended around `setOrigin` is held to its rules
    if (origin && originRefusal(origin)) return undefined;
    return { ...args.state, origin };
  }
}

// An origin lives on the log, so its credential is never a token. The reason never quotes the origin.
function originRefusal(origin: string): string | null {
  let userinfo: { user: string; password: string } | null;
  try {
    ({ userinfo } = gitRemoteOf(origin));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (
    userinfo &&
    !(/^[a-z][a-z0-9-]{0,31}$/.test(userinfo.user) && isSecretPlaceholder(userinfo.password))
  )
    return `an origin's credential is a plain user name and a secret placeholder (x-access-token:getSecret("/secrets/…")), never a token`;
  return null;
}

// THE STORE IS NAMED AT THE FIXED POINT, `itx.builtins.cfArtifacts`: the facet fetches the remote
// that the store names, with the Worker's own fetch, and sends the repo's token there. A rule of
// the repo's context that gives `itx.cfArtifacts` another meaning must not choose that address.
type RepoScope = ItxEntrypointScope & {
  builtins: {
    cfArtifacts: Omit<CfArtifactsApi, "get"> & { get(path: string): CfArtifactRepoApi };
  };
};

export class RepoFacet extends StreamProcessorDurableObject<
  RepoState,
  { ITX?: ItxEntrypointService },
  RepoScope
> {
  static override publicMethods = [...super.publicMethods, ...repoVerbs];

  processor = new RepoProcessor(
    RepoContract,
    () => this.getItx(),
    () => this.#path,
    {
      provision: async (path) => {
        using itx = this.getItx();
        return await itx.builtins.cfArtifacts.create(path);
      },
      teardown: async (path) => {
        using itx = this.getItx();
        return await itx.builtins.cfArtifacts.delete(path);
      },
    },
  );

  get #path(): string {
    return DurableObjectNameCodec.parse(this.ctx.props.iterateContextName).path;
  }

  // The git credentials live in storage too: a context is evicted soon after it goes idle. Writes
  // are `allowUnconfirmed`: a credential lost with one is only asked for again.

  #remoteRead?: string;
  async #remote(): Promise<string> {
    this.#remoteRead ||= await this.ctx.storage.get<string>("git-remote");
    if (this.#remoteRead) return this.#remoteRead;
    const path = this.#path;
    using itx = this.getItx();
    const remote = await itx.builtins.cfArtifacts.get(path).remote();
    await this.ctx.storage.put("git-remote", remote, { allowUnconfirmed: true });
    return (this.#remoteRead = remote);
  }

  // A token's life counts from before the mint was asked, so it never outlives the real one.
  #tokens: Partial<Record<"read" | "write", StoredToken>> = {};
  async #transport(scope: "read" | "write"): Promise<Transport> {
    const key = `git-token:${scope}`;
    const known = (this.#tokens[scope] ||= await this.ctx.storage.get<StoredToken>(key));
    if (known && Date.now() < known.until - TOKEN_REUSE_MARGIN_MS)
      return createGitWireTransport({
        remote: await this.#remote(),
        authorization: basicAuthorization(`x:${known.token}`),
      });
    const path = this.#path;
    const asked = Date.now();
    using itx = this.getItx();
    const [remote, minted] = await Promise.all([
      this.#remote(),
      itx.builtins.cfArtifacts.get(path).createToken(scope, TOKEN_TTL_SECONDS),
    ]);
    const token = { token: minted.plaintext, until: asked + TOKEN_TTL_SECONDS * 1000 };
    this.#tokens[scope] = token;
    await this.ctx.storage.put(key, token, { allowUnconfirmed: true });
    return createGitWireTransport({
      remote,
      authorization: basicAuthorization(`x:${minted.plaintext}`),
    });
  }

  // git drops wants for missing oids silently, so receipt is verified here: an omitted commit or tree
  // is an outage, not an empty tree.
  async #tipSnapshot(transport: Transport, tip: string): Promise<TipSnapshot> {
    const objects = new Map<string, RawGitObject>(
      (await transport.fetchObjects({ wants: [tip], deepen: 1 })).map((o) => [o.oid, o]),
    );
    const commit = objects.get(tip);
    if (commit?.type !== "commit")
      throw new Error(`repo: the pack omitted the tip commit ${tip} of ${REF}`);
    const tree = objects.get(parseCommit(commit.payload).tree);
    if (tree?.type !== "tree")
      throw new Error(`repo: the pack omitted the tree of the tip commit ${tip}`);
    return { manifest: manifestOf(parseTree(tree.payload), objects), objects };
  }

  // A commit's files never change, so the memo answers a read at its commit without asking the remote.
  #snapshotMemo: Snapshot | null = null;
  // One read in flight per commitOid and one for the tip (""), dropped when it settles.
  #snapshotReads = new Map<string, Promise<Snapshot>>();
  async #fresh(commitOid?: string): Promise<Snapshot> {
    if (commitOid && this.#snapshotMemo?.tip === commitOid) return this.#snapshotMemo;
    const key = commitOid || "";
    let read = this.#snapshotReads.get(key);
    if (!read) {
      read = this.#fetchSnapshot(commitOid).finally(() => this.#snapshotReads.delete(key));
      this.#snapshotReads.set(key, read);
    }
    return read;
  }
  async #fetchSnapshot(commitOid?: string): Promise<Snapshot> {
    const transport = await this.#transport("read");
    const tip = commitOid || (await transport.tipOf(REF)) || null;
    if (this.#snapshotMemo && this.#snapshotMemo.tip === tip) return this.#snapshotMemo;
    const kept = tip ? await this.ctx.storage.get<Snapshot>(KEPT_SNAPSHOT) : undefined;
    if (kept?.tip === tip) return (this.#snapshotMemo = kept);
    const files: Snapshot["files"] = {};
    if (tip) {
      const { manifest, objects } = await this.#tipSnapshot(transport, tip);
      for (const [file, entry] of manifest) {
        if (entry.mode === SUBMODULE_MODE) continue;
        const blob = objects.get(entry.oid);
        if (blob?.type !== "blob")
          throw new Error(`repo: the pack omitted the blob of ${file} (${entry.oid})`);
        files[file] = contentOf(blob.payload);
      }
    }
    return this.#remember({ tip, files });
  }

  // The stored copy lets the next incarnation answer a read with one ls-refs instead of a fetch of
  // the whole tip (1.6–2.7 s measured).
  async #remember(snapshot: Snapshot): Promise<Snapshot> {
    this.#snapshotMemo = snapshot;
    // a stored value is at most 2 MB: up to two bytes a character, and each entry's framing
    let bytes = 0;
    for (const [path, content] of Object.entries(snapshot.files))
      bytes += 2 * path.length + (typeof content === "string" ? 2 : 1) * content.length + 64;
    try {
      if (snapshot.tip && bytes <= 1_800_000) {
        await this.ctx.storage.put(KEPT_SNAPSHOT, snapshot, { allowUnconfirmed: true });
        await this.ctx.storage.delete("snapshot");
      }
    } catch (error) {
      console.warn("[repo] the tip's snapshot was not kept", { tip: snapshot.tip, bytes, error });
    }
    return snapshot;
  }

  async #created(): Promise<string> {
    const path = this.#path;
    assertCreated("repo", path, (await this.snapshot()).state);
    return path;
  }

  async tip(): Promise<string | null> {
    await this.#created();
    return (await this.#fresh()).tip;
  }

  // Lands the tip's fact again under a fresh key: an Artifacts repo outlives the deployment that made
  // it, and its commits have no fact on a new mind's log.
  announceTip(): Promise<string | null> {
    return this.#serialized(async () => {
      const path = await this.#created();
      const [newest] = await this.log({ limit: 1 });
      if (!newest) return null;
      const owed = await this.ctx.storage.get<OwedFact>("commit-fact");
      await this.#commitFact(
        owed?.commitOid === newest.oid
          ? owed
          : {
              path,
              commitOid: newest.oid,
              message: newest.message,
              changedPaths: [],
              key: occurrenceKey(path, newest.oid),
            },
      );
      return newest.oid;
    });
  }

  async readFile(path: string, options?: { commitOid: string }): Promise<string | null> {
    await this.#created();
    const revision = z
      .object({ commitOid: z.string().regex(/^[a-f0-9]{40}$/) })
      .optional()
      .parse(options);
    const { files } = await this.#fresh(revision?.commitOid);
    if (!Object.hasOwn(files, path)) return null;
    const content = files[path]!;
    if (typeof content !== "string")
      throw new Error(`repo: ${path} is not text: read it with readBytes`);
    return content;
  }

  // Any file, text or not. A stream with its size, as a mail's files travel.
  async readBytes(
    path: string,
    options?: { commitOid: string },
  ): Promise<{ data: ReadableStream<Uint8Array>; size: number } | null> {
    await this.#created();
    const revision = z
      .object({ commitOid: z.string().regex(/^[a-f0-9]{40}$/) })
      .optional()
      .parse(options);
    const { files } = await this.#fresh(revision?.commitOid);
    if (!Object.hasOwn(files, path)) return null;
    const content = files[path]!;
    const bytes = typeof content === "string" ? textEncoder.encode(content) : content;
    return {
      size: bytes.byteLength,
      data: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  }

  // The repo's text files, by path: a file that is not text is left out.
  async modules(options?: { commitOid?: string; dir?: string }): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [path, content] of Object.entries(await this.files(options)))
      if (typeof content === "string") out[path] = content;
    return out;
  }

  // Every file, as the loader reads a worker's source: text, or `{ base64 }` for one that is not.
  async files(options?: {
    commitOid?: string;
    dir?: string;
  }): Promise<Record<string, string | { base64: string }>> {
    await this.#created();
    const { commitOid, dir } =
      z
        .object({
          commitOid: z
            .string()
            .regex(/^[a-f0-9]{40}$/)
            .optional(),
          dir: z.string().min(1).optional(),
        })
        .strict()
        .optional()
        .parse(options) ?? {};
    const { files } = await this.#fresh(commitOid);
    const prefix = dir ? `${dir.replace(/\/$/, "")}/` : "";
    const out: Record<string, string | { base64: string }> = {};
    for (const [path, content] of Object.entries(files))
      if (path.startsWith(prefix))
        out[path.slice(prefix.length)] =
          typeof content === "string" ? content : { base64: base64Of(content) };
    return out;
  }
  async listFiles(): Promise<{ commitOid: string | null; paths: string[] }> {
    await this.#created();
    const { tip, files } = await this.#fresh();
    return { commitOid: tip, paths: Object.keys(files).sort() };
  }

  // `parent` names the tip the caller decided on (`null`: an unborn `main`), so a decision made on an
  // older read never lands on top of a commit it did not see.
  commitFiles(input: {
    message: string;
    changes: RepoFileChange[];
    author?: { name: string; email: string };
    parent?: string | null;
  }): Promise<{ commitOid: string | null; changedPaths: string[] }> {
    const cause = runningCause();
    refuseActPastLimit(cause, "a commit");
    return this.#serialized(async () => {
      if (!input.message.trim())
        throw new Error("repo.commitFiles: message must be a non-empty string");
      const onBehalfOf = await this.#onBehalfOfIn(cause);
      const email = onBehalfOf?.principal.email;
      const message = input.message.trimEnd();
      const trailers: string[] = [];
      if (onBehalfOf) {
        // git and GitHub read only the last paragraph as trailers
        if (!/\n\n(?:[\w-]+: .+\n?)+$/.test(message)) trailers.push("");
        trailers.push(`Iterate-Run: ${onBehalfOf.run}`);
        if (input.author && input.author.email !== email)
          trailers.push(`Requested-by: ${email || onBehalfOf.principal.actor}`);
      }
      return this.#commitFiles({
        ...input,
        author: input.author || (email ? { name: email, email } : undefined),
        message: [message, ...trailers].join("\n").trim(),
      });
    });
  }
  // A commit names the run it was made for. A person's own call into this facet names none.
  async #onBehalfOfIn(cause: Cause | undefined) {
    if (!cause?.onBehalfOf) return undefined;
    const onBehalfOf = await verifyOnBehalfOf(cause.onBehalfOf, env.MIND_SIGNING_KEY, Date.now());
    return onBehalfOf?.run ? { ...onBehalfOf, run: onBehalfOf.run } : undefined;
  }
  async #commitFiles(input: {
    message: string;
    changes: RepoFileChange[];
    author?: { name: string; email: string };
    parent?: string | null;
  }): Promise<{ commitOid: string | null; changedPaths: string[] }> {
    const path = await this.#created();
    if (input.changes.length === 0) throw new Error("repo.commitFiles: changes must name a file");
    const parent = z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable()
      .optional()
      .parse(input.parent);
    this.#snapshotMemo = null;
    const transport = await this.#transport("write");
    // An unborn `main` named and no fact owed reads no tip: the push is compare-and-swapped on no
    // commit, so a `main` born after all refuses it.
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `null` names an unborn main; an absent `parent` commits onto whatever main holds, so it reads the tip
    const unbornNamed = parent === null && !(await this.ctx.storage.get<OwedFact>("commit-fact"));
    const tip = unbornNamed ? null : (await transport.tipOf(REF)) || null;
    await this.#settleOwedFact(tip);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `parent` absent commits onto whatever main holds; `null` names an unborn main, which a born one refuses
    if (parent !== undefined && parent !== tip)
      throw new Error(
        `repo ${path}: the commit was refused: main is at ${tip || "no commit (unborn)"}, not at the parent it names (${parent || "unborn"})`,
      );
    const { manifest, objects }: TipSnapshot = tip
      ? await this.#tipSnapshot(transport, tip)
      : { manifest: new Map(), objects: new Map() };
    const toPush: { payload: Uint8Array; type: GitObjectType }[] = [];
    const changedPaths: string[] = [];
    const written = new Map<string, FileContent>();
    // Deletes first: a write may take a path a delete in the same batch frees.
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
          throw new Error(`repo.commitFiles: "${file}" collides with "${existing}"`);
      const blob = blobOf(change);
      const oid = await hashObject("blob", blob);
      written.set(oid, "content" in change ? change.content : contentOf(blob));
      const current = manifest.get(file);
      if (current?.oid === oid) continue;
      manifest.set(file, { oid, mode: current ? current.mode : "100644" });
      if (!objects.has(oid)) toPush.push({ payload: blob, type: "blob" });
      changedPaths.push(file);
    }
    if (changedPaths.length === 0) return { commitOid: tip, changedPaths };

    const { rootOid, trees } = await treeObjectsOf(manifest);
    for (const tree of trees)
      if (!objects.has(tree.oid)) toPush.push({ payload: tree.payload, type: "tree" });
    const commitBytes = encodeCommit({
      author: { ...(input.author || PLATFORM_AUTHOR), date: new Date() },
      committer: PLATFORM_AUTHOR,
      message: input.message,
      parents: tip ? [tip] : [],
      tree: rootOid,
    });
    const commitOid = await hashObject("commit", commitBytes);
    toPush.push({ payload: commitBytes, type: "commit" });
    // kept until it has landed on both logs, so a retry lands the same event under the same key
    const committed = {
      path,
      commitOid,
      message: input.message,
      changedPaths,
      key: occurrenceKey(path, commitOid),
    };
    await this.ctx.storage.put("commit-fact", committed);
    const refused = await transport.push({
      newOid: commitOid,
      oldOid: tip || ZERO_OID,
      pack: await buildPack(toPush),
      ref: REF,
    });
    // oxlint-disable-next-line iterate/simple-truthiness-check -- push() returns null only on success; an empty-string refusal reason (an `ng <ref>` line with no message) is still a refusal and must throw
    if (refused !== null) {
      await this.ctx.storage.delete("commit-fact");
      const born = unbornNamed && (await transport.tipOf(REF));
      if (born)
        throw new Error(
          `repo ${path}: the commit was refused: main is at ${born}, not at the parent it names (unborn)`,
        );
      throw new Error(`repo ${path}: the commit was refused: ${refused}`);
    }
    const pushed = this.#pushedSnapshot(commitOid, manifest, objects, written);
    if (pushed) await this.#remember(pushed);
    else this.#snapshotMemo = null;
    await this.#commitFact(committed);
    return { commitOid, changedPaths };
  }

  // null when the snapshot lacks a blob: re-fetched on the next read
  #pushedSnapshot(
    commitOid: string,
    manifest: RepoManifest,
    objects: Map<string, RawGitObject>,
    written: Map<string, FileContent>,
  ): { tip: string; files: Snapshot["files"] } | null {
    const files: Snapshot["files"] = {};
    for (const [file, entry] of manifest) {
      if (entry.mode === SUBMODULE_MODE) continue;
      const blob = objects.get(entry.oid);
      if (written.has(entry.oid)) files[file] = written.get(entry.oid)!;
      else if (blob?.type === "blob") files[file] = contentOf(blob.payload);
      else return null;
    }
    return { tip: commitOid, files };
  }

  // `/` first: the mind follows the config repo's commits, so a commit whose own-path fact lost
  // its answer is published anyway.
  async #commitFact({ key, ...payload }: OwedFact): Promise<void> {
    const committed: EventInput<typeof RepoContract> = {
      type: "events.iterate.com/repo/commit-completed",
      payload,
      // a debt stored before facts had keys of their own
      idempotencyKey: key || `repo/commit-completed:${payload.path}:${payload.commitOid}`,
    };
    using itx = this.getItx();
    await itx.cd("/").append(committed);
    await itx.append(committed);
    await this.ctx.storage.delete("commit-fact");
  }

  // Settled first, word for word, before a write can overwrite the debt or land on top of an
  // unpublished tip. A debt for another commit than the tip never landed or is stale: dropped.
  async #settleOwedFact(tip: string | null): Promise<void> {
    const owed = await this.ctx.storage.get<OwedFact>("commit-fact");
    if (!owed) return;
    if (owed.commitOid === tip) await this.#commitFact(owed);
    else await this.ctx.storage.delete("commit-fact");
  }

  // a commit and a pull each read the tip, owe a fact and push
  #writes: Promise<unknown> = Promise.resolve();
  #serialized<T>(write: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(write, write);
    this.#writes = run.catch(() => undefined);
    return run;
  }

  async origin(): Promise<string | null> {
    await this.#created();
    return (await this.snapshot()).state.origin;
  }

  async setOrigin(url: string | null): Promise<{ origin: string | null }> {
    const path = await this.#created();
    const origin = z.string().min(1).nullable().parse(url);
    const refused = origin && originRefusal(origin);
    if (refused) throw codedError("INVALID_INPUT", `repo ${path}: ${refused}`);
    using itx = this.getItx();
    await itx.append({ type: "events.iterate.com/repo/origin-set", payload: { origin } });
    return { origin };
  }

  pull(options?: { remote?: string; force?: boolean }, egress?: Egress): Promise<RepoSyncResult> {
    return this.#serialized(() => this.#pull(options, egress));
  }
  async #pull(options: unknown, egress: Egress | undefined): Promise<RepoSyncResult> {
    const path = await this.#created();
    const { remote, force } = await this.#syncOptions(options, egress);
    const artifacts = await this.#transport("write");
    const [ours = null, theirs = null] = await Promise.all([
      artifacts.tipOf(REF),
      remote.transport.tipOf(REF),
    ]);
    await this.#settleOwedFact(ours);
    if (!theirs) throw new Error(`repo ${path}: ${remote.shown} has no main to pull`);
    if (theirs === ours) return { status: "up-to-date", commitOid: ours, previousOid: ours };
    const pack = await remote.transport.fetchPack({ wants: [theirs], haves: ours ? [ours] : [] });
    if (ours && !force && !commitReaches(await parseBounded(pack), theirs, ours)) {
      if (await reaches(artifacts, ours, theirs))
        return { status: "up-to-date", commitOid: ours, previousOid: ours };
      throw notFastForward(path, `${remote.shown}'s main does not contain ours`, ours, theirs);
    }
    this.#snapshotMemo = null;
    const [before, after] = await Promise.all([
      ours ? this.#tipSnapshot(artifacts, ours) : null,
      this.#tipSnapshot(remote.transport, theirs),
    ]);
    const committed = {
      path,
      commitOid: theirs,
      message: parseCommit(after.objects.get(theirs)!.payload).message,
      changedPaths: changedPathsOf(before?.manifest || new Map(), after.manifest),
      key: occurrenceKey(path, theirs),
    };
    await this.ctx.storage.put("commit-fact", committed);
    const refused = await artifacts.push({
      oldOid: ours || ZERO_OID,
      newOid: theirs,
      pack,
      ref: REF,
    });
    // oxlint-disable-next-line iterate/simple-truthiness-check -- push() returns null only on success; an empty-string refusal is still a refusal
    if (refused !== null) {
      await this.ctx.storage.delete("commit-fact");
      throw new Error(`repo ${path}: the pull was refused: ${refused}`);
    }
    await this.#commitFact(committed);
    return { status: "updated", commitOid: theirs, previousOid: ours };
  }

  async push(
    options?: { remote?: string; force?: boolean },
    egress?: Egress,
  ): Promise<RepoSyncResult> {
    const path = await this.#created();
    const { remote, force } = await this.#syncOptions(options, egress);
    const artifacts = await this.#transport("read");
    const [ours = null, theirs = null] = await Promise.all([
      artifacts.tipOf(REF),
      remote.transport.tipOf(REF),
    ]);
    if (!ours) throw new Error(`repo ${path}: main has no commit to push`);
    if (theirs === ours) return { status: "up-to-date", commitOid: ours, previousOid: ours };
    const pack = await artifacts.fetchPack({ wants: [ours], haves: theirs ? [theirs] : [] });
    if (theirs && !force && !commitReaches(await parseBounded(pack), ours, theirs)) {
      if (await reaches(remote.transport, theirs, ours))
        return { status: "up-to-date", commitOid: theirs, previousOid: theirs };
      throw notFastForward(path, `our main does not contain ${remote.shown}'s`, ours, theirs);
    }
    const refused = await remote.transport.push({
      oldOid: theirs || ZERO_OID,
      newOid: ours,
      pack,
      ref: REF,
    });
    // oxlint-disable-next-line iterate/simple-truthiness-check -- push() returns null only on success; an empty-string refusal is still a refusal
    if (refused !== null)
      throw new Error(`repo ${path}: ${remote.shown} refused the push: ${refused}`);
    return { status: "updated", commitOid: ours, previousOid: theirs };
  }

  // `egress` is the caller's own `itx.fetch`, never this repo's: a caller that may not fetch reaches
  // no remote through a repo.
  async #syncOptions(options: unknown, egress: Egress | undefined) {
    if (!egress)
      throw codedError(
        "INVALID_INPUT",
        `repo ${this.#path}: a pull or push goes through its caller's egress — call it on itx.repos.get(path)`,
      );
    const { remote: named, force = false } =
      z
        .object({ remote: z.string().optional(), force: z.boolean().optional() })
        .strict()
        .optional()
        .parse(options) ?? {};
    const url = named || (await this.snapshot()).state.origin;
    if (!url)
      throw codedError(
        "INVALID_INPUT",
        `repo ${this.#path}: no origin — setOrigin(url) first, or name the remote`,
      );
    const { url: remoteUrl, authorization } = gitRemoteOf(url);
    const transport = createGitWireTransport({
      remote: remoteUrl,
      authorization,
      fetch: egress,
    });
    return { force, remote: { transport, shown: redactRemote(url) } };
  }

  writeFile(
    path: string,
    content: string,
  ): Promise<{ commitOid: string | null; changedPaths: string[] }> {
    return this.commitFiles({ message: `write ${path}`, changes: [{ path, content }] });
  }

  async log(options: { limit?: number } = {}): Promise<RepoLogEntry[]> {
    await this.#created();
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error(`repo.log: limit must be a positive integer (got ${String(limit)})`);
    const transport = await this.#transport("read");
    const tip = await transport.tipOf(REF);
    if (!tip) return [];
    const objects = new Map<string, RawGitObject>(
      (await transport.fetchObjects({ wants: [tip], deepen: limit })).map((o) => [o.oid, o]),
    );
    const entries: RepoLogEntry[] = [];
    let oid: string | undefined = tip;
    while (oid && entries.length < limit) {
      const commit = objects.get(oid);
      if (commit?.type !== "commit") break; // past the shallow boundary
      const { parents, author, committer, timestamp, message } = parseCommit(commit.payload);
      entries.push({ oid, message, author, committer, timestamp, parents });
      oid = parents[0];
    }
    return entries;
  }
}

function occurrenceKey(path: string, commitOid: string): string {
  return `repo/commit-completed:${path}:${commitOid}:${crypto.randomUUID()}`;
}

async function parseBounded(pack: Uint8Array): Promise<Map<string, RawGitObject>> {
  const limits = { maxObjectBytes: MAX_INFLATED_BYTES, maxTotalObjectBytes: MAX_INFLATED_BYTES };
  return new Map((await parsePack(pack, limits)).map((object) => [object.oid, object]));
}

// right whether the server honours the have, ignores it, or never saw it
async function reaches(transport: Transport, tip: string, oid: string): Promise<boolean> {
  return commitReaches(
    await parseBounded(await transport.fetchPack({ wants: [tip], haves: [oid] })),
    tip,
    oid,
  );
}

function changedPathsOf(before: RepoManifest, after: RepoManifest): string[] {
  const changed = new Set<string>();
  for (const [file, entry] of after) {
    const was = before.get(file);
    if (was?.oid !== entry.oid || was.mode !== entry.mode) changed.add(file);
  }
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

function notFastForward(path: string, why: string, ours: string, theirs: string): Error {
  return codedError(
    "NOT_FAST_FORWARD",
    `repo ${path}: not a fast-forward (${why}); pass { force: true } to overwrite`,
    { ours, theirs },
  );
}

function isSecretPlaceholder(value: string): boolean {
  const [match] = [...value.matchAll(SECRET_PLACEHOLDER)];
  return match?.index === 0 && match[0].length === value.length;
}
