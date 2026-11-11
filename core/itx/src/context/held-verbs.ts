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
 *  the same rules, null when it names nothing there. */
export function heldVerbOf(
  rules: readonly ActRule[],
  resolved: ItxExpression,
  extraArgs: readonly unknown[],
  resolvedVerb: (verb: ItxExpression) => ItxExpression | null,
): VerbAct | { refused: string } | null {
  const last = resolved.at(-1);
  // a name read as a value is no call: only a call is an act
  if (!Array.isArray(last) && extraArgs.length === 0) return null;
  for (const rule of rules) {
    if (rule.verb === EMAIL_SEND) continue;
    const under = rule.verb.endsWith(".*");
    const name = under ? rule.verb.slice(0, -2) : rule.verb;
    const target = resolvedVerb(normalizedItxExpression(name));
    if (!target || resolved.length < target.length) continue;
    if (under ? resolved.length === target.length : resolved.length !== target.length) continue;
    // every step before the rule's last is the same step; its last is the same name, called or not
    const same = target.every((step, index) =>
      index < target.length - 1
        ? jsonEqual(step, resolved[index])
        : under
          ? jsonEqual(step, resolved[index])
          : itxExpressionStepName(step) === itxExpressionStepName(resolved[index]),
    );
    if (!same) continue;
    const beyond = resolved.slice(target.length);
    const written = [name, ...beyond.map((step) => itxExpressionStepName(step))].join(".");
    // one call at the end: a call in the middle has arguments the approver would not see
    if (
      beyond.slice(0, -1).some((step) => Array.isArray(step)) ||
      (Array.isArray(last) && extraArgs.length > 0)
    )
      return {
        refused: `${written} waits for a member's approval, and can be held only as one call: names, then one call with its arguments`,
      };
    return verbActOf(written, Array.isArray(last) ? last.slice(1) : [...extraArgs]);
  }
  return null;
}
