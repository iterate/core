// worker-loader.ts — THE loader: `prepareConfinedWorker` turns a SOURCE into its loaded IDENTITY
// (the cache key) and a `load` thunk that mints the confined isolate under it through
// Cloudflare's `env.LOADER`, stopping at the `WorkerStub`. The CALLER then chooses the host — and
// WHEN to load: `load().getEntrypoint(name?)` at once for a stateless `WorkerEntrypoint`
// (`itx.workers.get`), or `load().getDurableObjectClass(name)` only when a durable facet of the
// context STARTS (`itx.facets.get(name, spec)`).
//
// THE CACHE KEY, Cloudflare's own contract (developers.cloudflare.com/dynamic-workers/api-reference):
// `LOADER.get(id, getCode)` runs `getCode` only when no isolate is warm under `id` — "although it is
// unusual for it to be called more than once", it MAY be — and "if anything about the content
// changes, you must use a new ID". So a source is EITHER its modules, literally (the key is then
// their content hash — the same content can never mean different code, its npm dependencies
// included: each resolves once per version as written, and a pkg.pr.new branch, which would load
// another build under the same key, is refused, module-resolution.ts), OR an itx EXPRESSION that
// PRODUCES the modules, in which case the caller MUST name the `cacheKey` (a build id, a commit): the
// producer runs inside `getCode`, i.e. only on a cold isolate, and the caller owns "same key ⇒ same
// code". A producer without a key is refused: hashing the expression would be the stale-code trap.
// A producer's answer is kept in ITX_KV for a day, so a cold isolate does not wake what produces it.
//
// A loaded worker's `env.ITX` is a Workers-RPC service binding to the `ItxEntrypoint`; `env.ITX.get()`
// is the genuine itx scope, a real RpcTarget, so mid-chain handles and callbacks pipeline natively —
// no client-side wrapper. Loaded code reaches it with `using itx = this.getItx()`, which releases
// the scope and every call made through it (lint: iterate/no-raw-itx-get). A loaded SOURCE EXPORTS its own host object (a `WorkerEntrypoint` or a
// `DurableObject` class), and no bare-lambda entry point: the code the author wrote IS what runs, and
// it always enters through an EXPORTED entrypoint. The one module the platform adds is evaluated
// first (module-resolution.ts `enteredThroughPlatform`): it carries the cause on `fetch` and gives
// every `WorkerEntrypoint` `callWithCause` and `getItx` (iterate src/sdk/loaded-worker.ts).

import { waitUntil } from "cloudflare:workers";
import { codedError, errorCode } from "iterate/lib";
import { normalizedItxExpression, type ItxExpression } from "iterate/expression";
import type { FacetSpec, WorkerSource } from "iterate/api";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { failureKind, ONCE_NOW, retryPlatformFailures } from "iterate/platform-retry";
import { z } from "zod";
import PLATFORM_MODULES from "../generated/platform-modules.js";
import { sha256Hex } from "../caller.ts";
import { iterateConfigOf, type IterateConfigEnv } from "../iterate-config.ts";
import { DurableObjectNameCodec } from "./paths.ts";
import { WorkerManifest } from "./worker-manifest.ts";
import { SOURCE_MAX_CHARS } from "./itx-expression-rewriting.ts";
import {
  enteredThroughPlatform,
  LOADED_WORKER_MODULE,
  readPackage,
  resolveModules,
  type ResolveOptions,
} from "./module-resolution.ts";

/** A worker's FILES as authored, path → code (module-resolution.ts `readPackage` finds the entry and
 *  resolves the rest into what the loader takes). */
export type WorkerModules = Record<string, string>;
/** How long a producer's modules stay in `ITX_KV`. Their key names the code (a published module's
 *  identity) or the producer's whole input (its owner, key and expression), so what goes stale is
 *  only a caller's key that does not keep "same key ⇒ same code"; the expiry bounds that, and lets
 *  a deleted project's entries go. */
const PRODUCED_MODULES_TTL_SECONDS = 24 * 60 * 60;
/** The most one KV value may be (Cloudflare's limit). A repo's whole tree can pass it while the
 *  files its entry's graph reads do not, so a value over it is simply not kept. */
const KV_VALUE_MAX_BYTES = 25 * 1024 * 1024;
/** A RESOLVED MEMO in `ITX_KV`: what `resolveModules` and `enteredThroughPlatform` made of a source,
 *  so a cold load reads it and runs no transform on its caller's thread (`prepareConfinedWorker`).
 *  The platform's own modules are named, not kept: this build has them (`PLATFORM_MODULES`), and
 *  the platform's code identity is in the key. `locks` is the SHA-256 of every module lock the
 *  resolution read: a lock that is no longer the one it read makes the memo a miss. The value is
 *  SEALED: the SHA-256 of the payload, a newline, then the payload, so a memo cut short or changed
 *  after its write is a miss (`readResolvedMemo`). */
const ResolvedMemo = z.object({
  mainModule: z.string(),
  modules: z.record(z.string(), z.string()),
  platformModules: z.array(z.string()),
  compatibilityFlags: z.array(z.string()).nullable(),
  locks: z.record(z.string(), z.string()),
});
/** Refuse a spec whose LITERAL source is over the ceiling (itx-expression-rewriting.ts
 *  `SOURCE_MAX_CHARS`) — the startup memo is one kv cell in the DO (re-read on every post-eviction
 *  wake) and the hosting event one log row under the 8 MiB event ceiling, so an oversize source
 *  fails where it is handed in, coded, not late at materialization; a producer EXPRESSION is small by
 *  nature and is not measured. The one check both entry points (`itx.processors.enable`, the DO's
 *  `itx.facets.get`) make, so the refusal is atomic: nothing appended, no memo. */
