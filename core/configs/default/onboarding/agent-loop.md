# The loop that runs the agents

The owner should come away with (an owner who builds software): how the agents run is set in a file of their mind, and they saw where.

## Ready today

Certain, from the code:

- `agents.ts` at the top of the mind's code exports the agents' two classes from `iterate/agents`;
  `installAgents(itx)` in `init.ts` finds them there by name. Every agent runs from that file's
  own bundle: a commit to `worker.ts` or a page alone leaves the agents as they are.
- The loop's own code is iterate's package `iterate/agents`, which comes from the platform and a
  platform deploy upgrades. Its source: https://github.com/iterate/core, `core/lib/src/agents/`.
- `agents.ts` sets three hooks on `AgentDurableObject`:
  - `standingFiles = (path, files) => [...]`: the Markdown files an agent reads before each
    request. The template answers `["AGENTS.md", "mind.md", ...files]`; `files` holds `<name>.md`
    for `/agents/<name>`, which is why you read `onboarding.md`.
  - `defaultConfig`: what a new agent starts with, written at its birth. The template sets
    `llm.apiKeys`, the order of what pays (`onboarding/pays.md`). An older agent keeps its own.
  - `messageGate`: a gate on words that ANOTHER AGENT sends without `trigger: false`: it decides
    whether they start a turn. It never sees a person's words. The template sets none.

## Not ready

- The idea below is NOT TESTED: never offer it as working. You may show the owner the files and
  say it is possible. A broken `agents.ts` stops every agent, you included: change it only with a
  way back that needs no agent (the Dash's code page, or the owner's GitHub mirror).

## How

Show the file (`onboarding/links.md`) or read it: `itx.repos.get("/repos/config").readFile("agents.ts")`.

The idea, NOT TESTED: an agent that stays silent when the owner's message has the word "banana":
a subclass of `AgentProcessor` (exported at `iterate/agents/processor`) whose `reduce` marks such
a user item as one that starts no request, and an agent class that uses it:

```ts
// agents.ts: NOT TESTED. The three hooks stay set on Base, as today.
import { AgentCollectionDurableObject, AgentDurableObject as Base } from "iterate/agents";
import { AgentProcessor } from "iterate/agents/processor";
class BananaProcessor extends AgentProcessor {
  reduce(args) {
    const { event } = args;
    const { payload } = event;
    if (
      event.type !== "events.iterate.com/agent/context-added" ||
      payload.role !== "user" ||
      !JSON.stringify(payload.content).includes("banana")
    )
      return super.reduce(args);
    return super.reduce({
      ...args,
      event: {
        ...event,
        payload: { ...payload, llmRequestPolicy: { behaviour: "dont-trigger-request" } },
      },
    });
  }
}
export class AgentDurableObject extends Base {
  processor = new BananaProcessor({
    getItx: () => this.getItx(),
    messageGate: () => Base.messageGate,
    standingFiles: () => Base.standingFiles,
    defaultConfig: () => Base.defaultConfig,
  });
}
export { AgentCollectionDurableObject };
```

Unproven: that `reduce` alone decides it, and that the subclass is found by its name.

## Say

- "Even how I run is set in a file of yours, agents.ts. Here it is. The loop's own code is
  iterate's, and it is public: you can read every line."
