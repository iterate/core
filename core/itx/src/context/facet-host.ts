// A caller's itx expression reaches a facet only through `handle`, checked against the methods its
// class lists; the platform's own calls take `callFacetAsPlatform`, which no walk can land on.
import { z } from "zod";
import {
  codedError,
  errorCode,
  jsonEqual,
  releaseRpcSessions,
  reportIssue,
  withTimeout,
} from "iterate/lib";
import { REVIVE_AFTER_MAX_MS, REVIVE_AFTER_MS, type StreamEvent } from "iterate/stream/processor";
import {
  itxExpressionStepName,
  normalizedItxExpression,
  print,
  type ItxExpression,
  type ItxExpressionInput,
} from "iterate/expression";
import type { FacetProps, StreamProcessorDurableObject } from "iterate/sdk";
import type { FacetSpec, WorkerSource } from "iterate/api";
import { failureKind, isPlatformFailureKind } from "iterate/platform-retry";
import { deepestCause, requestCausedBy, type Cause } from "../cause.ts";
import {
  CoreContract,
  facetSpecFromHostingTarget,
  facetSpecOf,
  rowsPushingFacet,
  type CoreState,
} from "../stream/core-processor.ts";
import {
  assertFacetPlacement,
  firstPartyFacetClassOf,
  firstPartyFacetPublicMethodsOf,
} from "../first-party-facets.ts";
import { itxLoader } from "../host.ts";
import type { Stream } from "../stream/stream.ts";
import {
  walkSteps,
  awaitAnswerReleasedIfRejected,
  FacetHandle,
  isMissingRpcMethod,
} from "./dispatch.ts";
import { assertFacetMethodIsPublic } from "./facet-public-methods.ts";
import {
  assertFacetSourceWithinCeiling,
  loadedIdentityChanges,
  namedWorkerLoad,
  type KeptModules,
  type NamedWorker,
  type WorkerModules,
} from "./worker-loader.ts";
import { namesAWorker } from "./itx-expression-rewriting.ts";
import { criticalSectionDeadline } from "./critical-section-deadline.ts";

// Workaround for a platform defect (https://github.com/iterate/alarm-loader-facet-repro): on prd, a
// loaded facet started in an alarm-woken incarnation can reject at start. Remove when it is fixed.
const isFacetStartPlatformFailure = (error: unknown): error is Error =>
  error instanceof Error &&
  // a coded rejection is a hop below's, classified there
  errorCode(error) === undefined &&
  (error.message.includes("Unable to deserialize cloned data") ||
    error.message.startsWith("internal error; reference = "));
/** A call that never answers would hold the pins' release, and with it this actor, forever. */
const FACET_CALL_WATCHDOG_MS = 60_000;
// Workaround for a platform defect: on the edge, a facet stopped after writes can reset its
// context on the next commit unless started first.
const FACET_START_WATCHDOG_MS = 10_000;
/** A stored value is at most 2 MB, counted two bytes a character. */
const KEPT_MODULES_MAX_BYTES = 1_800_000;
type FacetClaim = { at: number; cause?: Cause };

// A late failure may only retire its own run. `endedBy` says what a call still in flight rejects with.
type FacetGeneration = {
  endedBy?: { code: "FACET_ABORTED" | "FACET_RESTARTED" | "NO_FACET"; message: string };
};

// a deletion claims only the runtime's own words for it (workerd server.c++ `deleteFacet`)
function isRejectionByEndOfRun(
  code: NonNullable<FacetGeneration["endedBy"]>["code"],
  error: unknown,
): boolean {
  if (code === "FACET_ABORTED") return true;
  if (code === "FACET_RESTARTED") return errorCode(error) !== "TIMEOUT";
  return error instanceof Error && error.message === "Facet was deleted.";
}

// A platform start's timeout leaves the facet alone: an abort then would stop it outside the
// start's `blockConcurrencyWhile`.
type FacetCallWatchdog = { watchdogMs: number; onTimeout: "restart" | "leave" };
const FACET_CALL_WATCHDOG: FacetCallWatchdog = {
  watchdogMs: FACET_CALL_WATCHDOG_MS,
  onTimeout: "restart",
};
type FacetCallOptions = { byItxExpression?: boolean; cause?: Cause };
// A call from loaded code never restarts the quiet clock. Past the ~10 s eviction and the pins'
// 30 s release, so a used context costs one extra alarm wake per quiet period.
export const UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS = 60_000;

type FacetHostDeps = {
  ctx: Pick<DurableObjectState, "facets" | "storage" | "exports" | "blockConcurrencyWhile">;
  deployId: string;
  iterateContextName: string;
  path: string;
  itxEntrypoint: () => Fetcher;
  invoke: (call: ItxExpressionInput) => Promise<unknown>;
  namedWorker: (source: ItxExpressionInput) => Promise<NamedWorker>;
  resolveItxExpression: (expression: ItxExpressionInput) => ItxExpression[];
  stream: Stream;
  reconcileAlarm: () => void;
  loadedFacetMaterialized: () => void;
  deliveriesQueuedFor: (name: string) => Promise<unknown>;
  cause: () => Cause | undefined;
  // The cause of a caller's own call to `<facet>.<method>`: a promise only when it must be signed.
  causeOfCall: (call: string) => Cause | undefined | Promise<Cause | undefined>;
};

// answered from the processor's reduce, after the deliveries its context owes it
const PROCESSOR_READS: ReadonlySet<string> = new Set([
  "snapshot",
  "liveSnapshot",
] satisfies (keyof StreamProcessorDurableObject)[]);

type NamedWorkerStarted = {
  name: WorkerSource;
  mainModule?: string;
  generation: number;
  source: WorkerSource;
  cacheKey?: string;
  moduleIdentity?: string;
};

type FacetWorker = {
  source: WorkerSource;
  cacheKey?: string;
  moduleIdentity?: string;
  invoke: (call: ItxExpression) => Promise<unknown>;
  started?: NamedWorkerStarted;
};

