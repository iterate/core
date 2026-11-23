# Kinds of agent

What a kind of agent is, how to write one, and where an agent that a member starts on the Dash is
born: `agent-kinds/`, the `agentKinds` list in `agent-kinds/index.ts`, `agents.ts` and `iterate/agents/kinds`.

`installAgents(itx)` in the init case (`init.ts`)
finds the agents' two classes in `agents.ts` by its name. Every agent runs from that file's own bundle, so a commit that
changes only `worker.ts` or a page leaves the agents running.

Any context under `/agents` is an agent, and its kind is what the catalog lists it as: `iterate` for
iterate's own, `claude` for a Claude Code session, or one of your own. A kind is one file
(`agent-kinds/<kind>.ts` by convention) whose default export `satisfies AgentKind`, named in
`agent-kinds/index.ts`. `iterate/agents/kinds` has `makeAgentKind` and `AgentKind`;
`@iterate-com/ui/agent-kind-view`'s `AgentKind` is the same with the view typed:

```ts
// agent-kinds/index.ts
import { makeAgentKind } from "iterate/agents/kinds";

export const agentKinds = [
  makeAgentKind(import.meta, () => import("./iterate.ts")),
  makeAgentKind(import.meta, () => import("./grok.ts")),
];

// agent-kinds/grok.ts
import type { AgentKind } from "@iterate-com/ui/agent-kind-view";
import { createXai } from "@ai-sdk/xai"; // server only: fine to import, used in processEvent

export default {
  kind: "grok",
  // the Dash reads the agent's durable log, and these ephemeral types for its view
  ephemeralEvents: ["x.ai/grok/token"],
  // its server half, an Integration's processEvent: every event of the mind
  processEvent: async ({ event, itx }) => {
    if (event.type !== "events.iterate.com/agent/message-received") return;
    if (!event.path.startsWith("/agents/grok/")) return;
    // answer it, appending to itx.cd(event.path)
  },
  // its chat: htm, not JSX, with iterate's chat parts (`ui.AgentShell`, `ui.Feed`, …)
  view:
    ({ html, useMemo, ui }) =>
    (props) =>
      html`<${ui.AgentShell} ...${props} />`,
} satisfies AgentKind;
```

Every kind shares two things: the catalog row (kind, status, activity, title), and words sent with
`itx.agents.get(path).message(…)`, which land on the agent's log as
`events.iterate.com/agent/message-received`. Everything else is the kind's own: its events, its
rows and its chat. `itx.agents.list()` reads every row and wakes no agent;
`itx.agents.get(path).recent({ minutes: 5 })` is what one agent did in that window (status labels,
summaries, words in and out, scripts, and `lastScript`), read from its log in the same event types
for every kind. `every-event.ts` runs each kind's `processEvent` beside the integrations, and on every
publish `init.ts` writes where each kind's file is to the mind's KV (`agent-kinds`), where the Dash finds
it. The Dash's agent view runs `view` in a sandboxed frame with only that agent's log and verbs; there, a
server-only import is a stand-in that throws if the view touches it. A kind whose agents run
elsewhere (iterate's in the platform) needs no `processEvent`.

An agent that a member starts on the Dash is born in that person's folder:
`/agents/people/<person>/web/<moment>` for iterate's own, and
`/agents/people/<person>/<kind>/<moment>` for a kind's choice that says `byPerson: true` in its
`newAgent.choices`. `<person>` is the local part of the address the member signs in with, in
lower case, with `-` for each run of other characters than a-z and 0-9, 40 characters at most.
The list shows a person their own agents first, and another person's with that folder's name
before the title. The folder is a label, not proof of who started an agent, and two members with
the same local part at two domains share one folder. `people` is a name that no long-lived agent
(`/agents/<name>`) may take.

## The kind `agent`

`agent` is the mind's own agent: its code is in this repo, not in the platform. A person's new chat
in the Dash is one, because the kind's file says `newAgent: { default: true, … }`. The Dash's New
agent appends two facts to the new path, `/agents/people/<person>/agent/<moment>`, as the member
who typed: the kind's start fact, `agent-ui/agent-requested`, then the person's first words,
`agent-ui/message-received`. The kind answers the first with the agent's start facts. No method and
no rewrite rule stands between: `itx.agents.create` is iterate's own, so the onboarding agent, its
subagents and the agents of mail, X, Meet and Slack stay iterate's own. The kind acts only under
`/agents/people/`.

- `agent/`: the agent itself, its facets (`facets.ts`, `facets.json`), which run on the agent's
  context. `agent-start.ts` starts it with one append of keyed facts.
- `agent-kinds/agent.ts`: the kind. Its `processEvent` turns a person's words
  (`agent-ui/message-received`, `agent/message-received`) into the agent's one input,
  `agent/context-added`, and starts a subagent on `agent/subagent-requested`. Its view is
  iterate's chat.
- `agent-ui.ts`: the Dash's chat as a channel. `agent-prompt.ts`: what the agent is told.
- A model: `config.llm.model`, `<provider>/<model>` as the AI Gateway names it.

To make new chats iterate's own agent again, take `default: true` out of `agent-kinds/agent.ts`.
The chats that the kind started stay what they are.
