// init.ts — THE PUBLISH HOOK'S STEPS: worker.ts's `mind/worker-updated` case calls `init`.
//
// The platform appends `mind/worker-updated` on `/` whenever it publishes a commit of this repo,
// so these steps run again after every commit: each is idempotent. Only the platform appends this
// type. Each step runs by itself (`step`): a step that throws is reported, and the steps after it
// still run, here, in worker.ts and in the hooks after its switch.
import { reportIssue } from "iterate/lib";
import type { IterateConfigProcessEventArgs } from "iterate/sdk";
import { installAgents } from "iterate/agents/install";
import { publishAgentKinds } from "iterate/agents/kinds";
import { kindsForTheDash } from "./agent-kinds/index.ts";
import { sayMindForm } from "./cloud-deliveries.ts";
import { removeOwnTelemetryQueryRule } from "./telemetry.ts";

/** One step of the publish hook (the `mind/worker-updated` case). A step that throws is reported
 *  (`config.publish-hook`, in the Workers' log, with the step's name; apps/telemetry/exceptions.ts
 *  puts it on /exceptions) and does not stop the steps
 *  after it: one fault must not keep every later install from running at every publish. */
export async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    reportIssue("config.publish-hook", error, { step: name });
  }
}

/** The template's steps of the publish hook, in order: the agents, where each kind's file is, and
 *  what iterate Cloud is told. */
export async function init(itx: IterateConfigProcessEventArgs<"agents">["itx"]) {
  // The agents (agents.ts): the catalog on /agents and the `itx.agents` rule.
  await step("agents", () => installAgents(itx));
  // where each kind's file is, for the Dash's agent view (agent-kinds/index.ts). The Dash's New
  // agent starts the kind `agent` where it knows that kind's file, and it is told of it in a new
  // mind only (`kindsForTheDash`).
  await step("agent-kinds", async () => publishAgentKinds(itx, await kindsForTheDash(itx)));
  // Tell iterate Cloud that this mind reads its deliveries in the mind form
  // (cloud-deliveries.ts, and `processMindEvent` in worker.ts). Keep both, or the Cloud sends the
  // key form alone.
  await step("mind-form", () => sayMindForm(itx));
  // `itx.telemetry.query` is the platform's alone: the row an earlier turn-on wrote, which
  // pointed it at `itx.config.telemetryQuery`, goes (telemetry.ts).
  await step("telemetry-query-rule", () => removeOwnTelemetryQueryRule(itx));
}
