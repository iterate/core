import { codedError, errorCode } from "iterate/lib";
import type { ItxExpression } from "iterate/expression";
import type { FacetSpec, WorkerSource } from "iterate/api";
import { failureKind } from "iterate/platform-retry";
import { z } from "zod";
import { WorkerManifest } from "./worker-manifest.ts";
import { SOURCE_MAX_CHARS } from "./itx-expression-rewriting.ts";

// A worker's files as authored: a file is its text, or `{ base64 }` when it is not text.
export type WorkerModules = Record<string, string | { base64: string }>;

// The startup memo is one kv cell and the hosting event one log row under the 8 MiB event ceiling,
// so an oversize literal source is refused where it is handed in, before anything is appended.
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

// Anyone may write a rule, so the shape of the spec it names is checked where a name is read.
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

export type NamedWorker = {
  spec: unknown;
  vouched: boolean;
  invoke: (call: ItxExpression) => Promise<unknown>;
};

// A manifest counts only when the platform wrote the rule (`vouched`); anyone else's is ignored.
export function namedWorkerLoad(
  named: { spec: unknown; vouched: boolean },
  mainModule: string | undefined,
  where: string,
  className?: string,
): { source: WorkerSource; cacheKey?: string; moduleIdentity?: string; generation?: number } {
  // a facet's push asks on every call with the same spec object: the manifest is parsed once per spec
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

// Synchronous on purpose (the commit path, where `crypto.subtle` cannot run). Two 32-bit hashes:
// djb2 alone collides on `"Aa"`/`"B@"`, and one shared hash is one shared isolate.
const contentHashByWorkerModules = new WeakMap<WorkerModules, string>();

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

// The parts of a loader id, in order (the host's `prepareConfinedWorker` spells it).
const LOADER_ID_PARTS = ["kind", "platform", "owner", "source", "mainModule"];
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

// Only under a published module identity: unlike `ITX_KV`'s memos it does not expire, and that
// expiry is what bounds a caller's key that breaks "same key ⇒ same code".
export type KeptModules = {
  get(key: string): WorkerModules | undefined;
  keep(key: string, files: WorkerModules): void;
};

export type PrepareConfinedWorkerOptions = {
  // the loopback minted for the owning context: the loaded worker's `env.ITX` and `globalOutbound`
  itxEntrypoint: Fetcher;
  kind: "worker" | "facet";
  // one element of the JSON-array loader id, so a ":" in either half cannot alias another owner
  owner: string | readonly [iterateContextName: string, className: string];
  source: WorkerSource;
  cacheKey?: string;
  mainModule?: string;
  // names the code in the loader id in place of `cacheKey` or the content hash
  moduleIdentity?: string;
  // called inside `getCode`, so only on a cold isolate
  invoke: (call: ItxExpression) => Promise<unknown>;
  kept?: KeptModules;
  where: string;
};

// Workerd reports the defect that poisons a cached loader entry as V8's clone-version text or an
// opaque `internal error; reference = …`; the latter counts only when the runtime raised it.
export function isLoadedWorkerPlatformFailure(error: unknown): error is Error {
  if (!(error instanceof Error) || errorCode(error) !== undefined) return false;
  if (error.message.includes("Unable to deserialize cloned data")) return true;
  // workerd's flag on an error that crossed from another worker; loaded code's own throw has it set,
  // and retiring on that would mint a new billed identity per request
  const { remote } = error as { remote?: unknown };
  return (
    error.message.startsWith("internal error; reference = ") &&
    remote !== true &&
    failureKind(error) === "failed"
  );
}
