# Kinds of agent

What a kind of agent is, how to write one, and where an agent that a member starts on the Dash is
born: `agent-kinds/`, the `agentKinds` list in `agent-kinds/index.ts`, `agents.ts` and `iterate/agents/kinds`.

`installAgents(itx)` in the init case (`init.ts`) installs `itx.agents`, the platform's collection
on `/agents`, and finds its class in `agents.ts` by its name. `agents.ts` tells it which agent
`itx.agents.create(path)` starts: this repo's own, the kind `agent` below.

Any context under `/agents` is an agent, and its kind is what the catalog lists it as: `agent` for
the mind's own, `claude` for a Claude Code session, or one of your own. A kind is one file
(`agent-kinds/<kind>.ts` by convention) whose default export `satisfies AgentKind`, named in
`agent-kinds/index.ts`. `iterate/agents/kinds` has `makeAgentKind` and `AgentKind`;
`@iterate-com/ui/agent-kind-view`'s `AgentKind` is the same with the view typed:

```ts
// agent-kinds/index.ts
import { makeAgentKind } from "iterate/agents/kinds";

export const agentKinds = [
  makeAgentKind(import.meta, () => import("./agent.ts")),
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

`agent` is the mind's own agent, and every agent that this mind starts is one. Its code is in this
repo, not in the platform.

- **`itx.agents.create(path)` starts one at any path**: the onboarding agent, a mail, Slack or X
  thread, a meeting, a job of your own. The platform's collection appends the agent's start facts
  to that context, in one append (`agents.ts` hands it `startEvents` of `agent-start.ts`). Every
  fact has a key, so a second `create` writes nothing.
- **A person's new chat in the Dash is one**, because the kind's file says
  `newAgent: { default: true, … }`. The Dash's New agent appends two facts to the new path,
  `/agents/people/<person>/agent/<moment>`, as the member who typed: the kind's start fact,
  `agent-ui/agent-requested`, then the person's first words, `agent-ui/message-received`. The kind
  answers the first with the agent's start facts. No method stands between, so each fact carries
  that person's own stamp.
- **An agent starts a subagent** with one fact, `agent/subagent-requested`, under its own path.
  The mind's worker answers it with the mind's whole reach, so it refuses an agent that something
  holds: a request that another context's code wrote (an agent whose scripts run in a jail), an
  agent whose own table masks a name, and a path where an agent of another parent runs. A config
  that restricts an agent in another way refuses this fact itself.
- **Words reach an agent** as its one input, `agent/context-added`. A person's words in the Dash
  (`agent-ui/message-received`) and words sent with `itx.agents.get(path).message(…)`
  (`agent/message-received`) are transcribed into it by the kind. Its FIRST line is the mind's:
  who sent the words, whether that person is a member of this mind, and when. Everything after
  the first line is the sender's text. An integration appends the input itself.
- **What an agent is told follows its files.** A commit that changes `AGENTS.md`, `mind.md` or an
  agent's role file reaches an agent at its next input of role `user` (`agent-prompt.ts`). A fork
  keeps its parent's instructions.
- **A commit that changes `agent/` reaches an agent at its next message**: `message` sends the
  start facts with the words, and a facet row of another code version starts the new code.
- **The parent link is written once**, by the start that gives birth to an agent: to the mind's
  root, or to the agent that asked for a subagent. No later start changes it. The link is no
  jail: it says where the child's `itx` names lead, and it does not hold the child.

The files:

- `agent/`: the agent itself, its facets (`facets.ts`, `facets.json`), which run on the agent's
  context. `agent-start.ts` makes its start facts.
- `agent-kinds/agent.ts`: the kind. Its `processEvent` transcribes a person's words and starts a
  subagent. Its view is iterate's chat.
- `agent-ui.ts`: the Dash's chat as a channel. `agent-prompt.ts`: what the agent is told
  (`AGENTS.md`, `mind.md`, `<name>.md` for the agent at `/agents/<name>`, its capability tree).
- `agent-tests/`: the agent's unit tests, and `agent-kinds/agent.test.mjs`: the kind's. Run them
  from the repo's root with `node --test "agent-tests/*.test.mjs" agent-kinds/agent.test.mjs`. They
  are not in `agent/`, because every file of that folder is the facets' code.
- A model: `config.llm.model`, `<provider>/<model>` as the AI Gateway names it.

## A mind that is older than its own agent

Its earlier agents ran the platform's agent, and the catalog lists them as the kind `iterate`.
Each is taken over in place: at its next `create` or message the collection appends the own
agent's start facts to the same context. The conversation starts anew, and the old log stays
readable in the Dash. Every publish takes over the old agents that worked in the last 30 days, 20
at a time, the newest first (`init.ts`).
