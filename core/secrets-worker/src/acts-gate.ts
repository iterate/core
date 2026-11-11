// acts-gate.ts — THE GATE FOR ACTS THAT ARE NOT A SECRET'S REQUEST: a mail, and a call of a named
// verb (iterate/acts). One object for the whole mind. It keeps the rules, the switch that says
// whether rules still change with no signature, the rules an agent proposed, and each held act as
// one exact text. A secret's request with a rule is held by the secret's own object
// (./secret/durable-object.ts), in the same way.
//
// WHO ASKS. The boundary, before it sends a mail: so a mail is held even from a mind Worker
// that is hostile. The kernel, before it runs a verb a rule names: so a verb is held from the
// mind's agents and loaded code, and not from a mind Worker that is itself hostile, which holds
// the stub it would call.
//
// OPEN AT BIRTH. Until a member locks the gate with a signed statement, a member's session and the
// mind's own code set, loosen and remove rules with no signature. Locked, a member's session may
// only tighten, the mind's code may only propose, and anything else is a member's signed statement.
import { DurableObject } from "cloudflare:workers";
import {
  ACT_APPROVED,
  ACT_HELD,
  ACT_HOLD_EXPIRED,
  ACT_REJECTED,
  type Act,
  actOfText,
  ActRule,
  APPROVALS_CONTEXT,
  GATE_LOCKED,
  GATE_UNLOCKED,
  type GateAnswer,
  isMailAct,
  RULE_PROPOSED,
  RULE_SET,
  ruleHolds,
  rulesTighten,
  sha256Hex,
} from "iterate/acts";
import { codedError } from "iterate/lib";
import type { Envelope } from "iterate/signed";
import type { Env } from "./env.ts";
import type { Signer } from "./secret/contract.ts";

/** The one object's name. */
export const GATE = "gate";

/** `from` is the caller's claim of where the act began: never checked. */
export type HeldAct = {
  digest: string;
  text: string;
  at: number;
  until: number;
  from?: string;
  state: "waiting" | "approved" | "rejected" | "done";
  signer?: Signer;
  reason?: string;
};

export type ProposedRule = { id: string; rule: ActRule; from?: string; at: number };

/** Who changes the rules with no signature: a member's session on the page, or the mind's code. */
export type RuleWriter = { member: { userId: string; email: string } } | { mind: string };

export type GateFacts = GateAnswer["facts"];
export type GateState = {
  locked: boolean;
  rules: ActRule[];
  proposed: ProposedRule[];
  /** What waits, or was approved and is not done yet. `waited`: a caller waits for it now. */
  held: (HeldAct & { waited: boolean })[];
};
/** `run`: the ids of acts a member approved whose caller stopped waiting. The mind does them now:
 *  `approved(id)` gives each one's text. */
export type GateDecision = { error?: string; run?: string[] };

// As a secret's hold: a caller waits five minutes, and the act stays approvable for a day.
const HOLD_MS = 5 * 60_000;
const KEPT_MS = 24 * 60 * 60_000;
const MOST_WAITING = 50;
const MOST_RULES = 50;
const MOST_PROPOSED = 20;
const TEXT_LIMIT = 1024 * 1024;

export class ActsGate extends DurableObject<Env> {
  readonly #waiting = new Map<string, Set<() => void>>();

