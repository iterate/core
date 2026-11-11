import type { ItxExpression } from "iterate/expression";
import { errorCode, releaseRpcSessions, reportIssue } from "iterate/lib";
import {
  failureKind,
  isPlatformFailureKind,
  ONCE_NOW,
  retryPlatformFailures,
} from "iterate/platform-retry";
import type { FetchRouteTable } from "../fetch-routes.ts";
import { unavailable, unavailableError } from "../unavailable.ts";
import type { ItxExpressionRewriteRule } from "./itx-expression-rewriting.ts";

// A snapshot is used for SNAPSHOT_TTL_MS from when its read was SENT: the owner's revocation fence
// (`#takeRevocationFence`) waits out exactly that before a write that narrows a table answers.
export const SNAPSHOT_TTL_MS = 5_000;

// Must stay well above a read's round trip, which has to fit inside it.
export const UNPUBLISHED_ROOT_SNAPSHOT_TTL_MS = 1_000;

// Over Workers RPC the stub's method answers `never` (Rpc.Serializable does not reach expressions):
// a reader casts its answer to this.
export type RulesSnapshotAnswer = {
  version: string;
  rules?: ItxExpressionRewriteRule[];
  routing?: SnapshotRouting;
  // absent from an owner a deploy has not reached yet: SNAPSHOT_TTL_MS
  ttlMs?: number;
};

type SnapshotRouting = { fetchRoutes: FetchRouteTable; ingressTarget: ItxExpression | null };

export type RuleSnapshot = {
  version: string;
  rules: readonly ItxExpressionRewriteRule[];
  routing: SnapshotRouting;
  readAt: number;
  expiresAt: number;
};

export const SNAPSHOT_REREADS = 3;

type SnapshotRead = { answer: Promise<RuleSnapshot>; expiresAt: number };

class RuleSnapshotCache {
  readonly #held = new Map<string, RuleSnapshot>();
  readonly #reading = new Map<string, SnapshotRead>();
  readonly #readBehind = new WeakSet<RuleSnapshot>();
  // A read in flight may answer after its lifetime, or never, so validity is checked after every
  // wait. Past half its lifetime a snapshot is used at once and the owner read again behind it, once.
  async get(
    name: string,
    read: (ifVersion: string | undefined) => Promise<RulesSnapshotAnswer>,
    keepAlive: (reading: Promise<unknown>) => void = () => {},
  ): Promise<RuleSnapshot> {
    for (let reads = 0; reads < SNAPSHOT_REREADS; reads++) {
      const held = this.#held.get(name);
      const now = Date.now();
      if (held && now < held.expiresAt) {
        const halfLife = (held.readAt + held.expiresAt) / 2;
        if (now >= halfLife && !this.#readBehind.has(held) && !this.#reading.has(name)) {
          this.#readBehind.add(held);
          const behind = this.#answerInTime(name, this.#read(name, read, held));
          keepAlive(behind.catch((error: unknown) => logReadBehindFailure(name, error)));
        }
        return held;
      }
      const reading = this.#reading.get(name) || this.#read(name, read, held);
      const snapshot = await this.#answerInTime(name, reading);
      if (snapshot && Date.now() < snapshot.expiresAt) return snapshot;
    }
    throw unavailableError(
      "overloaded",
      `the rule snapshot of ${name} arrived expired ${SNAPSHOT_REREADS} times: its owner answers slower than a snapshot lasts`,
    );
  }

  // A read can outlive the request that sent it and never answer (workerd settles it for no other
  // request); waited on unbounded, it would hold every call through its table for the isolate's life.
  async #answerInTime(name: string, reading: SnapshotRead): Promise<RuleSnapshot | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lifetimeOver = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.max(0, reading.expiresAt - Date.now()));
    });
    const snapshot = await Promise.race([reading.answer, lifetimeOver]).finally(() =>
      clearTimeout(timer),
    );
    // Only the first caller to give up on a read drops and logs it.
    if (snapshot || this.#reading.get(name) !== reading) return snapshot;
    this.#reading.delete(name);
    console.warn({
      event: "rule-snapshot.platform-failure-read-deadline",
      name: "rulesSnapshot",
      context: name,
      waitedMs: SNAPSHOT_TTL_MS,
    });
    return undefined;
  }

  #read(
    name: string,
    read: (ifVersion: string | undefined) => Promise<RulesSnapshotAnswer>,
    held: RuleSnapshot | undefined,
  ): SnapshotRead {
    const readAt = Date.now();
    const expiresAt = readAt + SNAPSHOT_TTL_MS;
    const answer = retryPlatformFailures(() => read(held?.version), {
      area: "rule-snapshot",
      schedule: ONCE_NOW,
      idempotent: true,
      kind: failureKind,
      describe: () => ({ name: "rulesSnapshot", context: name }),
    })
      .catch((error: unknown) => {
        throw unavailable(error);
      })
      .then((result): RuleSnapshot => {
        // a copy: a Workers-RPC result holds its session, and the owner resident, until disposed
        const answered = structuredClone(result);
        releaseRpcSessions([result]);
        const unchanged = answered.version === held?.version ? held : undefined;
        const rules = answered.rules || unchanged?.rules;
        const routing = answered.routing || unchanged?.routing;
        if (!rules || !routing)
          throw new Error(
            `the rule snapshot of ${name} answered version ${answered.version} without its rows`,
          );
        const snapshot = {
          version: answered.version,
          rules,
          routing,
          readAt,
          expiresAt: readAt + (answered.ttlMs ?? SNAPSHOT_TTL_MS),
        };
        // A read given up on may answer after a later one: its snapshot never replaces the newer.
        if ((this.#held.get(name)?.readAt ?? -Infinity) > readAt) return snapshot;
        this.#held.delete(name);
        this.#held.set(name, snapshot);
        if (this.#held.size > 1_000) this.#held.delete(this.#held.keys().next().value!);
        return snapshot;
      })
      .finally(() => {
        if (this.#reading.get(name) === reading) this.#reading.delete(name);
      });
    const reading = { answer, expiresAt };
    this.#reading.set(name, reading);
    return reading;
  }
}

function logReadBehindFailure(name: string, error: unknown): void {
  const kind = failureKind(error);
  if (isPlatformFailureKind(kind)) return;
  if (kind === "refused")
    console.info({
      event: "rule-snapshot.read-behind-refused",
      context: name,
      code: errorCode(error),
      message: String(error),
    });
  else reportIssue("rule-snapshot.read-behind", error, { context: name });
}

// Shared by every context and entrypoint in this isolate.
export const ruleSnapshots = new RuleSnapshotCache();
