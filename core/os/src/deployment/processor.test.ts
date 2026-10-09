// src/deployment/processor.test.ts — the DeploymentProcessor's executable spec: the reduce as
// `{ events → state }` rows, the run as `{ events → facts }` rows, each a log that the engine
// catches up over a fake attempt, and a re-reduce row. The facet on a Worker, with Alchemy's engine
// loaded, is test/vitest/os/deployments.e2e.test.ts; the lifecycle's sagas are the entity tests'.
import { expect, test, vi } from "vitest";
import { ProcessorEngine, type StreamEventInput } from "iterate/stream/processor";
import { memoryStorage, memoryStream, reduceProcessor } from "iterate/stream/test-support";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { DeploymentContract, DeploymentRunRequested } from "./contract.ts";
import {
  DeploymentProcessor,
  type DeploymentRun,
  type DeploymentRunDeps,
  type DeploymentStepFact,
} from "./processor.ts";

const PATH = "/deployments/x-os";
const SHA256 = "b".repeat(64);
const WORKER_URL = "https://x-os.example.workers.dev";
/** What the fake attempt reports of the release and of a resource. */
const STAGED = { sha256: SHA256, files: 3, bytes: 300 };
const APPLIED = { fqn: "worker", type: "Cloudflare.Worker", status: "created" };

const birth = [
  { type: "events.iterate.com/deployment/create-requested", payload: {} },
  { type: "events.iterate.com/deployment/created", payload: { path: PATH } },
];
const born = { creation: { status: "created" as const, offset: 2 }, deletion: null };
const target = { accountId: "a".repeat(32), configId: "config-1" };

test.for([
  {
    name: "a request opens the run at its offset and records where it acts; a second one changes nothing",
    events: [...birth, requested("plan"), requested("deploy")],
    state: { ...born, target, run: openRun(3) },
  },
  {
    name: "each step of the attempt moves the step and the offset of its fact",
    events: [...birth, requested("plan"), started(3, 1), staged(3, 1), applied(3, 1)],
    state: { ...born, target, run: openRun(3, { attempt: 1, step: "applying", stepOffset: 6 }) },
  },
  {
    name: "a step of an older attempt, or the settlement of another request, changes nothing",
    events: [...birth, requested("plan"), started(3, 2), staged(3, 1), runSettled(9, "refused", 0)],
    state: { ...born, target, run: openRun(3, { attempt: 2, step: "started", stepOffset: 4 }) },
  },
  {
    name: "a deploy that succeeded sets the Worker's URL; a plan, or a run that did not succeed, keeps it",
    events: [
      ...birth,
      requested("deploy"),
      runSettled(3, "succeeded", 1, { url: WORKER_URL }),
      requested("plan"),
      runSettled(5, "succeeded", 1),
      requested("deploy"),
      runSettled(7, "unavailable", 1, { error: "the platform failed" }),
    ],
    state: { ...born, target, url: WORKER_URL },
  },
  {
    name: "a destroy that succeeded clears the URL",
    events: [
      ...birth,
      requested("deploy"),
      runSettled(3, "succeeded", 1, { url: WORKER_URL }),
      requested("destroy"),
      runSettled(5, "succeeded", 1),
    ],
    state: { ...born, target, url: null },
  },
])("the deployment's reduce: $name", ({ events, state }) => {
  // exact: the reduce owns the whole state, so a field that it should not have set fails the row
  expect(reduceProcessor(processorOver(), events)).toEqual({
    ...DeploymentContract.initialState(),
    ...state,
  });
});

// Each row's attempt succeeds with the Worker's URL, having reported `reports`.
test.for([
  {
    name: "a requested run starts attempt 1, lands each step that it reports, and settles as it ended",
    events: [...birth, requested("deploy")],
    reports: [
      { type: "events.iterate.com/deployment/release-staged", payload: STAGED },
      { type: "events.iterate.com/deployment/resource-applied", payload: APPLIED },
    ] satisfies DeploymentStepFact[],
    appended: [started(3, 1), staged(3, 1), applied(3, 1), settledWithUrl(3, 1)],
  },
  {
    name: "a run found mid-attempt starts the next attempt, saying why",
    events: [...birth, requested("deploy"), started(3, 1)],
    appended: [started(3, 2, "attempt 1 ended before it settled the run"), settledWithUrl(3, 2)],
  },
  {
    name: "a run found at its last attempt settles failed with no other attempt",
    events: [...birth, requested("deploy"), started(3, 4)],
    appended: [
      runSettled(3, "failed", 4, {
        error: "gave up after 4 attempts, none of which settled the run",
      }),
    ],
  },
  {
    name: "a request while a run is open settles refused, naming that run, which goes on",
    events: [...birth, requested("deploy"), requested("plan")],
    appended: [
      started(3, 1),
      runSettled(4, "refused", 0, {
        error: "a deploy run is open since offset 3: follow it to its settlement, then ask again",
      }),
      settledWithUrl(3, 1),
    ],
  },
  {
    name: "a run settled further on in the log starts no attempt while the log catches up",
    events: [...birth, requested("deploy"), runSettled(3, "succeeded", 1)],
    appended: [],
  },
])("the run: $name", async ({ events, reports = [], appended }) => {
  // exact: a key whose value is undefined fails the append when it is repeated (the stream compares
  // it with the stored JSON, which has no such key), and toEqual does not see that key
  expect(await caughtUp(events, reports)).toStrictEqual(appended);
});

