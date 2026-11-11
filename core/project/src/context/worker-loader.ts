// `LOADER.get(id, getCode)` runs `getCode` only when no isolate is warm under `id`, and "if anything
// about the content changes, you must use a new ID" (developers.cloudflare.com/dynamic-workers). So a
// source is its modules (keyed by content hash) or an expression that produces them, which must
// name a `cacheKey`: hashing the expression would be the stale-code trap.
import { env, waitUntil } from "cloudflare:workers";
import {
  contentHashOfWorkerModules,
  isWorkerModules,
  sha256Hex,
  type PrepareConfinedWorkerOptions,
  type WorkerModules,
} from "core-itx";
import { normalizedItxExpression } from "iterate/expression";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { failureKind, ONCE_NOW, retryPlatformFailures } from "iterate/platform-retry";
import { z } from "zod";
import PLATFORM_MODULES from "../generated/platform-modules.js";
import {
  enteredThroughPlatform,
  LOADED_WORKER_MODULE,
  readPackage,
  resolveModules,
  type ResolveOptions,
} from "./module-resolution.ts";

// The expiry bounds a caller's key that does not keep "same key ⇒ same code".
const PRODUCED_MODULES_TTL_SECONDS = 24 * 60 * 60;
// Cloudflare's limit for one KV value
const KV_VALUE_MAX_BYTES = 25 * 1024 * 1024;
// Platform modules are named, not kept: the platform's code identity is in the key. `locks` is the
// SHA-256 of every module lock the resolution read. The value is sealed: its payload's SHA-256, a
// newline, then the payload.
const ResolvedMemo = z.object({
  mainModule: z.string(),
  modules: z.record(z.string(), z.string()),
  platformModules: z.array(z.string()),
  compatibilityFlags: z.array(z.string()).nullable(),
  locks: z.record(z.string(), z.string()),
});
type ResolvedWorker = Awaited<ReturnType<typeof resolveModules>>;
type StartedWorker = ReturnType<typeof enteredThroughPlatform>;
type ObtainedModules = {
  files: WorkerModules;
  keep?: (resolved: ResolvedWorker, named: () => Promise<boolean>) => void;
  // A resolved memo of the files expires with them, so it never outlives what it was made from.
  expiresAt: number | undefined;
};
const KeptMetadata = z.object({ expiresAt: z.number() });
const aDayFromNow = () => Math.floor(Date.now() / 1000) + PRODUCED_MODULES_TTL_SECONDS;
type ProducedWorker = {
  worker: StartedWorker;
  modules: "resolved-memo" | "transformed";
  resolveMs: number;
};
// WORKAROUND, LOCAL WORKERD ONLY: local workerd keeps a named isolate whose `getCode` threw for the
// process's life, replaying the failure on every `LOADER.get(id)`; the edge runs `getCode` again.
// A producer that threw marks its id dead; the next attempt runs the producer outside the loader
// and loads under the next generation (`generationId`). One recovery at a time, kept beside the
// `itxEntrypoint` it was started for, so a new incarnation never waits on its predecessor's.
const loaderIdGenerations = new Map<
  string,
  {
    generation: number;
    dead: boolean;
    recovery?: { itxEntrypoint: Fetcher; modules: Promise<ProducedWorker> };
  }
>();

// a Worker may not make random values in global scope
let retiredGenerationSalt: string | undefined;
// The Worker Loader shares an entry by id across the isolates of a machine (workerd#7485), so a
// generation past 0 carries this isolate's salt: a replay loads fresh code, not a sibling's failing
// entry. It grows identities with failures, never with requests.
function generationId(base: string, generation: number): string {
  if (!generation) return base;
  retiredGenerationSalt ||= crypto.randomUUID().slice(0, 8);
  return `${base}#${generation}.${retiredGenerationSalt}`;
}

const packageReadOf = new WeakSet<WorkerModules>();

// KV takes one write per key per second
const keepsInFlight = new Set<string>();