type MaterializedFacet = {
  facet: Fetcher;
  retireLoadedIdentity?: () => void;
  startupFailed: () => boolean;
  generation: FacetGeneration;
  recordLoadedIdentity?: () => void;
  loaderId?: string;
};

export class FacetHost {
  readonly #deps: FacetHostDeps;
  // in memory on purpose: a facet this incarnation did not start is not its to count
  readonly #liveFacetNames = new Set<string>();
  // read once per incarnation: the loader's identity-keyed content hash then runs once per source
  readonly #facetStartupMemoByName = new Map<string, FacetSpec>();
  readonly #facetGenerationByName = new Map<string, FacetGeneration>();
  // the next recovery starts after this one, so no restart aborts another recovery's retry mid-call
  readonly #facetRecoveryByName = new Map<string, Promise<void>>();
  // aborting a facet mid-reduce is the stall a reduce would have to repair from the log
  #facetWorkInFlight = 0;
  readonly #facetClaims = new Map<string, FacetClaim>();
  // A kv row each, so the backoff survives the eviction between two passes: else a facet that
  // cannot be revived would cost a wake every 40 s for good.
  readonly #facetReviveFailures = new Map<string, number>();
  readonly #facetAddressByFacetHandle = new WeakMap<
    FacetHandle,
    { name: string; spec: FacetSpec | undefined }
  >();
  // a publication that changes the code changes the identity, and with it the list
  readonly #publicMethodsByLoaderId = new Map<string, readonly string[]>();
  readonly #loaderIdByName = new Map<string, string>();
  readonly #namedWorkerInstalled = new Map<string, NamedWorkerStarted>();
  readonly #ranThisIncarnation = new Set<string>();
  // read once per incarnation and written through: this host is their only writer
  readonly #rows = new Map<string, unknown>();
  #row<T>(key: string): T | undefined {
    if (!this.#rows.has(key)) this.#rows.set(key, this.#deps.ctx.storage.kv.get(key));
    return this.#rows.get(key) as T | undefined;
  }
  #putRow(key: string, value: unknown): void {
    this.#deps.ctx.storage.kv.put(key, value);
    this.#rows.set(key, value);
  }
  #deleteRow(key: string): void {
    this.#deps.ctx.storage.kv.delete(key);
    this.#rows.delete(key);
  }

  constructor(deps: FacetHostDeps) {
    this.#deps = deps;
    for (const [key, n] of deps.ctx.storage.kv.list({ prefix: "facet-claim-failures:" }))
      this.#facetReviveFailures.set(key.slice("facet-claim-failures:".length), n as number);
    // A first-party facet's claim the last incarnation left is due at this birth: its attempt ran
    // in an incarnation that is over. A loaded facet's claim is its author's, kept as written.
    const bornAt = Date.now();
    for (const [key, row] of deps.ctx.storage.kv.list({ prefix: "facet-claim:" })) {
      const name = key.slice("facet-claim:".length);
      const claim = row as FacetClaim;
      const dueAtBirth = firstPartyFacetClassOf(name) && !this.#facetReviveFailures.has(name);
      this.#facetClaims.set(
        name,
        dueAtBirth ? { ...claim, at: Math.min(claim.at, bornAt) } : claim,
      );
    }
  }

  deadlines(): { name: string; at: number }[] {
    return [...this.#facetClaims]
      .map(([name, { at }]) => ({ name, at }))
      .sort((a, b) => a.at - b.at);
  }

  snapshot(): { facetWorkInFlight: number; liveFacetNames: string[] } {
    return {
      facetWorkInFlight: this.#facetWorkInFlight,
      liveFacetNames: [...this.#liveFacetNames],
    };
  }

  restarts(name: string): number {
    return (this.#deps.ctx.storage.kv.get(`facet:${name}:restarts`) as number | undefined) ?? 0;
  }

  claim(name: string, at: number | null, cause?: Cause): void {
    this.#facetRevived(name);
    this.#claimFacetAlarm(name, at, cause);
    // a release can land after the facet's deletion took its memo
    if (
      firstPartyFacetClassOf(name) ||
      this.#deps.ctx.storage.kv.get(`facet:${name}`) !== undefined
    )
      this.#markRan(name);
  }

  // Each claim is spent before its revive: a claim is one revive, never a standing order.
  async reviveDueClaims(): Promise<void> {
    for (const [name, { at, cause }] of [...this.#facetClaims]) {
      if (at > Date.now()) continue;
      this.#claimFacetAlarm(name, null);
      try {
        await this.callFacetAsPlatform(name, [["revive"]], cause);
        this.#facetRevived(name);
      } catch (error) {
        // Cut off by an abort or a platform restart: the fresh instance is owed the same revive, now.
        const code = errorCode(error);
        if (code === "FACET_ABORTED" || code === "FACET_RESTARTED") {
          this.#claimFacetAlarm(name, Date.now(), cause);
          continue;
        }
        if (code === "PERMANENT_FAILURE") {
          this.#deps.stream.append({
            type: "events.iterate.com/itx/work-failed",
            payload: { facet: name, error: error instanceof Error ? error.message : String(error) },
          });
          continue;
        }
        reportIssue("iterate-context.revive", error, { name });
        // A revive that threw spent nothing: the claim is put back, later each time.
        if (errorCode(error) === "NO_FACET") continue;
        const failures = this.#facetReviveFailed(name);
        this.#claimFacetAlarm(
          name,
          Date.now() + Math.min(REVIVE_AFTER_MS * 2 ** failures, REVIVE_AFTER_MAX_MS),
          cause,
        );
      }
    }
  }

  // `ctx.facets.abort` needs nothing from the facet, so one that would never answer resets too.
  async abort(name: string, reason: string | undefined): Promise<void> {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- name arrives as a client-authored itx expression argument; the static string type is the API contract, not a runtime guarantee
    if (typeof name !== "string")
      throw new Error("itx.facets.abort(name, reason?): name the facet");
    if (name === CoreContract.slug)
      throw new Error(`"${name}" is the core reduce — never a facet, nothing to abort`);
    if (firstPartyFacetClassOf(name)) assertFacetPlacement(name, this.#deps.path);
    else this.#facetStartupMemoFor(name, undefined);
    const why = reason ? `: ${reason}` : "";
    await this.#restart(name, "itx.facets.abort", () =>
      this.#abortFacetIfRunning(name, `facet "${name}" aborted${why}`, {
        code: "FACET_ABORTED",
        message: `facet "${name}" was aborted${why} — its next call starts it fresh`,
      }),
    );
  }

  // Every facet that may have written since its last start is started before this incarnation
  // writes anything (FACET_START_WATCHDOG_MS). A facet outlives its context's eviction, billed, so a
  // loaded, unclaimed one is reset first.
  async startFacetsTheLastIncarnationRan(): Promise<string[]> {
    const ran = Array.from(this.#deps.ctx.storage.kv.list({ prefix: "facet-ran:" }), ([key]) =>
      key.slice("facet-ran:".length),
    );
    for (const name of ran) this.#ranThisIncarnation.add(name);
    const reset = ran.filter(
      (name) => !firstPartyFacetClassOf(name) && !this.#facetClaims.has(name),
    );
    await this.#restartAll(
      "birth",
      ran.map((name) => ({
        name,
        abort: reset.includes(name)
          ? () =>
              this.#abortFacetIfRunning(name, "reset: loaded, unclaimed, and its context reborn")
          : null,
      })),
    );
    return reset;
  }

  async resetUnclaimedLoadedFacets(): Promise<string[]> {
    const reset = Array.from(this.#deps.ctx.storage.kv.list({ prefix: "facet-ran:" }), ([key]) =>
      key.slice("facet-ran:".length),
    ).filter((name) => !firstPartyFacetClassOf(name) && !this.#facetClaims.has(name));
    await this.#restartAll(
      "quiet",
      reset.map((name) => ({
        name,
        abort: () =>
          this.#abortFacetIfRunning(name, "reset: loaded, unclaimed, and its context quiet"),
      })),
    );
    return reset;
  }

  async #restart(name: string, why: string, abort: () => void): Promise<boolean> {
    const [started] = await this.#restartAll(why, [{ name, abort }]);
    return started!;
  }

  // Under `blockConcurrencyWhile`, so no commit lands between a facet's stop and its start
  // (FACET_START_WATCHDOG_MS). Never throws: a callback that throws there resets the object.
  #restartAll(
    why: string,
    restarts: { name: string; abort: (() => void) | null }[],
  ): Promise<boolean[]> {
    if (restarts.length === 0) return Promise.resolve([]);
    return this.#deps.ctx.blockConcurrencyWhile(() =>
      this.#betweenStopsAndStarts(async () => {
        for (const { abort } of restarts) abort?.();
        const owed: (() => void)[] = [];
        const batch = new AbortController();
        const deadline = criticalSectionDeadline(FACET_START_WATCHDOG_MS, batch.signal);
        const started = await Promise.all(
          restarts.map(({ name }) => this.#start(name, why, owed, deadline)),
        );
        batch.abort();
        for (const write of owed) write();
        return started;
      }),
    );
  }

  #stopsNotStarted = 0;
  readonly #writesAfterStarts: (() => void)[] = [];
  // a write that may come at any moment waits until no facet is between its stop and its start
  async #betweenStopsAndStarts<T>(work: () => Promise<T>): Promise<T> {
    this.#stopsNotStarted++;
    try {
      return await work();
    } finally {
      if (--this.#stopsNotStarted === 0)
        for (const write of this.#writesAfterStarts.splice(0)) write();
    }
  }
  #writeOutsideStarts(write: () => void): void {
    if (this.#stopsNotStarted > 0) this.#writesAfterStarts.push(write);
    else write();
  }

  // Kept here because ITX_KV's memo expires: at the root, a birth's call for the config's code would
  // loop (the producer mints its git token through the root's rules, which answer after the birth).
  // A keep comes a turn after its load, so it keeps only while the facet's identity is that load's.
  #keptModulesOf(name: string, memo: FacetSpec, loaderIdOf: () => string | undefined): KeptModules {
    const row = `facet:${name}:modules`;
    type Kept = { key: string; files: WorkerModules };
    return {
      get: (key) => {
        const kept = this.#deps.ctx.storage.kv.get<Kept>(row);
        return kept?.key === key ? kept.files : undefined;
      },
      keep: (key, files) => {
        if (2 * JSON.stringify(files).length > KEPT_MODULES_MAX_BYTES) return;
        this.#writeOutsideStarts(() => {
          if (this.#facetStartupMemoByName.get(name) !== memo) return;
          if (this.#loaderIdByName.get(name) !== loaderIdOf()) return;
          // never thrown: the write may run where a throw resets the object (`#restartAll`)
          try {
            this.#deps.ctx.storage.kv.put(row, { key, files } satisfies Kept);
          } catch (error) {
            console.warn({
              event: "facet.platform-failure-keep-modules",
              namespace: "iterate-context",
              name,
              message: String(error instanceof Error ? error.message : error).slice(0, 512),
            });
          }
        });
      },
    };
  }

  // A loaded facet's new identity is recorded only once it started, so nothing is written before.
  // Never throws.
  async #start(
    name: string,
    why: string,
    owed: (() => void)[],
    deadline: Promise<void>,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const steps: ItxExpression = [["listPublicMethods"]];
    const watchdog: FacetCallWatchdog = { watchdogMs: FACET_START_WATCHDOG_MS, onTimeout: "leave" };
    const startedIfRefused = (error: unknown) => {
      if (!isMissingRpcMethod(error, "listPublicMethods")) throw error;
    };
    const start = async () => {
      const firstPartyClassName = firstPartyFacetClassOf(name);
      const facetStartupMemo = firstPartyClassName
        ? undefined
        : this.#facetStartupMemoFor(name, undefined);
      const started = await this.#materialize(name, firstPartyClassName, facetStartupMemo, {
        platformStart: true,
      });
      try {
        await this.#call(started, name, steps, watchdog).catch(startedIfRefused);
        if (started.recordLoadedIdentity) owed.push(started.recordLoadedIdentity);
      } catch (error) {
        // Not queued behind a call's recovery of the same facet: this start holds
        // `blockConcurrencyWhile`, which that recovery would wait on.
        if (!this.#isRecoverableFacetFailure(name, error, started)) throw error;
        await this.#recover(
          name,
          firstPartyClassName,
          facetStartupMemo,
          steps,
          { failedOn: started, error },
          watchdog,
          {},
          owed,
        ).catch(startedIfRefused);
      }
    };
    try {
      // a start that lost the race runs on, and is not counted as a start
      await Promise.race([
        start(),
        deadline.then(() => {
          throw codedError(
            "TIMEOUT",
            `facet "${name}" start: no answer in ${FACET_START_WATCHDOG_MS / 1000}s`,
          );
        }),
      ]);
      owed.push(() => this.#markRan(name));
      return true;
    } catch (error) {
      if (errorCode(error) === "NO_FACET") return true;
      owed.push(() => this.#markRan(name));
      console.warn({
        event: isFacetStartPlatformFailure(error)
          ? "facet.platform-failure-start"
          : "facet.start-failed",
        namespace: "iterate-context",
        name,
        why,
        elapsedMs: Date.now() - startedAt,
        message: String(error instanceof Error ? error.message : error).slice(0, 512),
      });
      return false;
    }
  }

  #markRan(name: string): void {
    if (this.#ranThisIncarnation.has(name)) return;
    this.#ranThisIncarnation.add(name);
    this.#deps.ctx.storage.kv.put(`facet-ran:${name}`, true);
  }

  #facetReviveFailed(name: string) {
    const failures = (this.#facetReviveFailures.get(name) ?? 0) + 1;
    this.#facetReviveFailures.set(name, failures);
    this.#deps.ctx.storage.kv.put(`facet-claim-failures:${name}`, failures);
    return failures;
  }
  #facetRevived(name: string) {
    this.#facetReviveFailures.delete(name);
    this.#deps.ctx.storage.kv.delete(`facet-claim-failures:${name}`);
  }
  #claimFacetAlarm(
    name: string,
    at: number | null,
    cause = this.#facetClaims.get(name)?.cause,
  ): void {
    if (at === null) {
      this.#facetClaims.delete(name);
      this.#deps.ctx.storage.kv.delete(`facet-claim:${name}`);
    } else {
      const claim: FacetClaim = cause ? { at, cause } : { at };
      this.#facetClaims.set(name, claim);
      this.#deps.ctx.storage.kv.put(`facet-claim:${name}`, claim);
    }
    this.#deps.reconcileAlarm();
  }

  owedCause(dueBy: number): Cause | undefined {
    return deepestCause(
      [...this.#facetClaims.values()].filter(({ at }) => at <= dueBy).map(({ cause }) => cause),
    );
  }

  // The memo is the only place a materialization reads the source from, so without this a
  // re-enable with new source would keep running the old code.
  refreshFacetStartupMemosFromHostingConfigurations(committedEvents: StreamEvent[]): void {
    for (const event of committedEvents) {
      if (event.type !== "events.iterate.com/itx/subscription-configured") continue;
      const { name, target } = event.payload as SubscriptionConfiguredPayload;
      if (!target || !this.#deps.stream.coreReducedState.subscriptions[name]?.hostedFacet) continue;
      try {
        const spec = facetSpecFromHostingTarget(
          this.#deps.resolveItxExpression(normalizedItxExpression(target)).at(-1)!,
        );
        if (!spec || firstPartyFacetClassOf(spec.name)) continue;
        this.#facetStartupMemoFor(spec.name, spec as FacetSpec);
      } catch (error) {
        // The row landed; a memo that cannot be written now is the next call's to recover or refuse.
        reportIssue("iterate-context.facet-startup-memo", error, { name });
      }
    }
  }

  // Done after the commit and before the append returns: only the pre-commit state knows what the
  // removed row targeted. A row that only addressed a running facet deletes nothing.
  deleteFacetsWhoseHostingSubscriptionWasRemoved(
    committedEvents: StreamEvent[],
    subscriptionsBeforeCommit: CoreState["subscriptions"],
  ): void {
    for (const event of committedEvents) {
      if (event.type !== "events.iterate.com/itx/subscription-configured") continue;
      const { name, target } = event.payload as SubscriptionConfiguredPayload;
      const removedRow = !target ? subscriptionsBeforeCommit[name] : undefined;
      const hosted = removedRow?.hostedFacet;
      if (!hosted) continue;
      const stillHosted = Object.values(this.#deps.stream.coreReducedState.subscriptions).some(
        (row) => row.hostedFacet?.name === hosted.name,
      );
      if (!stillHosted) this.#deleteFacet(hosted.name, hosted.className);
    }
  }

  handle(name: string, spec?: FacetSpec): FacetHandle {
    const facetHandle = new FacetHandle((itxExpressionSteps) => {
      // A facet never answers a WebSocket: a socket a facet held would die with it, unseen by the
      // parent (1006). Refused before the memo, so an upgrade materializes nothing.
      const [first] = itxExpressionSteps;
      if (
        Array.isArray(first) &&
        first[0] === "fetch" &&
        first[1] instanceof Request &&
        first[1].headers.get("Upgrade")?.toLowerCase() === "websocket"
      )
        throw codedError(
          "FACET_NO_UPGRADE",
          `facet "${name}": a facet answers RPC and plain HTTP, never a WebSocket — a socket terminates at the edge; reach the facet by itx expression`,
        );
      const call = (cause: Cause | undefined) =>
        this.#callFacet(name, spec, itxExpressionSteps, { byItxExpression: true, cause });
      // a `fetch` carries the mark alone, which names nobody
      const steps = itxExpressionSteps.map(itxExpressionStepName);
      const cause =
        steps[0] === "fetch"
          ? this.#deps.cause()
          : this.#deps.causeOfCall(`${name}.${steps.join(".")}`.slice(0, 200));
      return cause instanceof Promise ? cause.then(call) : call(cause);
    });
    this.#facetAddressByFacetHandle.set(facetHandle, { name, spec });
    return facetHandle;
  }

  hostsLoadedCode(facetHandle: FacetHandle): boolean {
    const facetAddress = this.#facetAddressByFacetHandle.get(facetHandle);
    if (!facetAddress)
      throw new Error("facet: a FacetHandle this context's facet host never minted");
    return !firstPartyFacetClassOf(facetAddress.name);
  }

  // Checked against no list, and no walk can land on it.
  async callFacetAsPlatform(
    facet: string | FacetHandle,
    itxExpressionSteps: ItxExpression,
    cause = this.#deps.cause(),
  ): Promise<unknown> {
    if (typeof facet === "string")
      return this.#callFacet(facet, undefined, itxExpressionSteps, { cause });
    const facetAddress = this.#facetAddressByFacetHandle.get(facet);
    if (!facetAddress)
      throw new Error("facet: a FacetHandle this context's facet host never minted");
    return this.#callFacet(facetAddress.name, facetAddress.spec, itxExpressionSteps, { cause });
  }

  // Facet stubs are non-transferable, so the walk happens where the stub lives.
  async #callFacet(
    name: string,
    spec: FacetSpec | undefined,
    itxExpressionSteps: ItxExpression,
    { byItxExpression = false, cause }: FacetCallOptions = {},
  ): Promise<unknown> {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- name arrives as a client-authored itx expression argument; the static string type is the API contract, not a runtime guarantee, so a non-string is rejected with a usage error
    if (typeof name !== "string")
      throw new Error(
        "itx.facets.get(name, spec?): name the facet; pass { source, className } to load and host it",
      );
    if (itxExpressionSteps.length === 0) throw new Error(`facet: name a method`);
    // the core reduce answers at its facet-shaped address with a synthesized view: it is no facet
    if (name === CoreContract.slug) {
      if (spec) throw new Error(`"${name}" is the core reduce — never a facet name`);
      return (
        await walkSteps(
          {
            value: { snapshot: () => this.#deps.stream.coreReducedStateSnapshot() },
            receiver: undefined,
          },
          itxExpressionSteps,
        )
      ).value;
    }
    const firstPartyClassName = firstPartyFacetClassOf(name);
    if (firstPartyClassName && spec)
      throw new Error(
        `facet "${name}" is first-party — hosted from this worker's own ${firstPartyClassName}, never a loaded source; call itx.facets.get("${name}") without a spec`,
      );
    // a first-party class runs with the Worker's real env, so only where the host places it
    assertFacetPlacement(name, this.#deps.path);
    const facetStartupMemo = firstPartyClassName
      ? undefined
      : this.#facetStartupMemoFor(name, spec);
    // a processor's read holds every commit acknowledged before it
    if (PROCESSOR_READS.has(itxExpressionStepName(itxExpressionSteps[0]) ?? ""))
      await this.#deps.deliveriesQueuedFor(name);
    // a `fetch` carries the cause on its Request, the one channel a socket rides
    const [first, ...rest] = itxExpressionSteps;
    if (cause && Array.isArray(first) && first[0] === "fetch" && first[1] instanceof Request)
      itxExpressionSteps = [
        ["fetch", requestCausedBy(first[1], cause), ...first.slice(2)],
        ...rest,
      ];
    const callOptions = { byItxExpression, cause };
    this.#markRan(name);
    this.#facetWorkInFlight++;
    try {
      const materialized = await this.#materialize(name, firstPartyClassName, facetStartupMemo, {
        platformStart: false,
      });
      try {
        const answer = await this.#callOn(
          materialized,
          name,
          itxExpressionSteps,
          FACET_CALL_WATCHDOG,
          callOptions,
        );
        materialized.recordLoadedIdentity?.();
        return answer;
      } catch (error) {
        if (!this.#isRecoverableFacetFailure(name, error, materialized)) throw error;
        const owed: (() => void)[] = [];
        try {
          return await this.#afterEarlierRecoveries(name, () =>
            this.#betweenStopsAndStarts(() =>
              this.#recover(
                name,
                firstPartyClassName,
                facetStartupMemo,
                itxExpressionSteps,
                { failedOn: materialized, error },
                FACET_CALL_WATCHDOG,
                callOptions,
                owed,
              ),
            ),
          );
        } finally {
          for (const write of owed) write();
        }
      }
    } finally {
      this.#facetWorkInFlight--;
    }
  }

  // Public methods are read off the identity materialized, so a publication that makes a method
  // private refuses it on the very call that runs the new code.
  async #callOn(
    materialized: MaterializedFacet,
    name: string,
    itxExpressionSteps: ItxExpression,
    watchdog: FacetCallWatchdog,
    { byItxExpression = false, cause }: FacetCallOptions,
  ): Promise<unknown> {
    if (byItxExpression) {
      const publicMethods = materialized.loaderId
        ? await this.#publicMethodsOf(materialized, name)
        : firstPartyFacetPublicMethodsOf(name);
      assertFacetMethodIsPublic(name, publicMethods, itxExpressionSteps);
    }
    const withCause =
      cause &&
      itxExpressionStepName(itxExpressionSteps[0]) !== "fetch" &&
      (!materialized.loaderId || (await this.#publicMethodsOf(materialized, name)).length > 0);
    return await this.#call(
      materialized,
      name,
      withCause ? [["callWithCause", cause, itxExpressionSteps]] : itxExpressionSteps,
      watchdog,
    );
  }

  // Asked of the facet: a static does not cross the isolate. A class that is no SDK shell lists nothing.
  async #publicMethodsOf(materialized: MaterializedFacet, name: string) {
    const loaderId = materialized.loaderId!;
    let publicMethods = this.#publicMethodsByLoaderId.get(loaderId);
    if (publicMethods) return publicMethods;
    try {
      publicMethods = z
        .array(z.string())
        .parse(await this.#call(materialized, name, [["listPublicMethods"]], FACET_CALL_WATCHDOG));
    } catch (error) {
      if (!isMissingRpcMethod(error, "listPublicMethods")) throw error;
      publicMethods = [];
    }
    this.#publicMethodsByLoaderId.set(loaderId, publicMethods);
    return publicMethods;
  }

  // At most one retry on a replacement a peer put in place, and one restart for this call, so a
  // single failure never becomes a restart per call in flight. A replacement can be good for exactly
  // one call (seen on prd), so the second attempt may fail the same way.
  async #recover(
    name: string,
    firstPartyClassName: string | undefined,
    facetStartupMemo: FacetSpec | undefined,
    itxExpressionSteps: ItxExpression,
    failure: { failedOn: MaterializedFacet; error: unknown },
    watchdog: FacetCallWatchdog,
    callOptions: FacetCallOptions,
    owed: (() => void)[],
  ): Promise<unknown> {
    let { failedOn, error } = failure;
    let retriedOnReplacement = false;
    let restarted = false;
    for (;;) {
      if (facetStartupMemo && this.#facetStartupMemoByName.get(name) !== facetStartupMemo)
        throw codedError(
          "NO_FACET",
          `facet "${name}" was deleted or reconfigured while it recovered`,
        );
      if (this.#facetGeneration(name) !== failedOn.generation) {
        if (retriedOnReplacement) throw error;
        retriedOnReplacement = true;
      } else {
        if (restarted || !isFacetStartPlatformFailure(error)) throw error;
        restarted = true;
        this.#abortFacetIfRunning(name, "platform failure at facet start — restarting");
        failedOn.retireLoadedIdentity?.();
        const restarts = this.restarts(name) + 1;
        // written once the attempt ran, as its loaded identity is: nothing between abort and start
        owed.push(() => this.#deps.ctx.storage.kv.put(`facet:${name}:restarts`, restarts));
        console.warn({
          event: "facet.platform-failure-retry",
          namespace: "iterate-context",
          name,
          restarts,
          message: error.message,
        });
      }
      const attempt = await this.#materialize(name, firstPartyClassName, facetStartupMemo, {
        platformStart: true,
      });
      try {
        return await this.#callOn(attempt, name, itxExpressionSteps, watchdog, callOptions);
      } catch (attemptError) {
        if (!this.#isRecoverableFacetFailure(name, attemptError, attempt)) throw attemptError;
        failedOn = attempt;
        error = attemptError;
      } finally {
        if (attempt.recordLoadedIdentity) owed.push(attempt.recordLoadedIdentity);
      }
    }
  }

  #isRecoverableFacetFailure(
    name: string,
    error: unknown,
    attempt: MaterializedFacet,
  ): error is Error {
    if (attempt.startupFailed()) return false;
    if (isFacetStartPlatformFailure(error)) return true;
    return (
      error instanceof Error &&
      error.message === "platform failure at facet start — restarting" &&
      this.#facetGeneration(name) !== attempt.generation
    );
  }

  // A facet's class is minted only when it starts: a running one never touches the loader.
  async #materialize(
    name: string,
    firstPartyClassName: string | undefined,
    facetStartupMemo: FacetSpec | undefined,
    { platformStart }: { platformStart: boolean },
  ): Promise<MaterializedFacet> {
    // `fedByPushes` is read as the class is minted, and never taken back while the facet runs.
    let codeId = this.#deps.deployId;
    const propsAtStart = () =>
      ({
        iterateContextName: this.#deps.iterateContextName,
        name,
        codeId,
        ...(rowsPushingFacet(this.#deps.stream.coreReducedState, name).length > 0 && {
          fedByPushes: true,
        }),
      }) satisfies FacetProps;
    let mintClass: () => DurableObjectClass;
    let retireLoadedIdentity: (() => void) | undefined;
    let recordLoadedIdentity: (() => void) | undefined;
    let materializedLoaderId: string | undefined;
    if (firstPartyClassName) {
      const exportsOf = this.#deps.ctx.exports as unknown as Record<
        string,
        (options: { props: FacetProps }) => DurableObjectClass
      >;
      mintClass = () => exportsOf[firstPartyClassName]!({ props: propsAtStart() });
    } else {
      const memo = facetStartupMemo!;
      const resolved = await this.#workerOf(name, memo).then(
        (worker) => ({ worker }),
        (error: unknown) => ({ error }),
      );
      // A live facet outlasts a name it cannot read right now (the platform failed the read, not the
      // rule): it keeps the identity it has.
      const liveLoaderId = this.#liveFacetNames.has(name)
        ? this.#loaderIdByName.get(name)
        : undefined;
      if ("error" in resolved) {
        if (!liveLoaderId || !isPlatformFailureKind(failureKind(resolved.error)))
          throw resolved.error;
        materializedLoaderId = liveLoaderId;
        mintClass = () => {
          throw resolved.error;
        };
      } else {
        const { worker } = resolved;
        let preparedLoaderId: string | undefined;
        const { loaderId, load, retire } = await itxLoader(`facet "${name}"`).prepareConfinedWorker(
          {
            itxEntrypoint: this.#deps.itxEntrypoint(),
            kind: "facet",
            owner: [this.#deps.iterateContextName, memo.className],
            source: worker.source,
            cacheKey: worker.cacheKey,
            mainModule: memo.mainModule,
            moduleIdentity: worker.moduleIdentity,
            invoke: worker.invoke,
            kept: this.#keptModulesOf(name, memo, () => preparedLoaderId),
            where: `facet "${name}"`,
          },
        );
        preparedLoaderId = loaderId;
        // a deploy is other code to work in flight, even one that keeps the loaded identity
        codeId = JSON.stringify([this.#deps.deployId, loaderId]);
        // A removal or reconfigure may have landed while that awaited: a stale call must neither
        // resurrect a deleted facet as an orphan nor abort the newer one. The memo's identity is the check.
        if (this.#facetStartupMemoByName.get(name) !== memo)
          throw codedError(
            "NO_FACET",
            `facet "${name}" was deleted or reconfigured while its source resolved`,
          );
        // a newer publication was installed meanwhile: the facet only moves forward
        if (worker.started) {
          if ((this.#namedWorkerStarted(name, memo)?.generation ?? 0) > worker.started.generation)
            return this.#materialize(name, firstPartyClassName, facetStartupMemo, {
              platformStart,
            });
          this.#namedWorkerInstalled.set(name, worker.started);
        }
        // workerd hands back the same facet container on every `facets.get`, even one whose startup
        // rejected; only an abort clears it. The row is written once the facet started under the new identity.
        const recordedLoaderId = this.#row<string>(`facet:${name}:loader-id`);
        const previousLoaderId = this.#loaderIdByName.get(name) ?? recordedLoaderId;
        this.#loaderIdByName.set(name, loaderId);
        // a restart whose start failed leaves the facet stopped, and this call is its start
        let started = true;
        if (previousLoaderId && previousLoaderId !== loaderId) {
          console.info({
            event: "facet.loaded-identity-changed",
            namespace: "iterate-context",
            name,
            changed: loadedIdentityChanges(previousLoaderId, loaderId),
          });
          this.#publicMethodsByLoaderId.delete(previousLoaderId);
          const abort = () => this.#abortForRestart(name, "loaded identity changed");
          if (platformStart) abort();
          else {
            started = await this.#restart(name, "loaded identity changed", abort);
            if (this.#facetStartupMemoByName.get(name) !== memo)
              throw codedError(
                "NO_FACET",
                `facet "${name}" was deleted or reconfigured while it restarted`,
              );
          }
        }
        if (this.#row(`facet:${name}:loader-id`) !== loaderId)
          recordLoadedIdentity = () => {
            this.#putRow(`facet:${name}:loader-id`, loaderId);
            if (worker.started) this.#putRow(`facet:${name}:named-worker`, worker.started);
          };
        if (!platformStart && started) {
          recordLoadedIdentity?.();
          recordLoadedIdentity = undefined;
        }
        materializedLoaderId = loaderId;
        mintClass = () => load().getDurableObjectClass(memo.className, { props: propsAtStart() });
        retireLoadedIdentity = retire;
      }
    }
    // A cold facet's class is minted before `facets.get`, so a loader that refuses leaves no container
    // behind: a startup callback that throws leaves workerd's container broken until an abort.
    let startupClass = mintClass;
    if (!this.#liveFacetNames.has(name)) {
      const minted = mintClass();
      startupClass = () => minted;
    }
    let startupFailed = false;
    const facet = this.#deps.ctx.facets.get(name, () => {
      try {
        return { class: startupClass() };
      } catch (error) {
        startupFailed = true;
        throw error;
      }
    });
    this.#liveFacetNames.add(name);
    if (!firstPartyClassName && !platformStart) this.#deps.loadedFacetMaterialized();
    return {
      facet,
      retireLoadedIdentity,
      startupFailed: () => startupFailed,
      generation: this.#facetGeneration(name),
      recordLoadedIdentity,
      loaderId: materializedLoaderId,
    };
  }

  // Only a manifest the platform vouches for counts, and a facet never loads a worker older than the
  // one it last started under: two readers a publication apart would restart it back and forth.
  async #workerOf(name: string, memo: FacetSpec): Promise<FacetWorker> {
    if (!namesAWorker(memo))
      return { source: memo.source, cacheKey: memo.cacheKey, invoke: this.#deps.invoke };
    const named = await this.#deps.namedWorker(memo.source);
    const { source, cacheKey, moduleIdentity, generation } = namedWorkerLoad(
      named,
      memo.mainModule,
      `facet "${name}"`,
      memo.className,
    );
    if (generation === undefined) return { source, cacheKey, invoke: named.invoke };
    const started = this.#namedWorkerStarted(name, memo);
    if (started && started.generation > generation) return { ...started, invoke: named.invoke };
    return {
      source,
      cacheKey,
      moduleIdentity,
      invoke: named.invoke,
      started: {
        name: memo.source,
        mainModule: memo.mainModule,
        generation,
        source,
        cacheKey,
        moduleIdentity,
      },
    };
  }

  #namedWorkerStarted(name: string, memo: FacetSpec): NamedWorkerStarted | undefined {
    const matches = (started: NamedWorkerStarted | undefined) =>
      started && jsonEqual(started.name, memo.source) && started.mainModule === memo.mainModule
        ? started
        : undefined;
    return (
      matches(this.#namedWorkerInstalled.get(name)) ??
      matches(this.#row<NamedWorkerStarted>(`facet:${name}:named-worker`))
    );
  }

  async #call(
    { facet, startupFailed, generation }: MaterializedFacet,
    name: string,
    itxExpressionSteps: ItxExpression,
    { watchdogMs, onTimeout }: FacetCallWatchdog,
  ): Promise<unknown> {
    // Every step the walk went past holds a session onto the facet, and so this actor, until disposed.
    const rpcSessionsSteppedPast: unknown[] = [];
    const call = walkSteps(
      { value: facet, receiver: undefined },
      itxExpressionSteps,
      rpcSessionsSteppedPast,
    ).then((walked) => awaitAnswerReleasedIfRejected(walked.value));
    let result: unknown;
    try {
      // the label is built lazily: it prints the whole pushed batch
      result = await withTimeout(
        call,
        watchdogMs,
        // secret calls can carry material or operator credentials: never in a timeout message
        () =>
          name === "secret" ? 'facet "secret"' : `facet "${name}" ${print(itxExpressionSteps)}`,
      );
    } catch (error) {
      if (errorCode(error) === "TIMEOUT") {
        if (onTimeout === "leave")
          // a late answer's disposer references the facet, so it is disposed when it comes
          void call.then(
            (answer) => (answer as Partial<Disposable> | undefined)?.[Symbol.dispose]?.(),
            () => {},
          );
        else if (this.#facetGeneration(name) === generation)
          await this.#restart(name, "call timed out", () =>
            this.#abortForRestart(name, "call timed out", generation),
          );
      } else if (startupFailed())
        this.#abortFacetIfRunning(name, "startup failed", undefined, generation);
      const { endedBy } = generation;
      if (endedBy && isRejectionByEndOfRun(endedBy.code, error))
        throw codedError(endedBy.code, endedBy.message);
      throw error;
    } finally {
      releaseRpcSessions(rpcSessionsSteppedPast);
    }
    // A Workers-RPC result's disposer references the facet until disposed or GC'd, and GC is too
    // late: this actor could not be evicted. So the data is copied out and the result released.
    if (typeof result === "object" && result && Symbol.dispose in result) {
      let copy: unknown;
      try {
        copy = structuredClone(result);
      } catch {
        return result;
      }
      (result as Disposable)[Symbol.dispose]();
      return copy;
    }
    return result;
  }

  // Synchronous, so nothing slips in between the checks.
  #facetStartupMemoFor(name: string, spec: FacetSpec | undefined): FacetSpec {
    let facetStartupMemo =
      this.#facetStartupMemoByName.get(name) ??
      (this.#deps.ctx.storage.kv.get(`facet:${name}`) as FacetSpec | undefined);
    if (spec) {
      assertFacetSourceWithinCeiling(spec, `facet "${name}"`);
      const storedSpec = facetSpecOf(spec);
      // replaced only when it changed: an unchanged spec keeps the loader's identity-keyed hash
      if (!facetStartupMemo || JSON.stringify(facetStartupMemo) !== JSON.stringify(storedSpec)) {
        this.#deps.ctx.storage.kv.put(`facet:${name}`, storedSpec);
        facetStartupMemo = storedSpec;
      }
    }
    if (!facetStartupMemo) {
      // A hosting row keeps no source in core state: recovered once from the durable log event that
      // configured it.
      const row = Object.values(this.#deps.stream.coreReducedState.subscriptions).find(
        (candidate) => candidate.hostedFacet?.name === name,
      );
      if (row?.hostedFacet) {
        const [configuredEvent] = this.#deps.stream.read(row.configuredAtOffset - 1, 1).events;
        const configuredTarget = (
          configuredEvent?.payload as SubscriptionConfiguredPayload | undefined
        )?.target;
        const recoveredSpec = configuredTarget
          ? facetSpecFromHostingTarget(
              this.#deps.resolveItxExpression(normalizedItxExpression(configuredTarget)).at(-1)!,
            )
          : undefined;
        if (recoveredSpec) {
          const recovered = facetSpecOf(recoveredSpec as FacetSpec);
          this.#deps.ctx.storage.kv.put(`facet:${name}`, recovered);
          facetStartupMemo = recovered;
        }
      }
    }
    if (!facetStartupMemo)
      throw codedError("NO_FACET", `no facet "${name}" — load a class into it first`);
    this.#facetStartupMemoByName.set(name, facetStartupMemo);
    return facetStartupMemo;
  }

  #afterEarlierRecoveries<T>(name: string, recover: () => Promise<T>): Promise<T> {
    const recovery = (this.#facetRecoveryByName.get(name) ?? Promise.resolve()).then(recover);
    const settled = recovery.then(
      () => {},
      () => {},
    );
    this.#facetRecoveryByName.set(name, settled);
    void settled.then(() => {
      if (this.#facetRecoveryByName.get(name) === settled) this.#facetRecoveryByName.delete(name);
    });
    return recovery;
  }

  #abortFacetIfRunning(
    name: string,
    reason: string,
    endedBy?: FacetGeneration["endedBy"],
    expectedGeneration?: FacetGeneration,
  ): void {
    const generation = this.#facetGeneration(name);
    if (expectedGeneration && expectedGeneration !== generation) return;
    this.#liveFacetNames.delete(name);
    try {
      this.#deps.ctx.facets.abort(name, reason);
    } catch {
      return;
    }
    generation.endedBy = endedBy;
    this.#facetGenerationByName.set(name, {});
  }
  #abortForRestart(name: string, reason: string, expectedGeneration?: FacetGeneration): void {
    this.#abortFacetIfRunning(
      name,
      reason,
      {
        code: "FACET_RESTARTED",
        message: `facet "${name}" was restarted (${reason}) — its next call runs on the new instance`,
      },
      expectedGeneration,
    );
  }
  #facetGeneration(name: string): FacetGeneration {
    let generation = this.#facetGenerationByName.get(name);
    if (!generation) this.#facetGenerationByName.set(name, (generation = {}));
    return generation;
  }

  // The runtime aborts the facet it deletes, ending an unreleased call session on it `exception` with
  // no line; the prd fault alarm reads that summary in this Durable Object as this deletion's.
  #deleteFacet(name: string, className: string): void {
    if (name === CoreContract.slug)
      throw new Error(`"${name}" is the core reduce — always on, never a facet`);
    console.info({ event: "facet.deleted", name, message: `${className}.jsrpc` });
    this.#deps.ctx.facets.delete(name);
    this.#facetGeneration(name).endedBy = {
      code: "NO_FACET",
      message: `facet "${name}" was deleted while this call was in flight`,
    };
    this.#facetGenerationByName.set(name, {});
    this.#claimFacetAlarm(name, null);
    this.#facetRevived(name);
    this.#deps.ctx.storage.kv.delete(`facet:${name}`);
    this.#deleteRow(`facet:${name}:loader-id`);
    this.#deleteRow(`facet:${name}:named-worker`);
    this.#deps.ctx.storage.kv.delete(`facet:${name}:modules`);
    this.#deps.ctx.storage.kv.delete(`facet:${name}:restarts`);
    this.#deps.ctx.storage.kv.delete(`facet-ran:${name}`);
    this.#facetStartupMemoByName.delete(name);
    this.#loaderIdByName.delete(name);
    this.#ranThisIncarnation.delete(name);
    this.#liveFacetNames.delete(name);
  }
}

// `normalizeControlEvent` parses the target at the append boundary, so every committed event has it.
type SubscriptionConfiguredPayload = { name: string; target: ItxExpression | null };
