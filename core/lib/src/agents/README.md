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

- `contract.ts` — an agent's events and state; `processor.ts` — the reduce and the loop;
  `render.ts` — each request as OpenAI reads it; `processor.test.ts` — the processor's spec.
- `catalog.ts`, `collection.ts` — `itx.agents`; `durable-object.ts` — one agent.
- `responses-keys.ts` — the model call with a stack of API keys.

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