export function assertFacetSourceWithinCeiling(spec: FacetSpec, where: string): void {
  if (typeof spec.source === "string" || Array.isArray(spec.source)) return; // a producer expression
  const chars = JSON.stringify(spec.source).length;
  if (chars > SOURCE_MAX_CHARS)
    throw codedError(
      "FACET_SOURCE_TOO_LARGE",
      `${where}: the facet's source is ${chars} chars, over the ${SOURCE_MAX_CHARS}-char ceiling — build it smaller, or load it from a producer expression with a cacheKey`,
    );
}

export const isWorkerModules = (source: unknown): source is WorkerModules =>
  // oxlint-disable-next-line iterate/simple-truthiness-check -- `source` is untrusted `unknown`; the null check is the standard non-null-object runtime guard and keeps this a boolean type predicate
  typeof source === "object" && source !== null && !Array.isArray(source);

/** A `workers.get` spec as a rule names a worker, with its manifest when the platform published it
 *  (worker-manifest.ts): anyone may write such a rule, so its shape is checked where a name is read. */
const NamedWorkerSpec = z.object({
  // the loader checks the files, or the expression, as it loads them
  source: z.custom<WorkerSource>(
    (value) => isWorkerModules(value) || typeof value === "string" || Array.isArray(value),
    "a worker's source is its files or an itx expression that produces them",
  ),
  cacheKey: z.string().optional(),
  // read only from a rule the platform wrote (`vouched`)
  manifest: z.unknown().optional(),
});

/** A worker's NAME resolved (the resolver's `namedWorker`): the `workers.get` spec of the rule it
 *  names, whether the platform wrote that rule (`vouched`), and the dispatch its producer runs
 *  through — with the authority of the context whose rule it is. */
export type NamedWorker = {
  spec: unknown;
  vouched: boolean;
  invoke: (call: ItxExpression) => Promise<unknown>;
};

/** WHAT A WORKER'S NAME LOADS for its entry `mainModule` — a source expression with no cacheKey
 *  (iterate/api `FacetSpec`, `workers.get`), resolved to the spec of the rule it names (the
 *  resolver's `namedWorker`): that spec's source under its cacheKey, and — only when the platform
 *  wrote the rule (`vouched`: its publication) — under `mainModule`'s identity in its manifest, with
 *  the manifest's generation. A publication may have dropped the module, or the Durable Object class
 *  a facet names (`className`): refused, naming it. A manifest anyone else wrote is ignored: its
 *  worker loads under its own cacheKey or content, as any source does. */
export function namedWorkerLoad(
  named: { spec: unknown; vouched: boolean },
  mainModule: string | undefined,
  where: string,
  className?: string,
): { source: WorkerSource; cacheKey?: string; moduleIdentity?: string; generation?: number } {
  // Pure in its inputs, and a facet's push asks it on every call with the spec the named worker's
  // resolution answered (the context's `#namedWorker` keeps that object while it lasts): the
  // manifest is parsed once per spec.
  const memoKey = `${named.vouched}\0${mainModule || ""}\0${className || ""}`;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- a WeakMap key must be an object, and the spec is data a rule carried: a primitive one is parsed, never remembered
  const spec = named.spec && typeof named.spec === "object" ? named.spec : undefined;
  const memo = spec && namedWorkerLoads.get(spec);
  const known = memo && memo.get(memoKey);
  if (known) return known;
  const loaded = parseNamedWorkerLoad(named, mainModule, where, className);
  if (spec)
    namedWorkerLoads.set(
      spec,
      (memo || new Map<string, ReturnType<typeof parseNamedWorkerLoad>>()).set(memoKey, loaded),
    );
  return loaded;
}

/** `namedWorkerLoad`'s answers, by the spec object they were parsed from. */
const namedWorkerLoads = new WeakMap<
  object,
  Map<string, ReturnType<typeof parseNamedWorkerLoad>>
>();

function parseNamedWorkerLoad(
  named: { spec: unknown; vouched: boolean },
  mainModule: string | undefined,
  where: string,
  className?: string,
): { source: WorkerSource; cacheKey?: string; moduleIdentity?: string; generation?: number } {
  const { source, cacheKey, manifest: given } = NamedWorkerSpec.parse(named.spec);
  const manifest = named.vouched && given !== undefined ? WorkerManifest.parse(given) : undefined;
  if (!manifest || !mainModule) return { source, cacheKey, generation: manifest?.generation };
  const published = manifest.modules[mainModule];
  if (!published)
    throw new Error(
      `${where}: the worker its source names publishes no module ${JSON.stringify(mainModule)}`,
    );
  if (className && !published.classes.includes(className))
    throw new Error(
      `${where}: the worker its source names publishes no Durable Object class ${JSON.stringify(className)} in ${JSON.stringify(mainModule)}`,
    );
  return { source, cacheKey, moduleIdentity: published.identity, generation: manifest.generation };
}

/** WORKAROUND — workerd keeps a named isolate whose startup FAILED (a `getCode` that threw) in its
 *  isolate map for the process's life, so every later `LOADER.get(id)` replays the failure: server.c++
 *  `WorkerStubImpl` never gets a `service`, and only an abort removes the map entry (still so on
 *  upstream main, 2026-09-03; the fix belongs there). Until a workerd release carries it: a producer
 *  that threw marks its loader id DEAD; the next attempt runs the producer OUTSIDE the loader (a
 *  failure there mints nothing) and loads the modules LITERALLY under the next GENERATION of the id
 *  (`generationId`). One extra identity per dead→recovered transition, never per attempt.
 *  Memory-only: a platform-isolate reset costs one replayed failure. Code that fails to START is outside this (same
 *  key ⇒ same code — the author's bug) and is replayed until upstream lands.
 *
 *  ONE RECOVERY AT A TIME: every caller that finds the id dead while a recovery runs waits on that
 *  one (`recovery`), as the loader has every caller of a cold id wait on one `getCode`, so a burst of
 *  callers runs one producer against the repo facet, not one each. The recovery is kept beside the `itxEntrypoint` stub it was started for, which a context mints once
 *  per incarnation: a new incarnation never waits on a promise its dead predecessor left behind. */