// `nodejs_als` carries a call's cause; `allow_irrevocable_stub_storage` lets loaded code persist its
// `env.ITX` stub.
const SDK_REQUIRED_COMPATIBILITY_FLAGS = ["nodejs_als", "allow_irrevocable_stub_storage"] as const;
// Node compat stays off by default: this compat date would turn v2 on, and it adds ~0.7 ms to every
// cold load. A declaring worker replaces this base with its own list.
const DEFAULT_BASE_COMPATIBILITY_FLAGS = ["no_nodejs_compat", "no_nodejs_compat_v2"] as const;

function applySdkCompatibilityFlags(declared: string[] | undefined, where: string): string[] {
  const base = declared || [...DEFAULT_BASE_COMPATIBILITY_FLAGS];
  for (const required of SDK_REQUIRED_COMPATIBILITY_FLAGS)
    if (base.includes(`no_${required}`))
      throw new Error(
        `${where}: compatibilityFlags must not disable "${required}", which the iterate SDK needs`,
      );
  return [...new Set([...base, ...SDK_REQUIRED_COMPATIBILITY_FLAGS])];
}

// Bump when a change here, in module-resolution.ts, or to sucrase or es-module-lexer, changes what a
// source produces or which files a resolution reads: memos are kept under this format.
const LOADED_CODE_FORMAT = 2;
let platformIdentity: Promise<string> | undefined;
// Never the deploy: a deploy that changes none of these keeps every loaded identity, so no facet
// restarts for it.
const platformCodeIdentity = () =>
  (platformIdentity ||= sha256Hex(
    JSON.stringify([
      LOADED_CODE_FORMAT,
      COMPATIBILITY_DATE,
      SDK_REQUIRED_COMPATIBILITY_FLAGS,
      DEFAULT_BASE_COMPATIBILITY_FLAGS,
      PLATFORM_MODULES.modules,
    ]),
  ));

