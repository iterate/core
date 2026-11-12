// Pure Workers-RPC: capnweb never terminates here. Dispatch is one method, `invoke`; every other
// change to this context is an appended event.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  codedError,
  errorCode,
  ITERATE_CAUSE_HEADER,
  releaseRpcSessions,
  reportIssue,
} from "iterate/lib";
import { DurableObject } from "cloudflare:workers";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import {
  canonicalItxExpressionPrefix,
  itxExpressionStepName,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  type ItxExpressionPrefix,
  InvokeHandle,
  normalizedItxExpression,
} from "iterate/expression";
import { ITX_PRINCIPAL_HEADER, type Principal } from "iterate/principal";
import type { RewriteRuleListEntry, StreamPage, SubscriptionListEntry } from "iterate/api";
import { ITERATE_ROUTING_SLUG_HEADER } from "iterate/mind-ingress";
import { RunRequested, type RunSettlement } from "iterate/stream/run";
import { failureKind, isPlatformFailureKind, logPlatformFailure } from "iterate/platform-retry";
import { causeOfDelivery, deepestCause, newChain, parseCause, type Cause } from "./cause.ts";
import {
  ITX_APP_HEADER,
  ITX_CALLER_PATH_HEADER,
  ITX_RUNS_ROW_HEADER,
  ITX_GRANT_HEADER,
  isConfigPointerMatch,
  refuseNonPlatformWrites,
  sha256Hex,
  stampCaller,
  type Caller,
} from "./caller.ts";
import {
  RpcStubHandle,
  itxAnswerDetachedFromSession,
  type FacetHandle,
} from "./context/dispatch.ts";
import { mintOnBehalfOf, type OnBehalfOf } from "./on-behalf-of.ts";
import { normalizeControlEvent, type CoreState } from "./stream/core-processor.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  parseFetchExpression,
  itxExpressionEndingInFetch,
  RpcStubDirectory,
  RPC_STUB_PAGER_KEEPALIVE_REQUEST,
  RPC_STUB_PAGER_KEEPALIVE_RESPONSE,
  type BorrowedRpcStub,
} from "./context/rpc-stubs.ts";
import { RpcStubFetchServer } from "./context/fetch-upgrade.ts";
import { waitForEventOnContext } from "./context-stub.ts";
import { Stream, type ReachableContext } from "./stream/stream.ts";
import { ALARM_MAX_REARMS, AlarmCoordinator } from "./alarm-coordinator.ts";
import { ancestorPathsOf, DurableObjectNameCodec } from "./context/paths.ts";
import { expressionFetchErrorAnswer } from "./unavailable.ts";
import { contexts, deployId, itxEntrypointFor, itxHost, type LibraryItx } from "./host.ts";
import { Connections } from "./context/connections.ts";
import { executeScript, runSettlementOf, settlementOfRun } from "./context/run.ts";
import { metrics } from "./metrics.ts";
import {
  ItxExpressionResolver,
  REWRITE_BUDGET,
  describeRewriteRules,
  rowsNamingRpcStub,
  refuseLiftingAJail,
  rpcStubKeysNamed,
  implicitRootsAt,
  namesTakenAway,
  rulesChangeNeedsCommitWait,
  type ItxExpressionRewriteRule,
} from "./context/itx-expression-rewriting.ts";
import { buildBuiltIns } from "./context/built-ins.ts";
import { refuseMoreArguments } from "./context/held-verbs.ts";
import { nameActiveSpan } from "./iterate-context.ts";
import { contextReach } from "./context/stateless-context.ts";
import { FacetHost } from "./context/facet-host.ts";
import type { NamedWorker } from "./context/worker-loader.ts";
import { firstPartyFacetClassOf } from "./first-party-facets.ts";
import { Residency } from "./context/residency.ts";
import { egress } from "./context/egress.ts";
import {
  SNAPSHOT_TTL_MS,
  UNPUBLISHED_ROOT_SNAPSHOT_TTL_MS,
  type RulesSnapshotAnswer,
} from "./context/rule-snapshots.ts";
import { SubscriptionDelivery, type DeliveryDeadline } from "./stream/subscription-delivery.ts";

// Reached by id alone (the context sweep), a context is its birth record; one with neither a birth
// record nor a name is refused, so no id alone ever mints one.
function iterateContextAddressOf(ctx: DurableObjectState) {
  if (ctx.id.name) return DurableObjectNameCodec.parse(ctx.id.name);
  let body: string | undefined;
  try {
    body = ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM events WHERE offset = 1")
      .toArray()[0]?.body;
  } catch {}
  const born = body
    ? (JSON.parse(body) as { type?: string; payload?: { path?: string } })
    : undefined;
  if (born?.type !== "events.iterate.com/itx/created" || !born.payload?.path) {
    const message =
      "IterateContextDurableObject must be addressed by name (reach it via getByName); by id, only a context that was born answers.";
    console.info({ event: "context.unborn-by-id", message });
    throw new Error(message);
  }
  return DurableObjectNameCodec.address(born.payload.path);
}

// Ephemeral and never an input: subscription delivery gets no trace and a trace moves no clock,
// or the tracing would trace itself.
export type AlarmTrace = {
  at: number;
  reason: "alarm-fired" | "alarm-pass" | "alarm-abandoned";
  error?: string;
  // `before` is null when the alarm itself woke this incarnation: workerd hides a firing alarm.
  alarm: { before: number | null; after: number | null };
  deadlines: {
    schedule: number | null;
    delivery: DeliveryDeadline[];
    deliveryOmitted: number;
    claims: { name: string; at: number }[];
    unclaimedFacetSweep: number | null;
  };
  durableHead: number;
  dueSchedules?: number;
  runs?: number;
  facetWorkInFlight: number;
  liveFacets: string[];
  borrowedRpcStubs: boolean;
  libraryHoldsSocket: boolean;
};

export type Env = object;

type RevocationFence = { until: number; takenAway: ItxExpressionPrefix[] };

const SNAPSHOT_ROW_TYPES: ReadonlySet<string> = new Set([
  "events.iterate.com/itx/rewrite-rule-configured",
  "events.iterate.com/itx/fetch-route-configured",
  "events.iterate.com/itx/ingress-configured",
]);

