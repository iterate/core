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
import { jsonEqual } from "iterate/lib";

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
  resolved: ItxExpression,
  extraArgs: readonly unknown[],
  resolvedVerb: (verb: ItxExpression) => ItxExpression | null,
): VerbAct | { refused: string } | null {
  for (const rule of rules) {
    if (rule.verb === EMAIL_SEND) continue;
    const under = rule.verb.endsWith(".*");
    const name = under ? rule.verb.slice(0, -2) : rule.verb;
    const target = resolvedVerb(normalizedItxExpression(name));
    if (!target || resolved.length < target.length) continue;
    // every step before the rule's last is the same step; its last is the same name, called or not
    const here = target.length - 1;
    const same = target.every((step, index) =>
      index < here
        ? jsonEqual(step, resolved[index])
        : jsonEqual(step, resolved[index]) ||
          (typeof step === "string" && step === itxExpressionStepName(resolved[index])),
    );
    if (!same) continue;
    // The rule's own last step can be a call that only finds the thing (`rpcStubs.get(key)`): it
    // is the same step in the call, and no act. A call of the rule's own name is the act.
    const from = jsonEqual(target[here], resolved[here]) ? here + 1 : here;
    const called = resolved.findIndex((step, index) => index >= from && Array.isArray(step));
    const end = called === -1 ? resolved.length - 1 : called;
    // nothing is called: a name read as a value is no act
    if (called === -1 && extraArgs.length === 0) continue;
    const beyond = resolved.slice(target.length, end + 1);
    const written = [name, ...beyond.map((step) => itxExpressionStepName(step))].join(".");
    if (called !== -1 && (called < resolved.length - 1 || extraArgs.length > 0))
      return {
        refused: `${written} waits for a member's approval, and can be held only as one call: names, then one call with its arguments, and nothing after it`,
      };
    const call = called === -1 ? undefined : resolved[called];
    // the call is in the expression, or the arguments beside it call the expression's end
    return verbActOf(written, Array.isArray(call) ? call.slice(1) : [...extraArgs]);
  }
  return null;
}