  async state(): Promise<GateState> {
    return {
      locked: this.#locked(),
      rules: this.#rules(),
      proposed: this.#proposed(),
      held: this.#held()
        .filter((row) => row.state === "waiting" || row.state === "approved")
        .map((row) => ({ ...row, waited: Boolean(this.#waiting.get(row.digest)?.size) })),
    };
  }

  /** WHAT THE GATE SAYS OF AN ACT (iterate/acts `GateAnswer`). The first sight of an act a rule
   *  holds answers `held` at once, so the mind's log hears of it. A call with `wait` then waits. */
  async act(input: { text: string; from?: string; wait?: boolean }): Promise<GateAnswer> {
    const { text, from, wait } = input;
    if (text.length > TEXT_LIMIT)
      throw codedError("INVALID_INPUT", "an act that may wait for approval is 1 MiB at most");
    const act = actOfText(text);
    if (!act)
      throw codedError(
        "INVALID_INPUT",
        "an act is a mail or a verb's call, as iterate/acts makes it",
      );
    const digest = await sha256Hex(text);
    const key = `held:${digest}`;
    let row = this.#held().find((held) => held.digest === digest);
    const ruled = this.#rules().some((rule) => ruleHolds(rule, act));
    // the rules as they are now: a rule taken away frees what waited under it
    if (row?.state === "waiting" && !ruled) {
      this.ctx.storage.kv.delete(key);
      row = undefined;
    }
    if (!row) {
      if (!ruled) return { state: "free", facts: [] };
      if (this.#held().filter((held) => held.state === "waiting").length >= MOST_WAITING)
        throw codedError(
          "UNAVAILABLE",
          `${MOST_WAITING} acts wait for approval already: approve or reject some first`,
        );
      const now = Date.now();
      this.ctx.storage.kv.put<HeldAct>(key, {
        digest,
        text,
        at: now,
        until: now + KEPT_MS,
        from,
        state: "waiting",
      });
      console.info({ event: "approval.act-held", digest, act: act.act, from });
      return {
        state: "held",
        digest,
        facts: factsOf({
          type: ACT_HELD,
          payload: { digest, act: act.act, summary: summaryOf(act), from },
        }),
      };
    }
    if (row.state === "waiting" && wait) {
      await this.#settled(digest, HOLD_MS);
      row = this.ctx.storage.kv.get<HeldAct>(key) ?? row;
    }
    if (row.state === "done") return { state: "done", digest, facts: [] };
    if (row.state === "rejected")
      return {
        state: "rejected",
        digest,
        reason: row.reason || "",
        by: row.signer?.principal.email || row.signer?.principal.actor || "a member",
        facts: [],
      };
    if (row.state === "waiting") {
      if (!wait) return { state: "held", digest, facts: [] };
      console.info({ event: "approval.hold-expired", digest });
      return {
        state: "waiting",
        digest,
        facts: factsOf({ type: ACT_HOLD_EXPIRED, payload: { digest } }),
      };
    }
    // no await from the read above to this mark: one approval does the act once
    this.ctx.storage.kv.put<HeldAct>(key, { ...row, state: "done" });
    return { state: "go", digest, facts: [] };
  }

  /** An act a member approved that is not done yet, for the mind to do: null when it is none. */
  async approved(digest: string): Promise<{ digest: string; text: string; from?: string } | null> {
    const row = this.#held().find((held) => held.digest === digest);
    if (row?.state !== "approved") return null;
    return { digest, text: row.text, from: row.from };
  }

  /** AN APPROVED MAIL THAT DID NOT GO: the boundary's, when the mail service refused the mail the
   *  gate let go. The member's yes stands again, so the same mail goes when it is sent again. A
   *  verb gets no approval back: one that failed may have acted. */
  async notDone(digest: string): Promise<void> {
    const key = `held:${digest}`;
    const row = this.ctx.storage.kv.get<HeldAct>(key);
    const act = row && actOfText(row.text);
    if (row?.state !== "done" || !row.signer || !act || !isMailAct(act)) return;
    this.ctx.storage.kv.put<HeldAct>(key, { ...row, state: "approved" });
    console.info({ event: "approval.act-given-back", digest });
  }

  /** The rules, changed with no signature: by anyone while the gate is open, and by a member's
   *  session when the change only holds more. */
  async setRules(input: {
    rules: unknown;
    by: RuleWriter;
  }): Promise<{ rules: ActRule[]; facts: GateFacts }> {
    const rules = rulesOf(input.rules);
    const before = this.#rules();
    if (this.#locked()) {
      if ("mind" in input.by)
        throw codedError(
          "FORBIDDEN",
          "the approval rules are locked: the mind's code proposes a rule with itx.approvals.propose(rule), and a member signs it on /secrets/approvals",
        );
      if (!rulesTighten(before, rules))
        throw codedError(
          "FORBIDDEN",
          "the approval rules are locked: a change that holds less needs a member's signed statement",
        );
    }
    this.#setRules(rules);
    return { rules, facts: factsOf({ type: RULE_SET, payload: { rules, by: input.by } }) };
  }

  /** A rule the mind's code asks for. It is no rule until a member signs it. */
  async propose(input: {
    rule: unknown;
    from?: string;
  }): Promise<{ id: string; facts: GateFacts }> {
    const parsed = ActRule.safeParse(input.rule);
    if (!parsed.success) throw codedError("INVALID_INPUT", problemsOf(parsed.error));
    const rule = parsed.data;
    const id = (await sha256Hex(JSON.stringify(rule))).slice(0, 16);
    const known = this.#proposed().some((proposal) => proposal.id === id);
    if (!known && this.#proposed().length >= MOST_PROPOSED)
      throw codedError("UNAVAILABLE", `${MOST_PROPOSED} proposed rules wait already`);
    if (known) return { id, facts: [] };
    this.ctx.storage.kv.put<ProposedRule>(`proposed:${id}`, {
      id,
      rule,
      at: Date.now(),
      from: input.from,
    });
    console.info({ event: "approval.rule-proposed", id, verb: rule.verb });
    return {
      id,
      facts: factsOf({
        type: RULE_PROPOSED,
        payload: { id, rule, from: input.from },
      }),
    };
  }

  /** A member's signed statement: an approval or a rejection of held acts, the rules, or the lock.
   *  A statement the auth Worker refused is a log line alone, since anyone can send one. */
  async decide(envelope: Envelope): Promise<{ result: GateDecision; facts: GateFacts }> {
    const verified = await this.env.AUTH.verify(envelope);
    if ("refused" in verified) {
      console.info({ event: "approval.statement-refused", reason: verified.refused });
      return { result: { error: verified.refused }, facts: [] };
    }
    const { statement } = verified;
    const signer: Signer = {
      principal: verified.signer.principal,
      key: verified.signer.key,
      label: verified.signer.label,
      userVerified: verified.signer.userVerified,
    };
    const refuse = (error: string) => {
      console.info({ event: "approval.statement-refused", reason: error, type: statement.type });
      return { result: { error }, facts: [] };
    };
    const done = (type: string, payload: Record<string, unknown>, result: GateDecision = {}) => {
      console.info({ event: type.replace("events.iterate.com/approval/", "approval.") });
      return {
        result,
        facts: factsOf({ type, payload: { ...payload, signer, signed: envelope } }),
      };
    };
    if (statement.path !== APPROVALS_CONTEXT)
      return refuse(`the statement is about ${statement.path}, not ${APPROVALS_CONTEXT}`);
    if (!verified.signer.member)
      return refuse("only a member's key approves, rejects, changes a rule or locks");
    // as a sign-in asks: a passkey that checked nobody is anyone's who holds the device
    if (verified.signer.userVerified === false)
      return refuse("the passkey did not check that it is you, by a PIN, a fingerprint or a face");
    if (statement.type === GATE_LOCKED || statement.type === GATE_UNLOCKED) {
      this.ctx.storage.kv.put("locked", statement.type === GATE_LOCKED);
      return done(statement.type, {});
    }
    if (statement.type === RULE_SET) {
      let rules: ActRule[];
      try {
        rules = rulesOf(statement.payload?.rules);
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error));
      }
      this.#setRules(rules);
      // the proposal this takes up, when the page named one
      const proposal = statement.payload?.proposal;
      if (typeof proposal === "string") this.ctx.storage.kv.delete(`proposed:${proposal}`);
      return done(RULE_SET, { rules });
    }
    if (statement.type !== ACT_APPROVED && statement.type !== ACT_REJECTED)
      return refuse(`the gate does not act on ${statement.type}`);
    const digests = statement.about || [];
    if (!digests.length) return refuse("the statement names no act");
    const now = Date.now();
    const held = digests
      .map((digest) => this.ctx.storage.kv.get<HeldAct>(`held:${digest}`))
      .filter((row) => !!row);
    if (
      held.length !== digests.length ||
      held.some((row) => row.state !== "waiting" || row.until <= now)
    )
      return refuse("an act it names does not wait here");
    const reason = statement.payload?.reason;
    const approved = statement.type === ACT_APPROVED;
    if (!approved && (typeof reason !== "string" || !reason.trim()))
      return refuse("a rejection names its reason");
    for (const row of held)
      this.ctx.storage.kv.put<HeldAct>(`held:${row.digest}`, {
        ...row,
        state: approved ? "approved" : "rejected",
        signer,
        ...(!approved && { reason: String(reason) }),
      });
    // an act nobody waits for is done by the mind now: its caller reads the outcome later
    const run = approved
      ? held.filter((row) => !this.#waiting.get(row.digest)?.size).map((row) => row.digest)
      : [];
    for (const digest of digests) this.#wake(digest);
    return approved
      ? done(ACT_APPROVED, { digests }, { run })
      : done(ACT_REJECTED, { digests, reason: String(reason) });
  }

  #locked(): boolean {
    return this.ctx.storage.kv.get<boolean>("locked") ?? false;
  }

  #rules(): ActRule[] {
    return this.ctx.storage.kv.get<ActRule[]>("rules") ?? [];
  }

  #setRules(rules: ActRule[]) {
    this.ctx.storage.kv.put("rules", rules);
    console.info({ event: "approval.rule-set", rules });
  }

  #proposed(): ProposedRule[] {
    return [...this.ctx.storage.kv.list<ProposedRule>({ prefix: "proposed:" })]
      .map(([, proposal]) => proposal)
      .sort((a, b) => a.at - b.at);
  }

  #held(): HeldAct[] {
    const now = Date.now();
    const rows: HeldAct[] = [];
    for (const [key, row] of this.ctx.storage.kv.list<HeldAct>({ prefix: "held:" }))
      if (row.until > now) rows.push(row);
      else this.ctx.storage.kv.delete(key);
    return rows;
  }

