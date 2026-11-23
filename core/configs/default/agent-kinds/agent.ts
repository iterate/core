// agent-kinds/agent.ts — THE AGENT AS A KIND (agent-kinds.md). Its server half is the facets of
// agent/, which agent-start.ts enables on each agent's context. Its chat is iterate's AgentChat.
//
// A person's new chat in the Dash is this agent: the kind says `newAgent: { default: true }`, so
// the Dash's New agent appends `agent-ui/agent-requested` and then the person's first words to
// `/agents/people/<person>/agent/<moment>`, as that member. Every other agent of the mind is the
// platform's.
//
// THE MIND'S SIDE OF THE AGENT (`processEvent`). The agent has one input, `agent/context-added`,
// and knows no channel. This kind acts on four facts, each in ONE append to a context:
//
//   agent-ui/message-received   the Dash's composer (the chat below)       → "— Web UI: …"
//   agent/message-received      the platform's `itx.agents.get(path).message()`: other kinds of
//                               agent, a tool, a page that stores no files  → "— Agents API: …"
//       on the context of an agent: its start facts (all keyed: written once) and the transcribed
//       input (agent-ui.ts), under a key that names the raw fact;
//   agent-ui/agent-requested    the start facts alone;
//   agent/subagent-requested    the agent's script: the child's start, and the answer and its note
//                               to the parent (agent-start.ts `startSubagent`).
//
// THE GUARD. The platform's agents run in the same mind and read some of the same facts. So this
// kind acts only on a context under `/agents/people/`, a person's own chats and their subagents,
// and there only on a context that runs this agent: one of its first facts is the start's
// `agent/configured` with `kind: "agent"` (agent/start.ts), or the Dash's request for one
// (agent-start.ts `runsTheAgent`). On every other context it does nothing.
//
// THE CHAT (`view`) is iterate's AgentChat as it is. It reads this agent's facts itself
// (packages/ui agent-chat/agent-facts.ts): a person's bubble from the raw fact and its stamp, a
// request and its windows, the agent's words (`agent-ui/message-sent`), and the facet's live state.
// Its composer stores a message's files and then appends ONE `agent-ui/message-received` with the
// words and the files, as the person who typed. The Events tab shows the raw log.
//
// A view runs in the Dash's frame, where every import of this file is a stub that throws when
// used (packages/ui agent-kind-view/load.ts). So a view uses nothing that this file imports.
import type { AgentKind } from "@iterate-com/ui/agent-kind-view";
import { PEOPLE, runsTheAgent, startSubagent, toAgent } from "../agent-start.ts";
import {
  agentsApiContext,
  agentUiContext,
  agentUiStartConfig,
  transcriptionKey,
} from "../agent-ui.ts";

const T = "events.iterate.com/";
const UI_MESSAGE = `${T}agent-ui/message-received`;
const UI_AGENT_REQUESTED = `${T}agent-ui/agent-requested`;
const API_MESSAGE = `${T}agent/message-received`;
const CONTEXT_ADDED = `${T}agent/context-added`;
const SUBAGENT_REQUESTED = `${T}agent/subagent-requested`;

/** THE MIND'S SIDE OF THE AGENT: each fact of the four becomes ONE append (the header). */
async function processEvent({ event, itx }: Parameters<NonNullable<AgentKind["processEvent"]>>[0]) {
  if (!event.path.startsWith(PEOPLE)) return;
  switch (event.type) {
    case UI_AGENT_REQUESTED: {
      const config = agentUiStartConfig(event);
      if (config) await toAgent(itx, event.path, [], { config });
      return;
    }
    case SUBAGENT_REQUESTED:
      if (await runsTheAgent(itx, event.path)) await startSubagent(itx, event);
      return;
    case UI_MESSAGE:
    case API_MESSAGE: {
      if (!(await runsTheAgent(itx, event.path))) return;
      const input = (event.type === UI_MESSAGE ? agentUiContext : agentsApiContext)(event);
      if (!input) return; // a payload the schema refuses
      await toAgent(itx, event.path, [
        { type: CONTEXT_ADDED, idempotencyKey: transcriptionKey(event), payload: input },
      ]);
    }
  }
}

export default {
  kind: "agent",
  processEvent,
  // THE MIND'S DEFAULT KIND: the Dash's New agent starts this one. The Dash appends the fact of
  // `start` and then the person's first words (`agent-ui/message-received`) to the new agent's
  // path, AS THE MEMBER WHO TYPED: no method of the mind stands between, so each fact carries that
  // person's own stamp. The Dash knows this file in a new mind only (agent-kinds/index.ts
  // `newChatsAreTheAgent`): in a mind that existed before this kind, New agent is iterate's own.
  newAgent: {
    default: true,
    choices: [{ id: "agent", label: "Agent", byPerson: true }],
    start: ({ path }) => [
      {
        type: UI_AGENT_REQUESTED,
        idempotencyKey: `agent-ui/agent-requested:${path}`,
        payload: {},
      },
    ],
  },
  // the streamed windows of the answer being written, in one shape for every provider
  ephemeralEvents: [`${T}llm-request/response-frame-received`],
  view: ({ ui }) => ui.AgentChat,
} satisfies AgentKind;
