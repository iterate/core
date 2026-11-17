// agents.ts — THE MIND'S AGENTS: the two Durable Object classes the platform ships as
// iterate/agents. The collection runs on /agents and is `itx.agents`; each agent is one context
// under it. worker.ts installs them (`installAgents`), which finds them in this file by its name.
// Set an agent's defaults here, on the class (`AgentDurableObject.defaultConfig`).
//
// Every agent reads AGENTS.md before each request, and one at /agents/<name> reads <name>.md too:
// /agents/onboarding reads onboarding.md.
import { AgentCollectionDurableObject, AgentDurableObject, AI_GATEWAY } from "iterate/agents";

// Every agent also reads mind.md, after AGENTS.md, when the repo has one: who this mind is (its
// name, its voice, what it is for, how it reaches its people). The template has no such file: the
// onboarding agent writes it with the owner (onboarding.md, "What you remember"), so it is the mind's own from
// its first line, and AGENTS.md stays a file that follows the template.
AgentDurableObject.standingFiles = (_path, files) => [
  ...new Set(["AGENTS.md", "mind.md", ...files]),
];

// The agents pay with the first of these that is set: a secret that is not set is passed over.
AgentDurableObject.defaultConfig = {
  llm: {
    apiKeys: [
      'getSecret("/secrets/chatgpt", { field: "accessToken" })', // a ChatGPT plan
      'getSecret("/secrets/openai")', // an OpenAI API key
      AI_GATEWAY, // the deployment's AI Gateway credit
    ],
  },
};

export { AgentCollectionDurableObject, AgentDurableObject };
