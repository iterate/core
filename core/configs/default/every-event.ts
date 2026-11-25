// every-event.ts — WHAT LOOKS AT EVERY EVENT: worker.ts's `processEvent` calls `everyEvent`
// after its own cases, for each event of every context of the mind.
//
// The hooks here run side by side: the integration packages (integrations.ts), the kinds of agent
// (agent-kinds/index.ts), the Integrations page's cards, the Cloudflare connection, each context's
// description, the onboarding steps and the tasks' change feed. Each hook returns at once for an event that is not its
// own. One hook that fails does not stop the others: the first failure is thrown after all of
// them settled.
import type { IterateConfigProcessEventArgs } from "iterate/sdk";
import { agentKinds } from "./agent-kinds/index.ts";
import { agentPrompt } from "./agent-prompt.ts";
import { onboardingEvent } from "./apps/onboarding/steps.ts";
// @ts-expect-error -- a plain module of the Tasks app, with no types
import { taskChangesEvent } from "./apps/tasks/feed.js";
import { cloudAccountsEvent } from "./cloud-accounts.ts";
import { mindFormEvent } from "./cloud-deliveries.ts";
import { cloudflareConnectionEvent } from "./cloudflare.ts";
import { contextDescriptionsEvent } from "./context-descriptions.ts";
import { integrations } from "./integrations.ts";

/** Every hook that looks at every event, after worker.ts's own cases. It throws the first hook's
 *  failure once every hook has settled. */
export async function everyEvent(
  itx: IterateConfigProcessEventArgs<"agents">["itx"],
  event: IterateConfigProcessEventArgs["event"],
) {
  // Every package and every kind of agent (`agentKinds`), after the mind's own cases; the hook
  // contract is iterate/sdk `Integration`. The map is async, so a hook that throws before its
  // first await fails like one that rejects.
  const kinds = await Promise.all(agentKinds.map(async (kind) => (await kind.load()).default));
  const hooks = await Promise.allSettled([
    ...[...integrations, ...kinds].map(async (integration) =>
      integration.processEvent?.({ event, itx }),
    ),
    // The sections of the Dash's Integrations page that the mind works out by itself: iterate
    // Cloud's apps and accounts, every other key and account, and what a computer lends
    // (cloud-accounts.ts).
    cloudAccountsEvent(itx, event),
    // An account that a member connected through iterate Cloud since the last publish: the
    // mind tells the Cloud at once that it reads the mind form (cloud-deliveries.ts). Keep it
    // with `processMindEvent` (worker.ts), as the init step's word.
    mindFormEvent(itx, event),
    // The mind's connection to its own Cloudflare account: a new consent is checked against
    // that account, and the "Cloudflare" card is made true at each publish (cloudflare.ts).
    cloudflareConnectionEvent(itx, event),
    // What each context is for, the line the mind's catalog shows: the table in
    // context-descriptions.ts, written at a context's birth and at each publish.
    contextDescriptionsEvent(itx, event),
    // The onboarding app's steps (apps/onboarding/steps.ts): the events that change a step's
    // card, such as the owner's signed rule for iterate Cloud. Any other event returns at once.
    onboardingEvent(itx, event),
    // The system prompt of a new agent of the kind `agent`, once (agent-prompt.ts).
    agentPrompt(itx, event),
    // An update of a repo's main: one `tasks/task-changed` for each task file that it changed,
    // on that repo's feed log, /task-files/<repo> (apps/tasks/feed.js). The followers of a task
    // and the board's "who asked" read it.
    taskChangesEvent(itx, event),
  ]);
  const failed = hooks.find((hook) => hook.status === "rejected");
  if (failed) throw failed.reason;
}
