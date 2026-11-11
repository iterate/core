import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { IterateContextApi, RepoFileChange, RepoLogEntry } from "iterate/api";
import { DurableObjectNameCodec, type ItxEntrypointScope } from "core-itx";
import {
  assertCreated,
  EntityLifecycleProcessor,
  type EntityCreationAndDeletionState,
} from "../project/entity-lifecycle.ts";
import { WorkspaceContract } from "./contract.ts";

type WorkspaceMount = { repo: string };

/** Scratch is "added". */
type WorkspaceChange = { path: string; change: "added" | "deleted" | "modified" };

type WorkspaceMountStatus = { path: string; repo: string; changes: WorkspaceChange[] };

function absolutePath(path: string): string {
  const segments = path.slice(1).split("/");
  const malformed =
    !path.startsWith("/") ||
    (path !== "/" && segments.some((s) => s === "" || s === "." || s === ".."));
  if (malformed) throw new Error(`workspace: not an absolute path (${JSON.stringify(path)})`);
  return path;
}

/** The longest mount path that is a proper ancestor: a repo may live beneath another's path. A mount
 *  point itself is a directory, never a file. */
function routeMount(
  mounts: Record<string, WorkspaceMount>,
  path: string,
): { mountPath: string; repo: string; relativePath: string } | null {
  let best: { mountPath: string; repo: string; relativePath: string } | null = null;
  for (const [mountPath, mount] of Object.entries(mounts)) {
    if (!path.startsWith(`${mountPath}/`)) continue;
    if (best && best.mountPath.length >= mountPath.length) continue;
    best = { mountPath, repo: mount.repo, relativePath: path.slice(mountPath.length + 1) };
  }
  return best;
}

export const workspaceVerbs = [
  "mounts",
  "readFile",
  "readBase",
  "writeFile",
  "deleteFile",
  "revert",
  "listAllFiles",
  "gitStatus",
  "gitCommit",
  "gitLog",
] as const;

/** The project library's `itx.repos`, which the kernel's type does not name. */
type WorkspaceScope = ItxEntrypointScope & Pick<IterateContextApi, "repos">;

export class WorkspaceFacet extends StreamProcessorDurableObject<
  EntityCreationAndDeletionState,
  { ITX?: ItxEntrypointService },
  WorkspaceScope
