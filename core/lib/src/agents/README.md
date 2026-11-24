# iterate/agents

The agents app for Iterate minds: the collection of a mind's agents, `itx.agents`, and the catalog
of them on `/agents`. A mind installs it; the platform ships its code as `iterate/agents`, so a
mind runs the deployment's own build and upgrades with it, like `iterate/sdk`.

**The platform runs no agent.** The mind's own agent is code in the mind's config repo
(`core/configs/default/agent/`: its processor, its request makers and its tests). The config
tells the collection how to start one, and the collection appends those facts. Any other kind of
agent (a coding session that a bridge appends to) is its kind's business.

## Install

A mind's config repo re-exports the collection's class from its root `agents.ts`, tells it which
agent `create` starts, and installs the app from its init case (core/configs/default does all
three). It lists no dependency: `iterate/*` comes from the platform.

```ts
// agents.ts
import { AgentCollectionDurableObject } from "iterate/agents";
import { startEvents } from "./agent-start.ts";

AgentCollectionDurableObject.agent = { kind: "agent", startEvents };

export { AgentCollectionDurableObject };
```

```ts
import { installAgents } from "iterate/agents/install";

// in processEvent, the init case
case "events.iterate.com/mind/worker-updated":
  await installAgents(itx);
```

- `kind` is what the agent's own start writes on `/agents` as its kind.
- `startEvents(path, { parent })` answers the facts that make the context at `path` run the agent.
  Each has an idempotency key, so appending them again writes nothing. With `parent` they hold the
  link from the context's `itx` to that context; without, they hold none (`collection.ts`
  `OwnAgent`).
- A config with no `agent` has no agent to start: `create` refuses with words that say so.

A config whose class is in another module names it: `installAgents(itx, { module })`.

`installAgents` enables the catalog processor on `/agents` and writes the `itx.agents` rewrite rule
on the root to the collection facet there; it does the same every time, and disables the catalog
the root held before it moved. The collection's facet names its class in that module of the mind's
published config (`{ className, mainModule: "agents.ts", source: itx.cd('/').config }`), so
nothing is copied into the mind.

Importing `iterate/agents` registers `itx.agents` on iterate/api's `InstalledAppRoots`:
`itx as IterateContextApiWith<"agents">` types `create`, `get(path).message`, `get(path).recent`,
`list` and `delete`.

## What an agent is

An agent is any context under `/agents`, at any depth. The mind's own agents live there
(`/agents/people/<person>/web/<moment>` for one that a member starts on the Dash,
`/agents/email/t<thread>`), and so can anything else that is a conversation with a title, a status
and a way to message it, such as a coding session a bridge appends to (`/agents/claude/<session>`,
its subagents beneath it). Every context announces itself to each of its ancestors when it first
wakes (`itx/child-created`), and the catalog on `/agents` folds those announcements, so it lists
every context below it with no registration step. Anything appended under `/agents` is listed,
whether or not it is an agent: that is the rule. A row's `parent` is the nearest row above it, so
`/agents/people/<person>/web`, which only holds that person's web agents, is the parent of each of
them.

`/agents/people` holds a folder for each person, named by the local part of the address they
sign in with. It is a name that no long-lived agent may take: `/agents/<name>` is such an
agent's place. Two members with the same local part at two domains share one folder.

`itx.agents.list()` reads a whole list from `/agents` in one go, so showing a list of agents wakes
none of them. Each row is small and the same for every kind of agent: `kind` (what runs it:
`agent` for the mind's own, `claude`, …), `host`, `status` (`working`, `idle`, `waiting`,
`ended`), `activity` (one line), `description` (a few sentences), `title` and `lastActivityAt`.
Everything but `createdAt` and `parent` comes from copies of the agent's own events onto `/agents`
as `agent/listing-updated` (`itx.subscribe` with `target: { path: "/agents", … }`): copies only,
since only the platform can set `source.copiedFrom`, and an older copy never undoes a newer one,
field by field. Each kind of agent configures its own copy rows. Those of the mind's own agent are
in its start facts (`core/configs/default/agent-start.ts` `CATALOG_ROWS`): its kind, its summary
(title, activity, description), the first line a person sends it, and each answer request
(`working`, then `idle`).

AT WORK: the row of the mind's own agent says `idle` from the moment a model's answer settles,
before the script of that answer runs. Readers decide with one rule, `agentAtWork`
(`iterate/agents/at-work`): `working` or `waiting`, or `idle` with an activity line from the last
ten minutes (a script runs at most that long). The Dash's agent rows use it.

## The verbs

`create(path)` starts the mind's own agent at `path`: its start facts and the collection's own row
for it, in ONE append. Nothing is waited for but the listing, and a second create writes nothing.
A deleted agent is not re-creatable.

`get(path).message(input)` appends ONE `agent/message-received` to the agent's context, for every
kind of agent. No verb calls a facet of an agent. The mind's own agent gets its start facts in the
same append, before the words, so a publish of new agent code reaches an agent at its next
message. The mind's config transcribes the fact into the agent's input
(`core/configs/default/agent-kinds/agent.ts`). Another kind's own subscription delivers it to
whatever runs it.

`get(path).recent({ minutes, limit })` answers what one agent did lately, from its own log
(`recent.ts`): its row's title, status, activity and description, one line per status, summary,
words in, words out and script in the window, oldest first, and the newest script whole
(`lastScript`, with its error if it failed). The log has no read from its end, so it reads forward
from a few thousand offsets before the newest offset the catalog copied, at most 4,000 events. It
wakes the agent's context alone.

`delete(path)` records the death on `/agents` first, so a verb that follows refuses. Then, for the
mind's own agent, every row that its start enables goes, and each facet with its storage. The death
of another kind of agent is the certificate alone.

A CONTEXT OF THE KIND `iterate` was run by an agent that the platform no longer has. The mind's own
agent takes it over at its next `create` or message: the start facts replace the row named `agent`,
and the four copy rows of the former agent are switched off. The agent reads nothing of the log
that stands before its start (`core/configs/default/agent/contract.ts`), so its conversation
begins there.

A MESSAGE THAT LANDS ONCE. `get(path).message(input, { key })` gives the message a key of the
sender's choice. Sent again with the same key and the same words, it lands once, and the call
answers the event the log holds, also when two sends race. The same key with other words is
refused (`IDEMPOTENCY_CONFLICT`). A page that cannot know whether its first try arrived sends again
with the same key.

- A file of a keyed message is never replaced: its path is made from the key, its place in the
  list and the SHA-256 of its content. The same key and words with other file content is refused,
  and the first event's file stays as it was. The refused send leaves its own file behind.
- The key is the context's, not the sender's: one name space per agent. A second sender with the
  same key and the same words gets the first sender's event, and the log names the first sender
  alone. So a sender makes keys that nobody else would make.

WHO SPOKE is the platform's stamp on a fact (`source.principal`, `source.onBehalfOf`, or a mind's
`source.signer`). No payload names a speaker. The mind's config words the sender for the model
when it transcribes a message (`core/configs/default/agent-ui.ts`).

## The files

- `contract.ts` — the three facts that every kind of agent shares: `agent/message-received`,
  `agent/summary-updated`, `agent/deleted`.
- `catalog.ts` — the catalog on `/agents`, and the collection's facet class.
- `collection.ts` — `itx.agents`: `list`, `create`, `delete`, `get(path)`.
- `message.ts` — what `message()` appends; `recent.ts` — `get(path).recent()`.
- `install.ts` — `installAgents`; `kinds.ts` — kinds of agent; `at-work.ts` — `agentAtWork`.
- `api.ts` — the published types.
