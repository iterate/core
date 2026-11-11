// backend.ts — THE AGENTS APP'S BACKEND: its two Durable Object classes, which the platform ships
// as iterate/agents. The collection runs on /agents and is `itx.agents`; each agent is one context
// under it. Set an agent's defaults here, on the class (`AgentDurableObject.defaultConfig`).
import { AgentCollectionDurableObject, AgentDurableObject, AI_GATEWAY } from "iterate/agents";

// The collection starts each agent from this module, so it is told where this file is.
AgentCollectionDurableObject.module = "apps/agents/backend.ts";

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

// Every agent reads AGENTS.md before each request, and one at /agents/<name> reads <name>.md too.
// The onboarding app's agent reads its text from the app's own folder instead.
AgentDurableObject.standingFiles = (path, files) =>
  path === "/agents/onboarding" ? ["AGENTS.md", "apps/onboarding/onboarding.md"] : files;

export { AgentCollectionDurableObject, AgentDurableObject };
