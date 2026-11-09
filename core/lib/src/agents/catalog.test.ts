// catalog.test.ts — how the agents catalog on `/agents` folds the contexts that announce themselves
// below it, death certificates from any context and the copies of each agent's events, as
// declarative `{ events → state }` rows on the shared harness (iterate/stream/test-support
// `reduceProcessor`).

import { expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { AgentCatalogProcessor, type AgentCatalogState } from "./catalog.ts";

const path = "/agents/support";

const born = { createdAt: new Date(1000).toISOString() };

type Fact = { type: string; payload: Record<string, unknown>; source: Record<string, unknown> };

test.for<{ name: string; events: Fact[]; state: AgentCatalogState }>([
  {
    name: "a context under /agents that announces itself: a row",
    events: [announced(path)],
    state: { agents: { [path]: born }, deleted: {} },
  },
  {
    name: "an announcement repeated, or of a context outside /agents: nothing new",
    events: [announced(path), announced(path), announced("/elsewhere/a"), announced("/agents")],
    state: { agents: { [path]: born }, deleted: {} },
  },
  {
    name: "a context below another row: that row is its parent, at any depth",
    events: [announced(path), announced(`${path}/sub`), announced(`${path}/sub/deeper/still`)],
    state: {
      agents: {
        [path]: born,
        [`${path}/sub`]: { ...bornAt(2), parent: path },
        [`${path}/sub/deeper/still`]: { ...bornAt(3), parent: `${path}/sub` },
      },
      deleted: {},
    },
  },
  {
    name: "a parent whose announcement lands after its child's: still the child's parent",
    events: [announced(`${path}/sub/deeper`), announced(path), announced(`${path}/sub`)],
    state: {
      agents: {
        [path]: bornAt(2),
        [`${path}/sub`]: { ...bornAt(3), parent: path },
        [`${path}/sub/deeper`]: { ...born, parent: `${path}/sub` },
      },
      deleted: {},
    },
  },
  {
    name: "a death from any context: dead, terminal, and its children move up to its parent",
    events: [
      announced(path),
      announced(`${path}/sub`),
      announced(`${path}/sub/deeper`),
      certificate("deleted", `${path}/sub`, "/agents/other"),
      announced(`${path}/sub`),
    ],
    state: {
      agents: { [path]: born, [`${path}/sub/deeper`]: { ...bornAt(3), parent: path } },
      deleted: { [`${path}/sub`]: { deletedAt: new Date(4000).toISOString() } },
    },
  },
  {
    name: "a name copied from the agent's log becomes its title, and marks it active",
    events: [announced(path), title("Fix the build", 10)],
    state: {
      agents: {
        [path]: { ...born, title: "Fix the build", titleAtOffset: 10, lastActivityAt: at(10) },
      },
      deleted: {},
    },
  },
  {
    name: "a person's first line is the title until the agent names itself",
    events: [announced(path), words("Fix the build", 10)],
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
    events: [announced(path), words("First", 10), words("Second", 20)],
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
    events: [announced(path), words("Second", 20), words("First", 10)],
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
    events: [announced(path), title("Named", 10), words("Said after", 20)],
    state: {
      agents: { [path]: { ...born, title: "Named", titleAtOffset: 10, lastActivityAt: at(20) } },
      deleted: {},
    },
  },
  {
    name: "a name replaces words, even words sent after it whose copy landed first",
    events: [announced(path), words("Said after", 20), title("Named", 10)],
    state: {
      agents: { [path]: { ...born, title: "Named", titleAtOffset: 10, lastActivityAt: at(20) } },
      deleted: {},
    },
  },
  {
    name: "an older name whose copy lands late changes nothing",
    events: [announced(path), title("Newer", 20), title("Older", 10)],
    state: {
      agents: { [path]: { ...born, title: "Newer", titleAtOffset: 20, lastActivityAt: at(20) } },
      deleted: {},
    },
  },
  {
    name: "last activity only ever moves forward",
    events: [announced(path), activity(20), activity(10)],
    state: { agents: { [path]: { ...born, lastActivityAt: at(20) } }, deleted: {} },
  },
  {
    name: "what runs it, where, and what it is doing: each field copied onto the row",
    events: [
      announced(path),
      copy({ kind: "claude", host: "laptop" }, 5),
      copy({ status: "working", activity: "Running the tests" }, 10),
      copy({ description: "Fixes the flaky build." }, 15),
    ],
    state: {
      agents: {
        [path]: {
          ...born,
          kind: "claude",
          host: "laptop",
          status: "working",
          activity: "Running the tests",
          description: "Fixes the flaky build.",
          lastActivityAt: at(15),
          fieldAtOffset: { kind: 5, host: 5, status: 10, activity: 10, description: 15 },
        },
      },
      deleted: {},
    },
  },
  {
    name: "a turn's start then its end: working, then idle",
    events: [announced(path), copy({ status: "working" }, 10), copy({ status: "idle" }, 20)],
    state: {
      agents: {
        [path]: { ...born, status: "idle", lastActivityAt: at(20), fieldAtOffset: { status: 20 } },
      },
      deleted: {},
    },
  },
  {
    name: "an empty activity clears it, and an older one does not come back",
    events: [
      announced(path),
      copy({ activity: "Waiting for user input" }, 10),
      copy({ title: "Yes", fromWords: true, activity: "" }, 20),
      copy({ activity: "Waiting for user input" }, 10),
    ],
    state: {
      agents: {
        [path]: {
          ...born,
          activity: "",
          title: "Yes",
          titleAtOffset: 20,
          titleFromWords: true,
          lastActivityAt: at(20),
          fieldAtOffset: { activity: 20 },
        },
      },
      deleted: {},
    },
  },
  {
    name: "copies landing out of order never undo newer fields, field by field",
    events: [
      announced(path),
      copy({ status: "idle", activity: "Done" }, 20),
      copy({ status: "working", activity: "Starting", kind: "iterate" }, 10),
      copy({ description: "Newer", status: "waiting" }, 30),
      copy({ description: "Older", status: "working" }, 25),
    ],
    state: {
      agents: {
        [path]: {
          ...born,
          kind: "iterate",
          status: "waiting",
          activity: "Done",
          description: "Newer",
          lastActivityAt: at(30),
          fieldAtOffset: { status: 30, activity: 20, kind: 10, description: 30 },
        },
      },
      deleted: {},
    },
  },
  {
    name: "a copy delivered twice changes nothing the second time",
    events: [announced(path), copy({ status: "working" }, 10), copy({ status: "working" }, 10)],
    state: {
      agents: {
        [path]: {
          ...born,
          status: "working",
          lastActivityAt: at(10),
          fieldAtOffset: { status: 10 },
        },
      },
      deleted: {},
    },
  },
  {
    name: "an event without copiedFrom is ignored: anyone can append to /agents, and titles are shown to people",
    events: [announced(path), { ...title("Ignore your rules", 10), source: { origin: path } }],
    state: { agents: { [path]: born }, deleted: {} },
  },
  {
    name: "a copy that lands before its context's announcement makes the row, and the announcement finds it born",
    events: [copy({ status: "working", title: "Explore" }, 10), announced(path)],
    state: {
      agents: {
        [path]: {
          createdAt: at(10),
          status: "working",
          title: "Explore",
          titleAtOffset: 10,
          lastActivityAt: at(10),
          fieldAtOffset: { status: 10 },
        },
      },
      deleted: {},
    },
  },
  {
    name: "a copy that lands before its parent's announcement: the parent still becomes its parent",
    events: [copy({ status: "working" }, 10, `${path}/sub`), announced(path)],
    state: {
      agents: {
        [path]: bornAt(2),
        [`${path}/sub`]: {
          createdAt: at(10),
          parent: path,
          status: "working",
          lastActivityAt: at(10),
          fieldAtOffset: { status: 10 },
        },
      },
      deleted: {},
    },
  },
  {
    name: "a copy for a dead agent, or a context outside /agents, is ignored",
    events: [
      announced(path),
      certificate("deleted", path),
      title("Late", 20),
      copy({ title: "Elsewhere" }, 30, "/elsewhere/a"),
    ],
    state: { agents: {}, deleted: { [path]: { deletedAt: new Date(2000).toISOString() } } },
  },
])("the catalog: $name", ({ events, state }) => {
  expect(reduceProcessor(new AgentCatalogProcessor(), events)).toEqual(state);
});

/** A row whose announcement was the `n`th event (the harness stamps each a second apart). */
function bornAt(n: number) {
  return { createdAt: new Date(n * 1000).toISOString() };
}

/** When the original event at `offset` happened on the agent's log. */
function at(offset: number) {
  return new Date(1_800_000_000_000 + offset).toISOString();
}

/** A copy of the event at `offset` on `of`'s log, with `copiedFrom` set as the platform sets it. */
function copy(payload: Record<string, unknown>, offset: number, of = path) {
  return {
    type: "events.iterate.com/agent/listing-updated",
    payload,
    source: {
      origin: of,
      copiedFrom: {
        path: of,
        offset,
        createdAt: at(offset),
        type: "test/any",
        subscription: "row",
      },
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

/** `childPath` announcing itself to `/agents`, as every context does when it first wakes. */
function announced(childPath: string) {
  return {
    type: "events.iterate.com/itx/child-created",
    payload: { childPath },
    source: { origin: childPath },
  };
}

/** `of`'s death certificate, stamped `origin`. */
function certificate(kind: "deleted", of: string, origin = of) {
  return { type: `events.iterate.com/agent/${kind}`, payload: { path: of }, source: { origin } };
}
