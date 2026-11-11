// The clock is one durable interval schedule per run, never a check that sets the next: that is code
// reacting to its own output (core-itx cause.ts), and one failed link would stop the clock.
import type { ProcessEventArgs, ProcessorContract, ReduceArgs } from "iterate/stream/processor";
import type { ItxEntrypointScope } from "core-itx";
import { EntityLifecycleProcessor } from "../project/entity-lifecycle.ts";
import {
  SANDBOX_CHECKPOINT_AFTER_MS,
  SANDBOX_IDLE_CHECK,
  SandboxConfigured,
  SandboxSnapshot,
  SandboxStarted,
  type SandboxState,
} from "./contract.ts";

export type SandboxCheckDeps = {
  usedAt(): Promise<number | null>;
  /** False when the sandbox turned out to be busy. */
  park(): Promise<boolean>;
  checkpoint(): Promise<void>;
};

export class SandboxProcessor extends EntityLifecycleProcessor<SandboxState> {
  readonly #getItx: () => ItxEntrypointScope & Disposable;
  readonly #check: SandboxCheckDeps;
  /** Null when this incarnation set no interval; the at-head pass sets it again after an eviction. */
  #period: number | null = null;
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
      // also cancels one an earlier incarnation set
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
    // an interval whose firing failed fires no more until it is set again
    if (event?.type === "events.iterate.com/itx/schedule-failed" && event.payload?.key === "idle")
      this.#period = null;
    const period = checkPeriodMs(state.idleAfterMs);
    if (this.#period !== period) {
      this.#period = period;
      runInBackground(() => this.#arm(period));
    }
  }

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

  /** Set again at the same period, it keeps its clock. */
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

/** Twice per idle (or checkpoint) period, so a park lands at most half a period late. */
const checkPeriodMs = (idleAfterMs: number) =>
  Math.max(1_000, Math.ceil(Math.min(idleAfterMs, SANDBOX_CHECKPOINT_AFTER_MS) / 2));
