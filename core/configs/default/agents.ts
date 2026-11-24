// agents.ts — THE MIND'S AGENTS. `itx.agents` is the platform's collection on /agents
// (iterate/agents): `list()`, `create(path)`, `get(path).message(…)`, `get(path).recent()` and
// `delete(path)`. init.ts installs it (`installAgents`), which finds the class in this file by
// its name.
//
// THE AGENT ITSELF IS THIS REPO'S CODE, in agent/. The platform runs no agent of its own: this
// file tells the collection which agent `create` starts.
//
//   kind          what an agent's start writes on /agents as its kind (agent-start.ts)
//   startEvents   the facts that make a context run the agent: `create` appends them, and
//                 `message` sends them with the words, so a commit that changes agent/ reaches an
//                 agent at its next message
//
// What an agent is told (AGENTS.md, mind.md, its capability tree) is agent-prompt.ts. The model
// and what pays for it are the agent's config: agent/contract.ts `AgentConfig`.
import { AgentCollectionDurableObject } from "iterate/agents";
import { startEvents } from "./agent-start.ts";

AgentCollectionDurableObject.agent = { kind: "agent", startEvents };

export { AgentCollectionDurableObject };