export class IterateContextDurableObject extends DurableObject<Env> {
  readonly #durableObjectAddress = iterateContextAddressOf(this.ctx);
  readonly #implicitRoots = implicitRootsAt(this.#durableObjectAddress.path);
  get #itxEntrypoint(): Fetcher {
    return itxEntrypointFor(this.ctx, this.#durableObjectAddress.name);
  }
  readonly #reach = contextReach({
    namespace: contexts(),
    ctx: this.ctx,
    ambient: () => this.#caller,
    readsRunSettlements: false,
  });
  readonly #rpcStubFetch = new RpcStubFetchServer(this.ctx, {
    deployId: deployId(),
    path: this.#durableObjectAddress.path,
    contextAbortedOffset: () =>
      this.#stream.coreReducedState.wokenAfterContextAbortedOffset ?? null,
  });
  readonly #rpcStubs = new RpcStubDirectory({
    rpcStubFetch: this.#rpcStubFetch,
    ctx: this.ctx,
    // The DO owns both ends of a lent stub's rule: this sets it, `#unsetWhatNamesRpcStub` un-sets it.
    appendEvents: (events) =>
      void this.#appendAndRunCommittedEffects(
        events.map((event) =>
          stampCaller(event, { principal: null }, this.#durableObjectAddress.path),
        ),
      ),
    // Ephemeral: the log must never claim a socket is open.
    onPresence: (kind, rpcStubKey) => {
      void this.append({
        type: `events.iterate.com/itx/rpc-stub-${kind}`,
        ephemeral: true,
        payload: { rpcStubKey },
      }).catch(() => undefined);
      // Decided here, not in the lender's session: a reconnect replaces the pager (never a detach),
      // so only this side knows a close is the last.
      if (kind === "detached") this.#unsetWhatNamesRpcStub(rpcStubKey);
    },
  });

  #unsetWhatNamesRpcStub(rpcStubKey: string): void {
    // One census before any append, so the answer never depends on the order of the removals. A rule
    // is removed, never masked: a mask is a caller's deliberate deny.
    const { ruleUnsets, subscriptionNames, fetchRouteNames } = rowsNamingRpcStub({
      rpcStubKey,
      ...this.#rowsForRpcStubCensus(),
    });
    const unset = (event: StreamEventInput) => {
      try {
        this.#appendAndRunCommittedEffects([event]);
      } catch {
        // A paused stream refuses it: the next wake's census un-sets it.
      }
    };
    // `ifTarget`: a `provide` that re-claims the match meanwhile is not clobbered.
    for (const { match, ifTarget } of ruleUnsets)
      unset({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match, target: null, ifTarget },
      });
    for (const name of subscriptionNames)
      unset({
        type: "events.iterate.com/itx/subscription-configured",
        payload: { name, target: null },
      });
    for (const fetchRouteName of fetchRouteNames)
      unset({
        type: "events.iterate.com/itx/fetch-route-configured",
        payload: { fetchRouteName, requestMatcher: null },
      });
  }

  #rowsForRpcStubCensus(): {
    rules: ItxExpressionRewriteRule[];
    subscriptionTargets: Record<string, ItxExpression>;
    fetchRouteTargets: Record<string, ItxExpression>;
    implicitRoots: ReadonlySet<string>;
  } {
    const { itxExpressionRewriteRules, subscriptions, fetchRoutes } = this.#stream.coreReducedState;
    return {
      implicitRoots: this.#implicitRoots,
      rules: Object.values(itxExpressionRewriteRules),
      subscriptionTargets: Object.fromEntries(
        Object.entries(subscriptions).map(([name, row]) => [name, row.target]),
      ),
      fetchRouteTargets: Object.fromEntries(
        Object.entries(fetchRoutes).map(([fetchRouteName, route]) => [
          fetchRouteName,
          route.target,
        ]),
      ),
    };
  }

  // A deploy kills every hibernatable socket silently, and a pause refuses an un-set, so the wake and
  // the resume un-set every key with no transport; a live lender re-dials and re-appends its row.
  #unsetWhatNamesDeadRpcStubs(committedEvents: StreamEvent[]): void {
    const sweep = committedEvents.some(
      (event) =>
        event.type === "events.iterate.com/itx/woken" ||
        event.type === "events.iterate.com/itx/resumed",
    );
    if (!sweep) return;
    const named = rpcStubKeysNamed(this.#rowsForRpcStubCensus());
    queueMicrotask(() => {
      const present = new Set(this.#rpcStubs.listRpcStubKeys());
      for (const rpcStubKey of named)
        if (!present.has(rpcStubKey)) this.#unsetWhatNamesRpcStub(rpcStubKey);
    });
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking this DO. DO-wide, so it covers eyeball sockets too: the
    // literal is distinctive so it never hijacks a client frame.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        RPC_STUB_PAGER_KEEPALIVE_REQUEST,
        RPC_STUB_PAGER_KEEPALIVE_RESPONSE,
      ),
    );
    // No wake record here: the first entry point names the wake and its cause, and a call past the
    // loop limit wakes nothing. Not awaited: the runtime holds every event until this settles.
    void this.ctx.blockConcurrencyWhile(async () => {
      this.#alarmCoordinator.restore(await this.ctx.storage.getAlarm());
      // Before this incarnation writes anything, so a facet evicted mid-write meets no commit stopped.
      await this.#residency.resetUnclaimedFacetsAtBirth();
      this.#stream.storage.countIncarnation();
      if (this.#stream.highestDurableOffset() > 0)
        // 250 ms: how far apart the clocks of two machines a context runs on may be.
        this.#snapshotLeaseUntil = Date.now() + SNAPSHOT_TTL_MS + 250;
      this.#alarmCoordinator.rearmIfOverdue(Date.now());
    });
  }

  // `ctx.abort` logs its message as an uncatchable error line, so the expected outcome is logged
  // first, at info.
  #abort(message: string): void {
    console.info({ event: "context.aborted", message });
    this.ctx.abort(message);
  }

  // Delivery runs as the kernel, never under the committing call's caller, which the async store
  // would otherwise carry into every continuation.
  readonly #stream = new Stream({
    storage: this.ctx.storage,
    deployId: deployId(),
    path: this.#durableObjectAddress.path,
    birthEvents: itxHost().birthEvents?.(this.#durableObjectAddress.path),
    wakeRecordDetail: () => this.#residency.wakeRecordDetail(),
    cause: () => this.#callerStorage.getStore()?.cause,
    onCommit: (freshEvents, afterOffset, throughOffset) => {
      const events = freshEvents.filter(
        (event) => event.type !== "events.iterate.com/itx/alarm-trace",
      );
      if (events.length === 0) return;
      const deliveryMayHaveClaimed = this.#callerStorage.run({ principal: null }, () => {
        const claimed = this.#subscriptionDelivery.onCommit(events, afterOffset, throughOffset);
        this.#startRequestedRuns(events);
        return claimed;
      });
      const woken = events.find((event) => event.type === "events.iterate.com/itx/woken");
      if (woken) this.#announceToAncestors(woken.source?.cause);
      this.#measureSize();
      this.#unsetWhatNamesDeadRpcStubs(events);
      // A batch of ephemerals that no cursor row delivers and that requests no run moves no deadline.
      if (
        deliveryMayHaveClaimed ||
        events.some(
          (event) => !event.ephemeral || event.type === "events.iterate.com/itx/run-requested",
        )
      )
        this.#alarmCoordinator.reconcile();
    },
  });

  // Fire-and-forget: a parent may be mid-call into this child, so waiting here could deadlock.
  #announceToAncestors(cause: Cause | undefined): void {
    const { path } = this.#durableObjectAddress;
    const ancestorPaths = ancestorPathsOf(path);
    if (ancestorPaths.length === 0 || this.ctx.storage.kv.get("ancestors-announced")) return;
    const announced = Promise.all(
      ancestorPaths.map((ancestorPath) =>
        this.#reach.contextOf(ancestorPath).append({
          type: "events.iterate.com/itx/child-created",
          idempotencyKey: `itx/child-created:${path}`,
          payload: { childPath: path },
          source: { origin: path, cause },
        }),
      ),
    ).then(
      () => {
        this.ctx.storage.kv.put("ancestors-announced", true);
      },
      (error: unknown) => {
        console.error({
          event: "context.announce-to-ancestors-failed",
          path,
          error: String(error),
        });
      },
    );
    this.ctx.waitUntil(announced);
  }

  async append(...events: StreamEventInput[]): Promise<StreamEvent[]> {
    this.#inboundRequestInOneTurn(
      "append",
      deepestCause(events.map((event) => event.source?.cause)),
    );
    return this.#appendWaitingOutOlderSnapshots(events);
  }

  async #appendWaitingOutOlderSnapshots(events: StreamEventInput[]): Promise<StreamEvent[]> {
    const before = this.#stream.coreReducedState;
    const committed = this.#appendAndRunCommittedEffects(events);
    await this.#waitOutOlderSnapshots(
      before,
      events.some((event) => SNAPSHOT_ROW_TYPES.has(event.type)),
    );
    return committed;
  }

  // A write that changes nothing (a repeat, a replay) waits out the pending fence.
  async #waitOutOlderSnapshots(before: CoreState, writesSnapshotRows: boolean): Promise<void> {
    const after = this.#stream.coreReducedState;
    const fence = this.#pendingFence();
    if (!fence) return;
    const waits =
      before.snapshotVersion === after.snapshotVersion
        ? writesSnapshotRows
        : this.#snapshotChangeNeedsCommitWait(before, after, fence.takenAway);
    for (let wait; waits && (wait = fence.until - Date.now()) > 0;)
      await new Promise((resolve) => setTimeout(resolve, wait));
  }

  // Taken in the commit's own turn by every commit, a schedule's too.
  #takeRevocationFence(before: CoreState): void {
    const after = this.#stream.coreReducedState;
    const pending = this.#pendingFence();
    if (!this.#snapshotChangeNeedsCommitWait(before, after, pending?.takenAway)) return;
    const until = Math.max(pending?.until ?? 0, this.#snapshotLeaseUntil);
    if (until <= Date.now()) return;
    this.#fence = {
      until,
      takenAway: [
        ...(pending?.takenAway || []),
        ...namesTakenAway(before.itxExpressionRewriteRules, after.itxExpressionRewriteRules),
      ],
    };
    this.ctx.storage.kv.put<RevocationFence>("rule-revocation-fence", this.#fence);
  }

  #snapshotChangeNeedsCommitWait(
    before: CoreState,
    after: CoreState,
    takenAway: readonly ItxExpressionPrefix[] | undefined,
  ): boolean {
    return (
      before.fetchRoutes !== after.fetchRoutes ||
      before.ingressTarget !== after.ingressTarget ||
      (!!this.#caller.platform &&
        before.itxExpressionRewriteRules !== after.itxExpressionRewriteRules) ||
      rulesChangeNeedsCommitWait(
        before.itxExpressionRewriteRules,
        after.itxExpressionRewriteRules,
        this.#implicitRoots,
        takenAway,
      )
    );
  }

  #pendingFence(): RevocationFence | undefined {
    if (this.#fence === undefined)
      this.#fence = this.ctx.storage.kv.get<RevocationFence>("rule-revocation-fence") ?? null;
    return this.#fence && this.#fence.until > Date.now() ? this.#fence : undefined;
  }

  // Cached: `#takeRevocationFence` is its only writer, and reading storage per append cost CPU.
  #fence: RevocationFence | null | undefined;

  #snapshotLeaseUntil = 0;

  // A version is this life's: a context born again over empty storage counts offsets from 1. A read
  // records nothing, so it wakes no context and births none.
  rulesSnapshot(ifVersion?: string): RulesSnapshotAnswer {
    this.#nameActiveSpan();
    this.#residency.inboundCallInOneTurn();
    const { snapshotVersion, itxExpressionRewriteRules, fetchRoutes, ingressTarget } =
      this.#stream.coreReducedState;
    const rules = Object.values(itxExpressionRewriteRules);
    const { path } = this.#durableObjectAddress;
    const unpublishedRoot = path === "/" && !rules.some(({ match }) => isConfigPointerMatch(match));
    const ttlMs = unpublishedRoot ? UNPUBLISHED_ROOT_SNAPSHOT_TTL_MS : SNAPSHOT_TTL_MS;
    this.#snapshotLeaseUntil = Math.max(this.#snapshotLeaseUntil, Date.now() + ttlMs);
    let life = this.ctx.storage.kv.get<string>("life");
    if (!life && this.#stream.highestDurableOffset() > 0)
      this.ctx.storage.kv.put("life", (life = crypto.randomUUID()));
    const version = `${life || "unborn"}:${snapshotVersion}`;
    if (ifVersion === version) return { version, ttlMs };
    return { version, rules, routing: { fetchRoutes, ingressTarget }, ttlMs };
  }

  #inboundRequestInOneTurn(call: string, cause?: Cause): void {
    this.#nameActiveSpan();
    this.#residency.inboundCallInOneTurn();
    this.#stream.appendWakeRecord({ cause: "call", caller: "other", call }, cause);
  }

  #nameActiveSpan(): void {
    nameActiveSpan(this.#durableObjectAddress);
  }

  // Synchronous: the pager attach needs the refusal in the turn it accepted the socket.
  #appendAndRunCommittedEffects(events: StreamEventInput[]): StreamEvent[] {
    const stateBeforeCommit = this.#stream.coreReducedState;
    const { subscriptions: subscriptionsBeforeCommit } = stateBeforeCommit;
    const headBeforeCommit = this.#stream.highestAssignedOffset();
    const normalized = events.map((event) =>
      normalizeControlEvent(event, this.#durableObjectAddress.path),
    );
    refuseLiftingAJail(
      normalized,
      this.#stream.coreReducedState.itxExpressionRewriteRules,
      this.#caller,
    );
    refuseNonPlatformWrites(normalized, this.#caller);
    const committedEvents = this.#stream.append(...normalized);
    this.#takeRevocationFence(stateBeforeCommit);
    // Fresh commits only: re-running an effect on an idempotency echo could revert later state.
    const freshEvents = committedEvents.filter((event) => event.offset > headBeforeCommit);
    this.#facetHost.deleteFacetsWhoseHostingSubscriptionWasRemoved(
      freshEvents,
      subscriptionsBeforeCommit,
    );
    this.#facetHost.refreshFacetStartupMemosFromHostingConfigurations(freshEvents);
    return committedEvents;
  }

  async read(
    afterOffset = 0,
    limit = 500,
    options: { includeEphemeral?: boolean } = {},
  ): Promise<StreamPage> {
    this.#inboundRequestInOneTurn("read");
    return this.#stream.read(afterOffset, limit, options);
  }

  async #rewriteRuleListAt(
    depth: number,
    path = this.#durableObjectAddress.path,
  ): Promise<RewriteRuleListEntry[]> {
    return describeRewriteRules({
      rules: await this.#rulesAt(path),
      implicitRoots: implicitRootsAt(path),
      path,
      depth,
      inherit: (there, hopsLeft) => this.#rewriteRuleListAt(hopsLeft, there),
    });
  }

  async #rulesAt(path: string): Promise<readonly ItxExpressionRewriteRule[]> {
    if (path === this.#durableObjectAddress.path)
      return Object.values(this.#stream.coreReducedState.itxExpressionRewriteRules);
    return (await this.#reach.snapshotOf(path)).rules;
  }

  // The caller crosses without its `app` bit: the library's own hops are the platform's act, and the
  // context's table already says what it may reach of the library.
  readonly #libraryItx = new InvokeHandle((steps) => {
    this.#residency.pinCallStarted();
    const { app: _loadedCode, ...caller } = this.#caller;
    return this.#invokeInProcess(["itx", ...steps], [], caller).finally(() =>
      this.#residency.pinCallEnded(),
    );
  }) as unknown as LibraryItx;
  readonly #connections = new Connections();

  // A run a dead incarnation left open is not here: the wake record settles it `interrupted`, and a
  // run is never re-run.
  readonly #scriptRunsInFlight = new Set<number>();
  readonly #runsOwedToTheAlarm = new Map<
    number,
    { code: string; requestedAt: number; requester: Requester | undefined }
  >();

  // A processor's run starts in the next alarm pass, a fresh invocation: Cloudflare's subrequest
  // depth limit (not configurable) ran out for runs started at the commit of a loop of turns.
  #startRequestedRuns(committedEvents: StreamEvent[]): void {
    for (const event of committedEvents) {
      if (event.type !== "events.iterate.com/itx/run-requested") continue;
      const { code } = event.payload as RunRequested;
      const requester = requesterOf(event);
      if (event.source?.processor)
        this.#runsOwedToTheAlarm.set(event.offset, { code, requestedAt: Date.now(), requester });
      else this.#startRun(event.offset, code, requester);
    }
  }

  #startRunsOwedToTheAlarm(): number {
    const owed = [...this.#runsOwedToTheAlarm];
    this.#runsOwedToTheAlarm.clear();
    return owed.filter(([offset, { code, requester }]) => this.#startRun(offset, code, requester))
      .length;
  }

  #startRun(requestOffset: number, code: string, requester: Requester | undefined): boolean {
    if (
      this.#scriptRunsInFlight.has(requestOffset) ||
      !this.#stream.coreReducedState.scriptRuns[requestOffset]
    )
      return false;
    this.#scriptRunsInFlight.add(requestOffset);
    void this.#executeRun(requestOffset, code, requester);
    return true;
  }

  async #executeRun(
    requestOffset: number,
    code: string,
    requester: Requester | undefined,
  ): Promise<void> {
    const cause = this.#stream.coreReducedState.scriptRuns[requestOffset]?.cause;
    // Straight onto the stream: no writer can append the platform's own record.
    const settle = (settlement: RunSettlement) =>
      this.#stream.append({
        type: "events.iterate.com/itx/run-settled",
        idempotencyKey: `itx/run-settled:${requestOffset}`,
        payload: { requestOffset, settlement },
        source: cause && { cause },
      });
    try {
      const { signingSecret, loader } = itxHost();
      const scriptCause =
        cause && requester && signingSecret
          ? {
              ...cause,
              onBehalfOf: await mintOnBehalfOf(
                { ...requester, run: `${this.#durableObjectAddress.path}@${requestOffset}` },
                await signingSecret(),
                Date.now(),
              ),
            }
          : cause;
      const settlement: RunSettlement = loader
        ? await runSettlementOf(
            this.#callerStorage.run({ principal: null, cause: scriptCause }, () =>
              this.#scriptExecution(code),
            ),
          )
        : {
            status: "failed",
            error: "itx.run: this Worker loads no code (its host has no loader)",
            failureKind: "runtime",
          };
      try {
        settle(settlement);
      } catch (error) {
        if (errorCode(error) !== "EVENT_TOO_LARGE") throw error;
        settle({
          status: "failed",
          error: `${error instanceof Error ? error.message : String(error)} — write a large result to itx.files and return its path`,
          failureKind: "runtime",
        });
      }
    } catch (error) {
      // An instance Cloudflare replaced mid-run can no longer write; its successor settles the run.
      const kind = failureKind(error);
      if (isPlatformFailureKind(kind))
        logPlatformFailure("iterate-context", "run-settle", kind, {
          name: "run-settled",
          message: String(error),
          requestOffset,
        });
      else reportIssue("iterate-context.run-settle", error, { requestOffset });
    } finally {
      this.#scriptRunsInFlight.delete(requestOffset);
    }
  }

  // A mask on `run` says what code here may spell, never where a request already on this log runs.
  async #scriptExecution(code: string): Promise<unknown> {
    let redirect: ItxExpression | undefined;
    try {
      const resolvedRun = this.#itxExpressionResolver.resolve(["itx", ["run", code]]).at(-1)!;
      const runsHere =
        resolvedRun.length === 3 &&
        resolvedRun[1] === "builtins" &&
        itxExpressionStepName(resolvedRun[2]) === "run";
      if (!runsHere) redirect = resolvedRun;
    } catch (error) {
      if (errorCode(error) !== "NO_ITX_EXPRESSION_MATCH") throw error;
    }
    if (!redirect) {
      const cause = {
        ...causeOfDelivery([{ source: { cause: this.#caller.cause } }]),
        onBehalfOf: this.#caller.cause?.onBehalfOf,
      };
      return this.#callerStorage.run({ ...this.#caller, cause }, () =>
        executeScript(this.#libraryItx, code),
      );
    }
    const answer = await this.#itxExpressionResolver.invoke(redirect);
    return settlementOfRun(answer, waitForEventOnContext(contexts())) ?? answer;
  }

  // A loopback records no wake and is no inbound call: an entry point already woke this incarnation.
  readonly #localContext: ReachableContext = {
    fetch: (request) => this.#serveFetch(request),
    append: (...events) => this.#appendWaitingOutOlderSnapshots(events),
    read: async (afterOffset, limit, options) => this.#stream.read(afterOffset, limit, options),
    reserveSend: async (key) => this.reserveSend(key),
    releaseSend: async (key) => this.releaseSend(key),
    invoke: (call, args = [], caller = this.#caller) =>
      this.#callerStorage.run(caller, () => this.#itxExpressionResolver.invoke(call, ...args)),
  };

  readonly #builtIns = buildBuiltIns({
    path: this.#durableObjectAddress.path,
    iterateContextName: this.#durableObjectAddress.name,
    invoke: (call) => this.#invokeAsLoadedCode(call),
    namedWorker: (source) => this.#namedWorker(source),
    context: (p) =>
      p === this.#durableObjectAddress.path ? this.#localContext : this.#reach.contextOf(p),
    egress: (request) => this.#egress(request),
    caller: () => this.#caller,
    invokeAs: (caller, call) => this.#invokeInProcess(call, [], caller),
    // A genuine RpcTarget, so a mid-chain call pipelines: workerd rejects a Proxy (workerd#6873).
    rpcStubs: {
      get: (rpcStubKey, ...more: unknown[]) => {
        refuseMoreArguments("rpcStubs.get(key)", more);
        // A key that is no string could still find a stub by how it prints: one stub, one spelling.
        // oxlint-disable-next-line iterate/simple-truthiness-check -- the key is a step's argument, which a caller writes: its declared type is not what arrives
        if (typeof rpcStubKey !== "string")
          throw codedError("INVALID_INPUT", "rpcStubs.get(key) takes a stub's key, a string");
        return new RpcStubHandle((itxExpressionSteps) => {
          this.#residency.pinCallStarted();
          return this.#rpcStubs
            .invokeRpcStub(rpcStubKey, itxExpressionSteps)
            .finally(() => this.#residency.pinCallEnded());
        });
      },
      list: () => this.#rpcStubs.listRpcStubKeys(),
    },
    claimFacetAlarm: (name, at) => {
      this.#residency.outsideActivityEnded();
      this.#facetHost.claim(name, at, this.#caller.cause);
      // The sweep may have disarmed while the claim held the facet. It never resets a first-party one.
      if (at === null && !firstPartyFacetClassOf(name)) this.#residency.armUnclaimedFacetSweep();
    },
    facets: {
      get: (name, spec, ...more: unknown[]) => {
        refuseMoreArguments("facets.get(name, spec)", more);
        return this.#facetHost.handle(name, spec);
      },
      abort: (name, reason) => this.#facetHost.abort(name, reason),
    },
    abortAfterTheAnswer: (message) => this.#abortAfterTheAnswer(message),
    schedules: {
      list: () => Object.values(this.#stream.coreReducedState.schedules),
      get: (key) => this.#stream.coreReducedState.schedules[key] ?? null,
    },
    subscriptions: {
      list: () => this.#subscriptionList(),
      get: (name) => this.#subscriptionList().find((s) => s.name === name) ?? null,
    },
    fetchRoutes: () => this.#stream.coreReducedState.fetchRoutes,
    rewriteRules: {
      list: (depth = REWRITE_BUDGET) => this.#rewriteRuleListAt(depth),
      get: async (match) => {
        let key: string;
        try {
          key = canonicalItxExpressionPrefix(match);
        } catch {
          return null;
        }
        return (await this.#rewriteRuleListAt(0)).find((row) => row.match === key) ?? null;
      },
      resolve: (call) => this.#itxExpressionResolver.resolve(call).map((step) => print(step)),
    },
    // "No event" alone cannot tell a deadline not yet due from one the runtime held.
    waitForEvent: (filter) =>
      this.#stream.waitForEvent(filter).catch((error: unknown) => {
        if (errorCode(error) !== "WAIT_TIMEOUT") throw error;
        throw codedError(
          "WAIT_TIMEOUT",
          `${(error as Error).message} — ${this.#alarmStory(Date.now())}`,
        );
      }),
    itxEntrypoint: () => this.#itxEntrypoint,
    itx: this.#libraryItx,
    connections: this.#connections,
  });

  // Declared after `#builtIns`: class fields initialize in order.
  readonly #itxExpressionResolver = new ItxExpressionResolver({
    reach: {
      ...this.#reach,
      recordLoopLimit: (_path, cause, message) => this.#stream.recordLoopLimit(cause, message),
    },
    rewriteRules: () => Object.values(this.#stream.coreReducedState.itxExpressionRewriteRules),
    builtIns: this.#builtIns,
    path: this.#durableObjectAddress.path,
    caller: () => this.#caller,
  });

  // `ctx.abort` rejects an answer the output gate still holds, so the answer's own turn is a
  // critical section, `sync()` makes the fact durable, and the reset is one turn after.
  #abortAfterTheAnswer(message: string) {
    void this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.sync();
      setTimeout(() => this.#abort(message), 0);
    });
  }

  readonly #metrics = metrics(itxHost().metrics, this.#durableObjectAddress.path);
  #sizeMeasuredAt = -Infinity;

  #measureSize(): void {
    if (Date.now() - this.#sizeMeasuredAt < 3_600_000) return;
    this.#sizeMeasuredAt = Date.now();
    this.#metrics("context.size", [
      this.ctx.storage.sql.databaseSize,
      this.#stream.highestDurableOffset(),
    ]);
  }

  // Yields to the event loop every 8 appends, or a burst holds back the
  // pushes to subscribers. A count, since a Worker's clock stands still between calls with no I/O.
  #directAppendFor(facetHandle: FacetHandle) {
    const caller = {
      principal: null,
      ...(this.#facetHost.hostsLoadedCode(facetHandle)
        ? { app: true as const }
        : { path: this.#durableObjectAddress.path }),
    };
    return async (cause: unknown, events: StreamEventInput[]): Promise<unknown> => {
      const appended = this.invoke(["itx", ["append", ...events]], [], {
        ...caller,
        cause: parseCause(cause) || newChain("loaded code"),
      });
      if (++this.#directAppends % 8 !== 0) return appended;
      // started before the yield, so an append sent after it never lands first
      const [answer] = await Promise.all([
        appended,
        new Promise((resolve) => setTimeout(resolve, 0)),
      ]);
      return answer;
    };
  }
  #directAppends = 0;

  readonly #subscriptionDelivery = new SubscriptionDelivery({
    stream: this.#stream,
    // Never with delivery authority, whatever the store holds. And as a row's run
    // (`Caller.runsRow`): a target that is a call is run here, when its head is read.
    evaluateItxExpression: (itxExpression) =>
      this.#callerStorage.run({ principal: null, runsRow: true }, () =>
        this.#itxExpressionResolver.evaluate(itxExpression),
      ),
    refuseHeldVerb: (target) =>
      this.#callerStorage.run({ principal: null }, () =>
        this.#itxExpressionResolver.refuseHeldVerb(target),
      ),
    pushEventBatchToFacet: (facetHandle, events, range) =>
      this.#facetHost.callFacetAsPlatform(facetHandle, [
        ["processEventBatch", events, range, this.#directAppendFor(facetHandle)],
      ]),
    catchUpFacetFromLog: (facetHandle, cause) =>
      this.#facetHost.callFacetAsPlatform(facetHandle, [["catchUpFromLog"]], cause),
    reconcileAlarm: () => this.#alarmCoordinator.reconcile(),
    runAsDelivery: async (events, call, delivery) => {
      const caller: Caller = { principal: null, runsRow: true, cause: causeOfDelivery(events) };
      if (delivery) caller.cause = { ...caller.cause!, writeKey: delivery };
      caller.delivery = await sha256Hex(JSON.stringify(delivery ? events[0] : events));
      return this.#callerStorage.run(caller, call);
    },
    // Through the target context's own rewrite rules, as `itx.cd(path).append` would be.
    appendCopy: async (path, { copiedFrom, ...eventCopy }) => {
      const context =
        path === this.#durableObjectAddress.path ? this.#localContext : this.#reach.contextOf(path);
      const appended = await context.invoke(["itx", ["append", eventCopy]], [], {
        principal: null,
        path: copiedFrom.path,
        cause: this.#caller.cause,
        copiedFrom,
      });
      releaseRpcSessions([appended]);
    },
    abortIncarnation: (reason) => this.#abortAfterTheAnswer(reason),
    metrics: this.#metrics,
  });

  readonly #alarmCoordinator = new AlarmCoordinator({
    setAlarm: (at) => this.ctx.storage.setAlarm(at),
    deleteAlarm: () => this.ctx.storage.deleteAlarm(),
    deadlines: () => [
      ...this.#durableAlarmDeadlines(),
      ...Object.values(this.#residency.deadlines()),
      ...[...this.#runsOwedToTheAlarm.values()].map(({ requestedAt }) => requestedAt),
    ],
    held: () => this.#residency.holdsResident() || this.#runsOwedToTheAlarm.size > 0,
    // The prd fault alarm's pin (PINNED_WORKAROUNDS) counts the re-arm warning.
    onOverdue: ({ armedAt, overdueMs, action, rearms }) => {
      const detail = {
        name: this.#durableObjectAddress.name,
        armedAt: new Date(armedAt).toISOString(),
        overdueMs,
        rearms,
      };
      if (action === "give-up")
        reportIssue(
          "iterate-context.alarm-overdue",
          new Error(
            `the alarm armed for ${detail.armedAt} is still due ${overdueMs} ms past its time after ${ALARM_MAX_REARMS} re-arms of the overdue watch`,
          ),
          detail,
        );
      else
        console.warn({
          event: "iterate-context.platform-failure-alarm-rearm",
          namespace: "iterate-context",
          message: "the runtime held an armed alarm past its time; re-armed it for now",
          ...detail,
        });
    },
  });

  // What a fresh incarnation derives again; the sweep and the owed runs are this incarnation's alone.
  #durableAlarmDeadlines(): (number | null)[] {
    return [
      this.#stream.nextScheduledAppendAt(),
      this.#subscriptionDelivery.deadlines()[0]?.at ?? null,
      this.#facetHost.deadlines()[0]?.at ?? null,
    ];
  }

  readonly #facetHost = new FacetHost({
    ctx: this.ctx,
    deployId: deployId(),
    iterateContextName: this.#durableObjectAddress.name,
    path: this.#durableObjectAddress.path,
    itxEntrypoint: () => this.#itxEntrypoint,
    invoke: (call) => this.#invokeAsLoadedCode(call),
    namedWorker: (source) => this.#namedWorker(source),
    resolveItxExpression: (expression) => this.#itxExpressionResolver.resolve(expression),
    stream: this.#stream,
    reconcileAlarm: () => this.#alarmCoordinator.reconcile(),
    loadedFacetMaterialized: () => this.#residency.armUnclaimedFacetSweep(),
    deliveriesQueuedFor: (name) => this.#subscriptionDelivery.deliveriesQueuedFor(name),
    cause: () => this.#caller.cause,
    causeOfCall: (call) => this.#causeNamingCaller(call),
  });

  // A facet's code calls as the context's, so the person who called it rides the call's cause,
  // signed (on-behalf-of.ts). A cause that names someone keeps them: they asked first.
  #causeNamingCaller(call: string): Cause | undefined | Promise<Cause | undefined> {
    const { principal, grant, via, cause } = this.#caller;
    const { signingSecret } = itxHost();
    if (!principal || !cause || cause.onBehalfOf || !signingSecret) return cause;
    const onBehalfOf = {
      principal,
      grant,
      via,
      call: `${this.#durableObjectAddress.path}#${call}`,
    };
    return signingSecret()
      .then((secret) => mintOnBehalfOf(onBehalfOf, secret, Date.now()))
      .then((token) => ({ ...cause, onBehalfOf: token }));
  }

  readonly #residency = new Residency({
    name: this.#durableObjectAddress.name,
    facetHost: this.#facetHost,
    rpcStubs: this.#rpcStubs,
    connections: this.#connections,
    scriptRunsInFlight: () => this.#scriptRunsInFlight.size + this.#runsOwedToTheAlarm.size,
    reconcileAlarm: () => this.#alarmCoordinator.reconcile(),
    inboundCallsHeldChanged: () => this.#alarmCoordinator.watch(),
  });

  #traceAlarm(
    reason: AlarmTrace["reason"],
    before: number | null,
    extra: Pick<AlarmTrace, "error" | "dueSchedules" | "runs"> = {},
  ) {
    const delivery = this.#subscriptionDelivery.deadlines();
    const facets = this.#facetHost.snapshot();
    const trace: AlarmTrace = {
      at: Date.now(),
      reason,
      ...extra,
      alarm: { before, after: this.#alarmCoordinator.snapshot().armedAt },
      deadlines: {
        schedule: this.#stream.nextScheduledAppendAt(),
        delivery: delivery.slice(0, 32),
        deliveryOmitted: Math.max(0, delivery.length - 32),
        claims: this.#facetHost.deadlines(),
        ...this.#residency.deadlines(),
      },
      durableHead: this.#stream.highestDurableOffset(),
      facetWorkInFlight: facets.facetWorkInFlight,
      liveFacets: facets.liveFacetNames.slice(0, 32),
      borrowedRpcStubs: this.#rpcStubs.hasBorrowedRpcStubs(),
      libraryHoldsSocket: this.#connections.holdsOpenSocket(),
    };
    // Not through `append`: a trace is not activity, and must never fail an alarm pass.
    try {
      this.#stream.append({
        type: "events.iterate.com/itx/alarm-trace",
        ephemeral: true,
        payload: trace,
      });
    } catch (error) {
      reportIssue("iterate-context.alarm-trace", error, { reason });
    }
  }

  #alarmStory(now: number): string {
    const { armedAt, passInProgress, lastPassStartedAt } = this.#alarmCoordinator.snapshot();
    const when = (at: number | null | undefined) =>
      at === null || at === undefined
        ? "none"
        : `${new Date(at).toISOString()} (${at <= now ? `${now - at} ms ago` : `in ${at - now} ms`})`;
    return [
      `alarm armed for ${when(armedAt)}`,
      `${passInProgress ? "a pass running since" : "this incarnation's last pass"} ${when(lastPassStartedAt)}`,
      `next schedule ${when(this.#stream.nextScheduledAppendAt())}`,
      `delivery claim ${when(this.#subscriptionDelivery.deadlines()[0]?.at)}`,
      `facet claim ${when(this.#facetHost.deadlines()[0]?.at)}`,
    ].join("; ");
  }

  #subscriptionList(): SubscriptionListEntry[] {
    return Object.entries(this.#stream.coreReducedState.subscriptions).map(([name, s]) => {
      const cursor = this.#subscriptionDelivery.cursor(name);
      return {
        name,
        target: print(s.target),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- an absent field stays absent on the wire
        ...(s.consumes && { consumes: s.consumes }),
        configuredAtOffset: s.configuredAtOffset,
        // oxlint-disable-next-line iterate/simple-truthiness-check -- an absent field stays absent on the wire
        ...(s.afterOffset !== undefined && { afterOffset: s.afterOffset }),
        ...(s.ordered === false && { ordered: false as const }),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- an absent field stays absent on the wire
        ...(s.filter && { filter: s.filter }),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- an absent field stays absent on the wire
        ...(s.copy && { copy: s.copy }),
        ...this.#subscriptionDelivery.fanOutView(name),
        ...(s.hostedFacet && {
          hostedFacet: { ...s.hostedFacet, restarts: this.#facetHost.restarts(s.hostedFacet.name) },
        }),
        ...(cursor && {
          cursor: {
            confirmedOffset: cursor.confirmedOffset,
            attempt: cursor.attempt,
            // oxlint-disable-next-line iterate/simple-truthiness-check -- an absent field stays absent on the wire
            ...(cursor.nextAttemptAtMs !== undefined && {
              nextAttemptAtMs: cursor.nextAttemptAtMs,
            }),
          },
        }),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- an absent field stays absent on the wire
        ...(s.halted && { halted: s.halted }),
      };
    });
  }

  // Nothing re-arms until the pass completes; a pass that dies is retried by the runtime.
  async alarm(): Promise<void> {
    this.#nameActiveSpan();
    this.#measureSize();
    const { armedAt: fired } = this.#alarmCoordinator.snapshot();
    const wokeAt = Date.now();
    // A run a dead incarnation left open is settled by this incarnation's wake record.
    const wakeRecordSettlesARun =
      !this.#stream.wakeRecorded() &&
      Object.keys(this.#stream.coreReducedState.scriptRuns).length > 0;
    const [schedule, delivery, facetClaim] = this.#durableAlarmDeadlines().map(
      (at) => at !== null && at <= wokeAt,
    );
    if (
      this.#runsOwedToTheAlarm.size === 0 &&
      !wakeRecordSettlesARun &&
      !(schedule || delivery || facetClaim)
    ) {
      await this.#alarmCoordinator.pass(async () => this.#residency.alarmPassStarted(wokeAt));
      return;
    }
    try {
      await this.#alarmCoordinator.pass(async () => {
        await this.#residency.alarmPassStarted(wokeAt);
        // Recorded inside the hold, so a wake with nothing else owed ends with no alarm write.
        const { schedules, scriptRuns } = this.#stream.coreReducedState;
        this.#stream.appendWakeRecord(
          {
            cause: "alarm",
            due: [
              ...(schedule ? ["schedule" as const] : []),
              ...(delivery ? ["retry" as const] : []),
              ...(facetClaim ? ["claim" as const] : []),
              ...(this.#runsOwedToTheAlarm.size > 0 || wakeRecordSettlesARun
                ? ["run" as const]
                : []),
            ],
          },
          deepestCause([
            ...Object.values(schedules)
              .filter((row) => !row.failure && Date.parse(row.nextAt) <= wokeAt)
              .map((row) => row.source?.cause),
            this.#subscriptionDelivery.owedCause(wokeAt),
            this.#facetHost.owedCause(wokeAt),
            ...Object.values(scriptRuns).map((run) => run.cause),
          ]),
        );
        const runs = this.#startRunsOwedToTheAlarm();
        // Appended before any subscriber RPC: the same transaction removes the obligation, so an
        // eviction or a duplicate alarm cannot repeat it.
        const now = Date.now();
        const due = Object.values(this.#stream.coreReducedState.schedules)
          .filter((row) => !row.failure && Date.parse(row.nextAt) <= now)
          .sort(
            (a, b) =>
              Date.parse(a.nextAt) - Date.parse(b.nextAt) ||
              a.scheduledAtOffset - b.scheduledAtOffset,
          )
          .slice(0, 32);
        this.#traceAlarm("alarm-fired", fired, { dueSchedules: due.length, runs });
        for (const row of due) {
          if (this.#stream.coreReducedState.paused) break;
          if (
            this.#stream.coreReducedState.schedules[row.key]?.scheduledAtOffset !==
            row.scheduledAtOffset
          )
            continue;
          const payload = {
            key: row.key,
            scheduledAtOffset: row.scheduledAtOffset,
            at: row.nextAt,
          };
          const cause = row.source?.cause;
          try {
            this.#appendAndRunCommittedEffects([
              ...row.events.map((event) => ({
                ...event,
                source: {
                  cause,
                  // A schedule set here from another context fires as that context's words.
                  ...(row.source?.origin && { origin: row.source.origin }),
                  schedule: {
                    ...payload,
                    ...((row.source?.processor || row.source?.principal) && {
                      definedBy: {
                        ...(row.source?.processor && { processor: row.source.processor }),
                        ...(row.source?.principal && { principal: row.source.principal }),
                      },
                    }),
                  },
                },
              })),
              { type: "events.iterate.com/itx/schedule-fired", payload, source: { cause } },
            ]);
            console.log({
              event: "scheduled-append.completed",
              namespace: "iterate-context",
              ...payload,
              count: row.events.length,
              latenessMs: now - Date.parse(row.nextAt),
            });
          } catch (error) {
            // A commit that landed before an effect threw keeps its completion for the runtime's
            // retry; otherwise the definition is parked visibly.
            if (
              this.#stream.coreReducedState.schedules[row.key]?.nextAt !== row.nextAt ||
              this.#stream.coreReducedState.schedules[row.key]?.scheduledAtOffset !==
                row.scheduledAtOffset
            ) {
              reportIssue("scheduled-append.effect-failed", error, payload);
              throw error;
            }
            this.#appendAndRunCommittedEffects([
              {
                type: "events.iterate.com/itx/schedule-failed",
                payload: { ...payload, error: String(error).slice(0, 2000) },
                source: { cause },
              },
            ]);
            reportIssue("scheduled-append.failed", error, payload);
          }
        }
        // Awaited, so the deadlines they leave are the ones derived after the pass.
        await this.#subscriptionDelivery.deliverEveryCursorSubscription();
        await this.#facetHost.reviveDueClaims();
      });
    } catch (error) {
      this.#traceAlarm("alarm-abandoned", fired, { error: String(error).slice(0, 256) });
      throw error;
    }
    this.#traceAlarm("alarm-pass", fired);
    this.#residency.outsideActivityEnded();
  }

  async invoke(
    call: ItxExpressionInput,
    args: unknown[] = [],
    caller: Caller = { principal: null },
  ): Promise<unknown> {
    this.#nameActiveSpan();
    const kind = caller.app ? "loaded" : caller.path ? "context" : "other";
    if (!caller.cause) caller = { ...caller, cause: newChain("a call") };
    if (!this.#stream.wakeRecorded())
      this.#stream.appendWakeRecord(
        {
          cause: "call",
          caller: kind,
          call: normalizedItxExpression(call).map(itxExpressionStepName).join(".").slice(0, 200),
        },
        caller.cause,
      );
    this.#residency.inboundCallStarted();
    // An approved act's text is for this one call (`Caller.approvedAct`).
    const { approvedAct, ...asCalled } = caller;
    const result = await (
      approvedAct
        ? this.#callerStorage.run(asCalled, () =>
            this.#itxExpressionResolver.invokeApproved(approvedAct, call, args),
          )
        : this.#invokeInProcess(call, args, caller)
    ).finally(() => this.#residency.inboundCallEnded(caller.app === true));
    // Every Workers-RPC caller arrives here, so the caller's session ends with the call, whatever
    // the caller disposes.
    return itxAnswerDetachedFromSession(result, call, args);
  }

  // A thrown error can lose its `code` between runtimes (since workerd v1.20261030.1), and a gradual
  // rollout runs two at once; a return value arrives whatever the runtimes.
  async invokeSafe(
    call: ItxExpressionInput,
    args: unknown[] = [],
    caller: Caller = { principal: null },
  ) {
    try {
      const data = (await this.invoke(call, args, caller)) as Partial<Disposable> | undefined;
      // Never add a disposer to every answer: workerd would keep this context open after each call.
      return {
        ok: true as const,
        data,
        ...(data?.[Symbol.dispose] && { [Symbol.dispose]: data[Symbol.dispose] }),
      };
    } catch (error) {
      const code = errorCode(error);
      if (error instanceof Error && code) {
        const data = "data" in error ? error.data : undefined;
        return { ok: false as const, error: { code, message: error.message, data } };
      }
      throw error;
    }
  }

  // At most once: neither recorded nor reserved when an earlier attempt reserved and recorded nothing.
  reserveSend(key: string): { recorded?: StreamEvent; reserved: boolean } {
    this.#nameActiveSpan();
    const row = this.#stream.storage.readEventByIdempotencyKey(key);
    if (row)
      return {
        recorded: {
          ...(JSON.parse(row.body) as object),
          offset: row.offset,
          path: this.#durableObjectAddress.path,
        } as StreamEvent,
        reserved: false,
      };
    if (this.ctx.storage.kv.get(`send:${key}`)) return { reserved: false };
    this.ctx.storage.kv.put(`send:${key}`, true);
    return { reserved: true };
  }
  releaseSend(key: string): void {
    this.#nameActiveSpan();
    this.ctx.storage.kv.delete(`send:${key}`);
  }

  recordLoopLimit(cause: unknown, message: string): void {
    const refused = parseCause(cause);
    if (!refused || this.#stream.highestDurableOffset() === 0) return;
    this.#inboundRequestInOneTurn("recordLoopLimit");
    this.#stream.recordLoopLimit(refused, String(message));
  }

  // A name is resolved as the platform; its producer runs as the loaded code of the context whose
  // rule named it.
  async #namedWorker(source: ItxExpressionInput): Promise<NamedWorker> {
    // Cached, since a facet resolves its source on every push: valid while the table is the same
    // committed object and until the first snapshot it read expires.
    const rules = this.#stream.coreReducedState.itxExpressionRewriteRules;
    const key = JSON.stringify(source);
    let known = this.#namedWorkers.get(key);
    if (!known || known.rules !== rules || Date.now() >= known.validUntil) {
      const resolved = await this.#callerStorage.run(
        { principal: null, cause: this.#caller.cause },
        () => this.#itxExpressionResolver.namedWorker(source),
      );
      known = { rules, ...resolved };
      if (this.#namedWorkers.size >= 100) this.#namedWorkers.clear();
      this.#namedWorkers.set(key, known);
    }
    const { at, spec, vouched } = known;
    const { cause } = this.#caller;
    return {
      spec,
      vouched,
      invoke: (call) =>
        at === this.#durableObjectAddress.path
          ? this.#invokeInProcess(call, [], { principal: null, app: true, cause })
          : this.#reach.loadedCodeAt(at, cause)(call),
    };
  }

  readonly #namedWorkers = new Map<
    string,
    { rules: object; at: string; spec: unknown; vouched: boolean; validUntil: number }
  >();

  #invokeInProcess(call: ItxExpressionInput, args: unknown[], caller: Caller): Promise<unknown> {
    return this.#callerStorage.run(caller, () => this.#itxExpressionResolver.invoke(call, ...args));
  }
  // A producer is loaded code's word: walled on its input and on every row it appends.
  #invokeAsLoadedCode(call: ItxExpressionInput): Promise<unknown> {
    return this.#invokeInProcess(call, [], {
      principal: null,
      app: true,
      cause: this.#caller.cause,
    });
  }
  readonly #callerStorage = new AsyncLocalStorage<Caller>();
  get #caller(): Caller {
    return this.#callerStorage.getStore() ?? { principal: null };
  }

  // A body still streaming after the Response is handed back is not counted as an inbound call.
  async fetch(request: Request): Promise<Response> {
    this.#nameActiveSpan();
    const fromLoadedCode = request.headers.get(ITX_APP_HEADER) !== null;
    const kind = fromLoadedCode ? "loaded" : "other";
    this.#stream.appendWakeRecord(
      { cause: "call", caller: kind, call: "fetch" },
      parseCause(request.headers.get(ITERATE_CAUSE_HEADER)),
    );
    this.#residency.inboundCallStarted();
    return this.#serveFetch(request).finally(() =>
      this.#residency.inboundCallEnded(fromLoadedCode),
    );
  }

  async #serveFetch(request: Request): Promise<Response> {
    const app = request.headers.get(ITX_APP_HEADER) !== null;
    // Loaded code gets neither the pager nor the fetch upgrade: both append rows past every table.
    if (!app) {
      const before = this.#stream.coreReducedState;
      const pager = this.#rpcStubs.acceptRpcStubPagerWebSocket(request);
      if (pager) {
        await this.#waitOutOlderSnapshots(before, true);
        return pager;
      }
      const upgradeLeg = this.#rpcStubFetch.acceptFetchUpgradeLeg(request);
      if (upgradeLeg) return upgradeLeg;
    }
    const itxExpressionHeader = request.headers.get(ITX_EXPRESSION_FETCH_HEADER);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an untrusted HTTP header: present (even empty) selects an itx-expression fetch, absent (null) routes to egress — that distinction must not collapse
    if (itxExpressionHeader !== null) {
      try {
        const itxExpression = parseFetchExpression(itxExpressionHeader);
        const headers = new Headers(request.headers);
        headers.delete(ITX_EXPRESSION_FETCH_HEADER);
        headers.delete(ITX_APP_HEADER);
        // The routing slug is the edge's alone, so loaded code can never forge one.
        headers.delete(ITERATE_ROUTING_SLUG_HEADER);
        // Trusted, so asserted rather than parsed: the edge sets it after admission, and every other
        // source of it is stripped (ItxEntrypoint strips a loaded worker's).
        const principal = JSON.parse(
          headers.get(ITX_PRINCIPAL_HEADER) ?? "null",
        ) as Principal | null;
        const grant = headers.get(ITX_GRANT_HEADER) || undefined;
        const callerPath = headers.get(ITX_CALLER_PATH_HEADER) || undefined;
        headers.delete(ITX_CALLER_PATH_HEADER);
        const runsRow = headers.get(ITX_RUNS_ROW_HEADER) !== null;
        headers.delete(ITX_RUNS_ROW_HEADER);
        const cause = parseCause(headers.get(ITERATE_CAUSE_HEADER)) ?? newChain("a request");
        headers.delete(ITERATE_CAUSE_HEADER);
        const forwarded = new Request(request, {
          headers,
          body: this.#expressionFetchBody(request),
        });
        const caller = {
          principal,
          grant,
          path: callerPath,
          cause,
          ...(app && { app: true as const }),
          ...(runsRow && { runsRow: true as const }),
        };
        const result = await this.#callerStorage.run(caller, () =>
          this.#itxExpressionResolver.invoke(itxExpressionEndingInFetch(itxExpression), forwarded),
        );
        return result instanceof Response
          ? result
          : new Response(`expression fetch: ${JSON.stringify(result)}\n`);
      } catch (error) {
        return expressionFetchErrorAnswer(error, itxExpressionHeader);
      }
    }
    if (app) return new Response("loaded code's fetch names no expression\n", { status: 404 });
    return new Response("a context's fetch names no expression\n", { status: 404 });
  }

  // A DO that answers while a body is unread gets an uncaught "Can't read from request stream" error
  // (workerd#918, workerd#1730), so this pipe owns the read and logs its end. `new Request` refuses a
  // body on GET or HEAD.
  #expressionFetchBody(request: Request): ReadableStream | null {
    if (!request.body || request.method === "GET" || request.method === "HEAD") return null;
    const { readable, writable } = new IdentityTransformStream();
    request.body.pipeTo(writable).catch((error: unknown) => {
      console.info({
        event: "expression-fetch.request-body-unread",
        namespace: "iterate-context",
        name: this.#durableObjectAddress.name,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return readable;
  }

  #egress(request: Request): Promise<Response> {
    return egress(request, { cause: this.#caller.cause, path: this.#durableObjectAddress.path });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.#inboundRequestInOneTurn("webSocketMessage");
    this.#rpcStubFetch.handleWebSocketMessage(ws, message);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.#inboundRequestInOneTurn("webSocketClose");
    if (this.#rpcStubFetch.handleWebSocketClose(ws, code, reason)) return;
    this.#rpcStubs.rpcStubPagerClosed(ws);
  }
  webSocketError(ws: WebSocket): void {
    this.#nameActiveSpan();
    this.webSocketClose(ws, 1006, "transport error");
  }

  // A Workers-RPC stub is a callable Proxy on the wire: it cannot be validated structurally.
  lendRpcStub(input: { rpcStubKey: string; stub: unknown }): void {
    this.#inboundRequestInOneTurn("lendRpcStub");
    this.#rpcStubs.lendRpcStub({
      rpcStubKey: input.rpcStubKey,
      stub: input.stub as BorrowedRpcStub,
    });
  }
}

type Requester = Pick<OnBehalfOf, "principal" | "grant" | "via">;

// A script's own request carries `source.onBehalfOf`, which the append stamped after verifying its
// token. None for a run no person asked for.
function requesterOf(event: StreamEvent): Requester | undefined {
  const { principal, grant, via, onBehalfOf } = event.source;
  if (principal) return { principal, grant, via };
  if (onBehalfOf)
    return { principal: onBehalfOf.principal, grant: onBehalfOf.grant, via: onBehalfOf.via };
  return undefined;
}