// THE cacheKey IS A DOLLAR AMOUNT: Cloudflare bills every distinct `LOADER.get` id as a Dynamic Worker
// per day, and a new id is a cold build. Key components must be low-cardinality: never a nonce,
// timestamp, request id, deploy or offset, but for one bounded by failures (`generationId`). The
// deploy needs no place in the key: the Worker Loader keeps no isolate across its parent's deploy.
export async function prepareConfinedWorker(
  opts: PrepareConfinedWorkerOptions,
): Promise<{ loaderId: string; load: () => WorkerStub; retire: () => void }> {
  const { where, source, cacheKey, mainModule } = opts;
  const requireFiles = (files: unknown): WorkerModules => {
    if (!isWorkerModules(files)) throw new Error(`${where}: a source is its files, path → code`);
    return files;
  };
  // tagged, so no cacheKey takes the id a module identity names
  const named = opts.moduleIdentity
    ? `module:${opts.moduleIdentity}`
    : cacheKey
      ? `key:${cacheKey}`
      : undefined;
  let sourceVersion: string;
  let getModules: () => Promise<ObtainedModules> | ObtainedModules;
  let sourceKey: () => Promise<string>;
  let keepCopyOnMemoHit: (() => void) | undefined;
  if (isWorkerModules(source)) {
    const modules = requireFiles(source);
    // refused where it is handed in, not late in a cold load
    if (!packageReadOf.has(modules)) {
      readPackage(modules, where);
      packageReadOf.add(modules);
    }
    sourceVersion = named || `content:${contentHashOfWorkerModules(modules)}`;
    getModules = () => ({ files: modules, expiresAt: aDayFromNow() });
    sourceKey = async () => `content:${await sha256Hex(JSON.stringify(modules))}`;
  } else {
    if (!named)
      throw new Error(
        `${where}: a source EXPRESSION needs a cacheKey (a build id, a commit) — the producer runs only when no isolate is warm under it and no answer of its is kept (a day), so the key must change whenever the code does`,
      );
    sourceVersion = named;
    // A producer's modules are kept in KV under what names the code, so a cold isolate does not wake
    // the producing context. Under a module identity only the files its graph read are kept, and only
    // when the graph this load resolved is it. A caller's key keeps every file: the key is its promise.
    const kept = opts.moduleIdentity ? opts.kept : undefined;
    const keepCopy = (kvKey: string, files: WorkerModules, isNamed: () => Promise<boolean>) => {
      if (!kept) return;
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (await isNamed()) kept.keep(kvKey, files);
      })().catch(moduleCacheFailed(opts, "put"));
    };
    // An answer the producer gave before its build landed must reach the next recovery, not be read
    // back for a day.
    const loadable = (files: unknown): files is WorkerModules => {
      if (!isWorkerModules(files)) return false;
      try {
        readPackage(files, where);
        return true;
      } catch {
        return false;
      }
    };
    const keep = (
      kvKey: string,
      files: WorkerModules,
      named: () => Promise<boolean>,
      expiresAt: number,
    ) =>
      keepInKv(
        opts,
        kvKey,
        async () => ((await named()) ? JSON.stringify(files) : undefined),
        expiresAt,
      );
    const producer = normalizedItxExpression(source);
    let producedKey: Promise<string> | undefined;
    sourceKey = () =>
      (producedKey ||= sha256Hex(
        JSON.stringify(
          opts.moduleIdentity
            ? [LOADED_CODE_FORMAT, named, mainModule]
            : [opts.owner, named, producer],
        ),
      ).then((hash) => `produced-modules-2/${hash}`));
    getModules = async () => {
      const kvKey = await sourceKey();
      const own = kept?.get(kvKey);
      if (loadable(own)) return { files: own, expiresAt: aDayFromNow() };
      const stored = await env.PROJECT_KV.getWithMetadata(kvKey, "json").catch(
        moduleCacheFailed(opts, "get"),
      );
      if (stored && loadable(stored.value)) {
        const files = stored.value;
        return {
          files,
          expiresAt: KeptMetadata.safeParse(stored.metadata).data?.expiresAt,
          keep: () => keepCopy(kvKey, files, async () => true),
        };
      }
      console.info({ event: "worker-loader.produced", name: opts.owner, where, source: named });
      // The producer is a read the cacheKey names, so running it twice is running it once.
      const produced = await retryPlatformFailures(() => opts.invoke(producer), {
        area: "worker-loader",
        schedule: ONCE_NOW,
        idempotent: true,
        kind: failureKind,
        describe: () => ({ name: opts.owner, where }),
      });
      // a copy: what is kept is what the producer answered now, whatever it does with its map after
      const files = {
        ...requireFiles(
          typeof produced === "string"
            ? { "package.json": '{"main":"worker.js"}', "worker.js": produced }
            : produced,
        ),
      };
      const expiresAt = aDayFromNow();
      if (!loadable(files)) return { files, expiresAt };
      return {
        files,
        expiresAt,
        keep: (resolved, isNamed) => {
          const keptFiles = opts.moduleIdentity ? resolved.files : files;
          keep(kvKey, keptFiles, isNamed, expiresAt);
          keepCopy(kvKey, keptFiles, isNamed);
        },
      };
    };
    keepCopyOnMemoHit = () => {
      if (!kept) return;
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const kvKey = await sourceKey();
        if (kept.get(kvKey)) return;
        const stored = await env.PROJECT_KV.get(kvKey, "json");
        if (loadable(stored)) kept.keep(kvKey, stored);
      })().catch(moduleCacheFailed(opts, "get"));
    };
  }
  // A JSON array, never `a:b:c`: an owner or a cacheKey may contain ":", and a joined string would
  // let two owners name one isolate, whose whole world is the host stub baked in at first load.
  const loaderIdBase = JSON.stringify([
    opts.kind,
    await platformCodeIdentity(),
    opts.owner,
    sourceVersion,
    ...(mainModule ? [mainModule] : []),
  ]);
  const state = loaderIdGenerations.get(loaderIdBase) ?? { generation: 0, dead: false };
  let { generation } = state;
  // A failure here, in the recovery below, comes before `load()` opens a new generation, so a failure
  // that persists mints no billed identity per retry. The resolved memo comes first: `getCode` runs
  // on a Durable Object's one thread, and resolving is 170–700 ms of synchronous CPU.
  const produce = async (): Promise<ProducedWorker> => {
    const memoKey = resolvedMemoKey(await sourceKey(), mainModule);
    let started = Date.now();
    const remembered = await readResolvedMemo(opts, await memoKey);
    if (remembered) {
      keepCopyOnMemoHit?.();
      return { worker: remembered, modules: "resolved-memo", resolveMs: Date.now() - started };
    }
    const { files, keep, expiresAt } = await getModules();
    // a resolution that wrote a lock keeps no memo: the next one reads what KV kept
    const locks = new Map<string, string>();
    let wroteLock = false;
    const store = {
      get: async (key: string) => {
        const value = await env.PROJECT_KV.get(key);
        if (value) locks.set(key, value);
        return value;
      },
      put: (key: string, value: string) => {
        wroteLock = true;
        return env.PROJECT_KV.put(key, value);
      },
    };
    started = Date.now();
    const resolved = await resolveModules(files, {
      ...resolveOptions(where, mainModule),
      store,
    });
    const worker = enteredThroughPlatform(resolved, PLATFORM_MODULES);
    const resolveMs = Date.now() - started;
    let namedCheck: Promise<boolean> | undefined;
    const isNamed = () => (namedCheck ||= isTheNamedCode(resolved).catch(() => false));
    keep?.(resolved, isNamed);
    // owned here before the write's turn: the loader has `worker`'s objects
    const snapshot = {
      mainModule: worker.mainModule,
      modules: { ...worker.modules },
      compatibilityFlags: worker.compatibilityFlags ? [...worker.compatibilityFlags] : null,
    };
    if (!wroteLock && expiresAt !== undefined)
      keepInKv(
        opts,
        await memoKey,
        async () => {
          if (!(await isNamed())) return undefined;
          const lockHashes: Record<string, string> = {};
          for (const [key, value] of locks) lockHashes[key] = await sha256Hex(value);
          // a source file under a platform module's name keeps its own text
          const isPlatformCopy = ([name, code]: [string, string]) =>
            Object.hasOwn(PLATFORM_MODULES.modules, name) &&
            PLATFORM_MODULES.modules[name] === code;
          const entries = Object.entries(snapshot.modules);
          const payload = JSON.stringify({
            mainModule: snapshot.mainModule,
            modules: Object.fromEntries(entries.filter((entry) => !isPlatformCopy(entry))),
            platformModules: entries.filter(isPlatformCopy).map(([name]) => name),
            compatibilityFlags: snapshot.compatibilityFlags,
            locks: lockHashes,
          } satisfies z.infer<typeof ResolvedMemo>);
          return `${await sha256Hex(payload)}\n${payload}`;
        },
        expiresAt,
      );
    return { worker, modules: "transformed", resolveMs };
  };
  const isTheNamedCode = async (resolved: ResolvedWorker): Promise<boolean> => {
    if (!opts.moduleIdentity || isWorkerModules(source)) return true;
    const identity = await identityOfResolved(resolved);
    if (identity === opts.moduleIdentity) return true;
    console.warn({
      event: "worker-loader.module-identity-mismatch",
      name: opts.owner,
      where,
      mainModule,
      expected: opts.moduleIdentity,
      produced: identity,
    });
    return false;
  };
  let workerForCode = produce;
  if (state.dead) {
    let recovery =
      state.recovery?.itxEntrypoint === opts.itxEntrypoint ? state.recovery.modules : undefined;
    if (!recovery) {
      const deadGeneration = generation;
      const started = Promise.resolve().then(produce);
      recovery = started;
      loaderIdGenerations.set(loaderIdBase, {
        generation,
        dead: true,
        recovery: { itxEntrypoint: opts.itxEntrypoint, modules: started },
      });
      const settle = (next: { generation: number; dead: boolean }) => {
        if (loaderIdGenerations.get(loaderIdBase)?.recovery?.modules === started)
          loaderIdGenerations.set(loaderIdBase, next);
      };
      started.then(
        () => settle({ generation: deadGeneration + 1, dead: false }),
        () => settle({ generation: deadGeneration, dead: true }), // the next caller tries again
      );
    }
    const resolved = await recovery;
    generation += 1;
    workerForCode = async () => resolved;
  }
  const loaderId = generationId(loaderIdBase, generation);
  const load = () =>
    env.LOADER.get(loaderId, async () => {
      let resolved: ProducedWorker;
      try {
        resolved = await workerForCode();
      } catch (error) {
        loaderIdGenerations.set(loaderIdBase, { generation, dead: true });
        throw error;
      }
      // `resolveMs` is by the Workers clock, which moves with I/O
      console.info({
        event: "worker-loader.built",
        name: opts.owner,
        where,
        loaderId,
        modules: resolved.modules,
        resolveMs: resolved.resolveMs,
      });
      const { worker } = resolved;
      return {
        // No CPU limit: trusted clients. The platform bounds a DO to 10 distinct dynamic workers
        // with in-flight requests.
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: applySdkCompatibilityFlags(worker.compatibilityFlags, opts.where),
        // the default 10,000 ends a voice call, one append per speaker frame, after ~17 minutes
        limits: { subRequests: 1_000_000 },
        mainModule: worker.mainModule,
        modules: worker.modules,
        env: { ITX: opts.itxEntrypoint },
        globalOutbound: opts.itxEntrypoint,
      };
    });
  return {
    loaderId,
    load,
    retire: () => {
      // a late retire never sends a recovered n+1 back to the dead n
      const current = loaderIdGenerations.get(loaderIdBase) ?? { generation: 0, dead: false };
      if (current.generation === generation && !current.dead)
        loaderIdGenerations.set(loaderIdBase, { generation, dead: true });
    },
  };
}