test("a version bump replays the log through the reduce alone: no append, and no attempt beyond version 1's", async () => {
  const mem = memoryStream(PATH);
  const storage = memoryStorage();
  // a plan, and a deploy that version 1 refuses while the plan's run is open
  mem.stream.append(...birth, requested("plan"), requested("deploy"));
  const attempts: number[] = [];
  const processorAt = (version: string) =>
    processorOver(async ({ attempt }) => {
      attempts.push(attempt);
      return { status: "succeeded" };
    }, version);
  const v1 = processorAt("1");
  await new ProcessorEngine(v1, { stream: mem.stream, storage }).catchUpFromLog();
  await v1.driven();
  const appends = vi.spyOn(mem.stream, "append");
  const v2 = new ProcessorEngine(processorAt("2"), { stream: mem.stream, storage });
  const { state } = await v2.snapshot();
  expect({
    state,
    // the processor's own facts, counted by call, since a repeated keyed append lands nothing new;
    // the engine's live-state delta is an ephemeral notification, no fact
    appended: appends.mock.calls.flat().filter((event) => !event.ephemeral),
    attempts,
  }).toMatchObject({
    state: { ...born, target, run: null, url: null },
    appended: [],
    // Version 1's checkpoint holds the plan's run open, and its driver made attempt 1. A replay
    // that ran effects would refuse the deploy again, and an at-head pass over the replayed state
    // would start another attempt.
    attempts: [1],
  });
});

/** `events` on a fresh log, caught up by the engine over a processor whose attempt reports
 *  `reports` and succeeds with the Worker's URL, until its driver ends: the facts it appended. */
async function caughtUp(events: StreamEventInput[], reports: DeploymentStepFact[]) {
  const { stream, events: log } = memoryStream(PATH);
  stream.append(...events);
  const processor = processorOver(async (_run, report) => {
    for (const fact of reports) await report(fact);
    return { status: "succeeded", url: WORKER_URL };
  });
  await new ProcessorEngine(processor, { stream, storage: memoryStorage() }).catchUpFromLog();
  await processor.driven();
  return log
    .slice(events.length)
    .map(({ type, idempotencyKey, payload }) => ({ type, idempotencyKey, payload }));
}

/** The processor over `attempt`, its contract at `version`. The one call that its rows make on the
 *  context is the lifecycle's certificate on `/` (`cd("/").append`): a stand-in for that one call
 *  is no whole scope, so it is cast. */
function processorOver(
  attempt: DeploymentRunDeps["attempt"] = () => Promise.reject(new Error("no attempt here")),
  version = DeploymentContract.version,
) {
  const itx = { cd: () => ({ append: async () => [] }), [Symbol.dispose]: () => undefined };
  return new DeploymentProcessor(
    { ...DeploymentContract, version },
    () => itx as unknown as ItxEntrypointScope & Disposable,
    () => PATH,
    {},
    { attempt },
  );
}

/** The open run of the plan that `requested("plan")` asks for, requested at `requestOffset`. */
function openRun(requestOffset: number, fields: Partial<DeploymentRun> = {}): DeploymentRun {
  return {
    requestOffset,
    request: DeploymentRunRequested.parse(requested("plan").payload),
    attempt: 0,
    step: "requested",
    stepOffset: requestOffset,
    ...fields,
  };
}

function requested(kind: "plan" | "deploy" | "destroy") {
  const release = { file: `/releases/${SHA256}.zip`, sha256: SHA256 };
  const run = { release, images: {} };
  return {
    type: "events.iterate.com/deployment/run-requested",
    payload: kind === "destroy" ? { kind, ...target } : { kind, ...target, ...run },
  };
}

function started(requestOffset: number, attempt: number, retrying?: string) {
  return {
    type: "events.iterate.com/deployment/attempt-started",
    idempotencyKey: `deployment/attempt-started:${requestOffset}:${attempt}`,
    payload: retrying ? { requestOffset, attempt, retrying } : { requestOffset, attempt },
  };
}

function staged(requestOffset: number, attempt: number) {
  return {
    type: "events.iterate.com/deployment/release-staged",
    idempotencyKey: `deployment/release-staged:${requestOffset}:${attempt}`,
    payload: { ...STAGED, requestOffset, attempt },
  };
}

/** A resource's fact: its key also names the resource and its status. */
function applied(requestOffset: number, attempt: number) {
  return {
    type: "events.iterate.com/deployment/resource-applied",
    idempotencyKey: `deployment/resource-applied:${requestOffset}:${attempt}:worker:created`,
    payload: { ...APPLIED, requestOffset, attempt },
  };
}

function runSettled(requestOffset: number, status: string, attempts: number, fields: object = {}) {
  return {
    type: "events.iterate.com/deployment/run-settled",
    idempotencyKey: `deployment/run-settled:${requestOffset}`,
    payload: { requestOffset, status, attempts, ...fields },
  };
}

/** The settlement of an attempt that succeeded with the Worker's URL. */
function settledWithUrl(requestOffset: number, attempts: number) {
  return runSettled(requestOffset, "succeeded", attempts, { url: WORKER_URL });
}