/** A source resolved into what the loader takes, and the files the resolution read
 *  (module-resolution.ts). */
type ResolvedWorker = Awaited<ReturnType<typeof resolveModules>>;
/** A resolved source as the loader starts it (module-resolution.ts `enteredThroughPlatform`). */
type StartedWorker = ReturnType<typeof enteredThroughPlatform>;
/** A source's files as `prepareConfinedWorker` obtained them, and for a producer's fresh answer how
 *  to keep it once it resolved (`produce`), when the resolution is the code its key names. */
type ObtainedModules = {
  files: WorkerModules;
  keep?: (resolved: ResolvedWorker, named: () => Promise<boolean>) => void;
  /** When what is kept of these files expires, in seconds since the epoch: a new day for files
   *  fresh from their source, the producer memo's own expiry for files read back from it (its
   *  `metadata`), nothing when that memo predates it. A resolved memo of the files expires with
   *  them, so it never outlives what it was made from (`produce`). */
  expiresAt: number | undefined;
};
/** A memo's expiry as its write carries it in KV `metadata` (`keepInKv`). */
const KeptMetadata = z.object({ expiresAt: z.number() });
/** When what is kept now expires: a day from now, in seconds since the epoch. */
const aDayFromNow = () => Math.floor(Date.now() / 1000) + PRODUCED_MODULES_TTL_SECONDS;
/** A started worker and how this load came by it: read whole from the resolved memo, or resolved
 *  and transformed here; `resolveMs` is how long that took (the `worker-loader.built` line). */
type ProducedWorker = {
  worker: StartedWorker;
  modules: "resolved-memo" | "transformed";
  resolveMs: number;
};
const loaderIdGenerations = new Map<
  string,
  {
    generation: number;
    dead: boolean;
    recovery?: { itxEntrypoint: Fetcher; modules: Promise<ProducedWorker> };
  }
>();

/** This isolate's salt on a generation past 0 (`generationId`), minted on first use: a Worker may
 *  not make random values in global scope. */
let retiredGenerationSalt: string | undefined;
/** THE LOADER ID OF `base`'s `generation`, as this isolate spells it. Generation 0 is `base`, which
 *  every isolate shares, so a warm entry serves them all. A later one replaces an entry that failed,
 *  and the Worker Loader shares an entry by id across the isolates of a machine (workerd#7485):
 *  so a generation past 0 carries this isolate's salt, and a replay loads fresh code, not a
 *  sibling's failing entry. The one nonce a loader id may carry: it grows identities with failures,
 *  one per failure per isolate, never with requests. */
function generationId(base: string, generation: number): string {
  if (!generation) return base;
  retiredGenerationSalt ||= crypto.randomUUID().slice(0, 8);
  return `${base}#${generation}.${retiredGenerationSalt}`;
}

/** The content hash of a literal module map, memoized by the map's IDENTITY: the DO hands the SAME
 *  startup-memo object per facet per incarnation, so the per-character hash runs ONCE per source per
 *  incarnation instead of once per push. SYNCHRONOUS on purpose (the commit path, where
 *  `crypto.subtle` cannot run), so it is two independent 32-bit hashes (djb2 and FNV-1a) plus the
 *  length: djb2 alone collides on two-character differences (`"Aa"` and `"B@"`), and one shared hash
 *  is one shared isolate. A guard against an accidental collision, not a crafted one (trusted clients). */
const contentHashByWorkerModules = new WeakMap<WorkerModules, string>();
/** Subrequests per invocation of a loaded worker: core/os's own (core/os/scripts/stack.ts
 *  `limits`). */
const LOADED_WORKER_SUBREQUESTS = 1_000_000;

/** The modules whose package.json `prepareConfinedWorker` has read: a facet's spec hands the same
 *  object over on every push. */
const packageReadOf = new WeakSet<WorkerModules>();

/** The producer cache keys this isolate is writing (`prepareConfinedWorker`): KV takes one write
 *  per key per second, so a load that finds its key here leaves the write to the one in flight. */
const keepsInFlight = new Set<string>();

export function contentHashOfWorkerModules(modules: WorkerModules): string {
  let hash = contentHashByWorkerModules.get(modules);
  if (!hash) {
    const serialized = JSON.stringify(modules);
    let djb2 = 5381;
    let fnv1a = 0x811c9dc5;
    for (let i = 0; i < serialized.length; i++) {
      const code = serialized.charCodeAt(i);
      djb2 = ((djb2 << 5) + djb2 + code) | 0;
      fnv1a = Math.imul(fnv1a ^ code, 0x01000193);
    }
    hash = `${(djb2 >>> 0).toString(36)}-${(fnv1a >>> 0).toString(36)}-${serialized.length.toString(36)}`;
    contentHashByWorkerModules.set(modules, hash);
  }
  return hash;
}

/** The workerd compatibility flags a loaded worker cannot run without: `nodejs_als` carries a call's
 *  cause (cause.ts) and `allow_irrevocable_stub_storage` lets loaded code persist its `env.ITX` stub. */
const SDK_REQUIRED_COMPATIBILITY_FLAGS = ["nodejs_als", "allow_irrevocable_stub_storage"] as const;
/** The default base when a worker declares no `compatibilityFlags`: Node compat stays off (this
 *  compat date would otherwise turn v2 on). A declaring worker replaces this base with its own list. */
const DEFAULT_BASE_COMPATIBILITY_FLAGS = ["no_nodejs_compat", "no_nodejs_compat_v2"] as const;

