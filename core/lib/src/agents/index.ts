// iterate/agents — the agents app: the collection of a mind's agents, `itx.agents`, and the
// catalog of them on `/agents`. The platform runs no agent: the mind's own agent is code in the
// mind's config repo (core/configs/default/agent/), and the config tells the collection how to
// start one. A mind's config repo re-exports this class from its `agents.ts` and installs it from
// its init case (install.ts); importing this module registers `itx.agents` on iterate/api's
// `InstalledAppRoots` (api.ts).
export { AgentCollectionDurableObject } from "./catalog.ts";
export { appendMessage } from "./message.ts";
export type {
  AgentHandleApi,
  AgentListing,
  AgentMessageInput,
  AgentsApi,
  AgentsRootApi,
} from "./api.ts";
export type { OwnAgent } from "./collection.ts";
