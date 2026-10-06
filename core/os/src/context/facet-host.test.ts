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

test("a restart whose start never answers ends when the start watchdog's clock answers, and its warn says why it ran and how long it took", async () => {
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => void warned.mockRestore());
  const facets = namedFacets();
  facets.publish(1);
  await facets.boot();
  facets.holdNextResolution(); // the start never reaches its facet: only the clock can end it
  const aborting = facets.abort("asked");
  await settle();
  facets.answerClock();
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

test("a restart whose clock fails logs that once, and a timer of the context still ends the start", async () => {
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => void warned.mockRestore());
  const facets = namedFacets({ clockFails: true });
  facets.publish(1);
  await facets.boot();
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  facets.holdNextResolution();
  const aborting = facets.abort("under a failing clock");
  await vi.advanceTimersByTimeAsync(10_000);
  await aborting;
  expect(warned.mock.calls).toMatchObject([
    [{ event: "critical-section-deadline.platform-failure-fetch", message: "no loopback" }],
    [{ event: "facet.start-failed", why: "itx.facets.abort", elapsedMs: 10_000 }],
  ]);
});

test("a birth with no facet to start opens no critical section and asks the clock nothing", async () => {
  const facets = namedFacets();
  expect(await facets.birth()).toEqual([]);
  expect(facets).toMatchObject({ locks: 0, clockRequests: 0 });
});

/** A context's facet host with one facet, `tally`, named by the root's published worker: `publish`
 *  sets the generation the name resolves to (agents.ts's identity `agents-v<generation>`, unless it
 *  names one), `boot` is
 *  one call on it answering the identity its class was minted under, and `started` every class the
 *  host minted, in order. `work` is a call the facet holds until `failHeldWork` rejects the oldest
 *  one held: the fake's abort and `delete` (its hosting row removed) cut off nothing by themselves,
 *  so a test says when the runtime's rejection arrives. The start watchdog's clock
 *  (`CriticalSectionDeadline`) answers when `answerClock` says, or fails with `clockFails`; `locks`
 *  counts the host's `blockConcurrencyWhile` calls and `clockRequests` the clock's. */
function namedFacets({ clockFails = false } = {}) {
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
  let clockRequests = 0;
  const clockAnswers: (() => void)[] = [];
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
      exports: {
        CriticalSectionDeadline: {
          fetch: () => {
            clockRequests++;
            if (clockFails) return Promise.reject(new Error("no loopback"));
            return new Promise<Response>((resolve) =>
              clockAnswers.push(() => resolve(new Response(null, { status: 204 }))),
            );
          },
        },
      },
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
    get clockRequests() {
      return clockRequests;
    },
    answerClock: () => clockAnswers.splice(0).forEach((answer) => answer()),
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
