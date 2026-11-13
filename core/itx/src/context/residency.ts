// Everything here is in memory on purpose: it watches the incarnation that armed it, and a fresh
// one has nothing to watch.
import type { Connections } from "./connections.ts";
import { UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS, type FacetHost } from "./facet-host.ts";
import type { RpcStubDirectory } from "./rpc-stubs.ts";

function decideQuietDeadline(input: {
  armedFor: number | null;
  now: number;
  lastCallEndedAt: number | null;
  workInFlight: number;
  windowMs: number;
}): { action: "none" } | { action: "rearm"; at: number } | { action: "due"; idleSince: number } {
  const { armedFor, now, lastCallEndedAt, workInFlight, windowMs } = input;
  if (armedFor === null || now < armedFor) return { action: "none" };
  if (workInFlight > 0) return { action: "rearm", at: now + windowMs };
  const idleSince = lastCallEndedAt ?? armedFor - windowMs;
  if (now - idleSince < windowMs) return { action: "rearm", at: idleSince + windowMs };
  return { action: "due", idleSince };
}

type ResidencyDeps = {
  name: string;
  facetHost: Pick<
    FacetHost,
    "snapshot" | "resetUnclaimedLoadedFacets" | "startFacetsTheLastIncarnationRan"
  >;
  rpcStubs: Pick<RpcStubDirectory, "hasBorrowedRpcStubs" | "returnBorrowedRpcStubs">;
  connections: Pick<Connections, "holdsOpenSocket" | "release">;
  scriptRunsInFlight: () => number;
  reconcileAlarm: () => void;
  inboundCallsHeldChanged: () => void;
};

export class Residency {
  readonly #deps: ResidencyDeps;

  constructor(deps: ResidencyDeps) {
    this.#deps = deps;
  }

  #inboundCallsInFlight = 0;
  // A call from loaded code does not move this clock: a facet that calls its own context often
  // would otherwise never be quiet, and never reset.
  #lastOutsideActivityEndedAt: number | null = null;

  inboundCallStarted(): void {
    this.#inboundCallsInFlight += 1;
    if (this.#inboundCallsInFlight === 1) this.#deps.inboundCallsHeldChanged();
  }

  inboundCallEnded(fromLoadedCode: boolean): void {
    this.#inboundCallsInFlight -= 1;
    if (!fromLoadedCode) this.#lastOutsideActivityEndedAt = Date.now();
    if (this.#inboundCallsInFlight === 0) this.#deps.inboundCallsHeldChanged();
  }

  holdsResident(): boolean {
    return this.#inboundCallsInFlight > 0;
  }

  inboundCallInOneTurn(): void {
    this.#lastOutsideActivityEndedAt = Date.now();
  }

  outsideActivityEnded(): void {
    this.#lastOutsideActivityEndedAt = Date.now();
  }

  // Borrowed stubs and open sockets keep the actor resident on the edge (workerd#6800), so a timer
  // releases them. A pending timer itself holds off eviction and hibernation, billed.
  #pinReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  #pinCallsInFlight = 0;

  pinCallStarted(): void {
    this.#pinCallsInFlight += 1;
    clearTimeout(this.#pinReleaseTimer);
    this.#pinReleaseTimer = undefined;
  }

  pinCallEnded(): void {
    this.#pinCallsInFlight -= 1;
    if (this.#pinCallsInFlight > 0) return;
    if (!this.#deps.rpcStubs.hasBorrowedRpcStubs() && !this.#deps.connections.holdsOpenSocket())
      return;
    this.#pinReleaseTimer = setTimeout(() => {
      this.#pinReleaseTimer = undefined;
      this.#releasePins();
    }, 30_000);
  }

  // Never a facet: it does not hold this actor, and an abort could kill an attempt for nothing.
  #releasePins(): void {
    this.#deps.rpcStubs.returnBorrowedRpcStubs();
    this.#deps.connections.release();
  }

  #unclaimedFacetSweepArmedFor: number | null = null;

  deadlines(): { unclaimedFacetSweep: number | null } {
    return { unclaimedFacetSweep: this.#unclaimedFacetSweepArmedFor };
  }

  armUnclaimedFacetSweep(): void {
    if (this.#unclaimedFacetSweepArmedFor !== null) return;
    this.#unclaimedFacetSweepArmedFor = Date.now() + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS;
    this.#deps.reconcileAlarm();
  }

  #workInFlight(): number {
    return (
      this.#inboundCallsInFlight +
      this.#deps.facetHost.snapshot().facetWorkInFlight +
      this.#deps.scriptRunsInFlight() +
      this.#pinCallsInFlight
    );
  }

  /** Work in flight, or pins this actor still waits to release: what its awake socket lasts as
   *  long as (awake.ts). */
  busy(): boolean {
    return this.#workInFlight() > 0 || this.#pinReleaseTimer !== undefined;
  }

  async alarmPassStarted(now: number): Promise<void> {
    const decision = decideQuietDeadline({
      armedFor: this.#unclaimedFacetSweepArmedFor,
      now,
      workInFlight: this.#workInFlight(),
      lastCallEndedAt: this.#lastOutsideActivityEndedAt,
      windowMs: UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS,
    });
    if (decision.action === "none") return;
    if (decision.action === "rearm") {
      this.#unclaimedFacetSweepArmedFor = decision.at;
      return;
    }
    this.#unclaimedFacetSweepArmedFor = null;
    const facets = await this.#deps.facetHost.resetUnclaimedLoadedFacets();
    if (facets.length > 0)
      console.log({
        event: "context.facets-reset-when-quiet",
        namespace: "iterate-context",
        name: this.#deps.name,
        facets,
      });
  }

  #facetsResetAtBirth: string[] = [];

  // Runs once in the DO's constructor, before it serves or writes anything.
  async resetUnclaimedFacetsAtBirth(): Promise<void> {
    this.#facetsResetAtBirth = await this.#deps.facetHost.startFacetsTheLastIncarnationRan();
    if (this.#facetsResetAtBirth.length > 0)
      console.log({
        event: "context.facets-reset-at-birth",
        namespace: "iterate-context",
        name: this.#deps.name,
        facets: this.#facetsResetAtBirth,
      });
  }

  wakeRecordDetail(): { facetsReset?: string[] } {
    return this.#facetsResetAtBirth.length > 0 ? { facetsReset: this.#facetsResetAtBirth } : {};
  }
}