const moduleCacheFailed =
  (opts: Pick<PrepareConfinedWorkerOptions, "owner" | "where">, action: "get" | "put") =>
  (error: unknown) => {
    console.warn({
      event: "worker-loader.platform-failure-module-cache",
      action,
      name: opts.owner,
      where: opts.where,
      message: error instanceof Error ? error.message : String(error),
    });
  };

// Not awaited by the load: a whole tree's write lasts as long as a cold build. `expiresAt` is also
// written as the metadata, so a memo made from it can expire with it.
function keepInKv(
  opts: Pick<PrepareConfinedWorkerOptions, "owner" | "where">,
  kvKey: string,
  make: () => Promise<string | undefined>,
  expiresAt: number,
): void {
  // KV refuses an expiry under a minute away: so little of the day left is not worth a write
  if (expiresAt < Date.now() / 1000 + 60 || keepsInFlight.has(kvKey)) return;
  keepsInFlight.add(kvKey);
  const kept = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const value = await make();
    if (!value) return;
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > KV_VALUE_MAX_BYTES) {
      console.info({
        event: "worker-loader.module-cache-too-large",
        name: opts.owner,
        where: opts.where,
        key: kvKey.slice(0, kvKey.indexOf("/")),
        bytes,
      });
      return;
    }
    // the work above may have taken the expiry under KV's minute
    if (expiresAt < Date.now() / 1000 + 60) return;
    await env.PROJECT_KV.put(kvKey, value, {
      expiration: expiresAt,
      metadata: { expiresAt } satisfies z.infer<typeof KeptMetadata>,
    });
  })()
    .catch((error: unknown) => {
      // another isolate kept it within the second
      if (/KV PUT failed: 429\b/.test(error instanceof Error ? error.message : String(error)))
        console.info({
          event: "worker-loader.module-cache-kept-elsewhere",
          name: opts.owner,
          where: opts.where,
        });
      else moduleCacheFailed(opts, "put")(error);
    })
    .finally(() => keepsInFlight.delete(kvKey));
  // a throw from `waitUntil` (no invocation to hold) must not fail the load
  try {
    waitUntil(kept);
  } catch {
    void kept;
  }
}

