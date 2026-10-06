// agent-input.test.ts — words other contexts put in an agent's log (message.ts): what `message()`
// appends, and THE GATE (the loop holds words another agent sent until the project's gate says
// whether they wake it).
import { expect, test, vi } from "vitest";
import type { StreamEvent } from "../stream/processor.ts";
import { messagePayload, type AgentInputGate } from "./message.ts";
import { AgentProcessor } from "./processor.ts";

test("message(text, { trigger: false }) is context only; the default is a trigger", () => {
  expect(messagePayload({ message: "FYI", files: [], from: CHIEF, trigger: false })).toEqual({
    role: "user",
    content: "FYI",
    actor: { type: "user" },
    from: CHIEF,
    llmRequestPolicy: { behaviour: "dont-trigger-request" },
  });
  expect(messagePayload({ message: "Alex asks…", files: [], from: CHIEF, trigger: true })).toEqual({
    role: "user",
    content: "Alex asks…",
    actor: { type: "user" },
    from: CHIEF,
  });
});

test("words another agent sent wait for the gate, by message() or by a raw append; a person's never do", async () => {
  const log = agentLog();
  await log.born();
  // by message(): the facet appends, so the origin is the agent and the sender rides as `from`
  await log.commit(
    contextAdded(
      messagePayload({ message: "FYI parcel", files: [], from: CHIEF, trigger: true }),
      FAMILY,
    ),
  );
  expect(log.state.pendingLlmRequestTrigger).toMatchObject({ offset: 3, gate: { waiting: [3] } });
  // by a raw append from the chief: waits too, beside the first
  await log.commit(contextAdded({ role: "user", content: "FYI receipt" }, CHIEF));
  expect(log.state.pendingLlmRequestTrigger).toMatchObject({
    offset: 4,
    gate: { waiting: [3, 4] },
  });
  // a person's words: a turn is owed, nothing waits any more
  await log.commit(
    contextAdded({ role: "user", actor: { type: "user" }, content: "Sam: hi" }, "/"),
  );
  expect(log.state).toMatchObject({ pendingLlmRequestTrigger: { offset: 5, source: "external" } });
  expect(log.state.pendingLlmRequestTrigger?.gate).toBeUndefined();
  // and an agent's words after a person's do not wait either
  await log.commit(
    contextAdded({ role: "user", content: "Done: the flights Alex asked for" }, CHIEF),
  );
  expect(log.state.pendingLlmRequestTrigger?.gate).toBeUndefined();
});

test("input-gated: a wake lets the trigger go on, a hold drops it with the last waiting input", async () => {
  const log = agentLog();
  await log.born();
  await log.commit(contextAdded({ role: "user", content: "FYI one" }, CHIEF));
  await log.commit(contextAdded({ role: "user", content: "FYI two" }, CHIEF));
  await log.commit(gated(3, false));
  expect(log.state.pendingLlmRequestTrigger).toMatchObject({ offset: 4, gate: { waiting: [4] } });
  await log.commit(gated(3, true)); // a decision for an input no longer waiting: a harmless fact
  expect(log.state.pendingLlmRequestTrigger).toMatchObject({ gate: { waiting: [4] } });
  await log.commit(gated(4, false));
  expect(log.state.pendingLlmRequestTrigger).toBeNull();
  expect(
    log.state.contextItems.filter((item) => item.from === CHIEF).map((item) => item.content),
  ).toEqual(["FYI one", "FYI two"]);
  await log.commit(
    contextAdded({ role: "user", content: "Alex asks: is the gallery done?" }, CHIEF),
  );
  await log.commit(gated(8, true));
  expect(log.state).toMatchObject({ pendingLlmRequestTrigger: { offset: 8, source: "external" } });
  expect(log.state.pendingLlmRequestTrigger?.gate).toBeUndefined();
});

test("at head, the gate is asked once per waiting input and its decision appended; no request opens before it", async () => {
  const decide = vi.fn<AgentInputGate["decide"]>(async ({ content }) => ({
    wake: content.startsWith("Done"),
    decision: { decision: content.startsWith("Done") ? "NOW" : "LATER" },
  }));
  const log = agentLog({ applies: () => true, decide });
  await log.born();
  const context = { llmRequestPolicy: { behaviour: "dont-trigger-request" } };
  await log.commit(
    contextAdded({ role: "user", content: "[monzo] £3 at Greggs", ...context }, "/"),
  );
  await log.commit(contextAdded({ role: "user", content: "FYI earlier", ...context }, CHIEF));
  const appended = await log.commit(contextAdded({ role: "user", content: "FYI parcel" }, CHIEF));
  expect(decide).toHaveBeenCalledTimes(1);
  expect(decide.mock.calls[0]![0]).toMatchObject({
    path: FAMILY,
    from: CHIEF,
    offset: 5,
    content: "FYI parcel",
    recent: ["[monzo] £3 at Greggs", `[from ${CHIEF}] FYI earlier`],
  });
  expect(appended.map((row) => [row.type, row.payload])).toEqual([
    [
      "events.iterate.com/agent/input-gated",
      { inputOffset: 5, wake: false, decision: { decision: "LATER" } },
    ],
  ]);
  // a pass over the same state asks nothing again while the first answer is out (here: answered)
  expect(log.state.pendingLlmRequestTrigger).toMatchObject({ gate: { waiting: [5] } });
});

