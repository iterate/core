import { type ActRule, EMAIL_SEND } from "iterate/acts";
import { releasedAnswer, reportIssue } from "iterate/lib";
import type { Door } from "iterate/workers";

/** THE VAULT'S GATE AS THE KERNEL ASKS IT (core-itx `ItxHost.acts`), through the boundary. Each
 *  answer is copied and released (iterate/lib `releasedAnswer`). An answer that is left alone
 *  keeps its call's session open for as long as the code that made the call runs, and a context
 *  that works for a long time (an agent's turn, a call that waits for a member) asks again every
 *  few seconds. `door` is read at each call: the binding is not there when this is first read. */
export function gateOf(door: () => Pick<Door, "actRules" | "act">) {
  return {
    verbRules: heldVerbRules(() => releasedAnswer(door().actRules())),
    ask: (input: Parameters<Door["act"]>[0]) => releasedAnswer(door().act(input)),
  };
}

/** THE VERB RULES FOR THE KERNEL'S HOLD (core-itx `ItxHost.acts`), read from the vault's gate and
 *  kept for `keptMs`: the kernel asks on every call a context resolves by its own table, so a new
 *  rule holds within that time. A read that fails is reported, and the rules last read stand: a
 *  vault that cannot be reached must not stop every call of the mind, nor lift a rule. */
export function heldVerbRules(
  read: () => Promise<{ rules: ActRule[] }>,
  keptMs = 5_000,
): () => Promise<readonly ActRule[]> {
  let last: readonly ActRule[] = [];
  let kept: { until: number; rules: Promise<readonly ActRule[]> } | undefined;
  return () => {
    if (!kept || kept.until <= Date.now())
      kept = {
        until: Date.now() + keptMs,
        rules: read().then(
          ({ rules }) => (last = rules.filter((rule) => rule.verb !== EMAIL_SEND)),
          (error: unknown) => {
            reportIssue("approval.rules-not-read", error);
            return last;
          },
        ),
      };
    return kept.rules;
  };
}
