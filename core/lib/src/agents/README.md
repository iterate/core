# iterate/agents

The agents app for Iterate minds: a collection of agents on a mind, each a conversation on
its own context, driven by a model that acts by writing scripts against that context's `itx`.
A mind installs it; the platform ships its code as `iterate/agents`, so a mind runs the
deployment's own build and upgrades with it, like `iterate/sdk`.

## Install

A mind's config repo re-exports the app's two classes from its root `agents.ts` and installs the
app from its init case (core/configs/default does both). It lists no dependency: `iterate/*` comes
from the platform.

```ts
// agents.ts
export { AgentCollectionDurableObject, AgentDurableObject } from "iterate/agents";
```

```ts
import { installAgents } from "iterate/agents/install";

// in processEvent, the init case
case "events.iterate.com/mind/worker-updated":
  await installAgents(itx);
```

A config whose classes are in another module names it twice: `installAgents(itx, { module })`, and
`AgentCollectionDurableObject.module = "<module>"` beside the export, where the collection starts
each agent from.

`installAgents` enables the catalog processor on `/agents` and writes the `itx.agents` rewrite rule
on the root to the collection facet there; it does the same every time, and disables the catalog
the root held before it moved. Every facet of the app, the collection's and each
agent's, names its class in that module of the mind's published config
(`{ className, mainModule: "agents.ts", source: itx.cd('/').config }`, `agentsFacetSpec`), so
nothing is copied into the mind. An agent's row keeps the module it was created with until
`create(path)` is called for it again, which enables the row with the collection's module: a
config that moves the module keeps the old file until its agents have moved. A commit that changes what that module
bundles restarts the
agents on their next call, and so does a platform deploy (every loader cache key folds in the
deployment).

Importing `iterate/agents` registers `itx.agents` on iterate/api's `InstalledAppRoots`:
`itx as IterateContextApiWith<"agents">` types `create`, `get(path).message`, `get(path).recent`,
`list` and `delete`.

## What an agent is

An agent is any context under `/agents`, at any depth. Iterate's own agents live there
(`/agents/people/<person>/web/<moment>` for one that a member starts on the Dash,
`/agents/email/t<thread>`), and so can anything else that is a
conversation with a title, a status and a way to message it, such as a coding session a bridge
appends to (`/agents/claude/<session>`, its subagents beneath it). Every context announces itself to
each of its ancestors when it first wakes (`itx/child-created`), and the catalog on `/agents` folds
those announcements, so it lists every context below it with no registration step. Anything
appended under `/agents` is listed, whether or not it is an agent: that is the rule. A row's
`parent` is the nearest row above it, so `/agents/people/<person>/web`, which only holds that
person's web agents, is the parent of each of them.

`/agents/people` holds a folder for each person, named by the local part of the address they
sign in with. It is a name that no long-lived agent may take: `/agents/<name>` is such an
agent's place. Two members with the same local part at two domains share one folder.

`itx.agents.list()` reads a whole list from `/agents` in one go, so showing a list of agents wakes
none of them. Each row is small and the same for every kind of agent: `kind` (what runs it:
`iterate`, `claude`, …), `host`, `status` (`working`, `idle`, `waiting`, `ended`), `activity` (one
line), `description` (a few sentences), `title` and `lastActivityAt`. Everything but `createdAt`
and `parent` comes from copies of the agent's own events onto `/agents` as `agent/listing-updated`
(`itx.subscribe` with `target: { path: "/agents", … }`): copies only, since only the platform can
set `source.copiedFrom`, and an older copy never undoes a newer one, field by field. An iterate
agent gets four subscription rows when it's created (`collection.ts` `CATALOG_ROWS`): its birth
(`kind: "iterate"`), its summary (title, activity, description), the first line a person sends it,
and each model request (`working`, then `idle`). Another kind of agent configures its own rows. An
agent created before the catalog moved to `/agents` shows only its path.

An iterate agent's `status` label goes onto its log as `agent/summary-updated` `{ activity }`, one
per script run that has a label, and its copy is the row's `activity`: while the agent works, the
row's line is what its newest script is doing. The run costs that one event and its copy on
`/agents`.