/** A loaded worker's effective compatibility flags: its declared list (or the default base), with the
 *  SDK-required flags force-added. A list that disables one of those is refused — one clear error, so a
 *  worker cannot silently break the SDK. */
function applySdkCompatibilityFlags(declared: string[] | undefined, where: string): string[] {
  const base = declared || [...DEFAULT_BASE_COMPATIBILITY_FLAGS];
  for (const required of SDK_REQUIRED_COMPATIBILITY_FLAGS)
    if (base.includes(`no_${required}`))
      throw new Error(
        `${where}: compatibilityFlags must not disable "${required}", which the iterate SDK needs`,
      );
  return [...new Set([...base, ...SDK_REQUIRED_COMPATIBILITY_FLAGS])];
}

/** How this file and module-resolution.ts turn a source into the modules an isolate runs. Bump it
 *  when a change to either, or to sucrase or es-module-lexer, changes what a source produces, as
 *  `module-lock-3` names the lock's rewrite rules, or makes a resolution read a file it did not: a
 *  module identity's memo keeps only the files its resolution read, under this format
 *  (`prepareConfinedWorker`). loaded-code-format.test.ts fails on a change to that code until it is
 *  decided here. */
export const LOADED_CODE_FORMAT = 1;
let platformIdentity: Promise<string> | undefined;
/** WHAT THE PLATFORM PUTS INTO EVERY LOADED ISOLATE, as one hash in every loader id: this build's
 *  platform packages at their content (PLATFORM_MODULES), the compatibility date, the flags the
 *  loader adds, and LOADED_CODE_FORMAT. Never the deploy: a deploy that changes none of these keeps
 *  every loaded identity, so no facet restarts for it and nothing is produced again (the runtime
 *  still builds each isolate again, `prepareConfinedWorker`). Hashed once per isolate, at its first
 *  load. */
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

/** The parts of a loader id (`prepareConfinedWorker`, step 2), by name: what a restart logs as its
 *  reason, `generation` past 0 being the dead-load workaround's (`generationId`). */
const LOADER_ID_PARTS = ["kind", "platform", "platformOrigin", "owner", "source", "mainModule"];
/** The parts that differ between two loader ids, by name (`LOADER_ID_PARTS`): what a facet logs
 *  when its loaded identity moves (FacetHost `#materialize`). */
export function loadedIdentityChanges(previous: string, next: string): string[] {
  const split = (id: string) => {
    const end = id.lastIndexOf("]") + 1;
    try {
      return {
        parts: z.array(z.unknown()).parse(JSON.parse(id.slice(0, end))),
        generation: id.slice(end),
      };
    } catch {
      return { parts: [], generation: id }; // not an id this file spells: every part differs
    }
  };
  const before = split(previous);
  const after = split(next);
  const changed = LOADER_ID_PARTS.filter(
    (_, i) => JSON.stringify(before.parts[i]) !== JSON.stringify(after.parts[i]),
  );
  return before.generation === after.generation ? changed : [...changed, "generation"];
}

/** What `prepareConfinedWorker` needs. */
type PrepareConfinedWorkerOptions = {
  env: { LOADER: WorkerLoader; ITX_KV: KVNamespace } & IterateConfigEnv;
  /** The platform origin the `itxEntrypoint` stub was minted with (null until a self-host's first
   *  stamped caller) — FOLDED INTO THE LOADER ID: a warm isolate keeps the `env.ITX` it captured, so
   *  one minted before the origin was known must not be reused once it is (the next `LOADER.get`
   *  under the new id mints a fresh isolate; the stale one idles out). One extra identity per
   *  context at most, once. */
  platformOrigin: string | null;
  /** The `ItxEntrypoint` stub a loaded worker gets as `env.ITX` and `globalOutbound` — the loopback
   *  minted for the owning context (iterate-context.ts `ItxEntrypoint`). */
  itxEntrypoint: Fetcher;
  /** `worker` = a stateless isolate (`itx.workers.get`); `facet` = a durable class hosted as a facet
   *  (`itx.facets.get`). A CLOSED union so a new cacheKey family is a deliberate type change. */
  kind: "worker" | "facet";
  /** The owning context's name — for a facet, the pair (context name, className). Either way it is
   *  ONE element of the JSON-array loader id, so a ":" in either half cannot alias another owner:
   *  context "/x:y" + class "Tally" and context "/x" + class "y:Tally" stay two identities
   *  (worker-loader.test.ts). */
  owner: string | readonly [iterateContextName: string, className: string];
  source: WorkerSource;
  cacheKey?: string;
  /** The module of `source` loaded as the entry (`resolveModules`'s `mainModule`), package.json's
   *  `main` when absent. One more element of the loader id when given: two entries of one source
   *  are two workers. */
  mainModule?: string;
  /** What names the code in the loader id in place of `cacheKey` or the content hash: the entry's
   *  own identity (`moduleIdentityOf`), from the manifest of the worker a facet is named by
   *  (FacetHost). A producer then runs under it: every source that answers one identity loads the
   *  same code for that entry. */
  moduleIdentity?: string;
  /** Evaluate a producer expression through the owning context's dispatch — inside `getCode`, so
   *  only on a cold isolate. */
  invoke: (call: ItxExpression) => Promise<unknown>;
  /** Names the load site in errors (`facet "tally"`, `workers.get`). */
  where: string;
};