// a change to `ResolvedMemo` is a new prefix
async function resolvedMemoKey(source: string, mainModule: string | undefined): Promise<string> {
  // null: the esm origin's place, kept so the key is as stored
  return `resolved-modules-2/${await sha256Hex(
    JSON.stringify([await platformCodeIdentity(), null, source, mainModule || null]),
  )}`;
}

async function readResolvedMemo(
  opts: Pick<PrepareConfinedWorkerOptions, "owner" | "where">,
  kvKey: string,
): Promise<StartedWorker | undefined> {
  const text = await env.PROJECT_KV.get(kvKey).catch(moduleCacheFailed(opts, "get"));
  if (typeof text !== "string") return undefined;
  const rejected = (reason: "integrity" | "shape" | "lock") => {
    console.info({
      event: "worker-loader.resolved-memo-rejected",
      name: opts.owner,
      where: opts.where,
      reason,
    });
    return undefined;
  };
  const seal = text.indexOf("\n");
  const payload = text.slice(seal + 1);
  if (seal !== 64 || (await sha256Hex(payload)) !== text.slice(0, seal))
    return rejected("integrity");
  let stored: unknown;
  try {
    stored = JSON.parse(payload);
  } catch {
    return rejected("shape");
  }
  const memo = ResolvedMemo.safeParse(stored);
  if (
    !memo.success ||
    !Object.hasOwn(memo.data.modules, memo.data.mainModule) ||
    !memo.data.platformModules.every((name) => Object.hasOwn(PLATFORM_MODULES.modules, name)) ||
    !(
      memo.data.platformModules.includes(LOADED_WORKER_MODULE) ||
      Object.hasOwn(memo.data.modules, LOADED_WORKER_MODULE)
    )
  )
    return rejected("shape");
  const { mainModule, modules, platformModules, compatibilityFlags, locks } = memo.data;
  const current = await Promise.all(
    Object.entries(locks).map(async ([key, hash]) => {
      const value = await env.PROJECT_KV.get(key).catch(moduleCacheFailed(opts, "get"));
      return typeof value === "string" && (await sha256Hex(value)) === hash;
    }),
  );
  if (!current.every(Boolean)) return rejected("lock");
  for (const name of platformModules) modules[name] = PLATFORM_MODULES.modules[name]!;
  return { mainModule, modules, compatibilityFlags: compatibilityFlags || undefined };
}

function resolveOptions(where: string, mainModule: string | undefined): ResolveOptions {
  return {
    platform: PLATFORM_MODULES,
    store: env.PROJECT_KV,
    // workerd refuses `fetch` called as another object's method ("Illegal invocation")
    fetch: (input, init) => fetch(input, init),
    where,
    mainModule,
  };
}

// What the loader loads with `mainModule` as the main module, less this build's platform packages:
// a facet whose class lives there keeps running across a commit that changes only the rest.
export async function moduleIdentityOf(
  files: WorkerModules,
  mainModule: string,
  where: string,
): Promise<string> {
  return identityOfResolved(await resolveModules(files, resolveOptions(where, mainModule)));
}

function identityOfResolved(resolved: ResolvedWorker): Promise<string> {
  const graph = Object.entries(resolved.modules)
    .filter(([name]) => !Object.hasOwn(PLATFORM_MODULES.modules, name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(
    JSON.stringify([resolved.mainModule, graph, resolved.compatibilityFlags || null]),
  );
}
