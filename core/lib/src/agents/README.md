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
  },
};
```

A request goes to the first key. A key that answers anything but 2xx, or throws because its secret
is missing, is logged by its position and the next key gets the same request. When none answers, the
last answer is the failure the agent reports. Every key gets the body a ChatGPT plan's token takes:
the fields it refuses (`max_output_tokens`, `temperature`, `top_p`, …) and the explicit cache
breakpoint are left out, which an API key never needs.

`defaultConfig` is appended to a new agent's log at birth as an `agent/configured` event. An agent
born before holds what its log holds: append `agent/configured` once to change it.
`AgentDurableObject.standingFiles = (path, files) => files` changes the Markdown files an agent reads
as standing instructions (`files` is the default list for `path`), and `messageGate` gates words
from other agents.