/**
 * THE one loading step, in two halves. RESOLVE, now: source → the cache key → `loaderId`, the
 * LOADED IDENTITY `FacetHost#materialize` stores as the facet's restart marker
 * (the one await is a dead id's recovery, which produces the modules OUTSIDE the loader so a
 * failure poisons nothing). LOAD, when the caller says: `load()` mints or reuses the confined
 * isolate under that identity and stops at the `worker` handle. "Name the code", "load the code"
 * and "choose the host" are visibly separate: `itx.workers.get` calls `load()` at once (a stateless
 * entrypoint per call; the loader caches by key); `FacetHost#materialize` calls
 * it only for a facet that STARTS — a call to a RUNNING facet never touches the loader
 * (Cloudflare's facet lifecycle; one isolate lookup per
 * warm call).
 *
 * ⚠️  THE cacheKey IS A DOLLAR AMOUNT. Cloudflare bills EVERY DISTINCT value ever passed to
 * `LOADER.get` as a Dynamic Worker at $0.002/worker/day, and a new value is a cold isolate build
 * (~5MB, 1-2s): a per-request nonce in the key bills a new worker and a cold build on every
 * dispatch. Key components must be LOW-CARDINALITY: the platform's code × owning context ×
 * (content hash | module identity | the caller's build/commit id) — NEVER a nonce, timestamp,
 * request id, deploy or offset, but for one bounded by failures (`generationId`). A loaded isolate
 * keeps the `env.ITX`/`globalOutbound` it was minted with, a loopback stub whose props name the
 * context and its origin (both in the key). The deploy needs no place in the key: the Worker Loader
 * keeps no isolate across its parent's deploy, and builds it again under the same id
 * (test/vitest/os/facet-rebuild.probe.e2e.test.ts shows it on a deployment). The confinement
 * contract, stated once: a loaded
 * worker's WHOLE world — `env.ITX` and every global fetch — is its owning context, so sibling calls
 * and egress route through the host's dispatch with no second path.
 */
