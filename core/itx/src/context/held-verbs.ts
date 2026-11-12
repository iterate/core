// held-verbs.ts — WHICH CALL AN APPROVAL RULE HOLDS (iterate/acts). A rule names a verb as its
// owner writes it, `itx.whatsapp.sendMessage`. The same function is reached by other names too:
// another rule that points at it, or the lent stub by its key. So a call is compared where its
// context has resolved it: the call's own resolved expression against the resolved expression of
// each rule's verb. A call that ends at the same place is held, whatever it was called.
import { type ActRule, EMAIL_SEND, type VerbAct, verbActOf } from "iterate/acts";
import {
  type ItxExpression,
  itxExpressionStepName,
  normalizedItxExpression,
} from "iterate/expression";
import { codedError, jsonEqual } from "iterate/lib";

/** WHAT A CALL'S NAME IS RIGHT NOW: the resolved call with the arguments of its last step taken
 *  off. A rule and an act name a verb as its owner writes it, and the mind's table says what that
 *  name is. The table can change between the moment an act is held and the moment it is done. So
 *  a held act carries a mark of this (the resolver hashes it), and an act whose name has become
 *  another function is another act, which nobody approved. A step that only finds the thing
 *  (`rpcStubs.get(key)`) keeps its argument: it says which thing. */
export function calledNameOf(resolved: ItxExpression): ItxExpression {
  const last = resolved.at(-1);
  return Array.isArray(last) ? [...resolved.slice(0, -1), last[0]] : resolved;
}

/** A HANDLE'S OWN DOORS. Each thing a step finds (a lent stub, a worker, a facet) is a handle,
 *  and a handle has two functions of its own: `invoke(steps)` hands the steps to the thing, and
 *  `applyRoot(args)` calls the thing (iterate/expression `InvokeHandle`). */
const DOORS = new Set(["invoke", "applyRoot"]);

const isSteps = (value: unknown): value is ItxExpression =>
  Array.isArray(value) &&
  value.every(
    (step) => typeof step === "string" || (Array.isArray(step) && typeof step[0] === "string"),
  );

/** THE EXPRESSION AS THE WALK DOES IT (./dispatch.ts `walkSteps`). Three spellings are no steps
 *  of their own, and a rule that names `send` holds each:
 *  - a name that is then called, `x.send` and `("jo")`, is the call `x.send("jo")`;
 *  - `x.invoke([["send", "jo"]])` is `x.send("jo")`: the handle hands the steps to the thing;
 *  - `x.applyRoot(["jo"])` is `x("jo")`.
 *  So they are undone before a rule is compared. `unread` is the place of the first door whose
 *  argument is no list of steps: what it calls cannot be read here. */
function asWalked(resolved: ItxExpression): {
  steps: ItxExpression;
  unread: number;
  /** Whether a door was opened: the steps are then not the ones that were written. */
  opened: boolean;
} {
  const steps = [...resolved];
  let opened = false;
  for (let at = 0; at < steps.length; at++) {
    const next = steps[at + 1];
    const name = steps[at]!;
    if (typeof name === "string" && Array.isArray(next) && next[0] === "")
      steps.splice(at, 2, [name, ...next.slice(1)]);
    const step = steps[at]!;
    if (!Array.isArray(step) || !DOORS.has(step[0])) continue;
    const [door, given] = step;
    if (door === "invoke" ? !isSteps(given) : !Array.isArray(given))
      return { steps, unread: at, opened };
    opened = true;
    // the steps take the door's place, and are read in their turn: a door may hold a door
    // `given` is a list of steps, or of arguments: checked right above
    const inside: ItxExpression =
      door === "invoke" ? (given as ItxExpression) : [["", ...(given as unknown[])]];
    steps.splice(at, 1, ...inside);
    at -= 1;
  }
  return { steps, unread: -1, opened };
}

/** Whether a step of the call is this step of a rule's verb. A name is the same name. A step that
 *  finds a thing, `rpcStubs.get(key)`, is the same step with more arguments after its own: the
 *  function that finds reads its own ones, so `get(key, 0)` is the same stub by another
 *  spelling. */
function sameStep(ofRule: ItxExpression[number], ofCall: ItxExpression[number] | undefined) {
  if (typeof ofRule === "string") return ofRule === ofCall;
  return (
    Array.isArray(ofCall) &&
    ofCall.length >= ofRule.length &&
    ofRule.every((part, index) => jsonEqual(part, ofCall[index]))
  );
}

