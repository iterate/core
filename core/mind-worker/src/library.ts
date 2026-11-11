import { z } from "zod";
import { InvokeHandle, print, type ItxExpression } from "iterate/expression";
import { codedError, resolveContextPath } from "iterate/lib";
import type { EventInput, ProcessorContract, StreamEvent } from "iterate/stream/processor";
import type {
  EntityCollectionApi,
  FileHandle,
  FileRecord,
  IterateContextApi,
  SandboxHandle,
} from "iterate/api";
import type { Caller, ItxHostRoot, LibraryItx } from "core-itx";
import { RepoContract } from "./repo/contract.ts";
import type { RepoFacet, repoVerbs } from "./repo/durable-object.ts";
import { WorkspaceContract } from "./workspace/contract.ts";
import type { WorkspaceFacet, workspaceVerbs } from "./workspace/durable-object.ts";
import { SandboxContract } from "./sandbox/contract.ts";
import type { SandboxFacet, sandboxVerbs } from "./sandbox/durable-object.ts";
import type { EntitySlug } from "./mind/entity-lifecycle.ts";
import { connectToCapnweb } from "./library/capnweb.ts";
import { connectToOpenApi } from "./library/openapi.ts";
import { WORKSPACES_ROOT_DESCRIPTION } from "./workspace/contract.ts";
import { SANDBOXES_ROOT_DESCRIPTION } from "./sandbox/contract.ts";
import { connectToMcpAt } from "./integrations/mcp.ts";

/** The one host root the library reads, which the kernel's `LibraryItx` does not name. */
type FilesItx = LibraryItx & Pick<IterateContextApi, "r2">;

type EntityRoot<Handle> = EntityCollectionApi<InvokeHandle & Handle>;

type EntityHandle<Facet, Verbs extends keyof Facet, Contract> = Pick<Facet, Verbs> & {
  append(...events: EventInput<Contract>[]): Promise<StreamEvent[]>;
};

/** A connector answers nothing where no `connections` are kept (the stateless resolver), so a call
 *  to one is sent to the context, which keeps its connection open. */
export const libraryRoots = {
  connectToOpenApi: {
    description:
      "a live OpenAPI handle: one method per operationId, `call(operationId, input)` too",
    build: ({ itx, connections }) =>
      connections &&
      (((specOrUrl, options) =>
        connections.memoized(["openapi", specOrUrl, options], false, () =>
          connectToOpenApi(itx, specOrUrl, options),
        )) satisfies IterateContextApi["connectToOpenApi"]),
  },
  connectToCapnweb: {
    description: "a live capnweb handle: `itx.connectToCapnweb(url)`, dotted calls pipelined",
    build: ({ itx, connections }) =>
      connections &&
      (((url, options) =>
        connections.memoized(["capnweb", url, options], options?.transport !== "batch", () =>
          connectToCapnweb(itx, url, options),
        )) satisfies IterateContextApi["connectToCapnweb"]),
  },
  connectToMcp: {
    description:
      "a live MCP handle: `(await itx.connectToMcp(url)).listTools()`, one method per tool; `subscribe(event, args)` lands the server's events here as `events.iterate.com/mcp/webhook-received`",
    build: ({ itx, path, connections }) =>
      connections &&
      (((url, options) =>
        connections.memoized(["mcp", url, options], false, () =>
          connectToMcpAt(itx, path)(url, options),
        )) satisfies IterateContextApi["connectToMcp"]),
  },
  repos: {
    description:
      "git on Artifacts; `/repos/config` is the mind's code: `repos.get(path).readFile(f)` · `commitFiles({ message, changes, parent? })` with whole files (edit the text in your script: `replace`, a regex) · `repos.list()`",
    build: (
      scope,
    ): EntityRoot<EntityHandle<RepoFacet, (typeof repoVerbs)[number], typeof RepoContract>> =>
      entityRoot(scope.itx, scope, "repo", "repos", RepoContract),
  },
  workspaces: {
    description: WORKSPACES_ROOT_DESCRIPTION,
    build: (
      scope,
    ): EntityRoot<
      EntityHandle<WorkspaceFacet, (typeof workspaceVerbs)[number], typeof WorkspaceContract>
    > => entityRoot(scope.itx, scope, "workspace", "workspaces", WorkspaceContract),
  },
  sandboxes: {
    description: SANDBOXES_ROOT_DESCRIPTION,
    build: (
      scope,
    ): EntityRoot<
      EntityHandle<
        SandboxFacet,
        Exclude<(typeof sandboxVerbs)[number], "replay">,
        typeof SandboxContract
      > &
        Pick<SandboxHandle, "container">
    > => entityRoot(scope.itx, scope, "sandbox", "sandboxes", SandboxContract),
  },
  files: {
    description:
      "mind files: `files.get(path).put({ contentType, data })` · `.bytes()` · `.url()` · `files.list(prefix)`",
    build: ({ itx }): IterateContextApi["files"] => ({
      get: (path) => fileHandle(withR2(itx), path),
      list: async (prefix = "") => {
        const records: FileRecord[] = [];
        for (let cursor: string | undefined; ;) {
          const page = await withR2(itx).r2.list({ prefix: fileKey(prefix), cursor });
          for (const object of page.objects) records.push(fileRecord(object));
          if (!page.truncated) return records;
          cursor = page.cursor;
        }
      },
    }),
  },
} satisfies Record<string, ItxHostRoot>;

