# The loop that runs the agents

The owner should come away with (an owner who builds software): how the agents run is code in their own mind, and they saw where.

## Ready today

Certain, from the code:

- The agent is the mind's own code: the folder `agent/` of the config repo. `agent/processor.ts`
  is the loop, `agent/contract.ts` is every fact it reads and writes, and `agent/llm-api.ts` with
  `agent/llm-apis/` makes the requests to a model, one file for each API shape.
- `agents.ts` at the top of the mind's code tells the platform's `itx.agents` which agent
  `itx.agents.create(path)` starts: `agent-start.ts` makes the facts that start one.
- `agent-prompt.ts` is what an agent is told when it starts: `AGENTS.md`, `mind.md`, the role file
  of an agent at `/agents/<name>`, and the agent's capability tree.
- An agent's model and its providers are its config (`agent/contract.ts` `AgentConfig`), set by
  one fact: `agent/configured { config: { llm: { model: "<provider>/<model>" } } }`.
- A commit that changes `agent/` reaches an agent at its next message.
- The agent's unit tests are in `agent-tests/`. Run them from the repo's root:
  `node --test "agent-tests/*.test.mjs" agent-kinds/agent.test.mjs`.

## Not ready

- The idea below is NOT TESTED: never offer it as working. You may show the owner the files and
  say it is possible. A broken `agent/` stops every agent, you included: change it only with a
  way back that needs no agent (the Dash's code page, or the owner's GitHub mirror), and run the
  tests first.

## How

Show the file (`onboarding/links.md`) or read it:
`itx.repos.get("/repos/config").readFile("agent/processor.ts")`.

The idea, NOT TESTED: an agent that stays silent when the owner's message has the word "banana".
`agent/processor.ts` has one small method for it, `inputStarts`, which says what an input starts.
A subclass of `Agent` answers "nothing" for such an input, and `agent/facet.ts` hosts the subclass
where it hosts `Agent`.

Unproven: that `inputStarts` alone decides it.

## Say

- "Even how I run is code of yours: the folder agent/. Here it is. You can read every line, change
  it, and run its tests."
