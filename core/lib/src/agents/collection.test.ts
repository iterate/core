// collection.test.ts — `itx.agents` (collection.ts) over a context that holds a log and a list of
// processor rows: what `create`, `message` and `delete` append and disable for the mind's own
// agent, for a context that an agent of the platform ran (a take-over), for another kind of agent,
// and in a mind whose config names no agent.
import { expect, test } from "vitest";
import type { StreamEvent, StreamEventInput } from "../stream/processor.ts";
import { memoryStream } from "../stream/test-support.ts";
import { AgentCollectionRpcTarget, type OwnAgent } from "./collection.ts";

const PATH = "/agents/a";

test("create starts the mind's own agent with one append, and a second create writes nothing", async () => {
  // listed with no kind: a context that announced itself and runs no agent yet
  const { agents, events } = ownCollection(null);
  expect(await agents.create(PATH)).toEqual({ path: PATH });
  // the start facts and the collection's own row, and nothing else: nothing is asked for and
  // nothing is waited for
  expect(typesOf(events)).toEqual([
    "itx/rewrite-rule-configured",
    "agent/configured",
    "itx/subscription-configured",
    "itx/subscription-configured",
    "itx/rewrite-rule-configured",
  ]);
  // the birth links the agent's `itx` to its creator, and the collection's own row follows
  expect(events[0]).toMatchObject({ payload: { match: "itx", target: 'itx.cd("/")' } });
  expect(events.at(-1)).toMatchObject({
    payload: { match: "itx.agents", target: `itx.cd('/').agents.at("${PATH}")` },
  });
  await agents.create(PATH);
  expect(events).toHaveLength(5);
});

test.for(["iterate", "agent"])(
  "create on a context where a %s agent runs writes no parent link: the link of its birth stands",
  async (kind) => {
    const { agents, events } = ownCollection(kind);
    await agents.create(PATH);
    expect(typesOf(events)).toContain("agent/configured");
    expect(events.map((event) => (event.payload as { match?: string }).match)).not.toContain("itx");
  },
);

test("create refuses a context where another kind of agent runs, and a deleted agent", async () => {
  const claude = ownCollection("claude");
  await expect(claude.agents.create(PATH)).rejects.toThrow(
    "an agent of the kind claude runs there",
  );
  const dead = ownCollection("agent", { deleted: true });
  await expect(dead.agents.create(PATH)).rejects.toThrow("deleted");
  expect([claude.events, dead.events]).toEqual([[], []]);
});

test.for(["iterate", "agent"])(
  "a message to a %s agent lands after the start facts, in one append",
  async (kind) => {
    const { agents, events } = ownCollection(kind);
    const sent = await agents.get(PATH).message("hello");
    expect(sent).toMatchObject({
      type: "events.iterate.com/agent/message-received",
      payload: { message: "hello" },
    });
    // a take-over first takes the former agent's four copy rows off
    const off = events.filter((event) => (event.payload as { target?: unknown }).target === null);
    expect(off.map((event) => (event.payload as { name: string }).name)).toEqual(
      kind === "iterate"
        ? ["catalog-kind", "catalog-summary", "catalog-first-words", "catalog-status"]
        : [],
    );
    expect(typesOf(events).slice(off.length)).toEqual([
      "agent/configured",
      "itx/subscription-configured",
      "itx/subscription-configured",
      "itx/rewrite-rule-configured",
      "agent/message-received",
    ]);
  },
);

test.for(["claude", null])(
  "a message to an agent of the kind %s is the words alone",
  async (kind) => {
    const { agents, events } = ownCollection(kind);
    await agents.get(PATH).message("hello");
    expect(typesOf(events)).toEqual(["agent/message-received"]);
  },
);

test("delete certifies the death, then disables every row that the start enables and no other", async () => {
  const first = ownCollection("agent");
  expect(await first.agents.delete(PATH)).toEqual({ path: PATH });
  // a second delete, after the catalog folded the death, certifies nothing again
  const again = ownCollection("agent", { deleted: true });
  await again.agents.delete(PATH);
  expect([first, again].map(({ deaths, disabled }) => ({ deaths, disabled }))).toEqual([
    {
      deaths: [{ type: "events.iterate.com/agent/deleted", payload: { path: PATH } }],
      disabled: ["agent", "llm-api-openai-responses"],
    },
    { deaths: [], disabled: ["agent", "llm-api-openai-responses"] },
  ]);
});

test("delete of another kind's agent certifies its death and disables nothing", async () => {
  const { agents, disabled, deaths } = ownCollection("claude");
  await agents.delete(PATH);
  expect({ deaths: deaths.length, disabled }).toEqual({ deaths: 1, disabled: [] });
});