/** `./x` from a child, answered at the root through its link, is the child's `./x`. */
const originOf = (caller: Caller, ownPath: string): string => caller.path || ownPath;

/** The collection's verbs answer exactly these shapes, so the wire's copy is asserted, not re-validated. */
function entityRoot<Handle>(
  itx: LibraryItx,
  /** Read when a handle is made: its later dispatches arrive with no ambient caller. */
  deps: { caller: () => Caller; path: string },
  name: EntitySlug,
  collection: "repos" | "workspaces" | "sandboxes",
  contract: EntityContract,
): EntityRoot<Handle> {
  // Creating and deleting reach only strictly beneath the caller's origin, stamped by the platform:
  // this is what bounds a jail granted the collection. `get` and `list` stay mind-wide.
  const beneathTheOrigin = (verb: "create" | "delete", path: string) => {
    const origin = originOf(deps.caller(), deps.path);
    const absolute = resolveContextPath(origin, path);
    if (absolute === origin || !absolute.startsWith(origin === "/" ? "/" : `${origin}/`))
      throw codedError(
        "FORBIDDEN",
        `${collection}.${verb}(${JSON.stringify(path)}) from ${JSON.stringify(origin)}: a context creates and deletes only beneath itself`,
      );
    return { origin, absolute };
  };
  return {
    get: (path) =>
      entityHandle(itx, path, name, contract, deps.caller(), deps.path) as InvokeHandle & Handle,
    list: () =>
      mindFacet(itx, [[collection], ["list"]]) as Promise<{ path: string; createdAt: string }[]>,
    // The saga writes the parent link `itx ⇒ itx.builtins.cd(creator)` on the new context; it points
    // up, so it closes no cycle.
    create: async (path) => {
      const { origin, absolute } = beneathTheOrigin("create", path);
      return mindFacet(itx, [[collection], ["create", absolute, { creator: origin }]]) as Promise<{
        path: string;
      }>;
    },
    delete: async (path) =>
      mindFacet(itx, [
        [collection],
        ["delete", beneathTheOrigin("delete", path).absolute],
      ]) as Promise<{ path: string }>,
  };
}

// The library's hops are spelled at the fixed point (`itx.builtins.cd`), so a jailed context, where
// `itx.cd` is masked, still reaches the entity and `/`. The typed `append` alone goes as the caller's.

async function mindFacet(itx: LibraryItx, steps: ItxExpression): Promise<unknown> {
  // two dotted calls, never one chain: the root's handle in-process is a value
  const context = await itx.builtins.cd("/");
  return context.invoke(["facets", ["get", "mind"], ...steps]);
}

type EntityContract = Pick<ProcessorContract, "payloadSchemaFor">;

// A handle types as the facet it dispatches to by assertion: the runtime guarantees the facet name is
// that class (first-party-facets.ts), which the type system cannot see.

