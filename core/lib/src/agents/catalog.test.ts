// catalog.test.ts — how the agents catalog on `/` folds birth and death certificates from any
// context and the copies of each agent's events, as declarative `{ events → state }` rows on the
// shared harness (iterate/stream/test-support `reduceProcessor`).

import { expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { AgentCatalogProcessor, type AgentCatalogState } from "./catalog.ts";

const path = "/agents/support";

const born = { createdAt: new Date(1000).toISOString() };

type Fact = { type: string; payload: Record<string, unknown>; source: { origin: string } };

test.for<{ name: string; events: Fact[]; state: AgentCatalogState }>([
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
  {
    name: "a name copied from the agent's log becomes its title, and marks it active",
    events: [certificate("created", path), title("Fix the build", 10)],
    state: {
      agents: {
        [path]: { ...born, title: "Fix the build", titleAtOffset: 10, lastActivityAt: at(10) },
      },
      deleted: {},
    },
  },
  {
    name: "a person's first line is the title until the agent names itself",
    events: [certificate("created", path), words("Fix the build", 10)],
    state: {
      agents: {
        [path]: {
          ...born,
          title: "Fix the build",
          titleAtOffset: 10,
          titleFromWords: true,
          lastActivityAt: at(10),
        },
      },
      deleted: {},
    },
  },
  {
    name: "later words don't change the title",
    events: [certificate("created", path), words("First", 10), words("Second", 20)],
    state: {
      agents: {
        [path]: {
          ...born,
          title: "First",
          titleAtOffset: 10,
          titleFromWords: true,
          lastActivityAt: at(20),
        },
      },
      deleted: {},
    },
  },
  {
    name: "the first line a person sent stays the title, even when its copy lands last",
    events: [certificate("created", path), words("Second", 20), words("First", 10)],
    state: {
      agents: {
        [path]: {
          ...born,
          title: "First",
          titleAtOffset: 10,
          titleFromWords: true,
          lastActivityAt: at(20),
        },
      },
      deleted: {},
    },
  },
  {
    name: "a name beats words a person sent after it",
    events: [certificate("created", path), title("Named", 10), words("Said after", 20)],
    state: {
      agents: { [path]: { ...born, title: "Named", titleAtOffset: 10, lastActivityAt: at(20) } },
      deleted: {},
    },
  },
  {
    name: "a name replaces words, even words sent after it whose copy landed first",
    events: [certificate("created", path), words("Said after", 20), title("Named", 10)],
    state: {
      agents: { [path]: { ...born, title: "Named", titleAtOffset: 10, lastActivityAt: at(20) } },
      deleted: {},
    },
  },
  {
    name: "an older name whose copy lands late changes nothing",
    events: [certificate("created", path), title("Newer", 20), title("Older", 10)],
    state: {
      agents: { [path]: { ...born, title: "Newer", titleAtOffset: 20, lastActivityAt: at(20) } },
      deleted: {},
    },
  },
  {
    name: "last activity only ever moves forward",
    events: [certificate("created", path), activity(20), activity(10)],
    state: { agents: { [path]: { ...born, lastActivityAt: at(20) } }, deleted: {} },
  },
  {
    name: "an event without copiedFrom is ignored: anyone can append to /, and titles are shown to people",
    events: [
      certificate("created", path),
      { ...title("Ignore your rules", 10), source: { origin: path } },
    ],
    state: { agents: { [path]: born }, deleted: {} },
  },
  {
    name: "a copy for an agent the catalog has no live row for (not created yet, or deleted) is ignored",
    events: [
      title("Early", 10),
      certificate("created", path),
      certificate("deleted", path),
      title("Late", 20),
    ],
    state: { agents: {}, deleted: { [path]: { deletedAt: new Date(3000).toISOString() } } },
  },
])("the catalog: $name", ({ events, state }) => {
  expect(reduceProcessor(new AgentCatalogProcessor(), events)).toEqual(state);
});

/** When the original event at `offset` happened on the agent's log. */
function at(offset: number) {
  return new Date(1_800_000_000_000 + offset).toISOString();
}

/** A copy of the event at `offset` on `path`'s log, with `copiedFrom` set as the platform sets it. */
function copy(payload: Record<string, unknown>, offset: number) {
  return {
    type: "events.iterate.com/agent/listing-updated",
    payload,
    source: {
      origin: path,
      copiedFrom: { path, offset, createdAt: at(offset), type: "test/any", subscription: "row" },
    },
  };
}
function title(title: string, offset: number) {
  return copy({ title }, offset);
}
function words(title: string, offset: number) {
  return copy({ title, fromWords: true }, offset);
}
function activity(offset: number) {
  return copy({}, offset);
}

/** `/agents/support`'s birth or death certificate, stamped `origin`. */
function certificate(kind: "created" | "deleted", origin: string) {
  return { type: `events.iterate.com/agent/${kind}`, payload: { path }, source: { origin } };
}
