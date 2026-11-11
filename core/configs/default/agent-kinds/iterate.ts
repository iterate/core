// agent-kinds/iterate.ts — iterate's own agents as a kind (AGENTS.md, "Kinds of agent"). Their
// server half is the platform's (`installAgents(itx)` in worker.ts), and their chat is iterate's
// AgentChat, which the Agents app runs in a sandboxed frame with the agent's log.
import type { AgentKind } from "@iterate-com/ui/agent-kind-view";

export default {
  kind: "iterate",
  // the streamed frames of the answer being written
  ephemeralEvents: ["events.iterate.com/agent/llm-response-frame"],
  view: ({ ui }) => ui.AgentChat,
} satisfies AgentKind;
