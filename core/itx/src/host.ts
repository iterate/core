// The kernel reads `CONTEXTS` and `CF_VERSION_METADATA` from the host Worker's env by name. One
// Worker has one host: `defineItxHost` runs once, at module scope, before it serves anything.
import { env } from "cloudflare:workers";
import type { ActRule, GateAnswer } from "iterate/acts";
import type { StreamEventInput } from "iterate/stream/processor";
import { codedError } from "iterate/lib";
import { reachableContext } from "./context-stub.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import type { BuildBuiltInsDeps, BuiltInScope } from "./context/built-ins.ts";
import type { PrepareConfinedWorkerOptions } from "./context/worker-loader.ts";
import type { IterateContextDurableObject } from "./iterate-context-durable-object.ts";
import type { ReachableContext } from "./stream/stream.ts";

export interface ItxHost {
  mindSlug?: string;
  /** Appended in the same batch as the birth and first wake records. */
  birthEvents?(path: string): readonly StreamEventInput[];
  /** Asked at every wake of a context, its birth too. Each has an idempotency key and lands once
   *  per context: what a host starts to want later reaches the contexts that exist
   *  (./stream/wake-events.ts). */
  wakeEvents?(path: string): readonly StreamEventInput[];
  /** Without it, a run's writes are attributed to nobody. */
  signingSecret?(): Promise<string>;
  firstPartyFacets: Record<string, FirstPartyFacet>;
  /** A name of the kernel's own roots is refused. */
  roots?: Record<string, ItxHostRoot>;
  /** A host with a loader exports `ItxEntrypoint`. */
  loader?: ItxLoader;
  metrics?: Pick<AnalyticsEngineDataset, "writeDataPoint">;
  /** Every outbound `itx.fetch`, after the kernel stripped its headers and stamped the cause. */
  egress?(request: Request, from: { path: string }): Promise<Response>;
  /** THE GATE FOR ACTS (iterate/acts): with it, a call of a verb that an approval rule names
   *  waits until a member approves it (./context/held-verbs.ts). `verbRules` is asked on every
   *  call a context resolves by its own table, so the host keeps it cheap. */
  acts?: {
    verbRules(): Promise<readonly ActRule[]>;
    ask(input: { text: string; from?: string; wait?: boolean }): Promise<GateAnswer>;
  };
}

export type FirstPartyFacet = {
  className: string;
  publicMethods: readonly string[];
  placement?: { where: string; mayBeHostedOn(path: string): boolean };
  /** The row's filter when its enable names none; without it, every durable event. */
  consumes?: readonly string[];
};

export type ItxHostRoot = {
  description: string;
  /** Undefined where it cannot be built (no `scope.connections`): the call goes to its context. */
  build(scope: ItxHostRootContext): unknown;
  /** Otherwise implicit at `/` alone. */
  everyContext?: boolean;
};

export type ItxHostRootContext = Pick<
  BuildBuiltInsDeps,
  "path" | "caller" | "context" | "egress" | "invokeAs" | "itx" | "connections"
>;

export type LibraryItx = Pick<BuiltInScope, "fetch" | "builtins" | "cd">;

export interface ItxLoader {
  prepareConfinedWorker(options: PrepareConfinedWorkerOptions): Promise<{
    loaderId: string;
    load(): WorkerStub;
    retire(): void;
  }>;
}

let definedHost: ItxHost | undefined;

// Two hosts in one Worker would be two kernels over one namespace.
export function defineItxHost(host: ItxHost): void {
  if (definedHost) throw new Error("defineItxHost: this Worker already defined its host");
  definedHost = host;
}

export function itxHost(): ItxHost {
  if (!definedHost)
    throw new Error(
      "core-itx: no host defined — call defineItxHost({ firstPartyFacets }) at the Worker's module scope",
    );
  return definedHost;
}

type ItxEnv = {
  CONTEXTS: DurableObjectNamespace<IterateContextDurableObject>;
  CF_VERSION_METADATA: WorkerVersionMetadata;
};

export const contexts = () => (env as unknown as ItxEnv).CONTEXTS;
export const deployId = () => (env as unknown as ItxEnv).CF_VERSION_METADATA.id;

export function itxLoader(needs: string): ItxLoader {
  const { loader } = itxHost();
  if (!loader)
    throw codedError("UNAVAILABLE", `${needs}: this Worker loads no code (its host has no loader)`);
  return loader;
}

const itxEntrypointsByCtx = new WeakMap<object, Map<string, Fetcher>>();

// Minted once per `ctx` and context: the loader keeps a dead id's recovery per stub
// (core/mind-worker worker-loader.ts `loaderIdGenerations`), so every load of `ctx` shares one.
export function itxEntrypointFor(
  ctx: DurableObjectState | ExecutionContext,
  iterateContextName: string,
): Fetcher {
  const mint = (
    ctx.exports as { ItxEntrypoint?: (options: { props: object }) => Fetcher } | undefined
  )?.ItxEntrypoint;
  if (!mint)
    throw codedError(
      "UNAVAILABLE",
      "loaded code: this Worker mints no env.ITX for it (it exports no ItxEntrypoint)",
    );
  const minted = itxEntrypointsByCtx.get(ctx) ?? new Map<string, Fetcher>();
  itxEntrypointsByCtx.set(ctx, minted);
  const known = minted.get(iterateContextName);
  if (known) return known;
  const stub = mint({ props: { iterateContextName } });
  minted.set(iterateContextName, stub);
  return stub;
}

export function contextAt(path: string): ReachableContext {
  const address = DurableObjectNameCodec.address(path);
  return reachableContext(contexts(), address, "host", { readsRunSettlements: true });
}
