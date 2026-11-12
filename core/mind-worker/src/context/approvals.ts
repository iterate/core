import type { ItxHostRootContext } from "core-itx";
import type { ActRule } from "iterate/acts";
import { releasedAnswer, reportIssue } from "iterate/lib";
import { platformOriginOf } from "iterate/mind-api";
import type { Door } from "iterate/workers";
import { hopCaller } from "./hop-caller.ts";

export const APPROVALS_ROOT_DESCRIPTION =
  "what waits for a member's signed yes before it is done: `approvals.rules()` → { locked, rules } · `approvals.setRules([{ verb, to? }])` replaces the rules while they are open (not locked) · `approvals.propose({ verb, to? })` → { id, signAt } asks a member to sign one rule at `signAt`; with `{ secret, methods, hosts, jsonStrings?, freePaths? }`, where `secret` is a secret's path, it proposes a rule for a request with that secret; a proposal holds nothing, and only a member puts a rule for a secret in force, so this is the one way for code or an agent to get one. A rule's `verb` is `email.send` (with `to: [\"*@example.com\"]` for mail to some recipients alone), one verb such as `itx.whatsapp.sendMessage`, or every verb under a name, `itx.whatsapp.*`. A held call waits five minutes for the member, then throws; the act can be approved for a day, and is done then";

/** A rule for a request with a secret, as the mind's code proposes it: the vault checks it, and a
 *  member signs it as that secret's rule. */
type SecretRuleProposal = {
  secret: string;
  methods: string[];
  hosts: string[];
  jsonStrings?: string[];
  freePaths?: string[];
};

/** The vault's gate for acts (iterate/acts), as the mind's own code reaches it. The gate decides:
 *  once a member locked it, `setRules` is refused and `propose` is the way. */
export function approvalsRoot(
  context: ItxHostRootContext,
  egress: Pick<Door, "actRules" | "setActRules" | "proposeActRule">,
  domain: string,
) {
  // Read at each call, never as the root is built: a context builds its roots before it can say
  // who calls it.
  const from = () => hopCaller(context);
  // The gate's facts are the platform's own. One that does not land is reported: the gate holds
  // the rules, and the log only says who changed them.
  const record = async (facts: Awaited<ReturnType<Door["setActRules"]>>["facts"]) => {
    for (const { path, events } of facts)
      await context
        .context(path)
        .invoke(["itx", "builtins", ["append", ...events]], [], { ...from(), platform: true })
        .catch((error: unknown) => reportIssue("approval.facts-not-recorded", error, { path }));
  };
  // each answer of the gate is copied and released: iterate/lib `releasedAnswer` says why
  return {
    rules: () => releasedAnswer(egress.actRules()),
    setRules: async (rules: ActRule[]) => {
      const set = await releasedAnswer(
        egress.setActRules({ rules, from: from().path || context.path }),
      );
      await record(set.facts);
      return set.rules;
    },
    // A rule for an act, or with `secret` a rule for a request with that secret. Either is a
    // proposal alone: the gate keeps it, and a member approves it with a key or rejects it, on
    // the approvals page beside the acts that wait. `signAt` is that page's address and holds no
    // word of the rule: what a member signs there is what the vault kept.
    propose: async (rule: ActRule | SecretRuleProposal) => {
      const proposed = await releasedAnswer(
        egress.proposeActRule({ rule, from: from().path || context.path }),
      );
      await record(proposed.facts);
      return { id: proposed.id, signAt: `${platformOriginOf(domain)}/secrets/approvals#proposed` };
    },
  };
}