`get(path).recent({ minutes, limit })` answers what one agent did lately, from its own log
(`recent.ts`): its row's title, status, activity and description, one line per status label,
summary, words in, words out and script in the window, oldest first, and the newest script whole
(`lastScript`, with its error if it failed). The log has no read from its end, so it reads forward
from a few thousand offsets before the newest offset the catalog copied, at most 4,000 events. It
wakes the agent's context, never its facet.

THE MIND NOW: before a request, an iterate agent that last read the mind `mindSnapshotEveryMs` ago
or longer (10 minutes by default; 0 turns it off, through `agent/configured` or `defaultConfig`)
reads `itx.agents.list()` once and appends ONE note, keyed to the request, that the turn
reads: the other agents at work, then those active in the last hour, newest first, at most 12 rows
of about 160 characters (`mind-now.ts`). Its role is `user` and its actor `agent`: the lines in it
are other agents' words, read as data; it starts no turn, and the agent chat shows it as a
background row. An idle agent gets none, and so does one when no other agent was active in the
last hour. A failed read is logged and the turn goes on.

AT WORK: an iterate agent's row says `idle` from the moment a model answer settles, before the
script that answer called runs, because the status copy rides the settlement. The rows are
written once, by `create`, so a new order would reach only new agents. Readers decide instead
with one rule, `agentAtWork` (`iterate/agents/mind-now`): `working` or `waiting`, or `idle` with
an activity line from the last ten minutes (a script runs at most that long). The mind-now note
and the Dash's agent rows both use it.

Messaging any agent is appending `agent/context-added` to its context. `get(path).message(input)`
sends an iterate agent's words through its facet, and appends the same event straight to any other
agent's context, whose own subscription delivers it to whatever runs it. `delete(path)` of an agent
iterate does not run records its death on `/agents` and nothing else.