export async function prepareConfinedWorker(
  opts: PrepareConfinedWorkerOptions,
): Promise<{ loaderId: string; load: () => WorkerStub; retire: () => void }> {
  const { where, source, cacheKey, mainModule } = opts;
  const requireFiles = (files: unknown): WorkerModules => {
    if (!isWorkerModules(files)) throw new Error(`${where}: a source is its files, path → code`);
    return files;
  };
  // 1. the key's last component, tagged with what names the code — a published module's identity,
  // the caller's cacheKey, or the content — so no cacheKey takes the id a module identity names;
  // and how the modules will be obtained.
  const named = opts.moduleIdentity
    ? `module:${opts.moduleIdentity}`
    : cacheKey
      ? `key:${cacheKey}`
      : undefined;
  let sourceVersion: string;
  let getModules: () => Promise<ObtainedModules> | ObtainedModules;
  /** What names the source in the resolved memo's key: its content, or the producer memo's key. */
  let sourceKey: () => Promise<string>;
  if (isWorkerModules(source)) {
    const modules = requireFiles(source);
    // refused where it is handed in, not late in a cold load; once per modules object
    if (!packageReadOf.has(modules)) {
      readPackage(modules, where);
      packageReadOf.add(modules);
    }
    sourceVersion = named || `content:${contentHashOfWorkerModules(modules)}`;
    getModules = () => ({ files: modules, expiresAt: aDayFromNow() });
    // the resolved memo's source is the content itself, by a hash no crafted source collides with
    sourceKey = async () => `content:${await sha256Hex(JSON.stringify(modules))}`;
  } else {
    if (!named)
      throw new Error(
        `${where}: a source EXPRESSION needs a cacheKey (a build id, a commit) — the producer runs only when no isolate is warm under it and no answer of its is kept (a day), so the key must change whenever the code does`,
      );
    sourceVersion = named;
    // A producer's modules are kept in `ITX_KV` under what names the code, so a cold isolate reads
    // them there instead of waking the context that produces them (for a config's worker,
    // `/repos/config`). A published module identity names the code: every context of the project
    // that loads it, every commit that publishes it and every deploy of one LOADED_CODE_FORMAT read
    // one answer: the files the graph from `mainModule` read, which resolve as the whole commit
    // does to the graph the identity hashes (`moduleIdentityOf`; why: `resolveModules`' `files`).
    // The format is in the key: a resolution that reads a file an older one did not is a new
    // format, so it never reads a memo that lacks that file. The project stays in the key, so a
    // context reads only its own project's files. The key spells `mainModule` as the source does:
    // `worker.ts` and `worker.js` holding one code load as one module, so they share an identity,
    // but each tree has only its own file. Files are kept under an identity only when the graph
    // this load resolved from that `mainModule` IS it (`keep`, below). A caller's key names the
    // code with its expression and its owner, and no main module,
    // so its memo keeps every file the producer answered: the key is that caller's promise, and an
    // expression may read the owner's own state. Never the deploy: a platform change to what a
    // producer answers is a new key prefix, and produced-modules-prefix.test.ts fails on a change
    // to the code that decides it until the prefix is decided. A KV failure is a miss: the
    // producer runs.
    /** Only an answer that can load is kept or believed: one the producer gave before its build
     *  landed must reach the dead-id recovery's next run, not be read back for a day. */
    const loadable = (files: unknown): files is WorkerModules => {
      if (!isWorkerModules(files)) return false;
      try {
        readPackage(files, where);
        return true;
      } catch {
        return false;
      }
    };
    /** Keep `files` under `kvKey` for the next cold load, once this load resolved them (`produce`),
     *  and only when the resolution is the code the key names (`named`, `produce`). */
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
            ? [LOADED_CODE_FORMAT, projectOf(opts.owner), named, mainModule]
            : [opts.owner, named, producer],
        ),
      ).then((hash) => `produced-modules-2/${hash}`));
    getModules = async () => {
      const kvKey = await sourceKey();
      const stored = await opts.env.ITX_KV.getWithMetadata(kvKey, "json").catch(
        moduleCacheFailed(opts, "get"),
      );
      if (stored && loadable(stored.value))
        return {
          files: stored.value,
          expiresAt: KeptMetadata.safeParse(stored.metadata).data?.expiresAt,
        };
      console.info({ event: "worker-loader.produced", name: opts.owner, where, source: named });
      // The producer is a read the cacheKey names, so running it twice is running it once: a read a
      // deploy's reset of the context it reads cut (the project ingress's
      // `itx.repos.get("/repos/config")`), or a lost connection, is read once more, from that
      // context's fresh incarnation.
      const produced = await retryPlatformFailures(() => opts.invoke(producer), {
        area: "worker-loader",
        schedule: ONCE_NOW,
        idempotent: true,
        kind: failureKind,
        describe: () => ({ name: opts.owner, where }),
      });
      // A producer that answers one module's text (a `readFile`, a `kv.get`) answers the source of
      // that one module, named as its `main`.
      // This load's own copy: what resolves, and what is kept after it, is what the producer
      // answered NOW, whatever it does with its map afterwards.
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
        keep: (resolved, isNamed) =>
          keep(kvKey, opts.moduleIdentity ? resolved.files : files, isNamed, expiresAt),
      };
    };
  }
  // 2. the confined worker under the billed cacheKey. A JSON array, never `a:b:c`: a context name,
  //    a class name or a caller's cacheKey may itself contain ":", and a joined string would let two
  //    different owners name ONE isolate — a silent cross-context authority transfer, since the
  //    isolate's whole world is the host stub baked in at first materialization. Changing the
  //    spelling restarts every loaded facet once on its next wake (a new restart marker), storage
  //    surviving, as a change to the platform's code does (`platformCodeIdentity`).
  const loaderIdBase = JSON.stringify([
    opts.kind,
    await platformCodeIdentity(),
    opts.platformOrigin,
    opts.owner,
    sourceVersion,
    ...(mainModule ? [mainModule] : []),
  ]);
  const state = loaderIdGenerations.get(loaderIdBase) ?? { generation: 0, dead: false };
  let { generation } = state;
  // Produce AND resolve: a source whose imports cannot resolve (a missing file, a parse error, esm.sh
  // down) fails here — in the recovery below that is before `load()` opens a new generation, so a
  // failure that persists mints no billed identity per retry.
  //
  // THE RESOLVED MEMO first: `getCode` runs on the caller's thread (a Durable Object's one thread),
  // and resolving is synchronous CPU there (sucrase, the lexer: 170–700 ms for a config worker), so
  // a cold load reads what an earlier load resolved and transforms nothing. Its key names everything
  // the resolution's answer depends on: the platform's code (its transforms, its modules, the
  // format), the source (its content, or what names a producer's answer), the main module and the
  // esm origin. The module locks it read are checked by value (`readResolvedMemo`). Each deployment
  // has its own ITX_KV. A miss resolves as before and keeps the answer off this load's path.
  const produce = async (): Promise<ProducedWorker> => {
    const memoKey = resolvedMemoKey(await sourceKey(), opts.env, mainModule);
    let started = Date.now();
    const remembered = await readResolvedMemo(opts, await memoKey);
    if (remembered)
      return { worker: remembered, modules: "resolved-memo", resolveMs: Date.now() - started };
    const { files, keep, expiresAt } = await getModules();
    // what each module lock read answered, and whether this resolution wrote one (a lock it made:
    // then the next resolution reads what KV kept, and the memo waits for that one)
    const locks = new Map<string, string>();
    let wroteLock = false;
    const store = {
      get: async (key: string) => {
        const value = await opts.env.ITX_KV.get(key);
        if (value) locks.set(key, value);
        return value;
      },
      put: (key: string, value: string) => {
        wroteLock = true;
        return opts.env.ITX_KV.put(key, value);
      },
    };
    started = Date.now();
    const resolved = await resolveModules(files, {
      ...resolveOptions(opts.env, where, mainModule),
      store,
    });
    const worker = enteredThroughPlatform(resolved, PLATFORM_MODULES);
    const resolveMs = Date.now() - started;
    // Kept only once it resolved, so an answer that cannot load is never kept; under a module
    // identity, only a graph that IS it (`isNamed`). Other answers load for this call, are logged.
    // Asked once, and only by a write, after its timer turn: hashing the graph is off the load's
    // path. A failure to hash it is a resolution not kept, never an unhandled rejection.
    let namedCheck: Promise<boolean> | undefined;
    const isNamed = () => (namedCheck ||= isTheNamedCode(resolved).catch(() => false));
    keep?.(resolved, isNamed);
    // what the memo keeps, owned here before the write's turn: the loader has `worker`'s objects
    const snapshot = {
      mainModule: worker.mainModule,
      modules: { ...worker.modules },
      compatibilityFlags: worker.compatibilityFlags ? [...worker.compatibilityFlags] : null,
    };
    // expires with the files it was made from; files whose expiry is unknown keep no memo
    if (!wroteLock && expiresAt !== undefined)
      keepInKv(
        opts,
        await memoKey,
        async () => {
          if (!(await isNamed())) return undefined;
          const lockHashes: Record<string, string> = {};
          for (const [key, value] of locks) lockHashes[key] = await sha256Hex(value);
          // only a module that IS this build's copy is named and left out: a source file under a
          // platform module's name keeps its own text
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
  /** Whether a resolution is the code its memos' keys name: always, but for a producer under a
   *  published module identity, whose graph must hash as the publication hashed it
   *  (`identityOfResolved`); literal files are their own key. Asked once per resolution, off the
   *  load's path. */
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
    // Outside the loader, so a throw here poisons nothing; one run for every caller while it lasts.
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
      // Only the recovery the map still holds settles it: a newer one (another incarnation's) wins.
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
    opts.env.LOADER.get(loaderId, async () => {
      let resolved: ProducedWorker;
      try {
        // Only on a cold isolate; resolution is locked per dependency set in ITX_KV, so a cold start
        // after the first one reads KV and never the network.
        resolved = await workerForCode();
      } catch (error) {
        loaderIdGenerations.set(loaderIdBase, { generation, dead: true });
        throw error;
      }
      // An isolate built: a new loaded identity, one this machine did not keep warm, or the first
      // load after a deploy.
      // `modules`: read from the resolved memo, or transformed here; `resolveMs`: how long that took
      // by the Workers clock, which moves with I/O (a transform's CPU shows in the DO's cpu time).
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
        // A worker's package.json gives its workerd compatibility flags (module-resolution.ts). The
        // default keeps Node compat OFF — this date turns it on, and it adds ~0.7 ms to every cold load
        // (measured 2026-09-29) while the SDK needs only `nodejs_als` — so a worker that wants Node
        // builtins (Baileys and the like) opts in with `"compatibilityFlags": ["nodejs_compat"]` and
        // pays that. `applySdkCompatibilityFlags` force-adds the flags the SDK cannot run without
        // (`nodejs_als`, which carries a call's cause; `allow_irrevocable_stub_storage`, which lets
        // loaded code persist its `env.ITX` stub — workers-and-facets.e2e pins it) and refuses a list
        // that disables either. No CPU limit: trusted clients. The platform bounds a DO to 10
        // distinct dynamic workers with in-flight requests — the pins' release keeps a context under it.
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: applySdkCompatibilityFlags(worker.compatibilityFlags, opts.where),
        // A loaded worker's invocation lasts as long as the work it starts: a voice agent's speaker
        // sender appends every frame of a call from one background task, each append a subrequest.
        // Under the plan's default of 10,000 per invocation, a call ends at its 10,000th speaker
        // frame (`Too many subrequests by single Worker invocation`): about 17 minutes of speech.
        limits: { subRequests: LOADED_WORKER_SUBREQUESTS },
        mainModule: worker.mainModule,
        modules: worker.modules,
        env: { ITX: opts.itxEntrypoint },
        globalOutbound: opts.itxEntrypoint,
      };
    });
  return {
    loaderId,
    load,
    /** Mark this identity DEAD: the next `prepareConfinedWorker` for the same base loads under the
     *  next generation — a genuinely fresh isolate. The recovery for a cached isolate that can no
     *  longer be called (the clone-version failure the DO's facet call names). */
    retire: () => {
      // Only the identity still current: a burst of calls that all failed on generation n retires
      // it once, and a late one never sends a recovered n+1 back to the dead n.
      const current = loaderIdGenerations.get(loaderIdBase) ?? { generation: 0, dead: false };
      if (current.generation === generation && !current.dead)
        loaderIdGenerations.set(loaderIdBase, { generation, dead: true });
    },
  };
}

/** WHETHER A CALL INTO A LOADED WORKER MET THE WORKER LOADER DEFECT that poisons a cached entry
 *  (facet-host.ts `isFacetStartPlatformFailure` names it; `retire` above is the recovery). The
 *  runtime reports it either as V8's clone-version text or as the opaque
 *  `internal error; reference = …`: its detail goes only to Cloudflare's own runtime log (workerd
 *  jsg/ser.c++), and the reference is logged nowhere, so it looks nothing up. The opaque text
 *  counts only when the runtime raised it: an internal failure inside the loaded worker reaches the
 *  caller unprefixed (workerd io/worker-entrypoint.c++ `exceptionToPropagate`), while an error the
 *  loaded code threw itself, the same text rethrown included, arrives with `remote` set and is the
 *  code's own. Retiring on that would mint a new billed identity for every request. An overload is
 *  its own kind of platform failure (platform-retry.ts `failureKind`), answered 503, and never a
 *  bad isolate. */
export function isLoadedWorkerPlatformFailure(error: unknown): error is Error {
  if (!(error instanceof Error) || errorCode(error) !== undefined) return false;
  if (error.message.includes("Unable to deserialize cloned data")) return true;
  // workerd's own flag on an error that crossed from another worker (jsg `decodeTunneledException`);
  // absent from the Error type, so read as the unknown it is.
  const { remote } = error as { remote?: unknown };
  return (
    error.message.startsWith("internal error; reference = ") &&
    remote !== true &&
    failureKind(error) === "failed"
  );
}

/** A read or write of a memo in ITX_KV that failed: a warning, and the memo a miss. */
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

/** Keep the value `make` answers under `kvKey` until `expiresAt` (seconds since the epoch, also
 *  written as its `metadata`, so a memo made from it can expire with it), without the load
 *  waiting for it: a whole
 *  tree's write lasts as long as a cold build (a config repo's 1.6 MB, 1.2–1.8 s; measured
 *  2026-11-04). `make` answers nothing for a value that must not be kept; a value over KV's limit
 *  is not kept either. A write already in flight for the key in this isolate is the one
 *  (`keepsInFlight`), and a 429 says another isolate kept it within the second. Anything else
 *  failing is a warning, as a failed read is: the next cold load misses and writes it again. */
function keepInKv(
  opts: Pick<PrepareConfinedWorkerOptions, "env" | "owner" | "where">,
  kvKey: string,
  make: () => Promise<string | undefined>,
  expiresAt: number,
): void {
  // KV refuses an expiry under a minute away: so little of the day left is not worth a write
  if (expiresAt < Date.now() / 1000 + 60 || keepsInFlight.has(kvKey)) return;
  keepsInFlight.add(kvKey);
  const kept = (async () => {
    // one turn of the event loop first: the load's answer goes before any of the memo's work
    await new Promise((resolve) => setTimeout(resolve, 0));
    const value = await make();
    if (!value) return;
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > KV_VALUE_MAX_BYTES) {
      // not kept: every cold load of it resolves again, so the line says why
      console.info({
        event: "worker-loader.module-cache-too-large",
        name: opts.owner,
        where: opts.where,
        key: kvKey.slice(0, kvKey.indexOf("/")),
        bytes,
      });
      return;
    }
    // checked again: the work above may have taken the expiry under KV's minute, which KV
    // would refuse, a refusal that is no platform failure
    if (expiresAt < Date.now() / 1000 + 60) return;
    await opts.env.ITX_KV.put(kvKey, value, {
      expiration: expiresAt,
      metadata: { expiresAt } satisfies z.infer<typeof KeptMetadata>,
    });
  })()
    .catch((error: unknown) => {
      // the binding quotes KV's status (platform-retry.ts `OVERLOADED_MESSAGE` reads it so)
      if (/KV PUT failed: 429\b/.test(error instanceof Error ? error.message : String(error)))
        console.info({
          event: "worker-loader.module-cache-kept-elsewhere",
          name: opts.owner,
          where: opts.where,
        });
      else moduleCacheFailed(opts, "put")(error);
    })
    .finally(() => keepsInFlight.delete(kvKey));
  // `waitUntil` holds a stateless invocation open for the write. It runs inside the load, so a
  // throw from it (no invocation to hold) must not fail the load: the write then runs detached.
  try {
    waitUntil(kept);
  } catch {
    void kept;
  }
}

