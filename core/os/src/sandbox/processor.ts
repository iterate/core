// src/sandbox/processor.ts — THE SANDBOX'S PROCESSOR: the entity lifecycle, what the container's
// facts do to the state, and the CHECK SAGA that makes a sandbox cost nothing between visits and
// lose little when its container dies.
//
// THE CHECK SAGA. A running container bills for as long as it runs, so a sandbox nobody uses is
// parked: its disk is snapshotted, then the container stops, and the next verb restores the disk. A
// sandbox in use has its disk saved every SANDBOX_CHECKPOINT_AFTER_MS, so a container that crashes
// loses at most that much (Cloudflare's own pattern, "Save a sandbox automatically"). Facets have
// no alarms (core/lib sdk/index.ts), so the clock is a schedule on the context (`itx.schedules`),
// armed whenever the processor sees the sandbox running and no check is set, and set again by each
// check. The container's own clock decides (`usedAt`): it is the one place every verb leaves its
// mark, whichever incarnation of this facet made it. State-derived, so an eviction costs nothing:
// the at-head pass arms the next check.
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
  /** This incarnation has a check set for the sandbox's current run. The durable ground is the
   *  schedule itself, which the at-head pass sets again after an eviction. */
  #armed = false;

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
      this.#armed = false;
      return;
    }
    // a new period replaces a check set for the old one
    if (event?.type === "events.iterate.com/sandbox/configured") this.#armed = false;
    if (event?.type === SANDBOX_IDLE_CHECK) {
      runInBackground(() => this.#guarded(() => this.#run(state)));
      return;
    }
    if (!this.#armed) {
      this.#armed = true;
      runInBackground(() => this.#guarded(() => this.#arm(nextCheckMs(state.idleAfterMs))));
    }
  }

  /** A failed attempt leaves nothing armed, so the next at-head pass sets the check again. */
  async #guarded(attempt: () => Promise<void>): Promise<void> {
    try {
      await attempt();
    } catch (error) {
      this.#armed = false;
      throw error;
    }
  }

  /** One check: a container that is gone, or unused for the idle period, is parked; one in use is
   *  checkpointed when its disk has gone unsaved for the checkpoint period; and the next check is
   *  set for whichever comes first. */
  async #run(state: SandboxState): Promise<void> {
    const { idleAfterMs } = state;
    const usedAt = await this.#check.usedAt();
    const now = Date.now();
    if (usedAt === null || now - usedAt >= idleAfterMs) {
      if (await this.#check.park()) return;
      return this.#arm(nextCheckMs(idleAfterMs));
    }
    const savedAt = state.savedAt ?? 0;
    if (usedAt > savedAt && now - savedAt >= SANDBOX_CHECKPOINT_AFTER_MS)
      await this.#check.checkpoint();
    return this.#arm(Math.min(idleAfterMs - (now - usedAt), SANDBOX_CHECKPOINT_AFTER_MS));
  }

  /** The sandbox's one check, `idle`: a key set again replaces the one before. */
  async #arm(afterMs: number): Promise<void> {
    using itx = this.#getItx();
    await itx.schedules.set({
      key: "idle",
      when: { afterMs: Math.max(1_000, Math.ceil(afterMs)) },
      events: [{ type: SANDBOX_IDLE_CHECK, payload: {} }],
    });
  }
}

/** How soon the first check after a start (or a busy park) is: the idle period, or the checkpoint
 *  period when that comes first. */
const nextCheckMs = (idleAfterMs: number) => Math.min(idleAfterMs, SANDBOX_CHECKPOINT_AFTER_MS);
