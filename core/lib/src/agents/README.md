# iterate/agents

The agents app for Iterate projects: a collection of agents on a project, each a conversation on
its own context, driven by a model that acts by writing scripts against that context's `itx`.
A project installs it; the platform ships its code as `iterate/agents`, so a project runs the
deployment's own build and upgrades with it, like `iterate/sdk`.

## Install

A project's config repo re-exports the app's two classes from `agents.ts` and installs the app
from its init case (core/configs/default does both). It lists no dependency: `iterate/*` comes
from the platform.

```ts
// agents.ts
export { AgentCollectionDurableObject, AgentDurableObject } from "iterate/agents";
```

```ts
import { installAgents } from "iterate/agents/install";

// in processEvent, the init case
case "events.iterate.com/project/worker-updated":
  await installAgents(itx);
```

`installAgents` enables the catalog processor on `/` and writes the `itx.agents` rewrite rule to the
collection facet; it does the same every time. Every facet of the app, the collection's and each
agent's, names its class in `agents.ts` of the project's published config
(`{ className, mainModule: "agents.ts", source: itx.cd('/').config }`, `agentsFacetSpec`), so
nothing is copied into the project. A commit that changes what `agents.ts` bundles restarts the
agents on their next call, and so does a platform deploy (every loader cache key folds in the
deployment).

Importing `iterate/agents` registers `itx.agents` on iterate/api's `InstalledAppRoots`:
`itx as IterateContextApiWith<"agents">` types `create`, `get(path).message`, `list` and `delete`.

`itx.agents.list()` reads a whole list from `/` in one go, with each agent's title and when it was
last active, so showing a list of agents wakes none of them. Agents have no list code of their own.
Each agent gets three subscription rows when it's created (`collection.ts` `CATALOG_ROWS`). They copy
its title, the first line a person sends it, and each model request onto `/` as
`agent/listing-updated` events (`itx.subscribe` with `target: { path: "/", … }`), and the catalog
folds those. An agent created before those rows existed shows only its path.

- `contract.ts` — an agent's events and state; `processor.ts` — the reduce and the loop;
  `render.ts` — each request as OpenAI reads it; `processor.test.ts` — the processor's spec.
- `catalog.ts`, `collection.ts` — `itx.agents`; `durable-object.ts` — one agent.
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

## Your own credentials

By default an agent's model calls go through the deployment's AI Gateway: no key, billed to the
deployment. A project that brings its own credentials sets `llm.apiKeys`, an ordered list. Each
entry is the text after `Bearer `, normally a `getSecret(...)` placeholder that egress swaps for the
secret's value on the way to api.openai.com:

```ts
// agents.ts
import { AgentDurableObject } from "iterate/agents";

AgentDurableObject.defaultConfig = {
  llm: {
    apiKeys: [
      'getSecret("/secrets/chatgpt", { field: "accessToken" })', // a ChatGPT plan, tried first
      'getSecret("/secrets/openai")', // the project's API key, when the first does not answer
    ],
    streamIdleTimeoutMs: 120_000, // how long an answer may send nothing; 60 s by default
  },
};
```

A request goes to the first key. A key whose answer fails before it completes is named, with its
error, in the request's `llm-request-settled` event (`failedKeys`), and the next key gets the same
request: an answer that is not 2xx, a throw (its secret is missing), an error event, a stream that
ends early, or one that sends nothing for `llm.streamIdleTimeoutMs`. Nothing of the failed answer is
kept, and a feed starts the next one afresh. The person's next words or the request's expiry stop
the stack. When no key succeeds, the last failure is the one the agent reports. Without keys, the AI
Gateway's answer has the same idle budget.

Every string of a request is sent well formed: a lone UTF-16 surrogate (half an emoji that a
`slice` cut) goes as U+FFFD, which the settlement counts (`repairedStrings`). The conversation keeps
what was written. Every key gets the body a ChatGPT plan's token takes:
the fields it refuses (`max_output_tokens`, `temperature`, `top_p`, …) and the explicit cache
breakpoint are left out, which an API key never needs.

`defaultConfig` is appended to a new agent's log at birth as an `agent/configured` event. An agent
born before holds what its log holds: append `agent/configured` once to change it.
`AgentDurableObject.standingFiles = (path, files) => files` changes the Markdown files an agent reads
as standing instructions (`files` is the default list for `path`), and `messageGate` gates words
from other agents.
