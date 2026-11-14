// The request that opens an entity's birth or death. Two calls in flight read the state
// before either request lands, and the processor answers the first request at once: the second
// call must get the answer too. A call after a failed birth is a new attempt.
import { codedError } from "iterate/lib";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import { memoryStream } from "iterate/stream/test-support";
import { expect, onTestFinished, test, vi } from "vitest";
import { WorkspaceContract } from "../workspace/contract.ts";
import { EntityCollectionRpcTarget } from "./collection.ts";
import { EntityLifecycleProcessor } from "./entity-lifecycle.ts";

const PATH = "/workspaces/w";

test.for([
  { verb: "create", born: false, request: "create-requested" },
  { verb: "delete", born: true, request: "delete-requested" },
] as const)(
  "two $verb calls in flight both answer, and the log holds one $request",
  async ({ verb, born, request }) => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const workspace = workspaceContext({ born });
    const workspaces = collectionOver(workspace.context);
    const call = () =>
      verb === "create" ? workspaces.create(PATH, { creator: "/" }) : workspaces.delete(PATH);
    const answers = Promise.allSettled([call(), call()]);
    // past every wait for a certificate
    await vi.advanceTimersByTimeAsync(60_000);
    expect({
      answers: (await answers).map((answer) =>
        answer.status === "fulfilled" ? answer.value : String(answer.reason),
      ),
      requests: workspace.events.filter(
        (event) => event.type === `events.iterate.com/workspace/${request}`,
      ).length,
    }).toEqual({ answers: [{ path: PATH }, { path: PATH }], requests: 1 });
  },
);

test("a create after a failed one is a new attempt, not the failed request again", async () => {
  const workspace = workspaceContext({ together: 1, failures: 1 });
  const workspaces = collectionOver(workspace.context);
  expect({
    first: await workspaces.create(PATH, { creator: "/" }).catch(String),
    second: await workspaces.create(PATH, { creator: "/" }),
    requests: workspace.events.filter(
      (event) => event.type === "events.iterate.com/workspace/create-requested",
    ).length,
  }).toEqual({
    first: "Error: workspace /workspaces/w: creation failed — no",
    second: { path: PATH },
    requests: 2,
  });
});

function collectionOver(context: object) {
  return new EntityCollectionRpcTarget(
    "workspace",
    () => ({ cd: () => context, [Symbol.dispose]() {} }) as never,
    async () => ({}) as never,
  );
}

/** The entity's context: the stream's commit semantics (memoryStream, keys included), its state
 *  folded by the entity's own reduce, and a processor that appends its keyed certificate as soon as
 *  a request lands. With `together`, a snapshot is answered only once that many calls have asked
 *  for one. With `failures`, the processor fails that many requests first. */
function workspaceContext({ born = false, together = 2, failures = 0 } = {}) {
  const { stream, events } = memoryStream(PATH);
  const processor = new EntityLifecycleProcessor(
    WorkspaceContract,
    () => ({}) as never,
    () => PATH,
  );
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
          ? { type: "events.iterate.com/workspace/create-failed", payload: { error: "no" } }
          : certificate("created", `workspace/created:${PATH}`),
      );
    if (state.deletion?.status === "requested")
      append(certificate("deleted", `workspace/deleted:${PATH}`));
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
        return [{ name: "workspace" }];
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
  return { type: `events.iterate.com/workspace/${fact}`, payload: { path: PATH }, idempotencyKey };
}
