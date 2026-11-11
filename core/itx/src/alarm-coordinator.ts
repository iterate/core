// Cloudflare sometimes holds an alarm 19–58 s; any `setAlarm()` releases it (github.com/iterate/
// do-alarm-held-repro). Remove the overdue watch when fixed (scripts/ci/prd-fault-alarm.ts).
const ALARM_OVERDUE_AFTER_MS = 5_000;
export const ALARM_MAX_REARMS = 3;

type OverdueAlarm = {
  armedAt: number;
  overdueMs: number;
  action: "rearm" | "give-up";
  rearms: number;
};

type AlarmCoordinatorDeps = {
  setAlarm: (at: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
  deadlines: () => (number | null)[];
  held: () => boolean;
  onOverdue: (overdue: OverdueAlarm) => void;
};

export class AlarmCoordinator {
  // What the sources want; after a re-arm, storage holds the re-arm's `now` instead.
  #armedAt: number | null = null;
  // A time written in the past is due when written (the runtime clamps it to now).
  #writtenAt: number | null = null;
  #rearms = 0;
  #passInProgress = false;
  #lastPassStartedAt: number | null = null;
  // An overdue alarm after a thrown pass is the runtime's retry; re-arming would defeat its backoff.
  #passThrew = false;
  #overdueTimer: ReturnType<typeof setTimeout> | undefined;
  #overdueTimerCheckAt: number | null = null;
  readonly #deps: AlarmCoordinatorDeps;

  constructor(deps: AlarmCoordinatorDeps) {
    this.#deps = deps;
  }

  snapshot(): {
    armedAt: number | null;
    passInProgress: boolean;
    lastPassStartedAt: number | null;
  } {
    return {
      armedAt: this.#armedAt,
      passInProgress: this.#passInProgress,
      lastPassStartedAt: this.#lastPassStartedAt,
    };
  }

  // Once, before the first commit can reconcile.
  restore(at: number | null) {
    this.#armedAt = at;
  }

  // Nothing is written while the work runs, so a pass that dies is retried by the runtime. The
  // fired alarm is forgotten either way: workerd deletes it after the handler or its retries.
  async pass(work: () => Promise<void>): Promise<void> {
    this.#passInProgress = true;
    this.#lastPassStartedAt = Date.now();
    this.#passThrew = false;
    this.#stopOverdueTimer();
    try {
      await work();
    } catch (error) {
      this.#passThrew = true;
      throw error;
    } finally {
      this.#passInProgress = false;
      this.#armedAt = null;
    }
    this.reconcile();
  }

  reconcile() {
    if (this.#passInProgress) return;
    const wanted = this.#wanted();
    if (wanted === this.#armedAt) return this.watch();
    this.#armedAt = wanted;
    this.#writtenAt = Date.now();
    this.#rearms = 0;
    // The output gate makes a failed storage write fail the invocation.
    void (wanted === null ? this.#deps.deleteAlarm() : this.#deps.setAlarm(wanted));
    this.watch();
  }

  rearmIfOverdue(now: number): void {
    const armedAt = this.#armedAt;
    if (armedAt === null || now - armedAt < ALARM_OVERDUE_AFTER_MS) return;
    if (this.#wanted() !== armedAt) return this.reconcile();
    this.#rearm(armedAt, now);
    this.watch();
  }

  // A pending timer holds off eviction, so none runs while the actor is idle.
  watch(): void {
    const checkAt = this.#overdueCheckAt();
    if (checkAt === null || !this.#deps.held()) return this.#stopOverdueTimer();
    if (this.#overdueTimer !== undefined && this.#overdueTimerCheckAt === checkAt) return;
    this.#stopOverdueTimer();
    this.#overdueTimerCheckAt = checkAt;
    this.#overdueTimer = setTimeout(
      () => {
        this.#overdueTimer = undefined;
        this.#rearmIfStillOverdue(Date.now());
      },
      Math.max(0, checkAt - Date.now()),
    );
  }

  #rearmIfStillOverdue(now: number): void {
    const checkAt = this.#overdueCheckAt();
    if (checkAt === null) return;
    if (now < checkAt) return this.watch();
    if (this.#wanted() !== this.#armedAt) return this.reconcile();
    const armedAt = this.#armedAt!;
    if (this.#rearms >= ALARM_MAX_REARMS) {
      this.#rearms += 1; // past the cap: no further check (`#overdueCheckAt`)
      this.#deps.onOverdue({
        armedAt,
        overdueMs: now - armedAt,
        action: "give-up",
        rearms: ALARM_MAX_REARMS,
      });
      return;
    }
    this.#rearm(armedAt, now);
    this.watch();
  }

  #rearm(armedAt: number, now: number): void {
    this.#rearms += 1;
    this.#writtenAt = now;
    // `now`, not the stored time: workerd's ActorSqlite ignores a write of the stored time.
    void this.#deps.setAlarm(now);
    this.#deps.onOverdue({
      armedAt,
      overdueMs: now - armedAt,
      action: "rearm",
      rearms: this.#rearms,
    });
  }

  #wanted(): number | null {
    let wanted: number | null = null;
    for (const at of this.#deps.deadlines())
      if (at !== null && (wanted === null || at < wanted)) wanted = at;
    return wanted;
  }

  #overdueCheckAt(): number | null {
    if (
      this.#armedAt === null ||
      this.#passInProgress ||
      this.#passThrew ||
      this.#rearms > ALARM_MAX_REARMS
    )
      return null;
    return Math.max(this.#armedAt, this.#writtenAt ?? 0) + ALARM_OVERDUE_AFTER_MS;
  }

  #stopOverdueTimer() {
    if (this.#overdueTimer === undefined) return;
    clearTimeout(this.#overdueTimer);
    this.#overdueTimer = undefined;
  }
}
