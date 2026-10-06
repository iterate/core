// catalog.test.ts — how the agents catalog on `/` folds birth and death certificates from any
// context, as declarative `{ events → state }` rows on the shared harness (iterate/stream/test-support
// `reduceProcessor`).

import { expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { AgentCatalogProcessor, type AgentCatalogState } from "./catalog.ts";

const path = "/agents/support";

test.for<{ name: string; events: ReturnType<typeof certificate>[]; state: AgentCatalogState }>([
  {
    name: "a birth stamped by the agent it names: counted",
    events: [certificate("created", path)],
    state: { agents: { [path]: { createdAt: new Date(1000).toISOString() } }, deleted: {} },
  },
  {
    name: "a birth stamped by another context: counted",
    events: [certificate("created", "/agents/other")],
    state: { agents: { [path]: { createdAt: new Date(1000).toISOString() } }, deleted: {} },
  },
  {
    name: "a death stamped by the agent: dead, and terminal",
    events: [
      certificate("created", path),
      certificate("deleted", path),
      certificate("created", path),
    ],
    state: { agents: {}, deleted: { [path]: { deletedAt: new Date(2000).toISOString() } } },
  },
  {
    name: "a death stamped by another context: dead",
    events: [certificate("created", path), certificate("deleted", "/agents/other")],
    state: { agents: {}, deleted: { [path]: { deletedAt: new Date(2000).toISOString() } } },
  },
])("the catalog: $name", ({ events, state }) => {
  expect(reduceProcessor(new AgentCatalogProcessor(), events)).toEqual(state);
});

/** `/agents/support`'s birth or death certificate, stamped `origin`. */
function certificate(kind: "created" | "deleted", origin: string) {
  return { type: `events.iterate.com/agent/${kind}`, payload: { path }, source: { origin } };
}