/** A STEP THAT FINDS A THING TAKES ITS OWN ARGUMENTS AND NO MORE (`rpcStubs.get(key)`,
 *  `workers.get(spec)`, `facets.get(name, spec)`). A rule is compared by the steps that reach its
 *  verb. A finder that read its first argument and let a second one pass gave the same thing a
 *  second spelling, `get(key, 0)`, which no rule named. The comparison above reads such a step
 *  right all the same; this makes the spelling an error for every caller. */
export function refuseMoreArguments(finder: string, more: readonly unknown[]): void {
  if (more.length > 0)
    throw codedError(
      "INVALID_INPUT",
      `${finder} takes no argument after its own, and got ${more.length} more`,
    );
}

/** The call as an act to hold, why it cannot be held as it is written, or null when no rule names
 *  it. `resolved` is the call after its context's rules; `resolvedVerb` resolves a rule's verb by
 *  the same rules, null when it names nothing there.
 *
 *  A RULE HOLDS THE FIRST CALL AT ITS VERB OR UNDER IT, WHEREVER THE EXPRESSION GOES ON FROM THERE.
 *  `itx.whatsapp.sendMessage(to, text).ok` calls the verb and then reads a name of its answer: the
 *  call runs all the same. So what counts is the first call step at the rule's place or after it,
 *  never how the expression ends. Anything after that call is refused: a held act is one call,
 *  which the approver reads whole.
 *
 *  `itx.whatsapp.sendMessage` holds that verb and every verb under it. `itx.whatsapp.*` holds every
 *  call at `itx.whatsapp` or under it. */
export function heldVerbOf(
  rules: readonly ActRule[],
  written: ItxExpression,
  extraArgs: readonly unknown[],
  resolvedVerb: (verb: ItxExpression) => ItxExpression | null,
): VerbAct | { refused: string } | null {
  const walked = asWalked(written);
  // As the walk does it, and then as it is written: a function of the thing that is itself named
  // `invoke` is called by the written steps, and a rule that names it holds those.
  return (
    heldAs(rules, walked.steps, walked.unread, extraArgs, resolvedVerb) ??
    (walked.opened ? heldAs(rules, written, -1, extraArgs, resolvedVerb) : null)
  );
}

function heldAs(
  rules: readonly ActRule[],
  resolved: ItxExpression,
  unread: number,
  extraArgs: readonly unknown[],
  resolvedVerb: (verb: ItxExpression) => ItxExpression | null,
): VerbAct | { refused: string } | null {
  for (const rule of rules) {
    if (rule.verb === EMAIL_SEND) continue;
    const under = rule.verb.endsWith(".*");
    const name = under ? rule.verb.slice(0, -2) : rule.verb;
    const target = resolvedVerb(normalizedItxExpression(name));
    if (!target) continue;
    // A door that cannot be read, on the way to the rule's verb or at it: it may call the verb.
    if (
      unread >= 0 &&
      unread <= target.length &&
      target.slice(0, unread).every((step, index) => sameStep(step, resolved[index]))
    )
      return {
        refused: `${name} waits for a member's approval, and ${String(itxExpressionStepName(resolved[unread]))}(…) here could call it unseen: write the call itself`,
      };
    if (resolved.length < target.length) continue;
    // every step before the rule's last is the same step; its last is the same name, called or not
    const here = target.length - 1;
    const same = target.every((step, index) =>
      index < here
        ? sameStep(step, resolved[index])
        : sameStep(step, resolved[index]) ||
          (typeof step === "string" && step === itxExpressionStepName(resolved[index])),
    );
    if (!same) continue;
    // The rule's own last step can be a call that only finds the thing (`rpcStubs.get(key)`): it
    // is the same step in the call, and no act. A call of the rule's own name is the act.
    const from = sameStep(target[here]!, resolved[here]) ? here + 1 : here;
    const called = resolved.findIndex((step, index) => index >= from && Array.isArray(step));
    const end = called === -1 ? resolved.length - 1 : called;
    // nothing is called: a name read as a value is no act
    if (called === -1 && extraArgs.length === 0) continue;
    const beyond = resolved.slice(target.length, end + 1);
    // an anonymous call, of the name itself or of what a name under it answers, adds no name
    const names = beyond.map((step) => itxExpressionStepName(step)).filter(Boolean);
    const act = [name, ...names].join(".");
    if (called !== -1 && (called < resolved.length - 1 || extraArgs.length > 0))
      return {
        refused: `${act} waits for a member's approval, and can be held only as one call: names, then one call with its arguments, and nothing after it`,
      };
    const call = called === -1 ? undefined : resolved[called];
    // the call is in the expression, or the arguments beside it call the expression's end
    return verbActOf(act, Array.isArray(call) ? call.slice(1) : [...extraArgs]);
  }
  return null;
}
