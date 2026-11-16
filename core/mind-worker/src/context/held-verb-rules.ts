import { type ActRule, EMAIL_SEND } from "iterate/acts";
import { releasedAnswer, reportIssue } from "iterate/lib";
import type { Door } from "iterate/workers";

/** THE VAULT'S GATE AS THE KERNEL ASKS IT (core-itx `ItxHost.acts`), through the boundary. Each
 *  answer is copied and released: iterate/lib `releasedAnswer` says why. `boundary` is read at
 *  each call: the binding is not there when this is first read. */
export function gateOf(boundary: () => Pick<Door, "actRules" | "act">) {
  return {
    verbRules: heldVerbRules(() => releasedAnswer(boundary().actRules())),
    ask: (input: Parameters<Door["act"]>[0]) => releasedAnswer(boundary().act(input)),
  };
}

/** THE VERB RULES FOR THE KERNEL'S HOLD (core-itx `ItxHost.acts`), read from the vault's gate and
 *  kept for `keptMs`: the kernel asks on every call a context resolves by its own table, so a new
 *  rule holds within that time. A read that fails is reported, and the rules last read stand: a
 *  vault that cannot be reached must not stop every call of the mind, nor lift a rule. Before the
 *  first read there are no rules to stand, and an empty list would lift them all: so that failure
 *  fails the call, nothing is kept, and the next call reads again.
 *
 *  The rules are kept, never the read's promise: its I/O is the request's that started it, and
 *  workerd cancels a request that waits on another request's I/O at once, as "hung". So each call
 *  that finds no rules kept reads them itself. */
export function heldVerbRules(
  read: () => Promise<{ rules: ActRule[] }>,
  keptMs = 5_000,
): () => Promise<readonly ActRule[]> {
  let last: readonly ActRule[] | undefined;
  let keptUntil = 0;
  return async () => {
    if (last && keptUntil > Date.now()) return last;
    try {
      const { rules } = await read();
      last = rules.filter((rule) => rule.verb !== EMAIL_SEND);
    } catch (error) {
      reportIssue("approval.rules-not-read", error);
      if (!last) throw error;
    }
    keptUntil = Date.now() + keptMs;
    return last;
  };
}