test("a mind whose config names no agent: create refuses, a message is the words alone, and delete certifies the death", async () => {
  const { agents, events, disabled, deaths } = ownCollection("claude", { own: null });
  await expect(agents.create(PATH)).rejects.toThrow("names no agent to start");
  await agents.get(PATH).message("hello");
  await agents.delete(PATH);
  expect({ types: typesOf(events), deaths: deaths.length, disabled }).toEqual({
    types: ["agent/message-received"],
    deaths: 1,
    disabled: [],
  });
});

test("an agent cannot create its own ancestor, and the root is no agent", async () => {
  const { events } = ownCollection(null);
  const child = new AgentCollectionRpcTarget(
    () => ({ cd: () => ({}), [Symbol.dispose]() {} }) as never,
    async () => ({ offset: 0, state: { agents: {}, deleted: {} } }) as never,
    `${PATH}/child`,
    OWN,
  );
  await expect(child.create(PATH)).rejects.toThrow("cannot create its own ancestor");
  await expect(child.create("/")).rejects.toThrow("needs its own context path");
  expect(events).toEqual([]);
});

test("list says whether a row's title is a name or only the first words a person sent", async () => {
  const createdAt = "2026-11-24T00:00:00.000Z";
  const agents = new AgentCollectionRpcTarget(
    () => ({ cd: () => ({}), [Symbol.dispose]() {} }) as never,
    async () =>
      ({
        offset: 0,
        state: {
          agents: {
            "/agents/named": { createdAt, title: "Engineering manager" },
            "/agents/words": { createdAt, title: "Please fix the build", titleFromWords: true },
            "/agents/silent": { createdAt },
          },
          deleted: {},
        },
      }) as never,
    "/",
    OWN,
  );
  expect(
    (await agents.list()).map(({ path, title, titleFromWords }) => [path, title, titleFromWords]),
  ).toEqual([
    ["/agents/named", "Engineering manager", false],
    ["/agents/words", "Please fix the build", true],
    ["/agents/silent", null, false],
  ]);
});

const typesOf = (events: StreamEvent[]) =>
  events.map((event) => event.type.replace("events.iterate.com/", ""));

/** A mind's own agent, as a config's agents.ts hands it to the collection. */
const OWN: OwnAgent = {
  kind: "agent",
  startEvents: (path: string, { parent }: { parent?: string }) => [
    ...(parent
      ? [
          {
            type: "events.iterate.com/itx/rewrite-rule-configured",
            idempotencyKey: `agent-parent:${path}`,
            payload: { match: "itx", target: `itx.cd(${JSON.stringify(parent)})` },
          },
        ]
      : []),
    {
      type: "events.iterate.com/agent/configured",
      idempotencyKey: `agent-configured:${path}`,
      payload: { kind: "agent", config: {} },
    },
    ...["agent", "llm-api-openai-responses"].map((name) => ({
      type: "events.iterate.com/itx/subscription-configured",
      idempotencyKey: `agent-facet:${name}:${path}`,
      payload: { name, target: ["itx", "facets", ["get", name, {}], "processEventBatch"] },
    })),
  ],
};

/** A context that holds a log and a list of processor rows, and a collection over it whose
 *  catalog says `kind` of the agent at PATH (null: listed, and it never said what it is). */
function ownCollection(
  kind: string | null,
  { deleted = false, own = OWN }: { deleted?: boolean; own?: OwnAgent | null } = {},
) {
  const { stream, events } = memoryStream(PATH);
  const rows = new Set(["agent", "llm-api-openai-responses", "llm-api-of-another-day", "call"]);
  const disabled: string[] = [];
  const deaths: StreamEventInput[] = [];
  const context = {
    async append(...inputs: StreamEventInput[]) {
      return stream.append(...inputs) as StreamEvent[];
    },
    processors: {
      async list() {
        return [...rows].map((name) => ({ name }));
      },
      async disable(name: string) {
        rows.delete(name);
        disabled.push(name);
      },
    },
  };
  const agents = new AgentCollectionRpcTarget(
    () =>
      ({
        cd: (path: string) =>
          path === "/agents"
            ? { append: async (...inputs: StreamEventInput[]) => void deaths.push(...inputs) }
            : context,
        [Symbol.dispose]() {},
      }) as never,
    async () =>
      ({
        offset: 0,
        state: {
          agents: { [PATH]: { createdAt: "2026-11-24T00:00:00.000Z", kind } },
          deleted: deleted ? { [PATH]: {} } : {},
        },
      }) as never,
    "/",
    own || undefined,
  );
  return { agents, events, disabled, deaths };
}
