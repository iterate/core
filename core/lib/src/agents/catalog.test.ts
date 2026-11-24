// catalog.test.ts — how the agents catalog on `/agents` folds the contexts that announce themselves
// below it, death certificates from any context and the copies of each agent's events, as
// declarative `{ events → state }` rows on the shared harness (iterate/stream/test-support
// `reduceProcessor`), and which `itx/described` line and title each copy puts on the agent's own
// log.

import { expect, test, vi } from "vitest";
import type { StreamEvent } from "../stream/processor.ts";
import { committedEvent, reduceProcessor } from "../stream/test-support.ts";
import { AgentCatalogProcessor, type AgentCatalogState, describedKey } from "./catalog.ts";

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
    name: "the same words copied again by a changed row give the title anew",
    events: [
      announced(path),
      words("[From the Agents app] Fix the build. Then the docs", 10),
      words("Fix the build", 10),
      words("Second", 20),
    ],
    state: {
      agents: {
        [path]: {
          ...born,
          title: "Fix the build",
          titleAtOffset: 10,
          titleFromWords: true,
          lastActivityAt: at(20),
        },
      },
      deleted: {},
    },
  },
  {
    name: "a name still beats the same words copied again",
    events: [announced(path), title("Named", 5), words("Fix the build", 10), words("Fix it", 10)],
    state: {
      agents: {
        [path]: {
          ...born,
          title: "Named",
          titleAtOffset: 5,
          lastActivityAt: at(10),
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
  expect(reduceProcessor(catalog().processor, events)).toEqual(state);
});

test.for<{
  name: string;
  events: Fact[];
  described: { path: string; key: string; text: string }[];
}>([
  {
    name: "a title the agent gave itself: its line, keyed by the copied event",
    events: [announced(path), title("Fix the build", 10)],
    described: [{ path, key: describedKey(path, 10, "Fix the build"), text: "Fix the build" }],
  },
  {
    name: "a description after the title: the description alone, as a purpose is not a name",
    events: [announced(path), title("Fix the build", 10), copy({ description: "CI is red" }, 11)],
    described: [
      { path, key: describedKey(path, 10, "Fix the build"), text: "Fix the build" },
      { path, key: describedKey(path, 11, "CI is red"), text: "CI is red" },
    ],
  },
  {
    name: "a person's first line, then the agent's own name: each once, later words nothing",
    events: [
      announced(path),
      words("Please fix the build", 10),
      words("And the docs", 20),
      title("Fix the build", 30),
    ],
    described: [
      { path, key: describedKey(path, 10, "Please fix the build"), text: "Please fix the build" },
      { path, key: describedKey(path, 30, "Fix the build"), text: "Fix the build" },
    ],
  },
  {
    name: "the same words copied again with another line: that line once more, and once only",
    events: [
      announced(path),
      words("[From the Agents app] Fix the build", 10),
      words("Fix the build", 10),
      words("Fix the build", 10),
    ],
    described: [
      {
        path,
        key: describedKey(path, 10, "[From the Agents app] Fix the build"),
        text: "[From the Agents app] Fix the build",
      },
      { path, key: describedKey(path, 10, "Fix the build"), text: "Fix the build" },
    ],
  },
  {
    name: "a status, an activity, an older title landing late or a copy without copiedFrom: nothing",
    events: [
      announced(path),
      title("Newer", 20),
      copy({ status: "working", activity: "Reading" }, 21),
      title("Older", 10),
      { ...title("Forged", 30), source: { origin: "/elsewhere" } },
    ],
    described: [{ path, key: describedKey(path, 20, "Newer"), text: "Newer" }],
  },
])("an agent's line in the mind's catalog: $name", async ({ events, described }) => {
  const { processor, appended } = catalog();
  await processAll(processor, events);
  expect(
    appended.filter(({ event }) => event.idempotencyKey.startsWith("agents/described:")),
  ).toEqual(
    described.map(({ path, key, text }) => ({
      path,
      event: {
        type: "events.iterate.com/itx/described",
        idempotencyKey: key,
        payload: { description: text },
      },
    })),
  );
});

test.for<{
  name: string;
  events: Fact[];
  listed?: { path: string; metadata?: Record<string, unknown> }[];
  titled: { key: string; metadata: Record<string, unknown> }[];
}>([
  {
    name: "a title the agent gave itself: metadata.title, keyed by the copied event",
    events: [announced(path), title("Fix the build", 10)],
    titled: [{ key: `agents/titled:${path}@10`, metadata: { title: "Fix the build" } }],
  },
  {
    name: "a title over 80 characters: its first 80",
    events: [announced(path), title("x".repeat(100), 10)],
    titled: [{ key: `agents/titled:${path}@10`, metadata: { title: "x".repeat(80) } }],
  },
  {
    name: "a person's first line: no title",
    events: [announced(path), words("Please fix the build", 10)],
    titled: [],
  },
  {
    name: "a second, newer title of its own: written once more",
    events: [announced(path), title("Fix the build", 10), title("Fix the docs", 20)],
    titled: [
      { key: `agents/titled:${path}@10`, metadata: { title: "Fix the build" } },
      { key: `agents/titled:${path}@20`, metadata: { title: "Fix the docs" } },
    ],
  },
  {
    name: "a description, an activity or the same title again: no title",
    events: [
      announced(path),
      title("Fix the build", 10),
      copy({ description: "CI is red" }, 11),
      activity(12),
      title("Fix the build", 13),
    ],
    titled: [{ key: `agents/titled:${path}@10`, metadata: { title: "Fix the build" } }],
  },
  {
    // About appends `agent/summary-updated` beside `itx/described`; the catalog's own
    // `itx/described` never comes back (no copy row takes an `itx/*` event), so it goes round once
    name: "a title set in About, then the same title of the agent's: written once",
    events: [
      announced(path),
      title("Coding chief of staff", 20),
      title("Coding chief of staff", 30),
    ],
    titled: [{ key: `agents/titled:${path}@20`, metadata: { title: "Coding chief of staff" } }],
  },
  {
    name: "the same, landing in the other order: written once",
    events: [
      announced(path),
      title("Coding chief of staff", 30),
      title("Coding chief of staff", 20),
    ],
    titled: [{ key: `agents/titled:${path}@30`, metadata: { title: "Coding chief of staff" } }],
  },
  {
    name: "a batch delivered again: nothing more",
    events: [announced(path), title("Fix the build", 10), title("Fix the build", 10)],
    titled: [{ key: `agents/titled:${path}@10`, metadata: { title: "Fix the build" } }],
  },
  {
    name: "the context's listed metadata: kept, its title replaced, a child's row not read",
    events: [announced(path), title("Fix the build", 10)],
    listed: [
      { path: `${path}/sub`, metadata: { child: true } },
      { path, metadata: { pinned: true, title: "A person's title" } },
    ],
    titled: [
      { key: `agents/titled:${path}@10`, metadata: { pinned: true, title: "Fix the build" } },
    ],
  },
])("an agent's title in the mind's catalog: $name", async ({ events, listed, titled }) => {
  const { processor, appended } = catalog(listed);
  await processAll(processor, events);
  expect(appended.filter(({ event }) => event.idempotencyKey.startsWith("agents/titled:"))).toEqual(
    titled.map(({ key, metadata }) => ({
      path,
      event: {
        type: "events.iterate.com/itx/described",
        idempotencyKey: key,
        payload: { metadata },
      },
    })),
  );
});

test("a copy that says another kind starts the row over: the first agent's title, lines and status go, and the new agent's first words title it", () => {
  const { processor } = catalog();
  const state = reduceProcessor(processor, [
    announced(path),
    copy({ kind: "iterate" }, 3),
    words("Say the single word MANGO", 5),
    copy({ status: "idle", activity: "Answering", description: "Fruit" }, 9),
    // the path started over, and the mind's own agent runs there now
    copy({ kind: "agent" }, 40),
    words("Say KIWI", 44),
    // a copy of the first agent that lands late changes nothing
    copy({ activity: "an old line" }, 12),
    words("An older first line", 2),
  ]);
  expect(state.agents[path]).toEqual({
    ...born,
    kind: "agent",
    title: "Say KIWI",
    titleAtOffset: 44,
    titleFromWords: true,
    startedOverAtOffset: 40,
    fieldAtOffset: { kind: 40 },
    lastActivityAt: at(44),
  });
});

test("a copy of a later version of the context starts the row over, also when the kind stays the same", () => {
  const { processor } = catalog();
  const ofVersion = (fact: ReturnType<typeof copy>, version: number) => ({
    ...fact,
    source: { ...fact.source, copiedFrom: { ...fact.source.copiedFrom, version } },
  });
  const state = reduceProcessor(processor, [
    announced(path),
    copy({ kind: "agent" }, 3),
    words("Say the single word MANGO", 5),
    title("The fruit agent", 8),
    // `itx.newVersion`: the platform writes the version on every copy from version 2 on
    ofVersion(copy({ kind: "agent" }, 40), 2),
    ofVersion(words("Say KIWI", 44), 2),
    // the same version again starts nothing over
    ofVersion(copy({ status: "idle" }, 50), 2),
  ]);
  expect(state.agents[path]).toEqual({
    ...born,
    kind: "agent",
    status: "idle",
    title: "Say KIWI",
    titleAtOffset: 44,
    titleFromWords: true,
    startedOverAtOffset: 40,
    version: 2,
    fieldAtOffset: { kind: 40, status: 50 },
    lastActivityAt: at(50),
  });
});

test("the same kind again starts nothing over, and neither does a row's first kind", () => {
  const { processor } = catalog();
  const state = reduceProcessor(processor, [
    announced(path),
    words("Hello", 5),
    copy({ kind: "agent" }, 6),
    copy({ kind: "agent" }, 30),
  ]);
  expect(state.agents[path]).toMatchObject({ title: "Hello", kind: "agent" });
  expect(state.agents[path]).not.toHaveProperty("startedOverAtOffset");
});

test("the first title after a path started over is written alone: the earlier version's metadata is not merged into it", async () => {
  // the mind's catalog of contexts still lists what the first agent's context held
  const { processor, appended, reads } = catalog([
    { path, metadata: { owner: "ada", title: "Old" } },
  ]);
  await processAll(processor, [
    announced(path),
    copy({ kind: "iterate" }, 3),
    copy({ kind: "agent" }, 40),
    title("The new agent", 50),
    title("Its second title", 60),
  ]);
  expect({
    titled: appended
      .filter(({ event }) => event.idempotencyKey.startsWith("agents/titled:"))
      .map(({ event }) => event.payload),
    reads,
  }).toEqual({
    titled: [
      { metadata: { title: "The new agent" } },
      // from the second title on the listed metadata is the new version's, and is merged
      { metadata: { owner: "ada", title: "Its second title" } },
    ],
    reads: ["/"],
  });
});

test("the listed row is read once for each change of an agent's own title, and never for the same title, a description or an activity", async () => {
  const { processor, reads } = catalog();
  await processAll(processor, [
    announced(path),
    title("Fix the build", 10),
    title("Fix the build", 11),
    copy({ description: "CI is red" }, 12),
    activity(13),
    title("Fix the docs", 20),
  ]);
  expect(reads).toEqual(["/", "/"]);
});

test("a context whose metadata would be too long with a title keeps it: no title is written", async () => {
  const reported = vi.spyOn(console, "error").mockImplementation(() => {});
  const { processor, appended } = catalog([{ path, metadata: { notes: "x".repeat(3_990) } }]);
  await processAll(processor, [announced(path), title("Fix the build", 10)]);
  expect(appended.filter(({ event }) => event.idempotencyKey.startsWith("agents/titled:"))).toEqual(
    [],
  );
  reported.mockRestore();
});

test("a mind that refuses the read writes no title, and says so once for each agent", async () => {
  const reported = vi.spyOn(console, "error").mockImplementation(() => {});
  const { processor, appended } = catalog([], true);
  await processAll(processor, [
    announced(path),
    title("Fix the build", 10),
    title("Fix the docs", 20),
  ]);
  expect(appended.filter(({ event }) => event.idempotencyKey.startsWith("agents/titled:"))).toEqual(
    [],
  );
  expect(
    reported.mock.calls.filter((call) => JSON.stringify(call).includes("agents.catalog.titled")),
  ).toHaveLength(1);
  reported.mockRestore();
});

/** The catalog's processor, with a root that records each append it is asked for and lists
 *  `listed` as the mind's catalog of contexts. */
function catalog(
  listed: { path: string; metadata?: Record<string, unknown> }[] = [],
  refuse = false,
) {
  const appended: { path: string; event: { idempotencyKey: string; payload: unknown } }[] = [];
  const reads: string[] = [];
  const itx = {
    cd: (at: string) => ({
      append: async (event: { idempotencyKey: string; payload: unknown }) => {
        appended.push({ path: at, event });
        return [];
      },
      contexts: {
        list: async () => {
          reads.push(at);
          if (refuse) throw new Error("refused");
          return at === "/" ? listed : [];
        },
      },
    }),
    [Symbol.dispose]() {},
  };
  // The processor reaches only `cd(path).append` and `cd("/").contexts.list`: the fake has nothing else.
  const processor = new AgentCatalogProcessor(() => itx as never);
  return { processor, appended, reads };
}

/** Each of `events` handed to `processEvent` in turn, its work done before the next. */
async function processAll(processor: AgentCatalogProcessor, events: Fact[]) {
  for (const [index, fact] of events.entries()) {
    const blockers: (() => Promise<unknown>)[] = [];
    processor.processEvent({
      event: eventAt(index + 1, fact),
      previousState: reduceProcessor(processor, events.slice(0, index)),
      state: reduceProcessor(processor, events.slice(0, index + 1)),
      append: async () => [],
      blockProcessorWhile: (work) => blockers.push(work),
      runInBackground: () => {},
      delivery: { caughtUp: false },
    });
    for (const work of blockers) await work();
  }
}

/** `fact` as the engine hands it over, at `offset` on `/agents`. */
function eventAt(offset: number, fact: Fact) {
  return {
    ...committedEvent(offset, fact.type, fact.payload),
    path: "/agents",
    source: fact.source,
  } as Parameters<AgentCatalogProcessor["processEvent"]>[0]["event"] & StreamEvent;
}

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
