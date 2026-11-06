// context/facet-host.test.ts — A FACET NAMED BY A PUBLISHED WORKER (FacetHost `#materialize`), in
// Node over fakes: the name's resolution is the test's to answer and hold, the loader keys a class by
// the identity its id names, and the host's restarts queue behind one another as
// `blockConcurrencyWhile` queues them. The Workers suite drives the real publication
// (test/vitest/os-workers/named-facets.test.ts).
import { expect, onTestFinished, test, vi } from "vitest";
import { codedError } from "iterate/lib";
import type { StreamEvent } from "iterate/stream/processor";
import { unavailableError } from "../unavailable.ts";
import { FacetHost } from "./facet-host.ts";
import { moduleIdentityOf } from "./worker-loader.ts";

test("a materialization that resolved an older publication and resumes after a newer one was installed leaves the facet on the newer one: nothing restarts it again", async () => {
  const facets = namedFacets();
  facets.publish(1);
  expect(await facets.boot()).toBe("agents-v1");
  // an older call's resolution is held while a newer publication is installed…
  const older = facets.holdNextResolution();
  const olderBoot = facets.boot();
  facets.publish(2);
  facets.holdRestarts();
  const newerBoot = facets.boot();
  await settle();
  // …and answers the older publication while the newer's restart is under way
  older.answer(1);
  await settle();
  facets.releaseRestarts();
  await Promise.all([olderBoot, newerBoot]);
  expect(facets).toMatchObject({ started: ["agents-v1", "agents-v2"] });
});

test("a publication restarts the facet only when its module identity moved, and logs which part of the loaded identity moved", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  onTestFinished(() => void info.mockRestore());
  const facets = namedFacets();
  facets.publish(1);
  expect(await facets.boot()).toBe("agents-v1");
  // a commit that leaves agents.ts: the same identity
  facets.publish(2, "agents-v1");
  expect(await facets.boot()).toBe("agents-v1");
  expect(facets).toMatchObject({ started: ["agents-v1"], locks: 0 });
  // a commit to agents.ts: a new identity
  facets.publish(3);
  expect(await facets.boot()).toBe("agents-v3");
  expect(facets).toMatchObject({ started: ["agents-v1", "agents-v3"], locks: 1 });
  expect(
    info.mock.calls.filter(([line]) => line.event === "facet.loaded-identity-changed"),
  ).toMatchObject([[{ name: "tally", changed: ["source"] }]]);
});

test("a live facet outlasts a name it cannot read right now: the platform failed the read, so the facet answers under the identity it runs", async () => {
  const facets = namedFacets();
  facets.publish(1);
  expect(await facets.boot()).toBe("agents-v1");
  facets.failResolutions(unavailableError("overloaded", "the root's rules could not be read"));
  expect(await facets.boot()).toBe("agents-v1");
  expect(facets).toMatchObject({ started: ["agents-v1"] });
});

test("a call cut off by `itx.facets.abort` rejects FACET_ABORTED with its own abort's reason, even once a second abort ended the next instance before the first cut-off arrived", async () => {
  const facets = namedFacets();
  facets.publish(1);
  await facets.boot();
  const cutOff = facets.work();
  await settle();
  await facets.abort("first");
  await facets.abort("second");
  facets.failHeldWork(new Error("the runtime's abort"));
  await expect(cutOff).rejects.toMatchObject({
    code: "FACET_ABORTED",
    message: expect.stringContaining("aborted: first"),
  });
});

test("a call cut off by `itx.facets.abort` rejects FACET_ABORTED even when what cut it off reads TIMEOUT", async () => {
  const facets = namedFacets();
  facets.publish(1);
  await facets.boot();
  const cutOff = facets.work();
  await settle();
  await facets.abort("asked");
  facets.failHeldWork(codedError("TIMEOUT", "the watchdog's own timeout"));
  await expect(cutOff).rejects.toMatchObject({ code: "FACET_ABORTED" });
});