/** The resolved memo's key (`prepareConfinedWorker`, `produce`). The `resolved-modules-N` prefix
 *  names the memo's shape: a change to `ResolvedMemo` is a new prefix. */
async function resolvedMemoKey(
  source: string,
  env: IterateConfigEnv,
  mainModule: string | undefined,
): Promise<string> {
  const esmOrigin = (env.ITERATE && iterateConfigOf(env).urls.esm) || null;
  return `resolved-modules-2/${await sha256Hex(
    JSON.stringify([await platformCodeIdentity(), esmOrigin, source, mainModule || null]),
  )}`;
}

/** The resolved memo under `kvKey` as the loader starts it, or nothing: a miss, a value of another
 *  shape, a module this build's platform does not ship, or a module lock that no longer holds what
 *  the resolution read. What it rejected is logged. A failed read is a miss. */
async function readResolvedMemo(
  opts: Pick<PrepareConfinedWorkerOptions, "env" | "owner" | "where">,
  kvKey: string,
): Promise<StartedWorker | undefined> {
  const text = await opts.env.ITX_KV.get(kvKey).catch(moduleCacheFailed(opts, "get"));
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
  // sealed: a value cut short, or changed since its write, is not the payload its digest names
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
    // every started worker enters through the platform's module (`enteredThroughPlatform`)
    !(
      memo.data.platformModules.includes(LOADED_WORKER_MODULE) ||
      Object.hasOwn(memo.data.modules, LOADED_WORKER_MODULE)
    )
  )
    return rejected("shape");
  const { mainModule, modules, platformModules, compatibilityFlags, locks } = memo.data;
  const current = await Promise.all(
    Object.entries(locks).map(async ([key, hash]) => {
      const value = await opts.env.ITX_KV.get(key).catch(moduleCacheFailed(opts, "get"));
      return typeof value === "string" && (await sha256Hex(value)) === hash;
    }),
  );
  if (!current.every(Boolean)) return rejected("lock");
  for (const name of platformModules) modules[name] = PLATFORM_MODULES.modules[name]!;
  return { mainModule, modules, compatibilityFlags: compatibilityFlags || undefined };
}

