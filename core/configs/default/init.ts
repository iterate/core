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
import { agentKinds } from "./agent-kinds/index.ts";
import { sayMindForm } from "./cloud-deliveries.ts";
import { ensureIterateCoreRepo } from "./iterate-core.ts";
import { removeOwnTelemetryQueryRule } from "./telemetry-query-rule.ts";

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
/** How many of the platform's old agents one publish takes over, and how long ago one may have
 *  worked: the newest first. The rest are taken over at their next `create` or message, and a
 *  later publish takes the next ones. */
const OLD_AGENTS = { atATime: 20, workedWithinMs: 30 * 24 * 60 * 60 * 1000 };

/** THE PLATFORM'S OLD AGENTS BECOME THE MIND'S OWN: `create` on the context of an agent whose kind
 *  is `iterate` appends the own agent's start facts there (`itx.agents`, collection.ts). Its
 *  conversation starts anew, and its old log stays readable. A new mind has none. */
async function takeOverOldAgents(itx: IterateConfigProcessEventArgs<"agents">["itx"]) {
  const since = new Date(Date.now() - OLD_AGENTS.workedWithinMs).toISOString();
  const old = (await itx.agents.list())
    .filter((agent) => agent.kind === "iterate" && (agent.lastActivityAt || "") >= since)
    .toSorted((a, b) => (b.lastActivityAt || "").localeCompare(a.lastActivityAt || ""))
    .slice(0, OLD_AGENTS.atATime);
  // each agent is a step of its own: one that cannot be taken over does not stop the others
  for (const agent of old)
    await step(`old-agent:${agent.path}`, () => itx.agents.create(agent.path));
}

export async function init(itx: IterateConfigProcessEventArgs<"agents">["itx"]) {
  // The agents (agents.ts): the catalog on /agents and the `itx.agents` rule.
  await step("agents", () => installAgents(itx));
  // where each kind's file is, for the Dash's agent view and its New agent (agent-kinds/index.ts)
  await step("agent-kinds", () => publishAgentKinds(itx, agentKinds));
  // A mind that is older than its own agent has agents that the platform's old agent ran. Each is
  // taken over at its next `create` or message. This takes over the ones that worked lately now,
  // so an input that reaches one by a plain append (a schedule, an integration) finds an agent.
  await step("old-agents", () => takeOverOldAgents(itx));
  // Tell iterate Cloud that this mind reads its deliveries in the mind form
  // (cloud-deliveries.ts, and `processMindEvent` in worker.ts). Keep both, or the Cloud sends the
  // key form alone.
  await step("mind-form", () => sayMindForm(itx));
  // `itx.telemetry.query` is the platform's alone: an old row that points it at
  // `itx.config.telemetryQuery` goes (telemetry-query-rule.ts).
  await step("telemetry-query-rule", () => removeOwnTelemetryQueryRule(itx));
  // A local mirror of github.com/iterate/core at /repos/github.com/iterate/core (iterate-core.ts),
  // so every mind's agents can inspect the platform's source locally.
  await step("iterate-core-repo", () => ensureIterateCoreRepo(itx));
}