test("at head, with no gate or a sender it does not apply to, words from an agent wake it as before", async () => {
  for (const gate of [
    undefined,
    { applies: () => false, decide: vi.fn<AgentInputGate["decide"]>() },
  ]) {
    const log = agentLog(gate);
    await log.born();
    const appended = await log.commit(contextAdded({ role: "user", content: "FYI parcel" }, CHIEF));
    expect(appended.map((row) => row.type)).toEqual([
      "events.iterate.com/agent/llm-request-requested",
    ]);
    if (gate) expect(gate.decide).not.toHaveBeenCalled();
  }
});

test("a gate that throws wakes the agent", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const log = agentLog({
    applies: () => true,
    decide: async () => {
      throw new Error("model down");
    },
  });
  await log.born();
  const appended = await log.commit(contextAdded({ role: "user", content: "FYI parcel" }, CHIEF));
  expect(appended).toEqual([
    {
      type: "events.iterate.com/agent/input-gated",
      idempotencyKey: expect.any(String),
      payload: { inputOffset: 3, wake: true, decision: { error: "Error: model down" } },
    },
  ]);
});

const FAMILY = "/agents/family-chief-of-staff";
const CHIEF = "/agents/chief-of-staff";

type Row = {
  type: string;
  payload?: Record<string, unknown>;
  source?: Record<string, unknown>;
  idempotencyKey?: string;
};

function contextAdded(payload: Record<string, unknown>, origin: string): Row {
  return { type: "events.iterate.com/agent/context-added", payload, source: { origin } };
}

function gated(inputOffset: number, wake: boolean): Row {
  return { type: "events.iterate.com/agent/input-gated", payload: { inputOffset, wake } };
}

/** The engine, small: each row is committed at the next offset, validated and reduced, then handed
 *  to processEvent at head (unless `head: false`); what it appends in the background is RETURNED,
 *  never committed, so a test sees the loop's next step without the model running. */
function agentLog(gate?: AgentInputGate) {
  const processor = new AgentProcessor({
    getItx: () => {
      throw new Error("this test reaches no itx");
    },
    now: () => Date.parse("2026-10-03T21:00:00Z"),
    sleep: () => Promise.resolve(),
    messageGate: () => gate,
  });
  const events: StreamEvent[] = [];
  let state = processor.contract.initialState();
  const commit = async (row: Row, { head = true }: { head?: boolean } = {}): Promise<Row[]> => {
    const parsed = processor.contract.payloadSchemaFor(row.type)?.safeParse(row.payload || {});
    if (parsed && !parsed.success) throw parsed.error;
    const offset = events.length + 1;
    const event = {
      type: row.type,
      payload: parsed ? parsed.data : row.payload,
      offset,
      createdAt: new Date(Date.parse("2026-10-03T21:00:00Z") + offset * 100).toISOString(),
      path: FAMILY,
      source: { origin: FAMILY, ...row.source },
    } as StreamEvent;
    events.push(event);
    const previousState = state;
    state = processor.reduce({ event, state } as never) ?? state;
    const appended: Row[] = [];
    const background: Array<() => Promise<unknown>> = [];
    processor.processEvent({
      event,
      state,
      previousState,
      append: async (...rows: Row[]) => {
        appended.push(...rows);
        return [];
      },
      blockProcessorWhile: (work: () => Promise<unknown>) => background.push(work),
      runInBackground: (work: () => Promise<unknown>) => background.push(work),
      delivery: { caughtUp: head },
    } as never);
    for (const work of background) await work();
    return appended;
  };
  return {
    commit,
    born: async () => {
      await commit(
        { type: "events.iterate.com/agent/create-requested", payload: {} },
        { head: false },
      );
      await commit(
        { type: "events.iterate.com/agent/created", payload: { path: FAMILY } },
        { head: false },
      );
    },
    get state() {
      return state;
    },
  };
}