function entityHandle(
  itx: LibraryItx,
  path: string,
  name: string,
  contract: EntityContract,
  caller: Caller,
  ownPath: string,
): InvokeHandle {
  const dispatch = async (itxExpressionSteps: ItxExpression) => {
    // two dotted calls, never one chain; the path means the caller's `./x`
    const entityPath = resolveContextPath(originOf(caller, ownPath), path);
    const [first, ...rest] = itxExpressionSteps;
    if (Array.isArray(first) && first[0] === "append" && rest.length === 0) {
      const [, ...events] = first;
      const parsed = events.map((event) => {
        // wire-fed: a handle's steps carry no validation
        const input = z
          .object({
            type: z.string(),
            payload: z.unknown(),
            idempotencyKey: z.string().optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
            ephemeral: z.literal(true).optional(),
          })
          .parse(event);
        const schema = contract.payloadSchemaFor(input.type);
        if (!schema)
          throw new Error(
            `${name}.append: ${JSON.stringify(input.type)} is not an event the ${name} contract owns`,
          );
        return { ...input, payload: schema.parse(input.payload ?? {}) };
      });
      // The hop is the library's, so the entity's context never learns that loaded code wrote: the
      // platform's keys are refused here (core-itx caller.ts `refusePlatformIdempotencyKeys`).
      if (caller.app)
        for (const { idempotencyKey } of parsed)
          if (
            idempotencyKey &&
            /^(?:itx|mind|repo|workspace|sandbox|secret)[/@]/.test(idempotencyKey)
          )
            throw codedError(
              "FORBIDDEN",
              `idempotency key ${JSON.stringify(idempotencyKey)} is the platform's`,
            );
      return (await itx.cd(entityPath)).invoke([["append", ...parsed]]);
    }
    const context = await itx.builtins.cd(entityPath);
    // A repo's remote is reached through the caller's own `itx.fetch`, never the repo's, so a caller
    // that may not fetch reaches no remote, and no mind secret, through a repo.
    if (name === "repo" && Array.isArray(first) && (first[0] === "pull" || first[0] === "push")) {
      const callerContext = await itx.builtins.cd(originOf(caller, ownPath));
      return context.invoke([
        "facets",
        ["get", name],
        [first[0], first[1], (request: Request) => callerContext.invoke([["fetch", request]])],
        ...rest,
      ]);
    }
    // a sandbox's `container` is replayed by the facet, where the container's objects live
    if (name === "sandbox" && first === "container")
      return context.invoke([
        "facets",
        ["get", name],
        [
          "replay",
          rest.length === 1 && Array.isArray(rest[0]) && rest[0][0] === "invoke"
            ? rest[0][1]
            : rest,
        ],
      ]);
    return context.invoke(["facets", ["get", name], ...itxExpressionSteps]);
  };
  // a sandbox's `container.exec(argv).stdout` is one walk: its `exec` answers a process no hop can carry
  return new InvokeHandle(dispatch, { takesTheRest: name === "sandbox" });
}

// The R2 key is the path without its leading slash, so `itx.r2.list()` shows the same objects.

const fileKey = (path: string): string => path.replace(/^\/+/, "");

/** A string is base64, with or without a `data:` prefix, never raw text. A `data:` URL's own content type wins. */
function fileBytes(data: Uint8Array | ArrayBuffer | string): {
  bytes: Uint8Array;
  contentType?: string;
} {
  if (typeof data !== "string")
    return { bytes: data instanceof Uint8Array ? data : new Uint8Array(data) };
  const dataUrl = /^data:([^;,]*)(?:;[^,]*)?,(.*)$/s.exec(data);
  const base64 = dataUrl ? dataUrl[2]! : data;
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, ...(dataUrl?.[1] && { contentType: dataUrl[1] }) };
}

const fileRecord = (object: {
  key: string;
  size: number;
  httpMetadata: { contentType?: string };
}): FileRecord => ({
  path: `/${object.key}`,
  contentType: object.httpMetadata.contentType || "application/octet-stream",
  size: object.size,
});

function fileHandle(itx: FilesItx, path: string): InvokeHandle & FileHandle {
  const key = fileKey(path);
  const verbs: FileHandle = {
    put: async (input) => {
      const { bytes, contentType } = fileBytes(input.data);
      return fileRecord(
        await itx.r2.put(key, bytes, {
          httpMetadata: {
            contentType: input.contentType || contentType || "application/octet-stream",
          },
        }),
      );
    },
    bytes: async () => {
      const object = await itx.r2.get(key);
      if (!object) throw new Error(`files: nothing at "/${key}"`);
      return object.data;
    },
    head: async () => {
      const object = await itx.r2.head(key);
      return object ? fileRecord(object) : null;
    },
    delete: () => itx.r2.delete(key),
    url: (input = {}) => itx.r2.presign({ key, ...input }),
  };
  return new InvokeHandle(async (itxExpressionSteps) => {
    const [step, ...rest] = itxExpressionSteps;
    if (rest.length > 0 || !Array.isArray(step) || !(step[0] in verbs))
      throw new Error(
        `files.get(path): one of put({ contentType, data }) · bytes() · head() · delete() · url({ method?, expiresInSeconds? }), got ${print(itxExpressionSteps)}`,
      );
    const [verb, ...args] = step as [keyof FileHandle, ...unknown[]];
    // wire-fed: an InvokeHandle's steps carry no validation
    return (verbs[verb] as (...verbArgs: unknown[]) => unknown)(...args);
  }) as InvokeHandle & FileHandle;
}

const withR2 = (itx: LibraryItx) => itx as FilesItx;
