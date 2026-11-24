// The agents' copy of core/mind-worker/src/mind/collection.test.ts, which says what it proves.
import { expect, onTestFinished, test, vi } from "vitest";
import { codedError } from "../lib.ts";
import type { StreamEvent, StreamEventInput } from "../stream/processor.ts";
import { memoryStream } from "../stream/test-support.ts";
import { AgentCollectionRpcTarget } from "./collection.ts";
import { AgentProcessor } from "./processor.ts";

const PATH = "/agents/a";

test.for([
  { verb: "create", born: false, request: "create-requested" },
  { verb: "delete", born: true, request: "delete-requested" },
] as const)(
  "two $verb calls in flight both answer, and the log holds one $request",
  async ({ verb, born, request }) => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const agent = agentContext({ born });
    const agents = collectionOver(agent.context);
    const answers = Promise.allSettled([agents[verb](PATH), agents[verb](PATH)]);
    // past every wait for a certificate
    await vi.advanceTimersByTimeAsync(60_000);
    expect({
      answers: (await answers).map((answer) =>
        answer.status === "fulfilled" ? answer.value : String(answer.reason),
      ),
      requests: agent.events.filter((event) => event.type === `events.iterate.com/agent/${request}`)
        .length,
    }).toEqual({ answers: [{ path: PATH }, { path: PATH }], requests: 1 });
  },
);

test("a create after a failed one is a new attempt, not the failed request again", async () => {
  const agent = agentContext({ together: 1, failures: 1 });
  const agents = collectionOver(agent.context);
  expect({
    first: await agents.create(PATH).catch(String),
    second: await agents.create(PATH),
    requests: agent.events.filter(
      (event) => event.type === "events.iterate.com/agent/create-requested",
    ).length,
  }).toEqual({
    first: "Error: agent /agents/a: creation failed — no",
    second: { path: PATH },
    requests: 2,
  });
});

// ── a mind with an agent of its own (catalog.ts `AgentCollectionDurableObject.agent`) ──

test("create starts the mind's own agent with one append, and a second create writes nothing", async () => {
  // listed with no kind: a context that announced itself and runs no agent yet
  const { agents, events } = ownCollection(null);
  expect(await agents.create(PATH)).toEqual({ path: PATH });
  // no request and no certificate of the platform's agent
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
    // a take-over first takes the platform agent's four copy rows off
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

function collectionOver(context: object) {
  return new AgentCollectionRpcTarget(
    () => ({ cd: () => context, [Symbol.dispose]() {} }) as never,
    async () =>
      ({
        offset: 0,
        state: { agents: { [PATH]: { createdAt: "2026-11-14T00:00:00.000Z" } }, deleted: {} },
      }) as never,
  );
}

/** As `workspaceContext` in core/mind-worker/src/mind/collection.test.ts, with the agent's
 *  reduce. */
function agentContext({ born = false, together = 2, failures = 0 } = {}) {
  const { stream, events } = memoryStream(PATH);
  const processor = new AgentProcessor({ getItx: () => ({}) as never });
  let state = processor.contract.initialState();
  const waiters = new Set<() => void>();
  const append = (...inputs: StreamEventInput[]) => {
    const before = events.length;
    const committed = stream.append(...inputs) as StreamEvent[];
    for (const event of committed)
      if (event.offset > before) state = processor.reduce({ state, event } as never) ?? state;
    for (const wake of waiters) wake();
    if (state.creation?.status === "requested")
      append(
        failures-- > 0
          ? { type: "events.iterate.com/agent/create-failed", payload: { error: "no" } }
          : certificate("created", `agent/created:${PATH}`),
      );
    if (state.deletion?.status === "requested")
      append(certificate("deleted", `agent/deleted:${PATH}`));
    return committed;
  };
  if (born) append(certificate("created"));
  let asking: (() => void)[] = [];
  const context = {
    async invoke() {
      await new Promise<void>((resolve) => {
        asking.push(resolve);
        if (asking.length < together) return;
        for (const answer of asking) answer();
        asking = [];
      });
      return { state };
    },
    processors: {
      async enable() {},
      async disable() {},
      async list() {
        return [{ name: "agent" }];
      },
    },
    async append(...inputs: StreamEventInput[]) {
      return append(...inputs);
    },
    waitForEvent(filter: { type: string[]; afterOffset: number; timeoutMs: number }) {
      return new Promise<StreamEvent>((resolve, reject) => {
        const look = () => {
          const found = events.find(
            (event) => event.offset > filter.afterOffset && filter.type.includes(event.type),
          );
          if (!found) return;
          waiters.delete(look);
          clearTimeout(timer);
          resolve(found);
        };
        const timer = setTimeout(() => {
          waiters.delete(look);
          reject(codedError("WAIT_TIMEOUT", "no such event"));
        }, filter.timeoutMs);
        waiters.add(look);
        look();
      });
    },
  };
  return { events, context };
}

function certificate(fact: "created" | "deleted", idempotencyKey?: string): StreamEventInput {
  return { type: `events.iterate.com/agent/${fact}`, payload: { path: PATH }, idempotencyKey };
}

const typesOf = (events: StreamEvent[]) =>
  events.map((event) => event.type.replace("events.iterate.com/", ""));

/** A mind's own agent, as a config's agents.ts hands it to the collection. */
const OWN = {
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
function ownCollection(kind: string | null, { deleted = false } = {}) {
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
    "agents.ts",
    OWN,
  );
  return { agents, events, disabled, deaths };
}
