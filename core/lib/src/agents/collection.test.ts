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