WHO SPOKE. Several people can write to one agent. When the platform knows who sent words, the
model reads a line before them that the platform wrote: `[from ada@example.com]` for a signed-in
person (with `, sent by a script of theirs` when their script sent them, and `, signed in by
<address> acting as them` under an administrator's sign-in), and `[from the mind example.com]`
for another mind whose key signed them.

- The line comes from the platform's stamp alone (`speakerOf` in `message.ts`): `source.principal`,
  `source.onBehalfOf`, or a mind's `source.signer`. No payload names a speaker.
- `message()` appends through the agent's facet, so the loop's copy of the words carries no stamp.
  The fold keeps who sent each `message-received`; the copy names the message's offset
  (`messageOffset`) and takes that speaker only when its words are the message's.
- Words with no such line name no verified sender. A schedule, a row's copy, the platform's own
  fact, the mind's config code and an agent's own script all append with no principal that said
  the words, and get none. A relay of mail, Slack or a phone line writes who it believes wrote
  into the words themselves.
- Words that begin like the platform's line and carry none are marked `[no verified sender]`,
  so a script or a relay cannot imitate it. A name in the line is cleaned of brackets and line
  breaks.

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

- `contract.ts` — an agent's events and state; `processor.ts` — the reduce and the loop;
  `render.ts` — each request as OpenAI reads it; `processor.test.ts` — the processor's spec.
- `catalog.ts`, `collection.ts` — `itx.agents`; `recent.ts` — `get(path).recent()`;
  `mind-now.ts` — the mind-now note; `durable-object.ts` — one agent.
- `responses-keys.ts` — the model call with a stack of API keys.

## Warming up

Code that knows an agent will be needed in a moment appends `agent/warm-up-requested` on its context:
`@iterate-com/voice` copies each press of a call there. If nothing is open, the agent sends one ping
over its conversation as it stands, so the request that follows finds its context awake, its socket
open (with `llm.apiKeys`) and its prompt cached. The ping writes nothing to the conversation and
changes no schedule, and `agent/cache-kept-warm` reports what it cost. A press that no request
follows costs that one ping.

It is best effort, and each part lasts a different time. The prompt is the provider's to keep: it
outlasted every wait measured, the longest 71 minutes, but no model promises that. The context sleeps
10 to 12 s after its last call, and takes its socket with it. The socket closes 60 s after its last
answer, even with the context awake.

So code that waits longer keeps the agent ready itself: one `waitForEvent` held open on the agent's
context holds it awake with no model call, and asking again within 60 s keeps the socket. A phone
bridge does this for a whole call. Measured on a 20,000-token agent, a hand-over reaches the model in
about 0.4 s with everything warm, 1.1 s on a new socket, and 2 s after the context slept.

## The model

The standard text model is Sol 6-2, `gpt-6.2-sol` at medium reasoning effort, everywhere (Jonas, 20
Nov 2026): it is `llm.model`'s default, and a helper that calls a text model by hand names it too.

## Your own credentials

`llm.apiKeys` is an ordered list of credentials. Each entry is the text after `Bearer `, normally a
`getSecret(...)` placeholder that egress swaps for the secret's value on the way to api.openai.com,
or `AI_GATEWAY` (`"ai-gateway"`): the deployment's AI Gateway, billed to the deployment, no key. An
empty list is the AI Gateway alone. The default config's `agents.ts` ships this order, so a person
who sets any one of the three needs no code change:

```ts
// agents.ts
import { AgentDurableObject, AI_GATEWAY } from "iterate/agents";

AgentDurableObject.defaultConfig = {
  llm: {
    apiKeys: [
      'getSecret("/secrets/chatgpt", { field: "accessToken" })', // a ChatGPT plan
      'getSecret("/secrets/openai")', // an OpenAI API key
      AI_GATEWAY, // the deployment's AI Gateway credit
    ],
    streamIdleTimeoutMs: 120_000, // how long an answer may send nothing; 60 s by default
  },
};
```

A request goes to the first credential. One whose answer fails before it completes is named, with
its error, in the request's `llm-request-settled` event (`failedKeys`), and the next one gets the
same request: an answer that is not 2xx, a throw, an error event, a stream that ends early, or one
that sends nothing for `llm.streamIdleTimeoutMs`. Nothing of the failed answer is kept, and a feed
starts the next one afresh. The person's next words or the request's expiry stop the stack. A key
whose secret is not set is passed over without a request, and it is no failure, so it is not
reported. The agent remembers which secrets are set and refreshes that behind each request: only
the first request of an incarnation can wait for it (the check begins when the turn does), and a
change is used one request later.
When none succeeds, the last failure is the one the agent reports; when no credential was tried,
the error names the ways to set one (`iterate chatgpt connect`, the secret `/secrets/openai`, or AI
Gateway credit in your Cloudflare account).

Every string of a request is sent well formed: a lone UTF-16 surrogate (half an emoji that a
`slice` cut) goes as U+FFFD, which the settlement counts (`repairedStrings`). The conversation keeps
what was written. Every key gets the body a ChatGPT plan's token takes:
the fields it refuses (`max_output_tokens`, `temperature`, `top_p`, …) and the explicit cache
breakpoint are left out, which an API key never needs.

`defaultConfig` is appended to a new agent's log at birth as an `agent/configured` event. An agent
born before holds what its log holds: append `agent/configured` once to change it.

AN AGENT THAT A MESSAGE CAN INTERRUPT: `llmRequestPolicy: { behaviour: "interrupt-current-request" }`
in an agent's config makes some messages end the answer the model is writing. The open request
settles `cancelled` (`interrupted-by-user-input`), what streamed stays in the conversation as a
record, and the next request reads both messages. Without the setting a message waits for the
running answer; `after-current-request` sets it back to that.

Which words interrupt is decided by how they arrive, not by who wrote them:

- Words sent with `message()` from the base `/` interrupt. That is the Dash chat, and also any
  script that calls `itx.cd("/").agents.get(path).message(…)`. A sender label is only advisory.
- Words sent with `message()` from any other context do not. They carry `from`.
- Words with `{ trigger: false }` do not. They stay context only.
- Words that a relay appends as a raw `agent/context-added` do not. Slack, email, mail, X DMs and
  the Cloud hand-over (`core/configs/default/worker.ts`, `cloud-handover.ts`) all do that, so a
  person who writes through them does not interrupt.

It ends a model's answer and nothing else: a script that is running goes on.

```ts
await itx.cd("/agents/support").append({
  type: "events.iterate.com/agent/configured",
  payload: { config: { llmRequestPolicy: { behaviour: "interrupt-current-request" } } },
});
```

`AgentDurableObject.standingFiles = (path, files) => files` changes the Markdown files an agent reads
as standing instructions (`files` is the default list for `path`), and `messageGate` gates words
from other agents.
