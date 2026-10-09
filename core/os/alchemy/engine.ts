// alchemy/engine.ts — ALCHEMY'S ENGINE INSIDE A DURABLE OBJECT, and nothing of iterate. Alchemy's own
// deploy() and destroy() load Node services, a file logger and profile stores that workerd cannot,
// and Cloudflare.providers() wires Docker and profile credentials. So a host composes the engine:
// `runStack` over its `Stack(...)`, `hostLayer`, `cloudflareProviders` over one API token,
// `stageRelease`, and ./state-sql.ts for the state. It imports only Alchemy, Effect and
// @effect/platform-node (.oxlintrc.json); a Worker that loads it needs ../vite.config.ts's shims.
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { apply } from "alchemy/Apply";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import * as Cloudflare from "alchemy/Cloudflare";
import { Docker } from "alchemy/Docker";
import * as Plan from "alchemy/Plan";
import { type ApplyStatus, Progress, type ProgressEvent } from "alchemy/Report";
import type { CompiledStack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { unzipFiles } from "alchemy/Util/zip";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

/** What one run reports, in order: the plan's rows once; each resource's status each time apply
 *  changes it (Alchemy's ApplyStatus, the transitions as well as the end); the stack's output last,
 *  after a deploy or a destroy. */
export type RunEvent =
  | {
      readonly _tag: "Planned";
      readonly resources: ReadonlyArray<{ fqn: string; type: string; action: string }>;
    }
  | {
      readonly _tag: "Applied";
      readonly fqn: string;
      readonly type: string;
      readonly status: ApplyStatus;
    }
  | { readonly _tag: "Output"; readonly output: unknown };

/** ONE RUN of `stack`, as it happens: `plan` plans; `deploy` plans and applies; `destroy` plans the
 *  deletion from the state alone (alchemy's Plan.ts `destroy`) and applies it. The Stream ends with
 *  the run and fails with it. */
export const runStack = <E, R>(
  kind: "plan" | "deploy" | "destroy",
  stack: Effect.Effect<CompiledStack, E, R>,
) =>
  Stream.callback<RunEvent, unknown, R>((queue) => {
    const offer = (event: RunEvent) => Effect.asVoid(Queue.offer(queue, event));
    const report = (event: ProgressEvent) =>
      event._tag === "apply.resource.status"
        ? offer({ _tag: "Applied", fqn: event.fqn, type: event.type, status: event.status })
        : Effect.void;
    return Queue.into(queue)(
      Effect.gen(function* () {
        const compiled = yield* stack;
        yield* Effect.gen(function* () {
          const plan = yield* kind === "destroy" ? Plan.destroy(compiled) : Plan.make(compiled);
          const { resources } = Plan.describePlan(plan);
          yield* offer({
            _tag: "Planned",
            resources: resources.map(({ fqn, resourceType, action }) => ({
              fqn,
              type: resourceType,
              action,
            })),
          });
          if (kind === "plan") return;
          const output = yield* apply(plan, { session: { emit: report, done: () => Effect.void } });
          yield* offer({ _tag: "Output", output });
        }).pipe(Effect.provideContext(compiled.services));
      }).pipe(Effect.provideService(Progress, report)),
    );
  });

/** THE HOST: what a run reads besides its stack's services. Its secrets resolve from `vars` ALONE,
 *  never process.env, where workerd puts the hosting Worker's own bindings and secrets, which a
 *  fallback would deploy into the target. Every request of Alchemy's providers goes through `fetch`. */
export const hostLayer = (
  stage: string,
  vars: Record<string, string>,
  fetch: typeof globalThis.fetch = globalThis.fetch,
) =>
  Layer.mergeAll(
    Layer.succeed(Stage)(stage),
    Layer.succeed(AlchemyContext)({ dotAlchemy: "/tmp/.alchemy", dev: false, adopt: false }),
    Layer.sync(ArtifactStore)(createArtifactStore),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: vars })),
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetch))),
    Path.layer,
    workerdFileSystem,
  );

/** THE CREDENTIALS: the providers of the resources ./stack.ts declares, over one run's API token.
 *  Cloudflare.Credentials is distilled's own service, which alchemy/Cloudflare exports. */
export const cloudflareProviders = (apiToken: string, accountId: string) =>
  Layer.mergeAll(
    Cloudflare.D1.DatabaseProvider(),
    Cloudflare.KV.NamespaceProvider(),
    Cloudflare.R2.BucketProvider(),
    Cloudflare.Workers.WorkerProvider(),
    Cloudflare.Containers.ContainerProvider(),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        noDocker,
        Layer.succeed(Cloudflare.Credentials)(
          Effect.succeed({
            type: "apiToken" as const,
            apiToken: Redacted.make(apiToken),
            apiBaseUrl: "https://api.cloudflare.com/client/v4",
          }),
        ),
        Layer.succeed(Cloudflare.CloudflareEnvironment)(
          Effect.succeed({
            type: "apiToken" as const,
            apiToken: Redacted.make(apiToken),
            accountId,
            source: { type: "env" as const },
          }),
        ),
      ),
    ),
    Layer.orDie,
  );

