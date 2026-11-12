// held-verbs.ts — WHICH CALL AN APPROVAL RULE HOLDS (iterate/acts). A rule names a verb as its
// owner writes it, `itx.whatsapp.sendMessage`. The same function is reached by other names too:
// another rule that points at it, or the lent stub by its key. So a call is compared where its
// context has resolved it: the call's own resolved expression against the resolved expression of
// each rule's verb. A call that ends at the same place is held, whatever it was called.
import { type ActRule, EMAIL_SEND, type VerbAct, verbActOf } from "iterate/acts";
import {
  containsItxExpressionHole,
  isItxExpressionHole,
  ITX_EXPRESSION_MERGE_KEY,
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
 *  finds a thing is the same step by its name and its first argument, which say which thing:
 *  `rpcStubs.get(key)`, `workers.get(spec)`, `facets.get(name, spec)`. What comes after the first
 *  argument does not: `get(key, 0)` is the same stub, and a facet found with no spec, or with
 *  another, is the same facet. */
function sameStep(ofRule: ItxExpression[number], ofCall: ItxExpression[number] | undefined) {
  if (typeof ofRule === "string") return ofRule === ofCall;
  return (
    Array.isArray(ofCall) &&
    ofRule[0] === ofCall[0] &&
    (ofRule.length < 2 || jsonEqual(ofRule[1], ofCall[1]))
  );
}

/** A RULE'S VERB WHOSE ROW FILLS IN THE CALL'S ARGUMENTS. A row may point a name at a call with a
 *  hole, `itx.slack.postMessage => itx.config.slack("chat.postMessage", @)`: the name is then a
 *  call of its own, and what the row pins ("chat.postMessage") says which. A rule on such a name
 *  is resolved with the hole left in place (`verbWithAHole`), and a call is the rule's verb when
 *  it is the same call around the hole: the same name, and every pinned argument the same. */
function sameCallAroundTheHole(
  ofRule: unknown[],
  ofCall: ItxExpression[number] | undefined,
): AroundTheHole {
  if (!Array.isArray(ofCall) || ofRule[0] !== ofCall[0]) return "other";
  const pinned = ofRule.slice(1);
  // an argument that is the hole itself takes every argument from there on: nothing after it
  // can be laid beside the call's
  const open = pinned.findIndex(isItxExpressionHole);
  const compared = open === -1 ? pinned : pinned.slice(0, open);
  if (ofCall.length - 1 < compared.length) return "other";
  const beyond = open === -1 && ofCall.length - 1 > pinned.length;
  return worstOf([
    ...compared.map((value, index) => sameAroundTheHole(value, ofCall[index + 1])),
    beyond ? "more" : "same",
  ]);
}

/** How a call lies beside the call a row makes. "more": every pinned value is there, and the call
 *  gives an argument or a key that the row's call has no place for. A function does not read what
 *  it does not name, so that call does what the row's call does, and it is not the row's call:
 *  no row could have made it, and its approval could not be run as the rule's name.
 *
 *  A call that gives LESS is another call: a pinned value that is the function's own default
 *  (null, false, 0, "") is not there when the call leaves it out, and the kernel does not know
 *  a function's defaults. So a rule on a name that a row fills in holds that row's call; a rule
 *  on the function under it holds every call of it. */
type AroundTheHole = "same" | "more" | "other";
const worstOf = (all: AroundTheHole[]): AroundTheHole =>
  all.includes("other") ? "other" : all.includes("more") ? "more" : "same";

/** An argument that is a list of JSON. */
const isJsonList = (value: unknown): value is unknown[] => Array.isArray(value);

/** An argument that is an object of JSON: keys and values, no list. */
const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value instanceof Object && !Array.isArray(value);

function sameAroundTheHole(pinned: unknown, given: unknown): AroundTheHole {
  if (isItxExpressionHole(pinned)) return "same";
  if (Array.isArray(pinned)) {
    if (!Array.isArray(given) || given.length < pinned.length) return "other";
    return worstOf([
      ...pinned.map((value, index) => sameAroundTheHole(value, given[index])),
      given.length > pinned.length ? "more" : "same",
    ]);
  }
  if (!isJsonObject(pinned)) return jsonEqual(pinned, given) ? "same" : "other";
  if (!isJsonObject(given)) return "other";
  // `...@` merges the caller's object in: the pinned keys are there, and others may be
  const merges = pinned[ITX_EXPRESSION_MERGE_KEY] === true;
  const keys = Object.keys(pinned).filter((key) => key !== ITX_EXPRESSION_MERGE_KEY);
  return worstOf([
    ...keys.map((key) =>
      Object.hasOwn(given, key) ? sameAroundTheHole(pinned[key], given[key]) : "other",
    ),
    merges || Object.keys(given).length === keys.length ? "same" : "more",
  ]);
}

/** WHAT THE CALLER GAVE THE RULE'S NAME, read back out of the call the row made of it. The act is
 *  the name with these: its late approval calls the name with them, and the row fills the call in
 *  again. A hole that is an argument took every argument from there on. A hole inside an
 *  argument is the one argument the caller gave: a nested `@` is that argument whole, and a `...@`
 *  is the keys the row did not pin (a pinned key the caller also gave was overwritten). */
function givenAroundTheHole(ofRule: unknown[], ofCall: unknown[]): unknown[] {
  const pinned = ofRule.slice(1);
  const open = pinned.findIndex(isItxExpressionHole);
  if (open !== -1) return ofCall.slice(open + 1);
  const found = pinned.flatMap((value, index) => givenInside(value, ofCall[index + 1]));
  return found.slice(0, 1);
}

function givenInside(pinned: unknown, given: unknown): unknown[] {
  if (isItxExpressionHole(pinned)) return [given];
  if (isJsonList(pinned) && isJsonList(given))
    return pinned.flatMap((value, index) => givenInside(value, given[index]));
  if (!isJsonObject(pinned) || !isJsonObject(given)) return [];
  const keys = Object.keys(pinned).filter((key) => key !== ITX_EXPRESSION_MERGE_KEY);
  const nested = keys.flatMap((key) => givenInside(pinned[key], given[key]));
  if (nested.length > 0 || pinned[ITX_EXPRESSION_MERGE_KEY] !== true) return nested;
  return [Object.fromEntries(Object.entries(given).filter(([key]) => !keys.includes(key)))];
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
    // The rule's verb is a call that its row fills in: the call around the hole is the act.
    const filledIn = target[here];
    if (Array.isArray(filledIn) && containsItxExpressionHole(filledIn)) {
      const call = resolved[here];
      if (!target.slice(0, here).every((step, index) => sameStep(step, resolved[index]))) continue;
      const beside = sameCallAroundTheHole(filledIn, call);
      if (beside === "other" || !Array.isArray(call)) continue;
      if (beside === "more")
        return {
          refused: `${name} waits for a member's approval, and can be held only as the call its row makes: this call gives more than the row has a place for`,
        };
      if (resolved.length > target.length || extraArgs.length > 0)
        return {
          refused: `${name} waits for a member's approval, and can be held only as one call: names, then one call with its arguments, and nothing after it`,
        };
      return verbActOf(name, givenAroundTheHole(filledIn, call));
    }
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
