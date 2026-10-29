// src/sandbox/processor.ts — THE SANDBOX'S PROCESSOR: the entity lifecycle, what the container's
// facts do to the state, and the CHECK SAGA that makes a sandbox cost nothing between visits and
// lose little when its container dies.
//
// THE CHECK SAGA. A running container bills for as long as it runs, so a sandbox nobody uses is
// parked: its disk is snapshotted, then the container stops, and the next verb restores the disk. A
// sandbox in use has its disk saved every SANDBOX_CHECKPOINT_AFTER_MS, so a container that crashes
// loses at most that much (Cloudflare's own pattern, "Save a sandbox automatically"). Facets have
// no alarms (core/lib sdk/index.ts), so the clock is a schedule on the context (`itx.schedules`):
// one interval for as long as the sandbox runs, set whenever the processor sees it running and has
// set none, cancelled when it stops. Never a check that sets the next: that is code reacting to its
// own output, one hand-off deeper each time (src/cause.ts), and one failed link would stop the
// clock. Each tick only decides, by the container's own clock (`usedAt`): it is the one place every
// verb leaves its mark, whichever incarnation of this facet made it. One tick decides at a time: a
// tick that comes while the last one's park or checkpoint still runs looks no further. The interval
// is durable, so an eviction costs nothing: it goes on ticking, a tick that finds the sandbox
// stopped cancels one no incarnation remembers, and an interval whose firing failed is set again,
// which revives it.
import type { ProcessEventArgs, ProcessorContract, ReduceArgs } from "iterate/stream/processor";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { EntityLifecycleProcessor } from "../project/entity-lifecycle.ts";
import {
  SANDBOX_CHECKPOINT_AFTER_MS,
  SANDBOX_IDLE_CHECK,
  SandboxConfigured,
  SandboxSnapshot,
  SandboxStarted,
  type SandboxState,
} from "./contract.ts";

/** What the check saga needs of the facet that hosts it. */
export type SandboxCheckDeps = {
  /** Epoch ms of the container's last use; null when no container runs. */
  usedAt(): Promise<number | null>;
  /** Snapshot and stop, as an idle stop. False when the sandbox turned out to be busy. */
  park(): Promise<boolean>;
  /** Snapshot, and let the container go on. */
  checkpoint(): Promise<void>;
};

export class SandboxProcessor extends EntityLifecycleProcessor<SandboxState> {
  readonly #getItx: () => ItxEntrypointScope & Disposable;
  readonly #check: SandboxCheckDeps;
  /** The period this incarnation set the sandbox's interval at, for its current run: null when it
   *  set none. The durable ground is the schedule itself, which the at-head pass sets again after
   *  an eviction. */
  #period: number | null = null;
  /** A tick's park or checkpoint is running: a tick that comes meanwhile looks no further. */
  #ticking = false;

  constructor(
    contract: ProcessorContract<SandboxState>,
    getItx: () => ItxEntrypointScope & Disposable,
    path: () => string,
    effects: ConstructorParameters<typeof EntityLifecycleProcessor>[3],
    check: SandboxCheckDeps,
  ) {
    super(contract, getItx, path, effects);
    this.#getItx = getItx;
    this.#check = check;
  }

  override reduce(args: ReduceArgs<SandboxState>): SandboxState | undefined {
    const { state, event } = args;
    switch (event.type) {
      case "events.iterate.com/sandbox/started": {
        const { discardedSnapshotId, instance, fromSandbox, snapshotId, snapshotSize } =
          SandboxStarted.parse(event.payload);
        const discarded = !!discardedSnapshotId && state.snapshot?.id === discardedSnapshotId;
        // another sandbox's snapshot, restored here, is this one's disk from now on
        const adopted =
          fromSandbox && snapshotId ? { id: snapshotId, size: snapshotSize || 0 } : null;
        return {
          ...state,
          running: true,
          savedAt: Date.parse(event.createdAt),
          snapshot: adopted || (discarded ? null : state.snapshot),
          instance: instance || state.instance,
        };
      }
      case "events.iterate.com/sandbox/snapshotted":
        return {
          ...state,
          snapshot: SandboxSnapshot.parse(event.payload),
          savedAt: Date.parse(event.createdAt),
        };
      case "events.iterate.com/sandbox/stopped":
        return { ...state, running: false, savedAt: null };
      case "events.iterate.com/sandbox/configured": {
        const { idleAfterMs = state.idleAfterMs } = SandboxConfigured.parse(event.payload);
        return { ...state, idleAfterMs };
      }
      default:
        return super.reduce(args);
    }
  }

  override processEvent(args: ProcessEventArgs<SandboxState>): undefined {
    super.processEvent(args);
    const { state, event, delivery, runInBackground } = args;
    if (!delivery.caughtUp) return;
    if (!state.running || state.deletion) {
      // the run is over: its interval goes, and so does one an earlier incarnation set
      if (this.#period !== null || event?.type === SANDBOX_IDLE_CHECK) {
        this.#period = null;
        runInBackground(() => this.#cancel());
      }
      return;
    }
    if (event?.type === SANDBOX_IDLE_CHECK) {
      if (this.#ticking) return;
      this.#ticking = true;
      runInBackground(async () => {
        try {
          await this.#run(state);
        } finally {
          this.#ticking = false;
        }
      });
      return;
    }
    // an interval whose firing failed fires no more until it is set again (context/built-ins.ts)
    if (event?.type === "events.iterate.com/itx/schedule-failed" && event.payload?.key === "idle")
      this.#period = null;
    // a new idle period is a new interval
    const period = checkPeriodMs(state.idleAfterMs);
    if (this.#period !== period) {
      this.#period = period;
      runInBackground(() => this.#arm(period));
    }
  }

  /** One tick: a container that is gone, or unused for the idle period, is parked (a busy one is
   *  looked at again next tick); one in use is checkpointed when its disk has gone unsaved for the
   *  checkpoint period. It sets nothing: the interval goes on by itself. */
  async #run(state: SandboxState): Promise<void> {
    const { idleAfterMs } = state;
    const usedAt = await this.#check.usedAt();
    const now = Date.now();
    if (usedAt === null || now - usedAt >= idleAfterMs) {
      await this.#check.park();
      return;
    }
    const savedAt = state.savedAt ?? 0;
    if (usedAt > savedAt && now - savedAt >= SANDBOX_CHECKPOINT_AFTER_MS)
      await this.#check.checkpoint();
  }

  /** The sandbox's one interval, `idle`: set again as it stands, it keeps its clock; at another
   *  period, it replaces the one before. A failed attempt leaves nothing set, so the next at-head
   *  pass sets it again. */
  async #arm(everyMs: number): Promise<void> {
    try {
      using itx = this.#getItx();
      await itx.schedules.set({
        key: "idle",
        when: { everyMs },
        events: [{ type: SANDBOX_IDLE_CHECK, payload: {} }],
      });
    } catch (error) {
      this.#period = null;
      throw error;
    }
  }

  async #cancel(): Promise<void> {
    using itx = this.#getItx();
    await itx.schedules.cancel("idle");
  }
}

/** How often a running sandbox is looked at: twice per idle period (or per checkpoint period, when
 *  that is shorter), so a park lands at most half an idle period late; at most once a second. */
const checkPeriodMs = (idleAfterMs: number) =>
  Math.max(1_000, Math.ceil(Math.min(idleAfterMs, SANDBOX_CHECKPOINT_AFTER_MS) / 2));
