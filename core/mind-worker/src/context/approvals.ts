import type { ItxHostRootContext } from "core-itx";
import type { ActRule } from "iterate/acts";
import { releasedAnswer, reportIssue } from "iterate/lib";
import { platformOriginOf } from "iterate/mind-api";
import type { Door } from "iterate/workers";
import { hopCaller } from "./hop-caller.ts";

export const APPROVALS_ROOT_DESCRIPTION =
  "what waits for a member's signed yes before it is done: `approvals.rules()` → { locked, rules } · `approvals.setRules([{ verb, to? }])` replaces the rules while they are open (not locked) · `approvals.propose({ verb, to? })` → { id, signAt } asks a member to sign one rule at `signAt` · `approvals.secretRuleLink(path, { methods, hosts, jsonStrings?, freePaths? })` → the link that opens the approvals page with a rule for a request with the secret at `path` filled in, for a member to read and save (only a member saves a secret's rule). A rule's `verb` is `email.send` (with `to: [\"*@example.com\"]` for mail to some recipients alone), one verb such as `itx.whatsapp.sendMessage`, or every verb under a name, `itx.whatsapp.*`. A held call waits five minutes for the member, then throws; the act can be approved for a day, and is done then";

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
    // A secret's rule is a member's to save: the link opens the approvals page with these words
    // filled in under "A new rule" (core/secrets-worker/src/approvals-page.ts `ruleFromLink`).
    secretRuleLink: (
      path: string,
      rule: { methods: string[]; hosts: string[]; jsonStrings?: string[]; freePaths?: string[] },
    ) =>
      `${platformOriginOf(domain)}/secrets/approvals?${new URLSearchParams({
        path,
        ...Object.fromEntries(
          Object.entries(rule).map(([field, words]) => [field, words.join(",")]),
        ),
      })}#offered`,
    propose: async (rule: ActRule) => {
      const proposed = await releasedAnswer(
        egress.proposeActRule({ rule, from: from().path || context.path }),
      );
      await record(proposed.facts);
      return { id: proposed.id, signAt: `${platformOriginOf(domain)}/secrets/approvals` };
    },
  };
}