> {
  static override publicMethods = [...super.publicMethods, ...workspaceVerbs];

  processor = new EntityLifecycleProcessor(
    WorkspaceContract,
    () => this.getItx(),
    () => this.#path,
  );

  get #path(): string {
    return DurableObjectNameCodec.parse(this.ctx.props.iterateContextName).path;
  }

  #tableCreated = false;
  get #sql() {
    const sql = this.ctx.storage.sql;
    if (!this.#tableCreated) {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)",
      );
      this.#tableCreated = true;
    }
    return sql;
  }
  #row(path: string): { content: string; deleted: number } | undefined {
    return this.#sql
      .exec<{ content: string; deleted: number }>(
        "SELECT content, deleted FROM files WHERE path = ?",
        path,
      )
      .toArray()[0];
  }
  #rows(): { path: string; content: string; deleted: number }[] {
    return this.#sql
      .exec<{ path: string; content: string; deleted: number }>(
        "SELECT path, content, deleted FROM files ORDER BY path",
      )
      .toArray();
  }

  async #created(): Promise<void> {
    assertCreated("workspace", this.#path, (await this.snapshot()).state);
  }

  async mounts(): Promise<Record<string, WorkspaceMount>> {
    await this.#created();
    const mounts: Record<string, WorkspaceMount> = {};
    using itx = this.getItx();
    for (const { path } of await itx.repos.list()) mounts[path] = { repo: path };
    return mounts;
  }

  async readFile(path: string): Promise<string | null> {
    await this.#created();
    const resolved = absolutePath(path);
    const row = this.#row(resolved);
    if (row) return row.deleted ? null : row.content;
    return this.#readMounted(resolved, await this.mounts());
  }

  /** What uncommitted work diffs against. */
  async readBase(path: string): Promise<string | null> {
    await this.#created();
    return this.#readMounted(absolutePath(path), await this.mounts());
  }

  async #readMounted(path: string, mounts: Record<string, WorkspaceMount>): Promise<string | null> {
    const route = routeMount(mounts, path);
    if (!route) return null;
    using itx = this.getItx();
    return await itx.repos.get(route.repo).readFile(route.relativePath);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const resolved = absolutePath(path);
    if (resolved === "/" || resolved in (await this.mounts()))
      throw new Error(`workspace: "${resolved}" is a directory`);
    this.#sql.exec(
      "INSERT INTO files (path, content, deleted) VALUES (?, ?, 0) ON CONFLICT(path) DO UPDATE SET content = excluded.content, deleted = 0",
      resolved,
      content,
    );
  }

  /** False when the path was not a file of the view. */
  async deleteFile(path: string): Promise<boolean> {
    await this.#created();
    const resolved = absolutePath(path);
    const row = this.#row(resolved);
    const route = routeMount(await this.mounts(), resolved);
    let mounted = false;
    if (route) {
      using itx = this.getItx();
      mounted = (await itx.repos.get(route.repo).listFiles()).paths.includes(route.relativePath);
    }
    if (mounted)
      this.#sql.exec(
        "INSERT INTO files (path, content, deleted) VALUES (?, '', 1) ON CONFLICT(path) DO UPDATE SET content = '', deleted = 1",
        resolved,
      );
    else this.#sql.exec("DELETE FROM files WHERE path = ?", resolved);
    return row ? !row.deleted : mounted;
  }

  async revert(path: string): Promise<void> {
    await this.#created();
    this.#sql.exec("DELETE FROM files WHERE path = ?", absolutePath(path));
  }

  /** A tip path is listed only where it routes to that mount, as `readFile` and a commit see it. */
  async listAllFiles(): Promise<string[]> {
    await this.#created();
    const mounts = await this.mounts();
    const paths = new Set<string>();
    const whiteouts = new Set<string>();
    for (const row of this.#rows()) (row.deleted ? whiteouts : paths).add(row.path);
    await Promise.all(
      Object.entries(mounts).map(async ([mountPath, { repo }]) => {
        using itx = this.getItx();
        for (const relativePath of (await itx.repos.get(repo).listFiles()).paths) {
          const path = `${mountPath}/${relativePath}`;
          if (!whiteouts.has(path) && routeMount(mounts, path)?.mountPath === mountPath)
            paths.add(path);
        }
      }),
    );
    return [...paths].sort();
  }

  async gitStatus(): Promise<{ mounts: WorkspaceMountStatus[]; unmounted: WorkspaceChange[] }> {
    await this.#created();
    return this.#status(await this.mounts());
  }

  async #status(
    mounts: Record<string, WorkspaceMount>,
  ): Promise<{ mounts: WorkspaceMountStatus[]; unmounted: WorkspaceChange[] }> {
    const byMount = new Map<string, WorkspaceMountStatus>();
    for (const [path, { repo }] of Object.entries(mounts))
      byMount.set(path, { path, repo, changes: [] });
    const unmounted: WorkspaceChange[] = [];
    const tipPaths = new Map<string, Set<string>>();
    for (const { path, deleted } of this.#rows()) {
      const route = routeMount(mounts, path);
      if (!route) {
        unmounted.push({ path, change: deleted ? "deleted" : "added" });
        continue;
      }
      let tip = tipPaths.get(route.mountPath);
      if (!tip) {
        using itx = this.getItx();
        tip = new Set((await itx.repos.get(route.repo).listFiles()).paths);
        tipPaths.set(route.mountPath, tip);
      }
      byMount.get(route.mountPath)!.changes.push({
        path,
        change: deleted ? "deleted" : tip.has(route.relativePath) ? "modified" : "added",
      });
    }
    return { mounts: [...byMount.values()], unmounted };
  }

  async gitCommit(input: {
    message: string;
    scope?: string;
    author?: { name: string; email: string };
  }): Promise<{ commitOid: string | null; mount: string; repo: string; changedPaths: string[] }> {
    const mounts = await this.mounts();
    const status = await this.#status(mounts);
    const dirty = status.mounts.filter((candidate) => candidate.changes.length > 0);
    let mount: WorkspaceMountStatus | undefined;
    if (input.scope) {
      const scope = absolutePath(input.scope);
      mount = status.mounts.find((candidate) => candidate.path === scope);
      if (!mount)
        throw new Error(
          `workspace: no mount at "${scope}" (mounts: ${status.mounts.map((m) => `"${m.path}"`).join(", ")})`,
        );
    } else {
      if (dirty.length !== 1)
        throw new Error(
          dirty.length === 0
            ? "workspace: nothing to commit — no mount has changes"
            : `workspace: changes span ${dirty.length} mounts (${dirty.map((m) => `"${m.path}"`).join(", ")}) — a commit never spans mounts; pass { scope }`,
        );
      mount = dirty[0]!;
    }
    if (mount.changes.length === 0)
      throw new Error(`workspace: nothing to commit under "${mount.path}"`);
    const mountPath = mount.path;
    const changes: RepoFileChange[] = this.#rows()
      .filter((row) => routeMount(mounts, row.path)?.mountPath === mountPath)
      .map((row) => {
        const path = row.path.slice(mountPath.length + 1);
        return row.deleted ? { path, delete: true as const } : { path, content: row.content };
      });
    using itx = this.getItx();
    const committed = await itx.repos
      .get(mount.repo)
      .commitFiles({ message: input.message, changes, author: input.author });
    for (const { path } of mount.changes) this.#sql.exec("DELETE FROM files WHERE path = ?", path);
    return {
      commitOid: committed.commitOid,
      mount: mountPath,
      repo: mount.repo,
      changedPaths: committed.changedPaths.map((path: string) => `${mountPath}/${path}`),
    };
  }

  async gitLog(input: { scope?: string; limit?: number } = {}): Promise<RepoLogEntry[]> {
    const mounts = await this.mounts();
    const mountPaths = Object.keys(mounts);
    const scope = input.scope
      ? absolutePath(input.scope)
      : mountPaths.length === 1
        ? mountPaths[0]!
        : "";
    const mount = mounts[scope];
    if (!mount)
      throw new Error(
        `workspace: name the mount to log — { scope } is one of ${mountPaths.map((path) => `"${path}"`).join(", ")}`,
      );
    using itx = this.getItx();
    return await itx.repos.get(mount.repo).log({ limit: input.limit });
  }
}