test("a call in flight when its facet is deleted rejects NO_FACET only for the runtime's own words for the deletion, and keeps any other failure as its own", async () => {
  const facets = namedFacets();
  facets.publish(1);
  await facets.boot();
  const ownFailure = facets.work();
  const cutOff = facets.work();
  await settle();
  facets.delete();
  facets.failHeldWork(new Error("the facet's own failure"));
  facets.failHeldWork(new Error("Facet was deleted."));
  await expect(ownFailure).rejects.toThrow("the facet's own failure");
  await expect(cutOff).rejects.toMatchObject({ code: "NO_FACET" });
});

test("a restart whose start never answers ends at the start watchdog, and its warn says why it ran and how long it took", async () => {
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => void warned.mockRestore());
  const facets = namedFacets();
  facets.publish(1);
  await facets.boot();
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  facets.holdNextResolution(); // the start never reaches its facet: only the watchdog can end it
  const aborting = facets.abort("asked");
  await vi.advanceTimersByTimeAsync(10_000);
  await aborting;
  expect(warned.mock.calls).toMatchObject([
    [
      {
        event: "facet.start-failed",
        why: "itx.facets.abort",
        elapsedMs: expect.any(Number),
        message: 'facet "tally" start: no answer in 10s',
      },
    ],
  ]);
});

test("a birth with no facet to start opens no critical section", async () => {
  const facets = namedFacets();
  expect(await facets.birth()).toEqual([]);
  expect(facets).toMatchObject({ locks: 0 });
});

test("a birth starts a loaded facet from the code its context kept: once ITX_KV's memo expired, the start asks no producer, which at the root would wait on the root's own birth", async () => {
  const facets = await producedFacets();
  expect(await facets.call()).toBe("ok"); // the first start runs the producer
  await vi.waitFor(() => expect(facets.kept()).toBeDefined());
  // no isolate warm and no memo in ITX_KV: a deploy once the memos expired
  facets.deploy();
  facets.expireMemo();
  expect(await facets.birth()).toEqual(["tally"]);
  expect(facets).toMatchObject({ produced: 1, starts: 2 });
  expect(await facets.call()).toBe("ok");
});

test("the code a birth's start keeps is written only once every start of the birth settled: nothing lands between a facet's stop and its start, and a start from the resolved memo keeps it too", async () => {
  const facets = await producedFacets();
  await facets.call();
  await vi.waitFor(() => expect(facets.kept()).toBeDefined());
  // a context that kept no copy yet (one born before copies were kept), its memos still in ITX_KV
  facets.forgetCopy();
  facets.deploy();
  await facets.birth();
  await vi.waitFor(() => expect(facets.kept()).toBeDefined());
  expect(facets.order.slice(facets.order.lastIndexOf("started"))).toEqual([
    "started",
    "put facet:tally:modules",
  ]);
  expect(facets).toMatchObject({ produced: 1 });
  // that birth loaded from the resolved memo, yet its copy is the files: once both memos expired,
  // the next birth asks no producer
  facets.deploy();
  facets.expireMemo();
  expect(await facets.birth()).toEqual(["tally"]);
  expect(facets).toMatchObject({ produced: 1 });
});

test("a facet's kept code is the latest load's: an older load's keep that lands after a newer publication's is dropped, so the copy stays the code the facet runs", async () => {
  const facets = await producedFacets();
  await facets.call();
  await vi.waitFor(() => expect(facets.kept()).toBeDefined());
  await vi.waitFor(() => expect(facets.resolvedMemoKept()).toBe(true));
  // a birth that reads the resolved memo, with no copy: its keep reads the files' memo, held
  facets.forgetCopy();
  const reads = facets.holdFileReads();
  facets.deploy();
  await facets.birth();
  await vi.waitFor(() => expect(reads.waiting()).toBe(1));
  // agents.ts changes, and the next birth keeps the new code's copy
  await facets.publish(2);
  facets.deploy();
  await facets.birth();
  await vi.waitFor(() => expect(facets.kept()?.files).toEqual(facets.filesAt(2)));
  reads.release();
  await settle();
  expect(facets.kept()?.files).toEqual(facets.filesAt(2));
  expect(facets).toMatchObject({ produced: 2 });
});

