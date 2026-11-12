// `start({ egress })`: the itx expression that answers the sandbox's requests in place of the
// mind's `itx.fetch`. It is a rule for `itx.fetch` on the sandbox's context. The library's hop
// that appends it does not carry the caller's mark, so the rule is admitted here, as any row the
// caller writes itself (loaded code names no built-in in a target). With none, a
// sandbox sends through `itx.fetch` and may use any secret pinned to where it sends.
import { z } from "zod";
import { admitRowsOfCall, type Caller } from "core-itx";
import type { ItxExpression } from "iterate/expression";

// the facet checks the rest of the options; the rule's own admission checks the target
const StartWithEgress = z.looseObject({ egress: z.unknown() });

/** The rule a start's `egress` names, and the start's steps without it; null when none is named. */
export function egressRuleOfStart(steps: ItxExpression, caller: Caller, sandboxPath: string) {
  const [first, ...rest] = steps;
  if (!Array.isArray(first) || first[0] !== "start") return null;
  const [, options, ...more] = first;
  const named = StartWithEgress.safeParse(options);
  if (!named.success || !("egress" in named.data)) return null;
  const { egress, ...start } = named.data;
  const without: ItxExpression = [["start", start, ...more], ...rest];
  const rule = {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.fetch", target: egress },
  };
  admitRowsOfCall(caller, [rule], sandboxPath);
  return { rule, steps: without };
}

type EgressRule = NonNullable<ReturnType<typeof egressRuleOfStart>>["rule"];

/** The rule is on before the start runs: the facet and the context are two objects, so a box that
 *  ran first could send through the mind's own `itx.fetch` in between (a custom entrypoint, an
 *  `exec` of another caller). A refused start takes its rule back by compare-and-set, so a later
 *  rule stays. Core has no compare-and-set that puts a rule back, so a box that had an earlier rule
 *  of its own (`hadOwnRule`) keeps the one this start named, and the error says so. A start still
 *  going on when its caller stops waiting comes up all the same, and keeps its rule. */
export async function ruleThenStart<T>(
  rule: EgressRule,
  hadOwnRule: boolean,
  append: (event: EgressRule | { type: string; payload: object }) => Promise<unknown>,
  start: () => Promise<T>,
): Promise<T> {
  await append(rule);
  try {
    return await start();
  } catch (error) {
    if (error instanceof Error && /is still starting/.test(error.message)) throw error;
    const keeps = (why: string) =>
      new Error(
        `${error instanceof Error ? error.message : String(error)} (the sandbox keeps the egress this start named: ${why})`,
        { cause: error },
      );
    if (hadOwnRule)
      throw keeps("its earlier rule cannot be put back without overwriting a later one");
    await append({
      type: rule.type,
      payload: { match: "itx.fetch", target: null, ifTarget: rule.payload.target },
    }).catch((failure: unknown) => {
      throw keeps(`taking it back failed: ${String(failure)}`);
    });
    throw error;
  }
}