/** A release `stageRelease` will not stage, a refusal: the same release fails the same way. */
export class ReleaseRefused extends Data.TaggedError("ReleaseRefused")<{
  readonly message: string;
}> {}

/** A RELEASE STAGED: `archive`'s SHA-256 checked, its entries checked to land inside `directory`,
 *  then unzipped there; the scope removes it. A host names the same directory on every run of one
 *  stack: Alchemy's state keeps a D1's `migrations` path, and a plan that sees another updates it. */
export const stageRelease = Effect.fn("alchemy.stageRelease")(function* (
  archive: Uint8Array,
  sha256: string,
  directory: string,
) {
  const digest = Hex.encode(
    new Uint8Array(yield* Effect.promise(() => crypto.subtle.digest("SHA-256", archive))),
  );
  if (digest !== sha256)
    return yield* new ReleaseRefused({
      message: `the release's SHA-256 is ${digest}, not ${sha256}`,
    });
  const entries = yield* unzipFiles(archive).pipe(
    Effect.mapError(
      (error) =>
        new ReleaseRefused({ message: `the release is not a zip archive: ${String(error.cause)}` }),
    ),
  );
  // A directory entry (`bundle/`, which `zip -r` and a Finder zip write) is no file: the files
  // make their directories.
  const files = Object.fromEntries(Object.entries(entries).filter(([path]) => !path.endsWith("/")));
  const outside = Object.keys(files).filter((path) =>
    path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
  );
  if (outside.length > 0)
    return yield* new ReleaseRefused({
      message: `the release holds ${outside.map((path) => JSON.stringify(path)).join(", ")}, outside its directory`,
    });
  const fs = yield* FileSystem.FileSystem;
  const remove = fs.remove(directory, { recursive: true });
  // `exists` first: workerd's rm refuses a missing path, `force` or not
  const clear = Effect.flatMap(fs.exists(directory), (found) => (found ? remove : Effect.void));
  // as @effect/platform-node's makeTempDirectoryScoped removes its own directory
  yield* Effect.acquireRelease(
    clear.pipe(Effect.andThen(fs.makeDirectory(directory, { recursive: true }))),
    () => Effect.orDie(remove),
  );
  let bytes = 0;
  for (const [path, content] of Object.entries(files)) {
    // an entry at the top has no directory of its own to make
    const parent = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
    yield* fs.makeDirectory(`${directory}/${parent}`, { recursive: true });
    yield* fs.writeFile(`${directory}/${path}`, content);
    bytes += content.byteLength;
  }
  return { directory, files: Object.keys(files).length, bytes };
});

/** The Docker service the Container provider takes, with no Docker behind it: a Worker cannot spawn
 *  the CLI, and the provider calls it only for an application with an image of its own, which the
 *  sandboxes' lacks (./stack.ts). A member that is called dies, naming itself. */
const noDocker = Layer.succeed(Docker)(
  new Proxy(
    {},
    {
      get: (_target, member) =>
        typeof member === "symbol" || member === "then"
          ? undefined
          : () => Effect.die(new Error(`Docker.${member} is not available in workerd`)),
    },
  ) as Docker["Service"],
);

/** THE FILE SYSTEM: NodeFileSystem over workerd's node:fs, whose recursive readdir answers paths
 *  relative to "/" (test/vitest/os-workers/workerd-readdir.test.ts), so a recursive read walks one
 *  directory at a time. Once that pin goes red, this is NodeFileSystem.layer. */
const workerdFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const walk = (root: string, below: string): Effect.Effect<Array<string>, PlatformError> =>
      fs.readDirectory(below ? `${root}/${below}` : root).pipe(
        Effect.flatMap((names) =>
          Effect.forEach(names, (name) => {
            const entry = below ? `${below}/${name}` : name;
            return fs
              .stat(`${root}/${entry}`)
              .pipe(
                Effect.flatMap((info) =>
                  info.type === "Directory"
                    ? Effect.map(walk(root, entry), (deeper) => [entry, ...deeper])
                    : Effect.succeed([entry]),
                ),
              );
          }),
        ),
        Effect.map((entries) => entries.flat()),
      );
    return FileSystem.FileSystem.of({
      ...fs,
      readDirectory: (path, options) =>
        options?.recursive ? walk(path, "") : fs.readDirectory(path, options),
    });
  }),
).pipe(Layer.provide(NodeFileSystem.layer));