test("calls to a running facet while its load's keep waits drop nothing: the copy is kept once the read answers", async () => {
  const facets = await producedFacets();
  await facets.call();
  await vi.waitFor(() => expect(facets.kept()).toBeDefined());
  await vi.waitFor(() => expect(facets.resolvedMemoKept()).toBe(true));
  // a birth that reads the resolved memo, with no copy: its keep reads the files' memo, held
  facets.forgetCopy();
  const reads = facets.holdFileReads();
  facets.deploy();
  await facets.birth();
  await vi.waitFor(() => expect(reads.waiting()).toBe(1));
  // every call resolves the facet's identity again, and finds it unchanged
  for (let i = 0; i < 3; i++) expect(await facets.call()).toBe("ok");
  reads.release();
  await vi.waitFor(() => expect(facets.kept()?.files).toEqual(facets.filesAt(1)));
});

/** A context's facet host with one facet, `tally`, named by the root's published worker: `publish`
 *  sets the generation the name resolves to (agents.ts's identity `agents-v<generation>`, unless it
 *  names one), `boot` is
 *  one call on it answering the identity its class was minted under, and `started` every class the
 *  host minted, in order. `work` is a call the facet holds until `failHeldWork` rejects the oldest
 *  one held: the fake's abort and `delete` (its hosting row removed) cut off nothing by themselves,
 *  so a test says when the runtime's rejection arrives. `locks` counts the host's
 *  `blockConcurrencyWhile` calls. */
function namedFacets() {
  const kv = new Map<string, unknown>();
  const started: string[] = [];
  const instances = new Map<
    string,
    { boot(): string; listPublicMethods(): string[]; work(): Promise<never> }
  >();
  const heldWork: ((error: unknown) => void)[] = [];
  let generation = 0;
  const identityAt = new Map<number, string>();
  let holdNext = false;
  let answerHeld = (_generation: number) => {};
  let failure: unknown;
  let restarts = Promise.resolve<unknown>(undefined);
  let releaseRestarts = () => {};
  let locks = 0;
  const named = async () => {
    if (failure) throw failure;
    const at = holdNext
      ? await new Promise<number>((resolve) => {
          holdNext = false;
          answerHeld = resolve;
        })
      : generation;
    return {
      vouched: true,
      invoke: () => Promise.reject(new Error("literal modules — nothing to invoke")),
      spec: {
        source: { "package.json": '{"main":"worker.js"}', "worker.js": "", "agents.ts": "" },
        manifest: {
          generation: at,
          modules: {
            "agents.ts": { identity: identityAt.get(at) ?? `agents-v${at}`, classes: ["Tally"] },
          },
        },
      },
    };
  };
  const host = new FacetHost({
    ctx: {
      storage: {
        kv: {
          get: (key: string) => kv.get(key),
          put: (key: string, value: unknown) => void kv.set(key, value),
          delete: (key: string) => kv.delete(key),
          list: () => new Map(),
        },
      },
      facets: {
        get: (name: string, startup: () => { class: { identity: string } }) => {
          let instance = instances.get(name);
          if (!instance) {
            const { identity } = startup().class;
            started.push(identity);
            instance = {
              boot: () => identity,
              listPublicMethods: () => ["boot"],
              work: () => new Promise<never>((_, reject) => heldWork.push(reject)),
            };
            instances.set(name, instance);
          }
          return instance;
        },
        abort: (name: string) => void instances.delete(name),
        delete: (name: string) => void instances.delete(name),
      },
      blockConcurrencyWhile: <T>(work: () => Promise<T>) => {
        locks++;
        const run = restarts.then(work);
        restarts = run.catch(() => undefined);
        return run;
      },
      exports: {},
    },
    env: () => ({
      LOADER: {
        get: (id: string) => ({
          getDurableObjectClass: () => ({ identity: /module:(agents-v\d+)/.exec(id)![1] }),
        }),
      },
      ITX_KV: {},
    }),
    deployId: "deploy-1",
    iterateContextName: "prj_unit.iterate/x",
    projectId: "prj_unit",
    path: "/x",
    platformOrigin: () => null,
    itxEntrypoint: () => ({}),
    invoke: () => Promise.reject(new Error("unused")),
    namedWorker: named,
    resolveItxExpression: () => [],
    stream: { coreReducedState: { subscriptions: {} } },
    reconcileAlarm: () => {},
    loadedFacetMaterialized: () => {},
    deliveriesQueuedFor: async () => {},
    cause: () => undefined,
  } as unknown as ConstructorParameters<typeof FacetHost>[0]);
  const tally = host.handle("tally", {
    className: "Tally",
    mainModule: "agents.ts",
    source: ["itx", ["cd", "/"], "config"],
  });
  return {
    started,
    get locks() {
      return locks;
    },
    birth: () => host.startFacetsTheLastIncarnationRan(),
    publish: (next: number, identity = `agents-v${next}`) => {
      generation = next;
      identityAt.set(next, identity);
    },
    boot: () => host.callFacetAsPlatform(tally, [["boot"]]),
    work: () => host.callFacetAsPlatform(tally, [["work"]]),
    abort: (reason: string) => host.abort("tally", reason),
    failHeldWork: (error: unknown) => heldWork.shift()?.(error),
    delete: () =>
      host.deleteFacetsWhoseHostingSubscriptionWasRemoved(
        [removedTallyRow],
        // The deletion reads only the removed row's `hostedFacet`; the row's other fields are the
        // reduce's, which this fake never runs.
        {
          "tally-row": { hostedFacet: { name: "tally", className: "Tally" } },
        } as unknown as Parameters<FacetHost["deleteFacetsWhoseHostingSubscriptionWasRemoved"]>[1],
      ),
    holdNextResolution: () => {
      holdNext = true;
      return { answer: (at: number) => answerHeld(at) };
    },
    failResolutions: (error: unknown) => void (failure = error),
    holdRestarts: () => {
      restarts = new Promise((resolve) => (releaseRestarts = () => resolve(undefined)));
    },
    releaseRestarts: () => releaseRestarts(),
  };
}