  #settled(digest: string, ms: number): Promise<void> {
    return new Promise((settle) => {
      const waiters = this.#waiting.get(digest) ?? new Set();
      this.#waiting.set(digest, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        settle();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
    });
  }

  #wake(digest: string) {
    for (const done of [...(this.#waiting.get(digest) ?? [])]) done();
    this.#waiting.delete(digest);
  }
}

const factsOf = (event: { type: string; payload: Record<string, unknown> }): GateFacts => [
  { path: APPROVALS_CONTEXT, events: [event] },
];

function rulesOf(given: unknown): ActRule[] {
  if (!Array.isArray(given) || given.length > MOST_RULES)
    throw codedError("INVALID_INPUT", `the rules are a list of ${MOST_RULES} at most`);
  const rules = given.map((rule) => {
    const parsed = ActRule.safeParse(rule);
    if (!parsed.success) throw codedError("INVALID_INPUT", problemsOf(parsed.error));
    return parsed.data;
  });
  // one rule a verb: a second would say the same or less
  const byVerb = new Map(rules.map((rule) => [rule.verb, rule]));
  return [...byVerb.values()].sort((a, b) => (a.verb < b.verb ? -1 : 1));
}

const problemsOf = (error: { issues: { message: string }[] }) =>
  error.issues.map((issue) => issue.message).join("; ");

/** One line for a list: who a mail goes to and its subject, or the verb. */
export function summaryOf(act: Act): string {
  if (isMailAct(act)) return `Mail to ${[...act.to, ...act.cc].join(", ")}: ${act.subject}`;
  return act.act;
}