/** How the loader resolves a source (module-resolution.ts): this build's platform packages,
 *  the npm locks in ITX_KV, and the network for a dependency set no lock holds yet. */
function resolveOptions(
  env: { ITX_KV: KVNamespace } & IterateConfigEnv,
  where: string,
  mainModule: string | undefined,
): ResolveOptions {
  return {
    platform: PLATFORM_MODULES,
    store: env.ITX_KV,
    // A wrapper, never the bare global: workerd refuses `fetch` called as another object's
    // method ("Illegal invocation"), which `opts.fetch(...)` in the resolver would be.
    fetch: (input, init) => fetch(input, init),
    where,
    mainModule,
    esmOrigin: env.ITERATE && iterateConfigOf(env).urls.esm,
  };
}

/**
 * THE IDENTITY OF ONE MODULE OF A SOURCE: the SHA-256 of what the loader loads with it as the main
 * module — its resolved graph, its npm dependencies as their locks have them, and package.json's
 * `compatibilityFlags` — less this build's platform packages, which the platform identity in every
 * loader id names already (`platformCodeIdentity`). Two sources whose `mainModule` answers one
 * identity load the same code for it, so a facet whose class lives there keeps running across a
 * commit that changes only the rest of the source (a worker's manifest, FacetHost): another
 * module, an `AGENTS.md`. A module that does not resolve throws, as its load would.
 */
export async function moduleIdentityOf(
  files: WorkerModules,
  mainModule: string,
  env: { ITX_KV: KVNamespace } & IterateConfigEnv,
  where: string,
): Promise<string> {
  return identityOfResolved(await resolveModules(files, resolveOptions(env, where, mainModule)));
}

/** The identity of a source already resolved from its main module (`moduleIdentityOf`): what a
 *  load that resolved its files checks before it keeps them under that identity. */
function identityOfResolved(resolved: ResolvedWorker): Promise<string> {
  const graph = Object.entries(resolved.modules)
    .filter(([name]) => !Object.hasOwn(PLATFORM_MODULES.modules, name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(
    JSON.stringify([resolved.mainModule, graph, resolved.compatibilityFlags || null]),
  );
}

/** The project an owner (a context name, or a context name and class) belongs to: a memo shared
 *  by a module identity is shared inside it. */
function projectOf(owner: PrepareConfinedWorkerOptions["owner"]): string {
  return DurableObjectNameCodec.parse(typeof owner === "string" ? owner : owner[0]).projectId;
}