/** How many `producedFacets` hosts this file made: each gets a project of its own. */
let producedFacetsMade = 0;

/** A context's facet host with one loaded facet, `tally`, named by the root's published worker
 *  and loaded from a PRODUCER (the config pointer's: `itx.config.modules({ commitOid })`), over a
 *  Worker Loader that runs `getCode` once per id until `deploy` drops every isolate, and an ITX_KV
 *  memo that `expireMemo` empties. A facet's start waits for its code, as workerd's does.
 *  `produced` counts the producer's runs, `starts` the facet's instances, `kept` reads the
 *  context's copy of the code, and `order` lists every start and every storage write. */
async function producedFacets() {
  // a project of its own: the loader's in-flight memo writes are per isolate, keyed by project
  const project = `prj_produced${++producedFacetsMade}`;
  const kv = new Map<string, unknown>();
  const memo = new Map<string, string>();
  const memoMetadata = new Map<string, unknown>();
  const warm = new Map<string, Promise<unknown>>();
  const instances = new Map<string, object>();
  const order: string[] = [];
  let produced = 0;
  let starts = 0;
  const filesAt = (version: number) => ({
    "package.json": '{"main":"worker.js"}',
    "worker.js": "export default {}",
    "agents.ts": `export class Tally { version = ${version} }`,
  });
  const identityOf = (files: Record<string, string>) =>
    moduleIdentityOf(files, "agents.ts", { ITX_KV: {} as KVNamespace }, "agents.ts");
  let files = filesAt(1);
  let identity = await identityOf(files);
  let commit = 1;
  /** Reads of the files' memo that wait until `release` (`holdFileReads`). */
  let heldFileReads: (() => void)[] | undefined;
  const host = new FacetHost({
    ctx: {
      storage: {
        kv: {
          get: (key: string) => kv.get(key),
          put: (key: string, value: unknown) => {
            order.push(`put ${key}`);
            kv.set(key, value);
          },
          delete: (key: string) => kv.delete(key),
          list: ({ prefix }: { prefix: string }) =>
            new Map([...kv].filter(([key]) => key.startsWith(prefix))),
        },
      },
      facets: {
        get: (name: string, startup: () => { class: { code: Promise<unknown> } }) => {
          let instance = instances.get(name);
          if (!instance) {
            const { code } = startup().class;
            starts++;
            instance = {
              listPublicMethods: async () => {
                await code;
                order.push("started");
                return ["call"];
              },
              call: async () => {
                await code;
                return "ok";
              },
            };
            instances.set(name, instance);
          }
          return instance;
        },
        abort: (name: string) => void instances.delete(name),
        delete: (name: string) => void instances.delete(name),
      },
      blockConcurrencyWhile: <T>(work: () => Promise<T>) => work(),
      exports: {},
    },
    env: () => ({
      LOADER: {
        get: (id: string, getCode: () => Promise<unknown>) => {
          if (!warm.has(id)) warm.set(id, getCode());
          return { getDurableObjectClass: () => ({ code: warm.get(id) }) };
        },
      },
      ITX_KV: {
        get: async (key: string, type?: "json") => {
          if (heldFileReads && key.startsWith("produced-modules-"))
            await new Promise<void>((resolve) => heldFileReads!.push(resolve));
          const value = memo.get(key) ?? null;
          return type === "json" && value ? JSON.parse(value) : value;
        },
        getWithMetadata: async (key: string, type?: "json") => {
          const value = memo.get(key) ?? null;
          return {
            value: type === "json" && value ? JSON.parse(value) : value,
            metadata: (value && memoMetadata.get(key)) ?? null,
          };
        },
        put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
          memo.set(key, value);
          memoMetadata.set(key, options?.metadata);
        },
      },
    }),
    deployId: "deploy-1",
    iterateContextName: `${project}.iterate/`,
    projectId: project,
    path: "/",
    platformOrigin: () => null,
    itxEntrypoint: () => ({}),
    invoke: () => Promise.reject(new Error("unused")),
    namedWorker: async () => {
      const [answer, at] = [files, commit];
      return {
        vouched: true,
        // `/repos/config`'s files at the commit: at a root's birth, a call that waits on that birth
        invoke: async () => {
          produced++;
          return answer;
        },
        spec: {
          source: ["itx", "config", ["modules", { commitOid: `c${at}` }]],
          cacheKey: `c${at}`,
          manifest: {
            generation: at,
            modules: { "agents.ts": { identity, classes: ["Tally"] } },
          },
        },
      };
    },
    resolveItxExpression: () => [],
    stream: { coreReducedState: { subscriptions: {} } },
    reconcileAlarm: () => {},
    loadedFacetMaterialized: () => {},
    deliveriesQueuedFor: async () => {},
    cause: () => undefined,
  } as unknown as ConstructorParameters<typeof FacetHost>[0]);
  const tally = host.handle("tally", {
    className: "Tally",
    mainModule: "agents.ts",
    source: ["itx", ["cd", "/"], "config"],
  });
  return {
    order,
    get produced() {
      return produced;
    },
    get starts() {
      return starts;
    },
    kept: () => kv.get("facet:tally:modules") as { key: string; files: object } | undefined,
    resolvedMemoKept: () => [...memo.keys()].some((key) => key.startsWith("resolved-modules-")),
    filesAt,
    /** A commit that changes `agents.ts`: a new identity, under the same spec. */
    publish: async (version: number) => {
      files = filesAt(version);
      identity = await identityOf(files);
      commit++;
    },
    /** Hold every read of the files' memo until the answer's `release`. */
    holdFileReads: () => {
      const held: (() => void)[] = [];
      heldFileReads = held;
      return {
        waiting: () => held.length,
        release: () => {
          heldFileReads = undefined;
          for (const resolve of held.splice(0)) resolve();
        },
      };
    },
    forgetCopy: () => void kv.delete("facet:tally:modules"),
    call: () => host.callFacetAsPlatform(tally, [["call"]]),
    birth: () => host.startFacetsTheLastIncarnationRan(),
    deploy: () => warm.clear(),
    expireMemo: () => memo.clear(),
  };
}

/** `tally`'s hosting row removed: a `subscription-configured` with no target is the disablement. */
const removedTallyRow: StreamEvent = {
  offset: 1,
  type: "events.iterate.com/itx/subscription-configured",
  createdAt: "2026-09-30T00:00:00.000Z",
  path: "/x",
  source: { origin: "prj_unit.iterate/x" },
  payload: { name: "tally-row", target: null },
};

/** Let every promise chain started so far settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
