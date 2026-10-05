// answer-owed.test.ts — THE ANSWER OWED: coverage for processor.ts `answerOwedFor` and the reminder
// its itx/run-settled handler gives. The fixture is a scheduled digest whose second script only
// updates its notes and returns nothing.
import { expect, test } from "vitest";
import type { StreamEvent } from "../stream/processor.ts";
import { answerOwedFor, AgentProcessor } from "./processor.ts";
import { answerText, buildResponsesInput, type RenderItem } from "./render.ts";

const PATH = "/agents/chief-of-staff";
/** Where the agent's own scripts append from: its own context. */
const SCRIPTS = PATH;
const AGENT_LOOP = { processor: { slug: "agent", version: "13" } };

/** The chief's evening digest, as its schedule delivers it: set by the agent's own script. */
const DIGEST_JOB =
  "[scheduled digest evening] Read the digest files, re-arm this slot for tomorrow, then deliver the digest.";

// the two scripts of the turn, in the shape the model wrote them (the second has no `return`)
const RE_ARM_AND_READ = `await itx.cd('/agents/chief-of-staff').schedules.set({key:'digest-evening',when:{at:'2026-10-04T17:00:00Z'},events:[{type:'events.iterate.com/agent/context-added',payload:{role:'user',actor:{type:'user'},content:${JSON.stringify(DIGEST_JOB)}}}]});return await Promise.all(['/agents/chief-of-staff/digest/to-discuss.md','/agents/chief-of-staff/digest/discussed.md'].map(async path=>({path,text:new TextDecoder().decode(await itx.files.get(path).bytes())})));`;
const UPDATE_NOTES = `const rows=await results[0].load();const p=rows[0].path;let t=rows[0].text;
t += '\\n- 2026-10-03 18:00 evening digest prepared: the boiler service visit and the newsletter clean-up remain open; sending the digest is NOT approval or resolution.\\n';
await itx.files.get(p).put({contentType:'text/markdown',data:new TextEncoder().encode(t)});`;
const FILES = [
  {
    path: "/agents/chief-of-staff/digest/to-discuss.md",
    text: "# To discuss\n\n## Needs Alex's input\n- Boiler service: Robin proposes Wednesday 14 Oct 10:30.",
  },
  { path: "/agents/chief-of-staff/digest/discussed.md", text: "# Discussed\n" },
];
const DIGEST =
  "Evening digest, sir.\n\n*Decisions still open*\n• Robin, the boiler engineer, proposes Wednesday 14 October at 10:30. Does that suit?";

test("the evening digest that ended on a script returning nothing is reminded once, and its digest goes out", async () => {
  const log = agentLog();
  await born(log);
  const fired = await digestJobFires(log);
  expect(log.state).toMatchObject({
    owedAnswer: {
      offset: fired.offset,
      why: 'the scheduled job "digest-evening"',
      reminded: false,
    },
  });

  // step 1: re-arm the slot and read the files (a value comes back, so the turn goes on)
  await step(log, { script: RE_ARM_AND_READ });
  await scriptSettles(log, FILES);
  expect(notes(log.events).at(-1)!.payload.llmRequestPolicy).toBeUndefined();

  // step 2, the live failure: only the notes are updated, no words, and the script returns nothing
  await step(log, { script: UPDATE_NOTES });
  const mark = log.events.length;
  const settled = await scriptSettles(log);

  // the owed answer is reminded: one event that says so, and a note that starts one more request
  const consequences = log.after(mark);
  expect(types(consequences)).toEqual([
    "itx/run-settled",
    "agent/answer-reminded",
    "agent/context-added",
  ]);
  expect(consequences[1]!).toMatchObject({
    payload: {
      inputOffset: fired.offset,
      runRequestOffset: (settled.payload as { requestOffset: number }).requestOffset,
      why: 'the scheduled job "digest-evening"',
    },
  });
  const note = notes(consequences)[0]!;
  expect(note.payload.llmRequestPolicy).toBeUndefined();
  expect(note.payload.content).toMatch(
    /^Your script finished and returned nothing \(in [^)]+\)\. That would end your turn, but nothing has been said yet for the scheduled job "digest-evening" @\d+, which expects an answer/,
  );
  expect(log.state.pendingLlmRequestTrigger).toMatchObject({
    offset: note.offset,
    source: "agent-loop",
  });
  expect(log.state.owedAnswer?.reminded).toBe(true);

  // the reminder is the call's own output, so the request after it still extends the cached prefix
  const input = buildResponsesInput({
    items: log.state.contextItems as RenderItem[],
    images: new Map(),
    runs: log.state.runs,
    model: "gpt-6.1-sol",
    ownPath: PATH,
  });
  expect(input.at(-1)).toMatchObject({
    type: "function_call_output",
    output: note.payload.content,
  });

  // step 3: the model writes the digest as its final message, which the relay sends to the person
  const last = log.events.length;
  await step(log, { prose: DIGEST });
  const sent = log
    .after(last)
    .filter((event) => event.type === "events.iterate.com/agent/web-message-sent");
  expect(sent.map((event) => event.payload)).toEqual([
    { message: DIGEST, llmRequestOffset: expect.any(Number) },
  ]);
  expect(log.state.owedAnswer).toBeNull();
  expect(log.state.pendingLlmRequestTrigger).toBeNull();
});

test("the reminder comes once: a second script that returns nothing ends the turn", async () => {
  const log = agentLog();
  await born(log);
  await digestJobFires(log);
  await step(log, { script: UPDATE_NOTES });
  await scriptSettles(log);
  expect(log.state.owedAnswer?.reminded).toBe(true);

  await step(log, { script: UPDATE_NOTES });
  const mark = log.events.length;
  await scriptSettles(log);
  expect(types(log.after(mark))).toEqual(["itx/run-settled", "agent/context-added"]);
  expect(notes(log.after(mark))[0]!.payload).toMatchObject({
    content: expect.stringMatching(/^Your script finished and returned nothing \(in [^)]+\)\.$/),
    llmRequestPolicy: { behaviour: "dont-trigger-request" },
  });
  expect(log.state.pendingLlmRequestTrigger).toBeNull();
  expect(log.state.owedAnswer).toBeNull();
});

test("the model's own silence is an answer: an empty response ends a scheduled turn with no reminder", async () => {
  const log = agentLog();
  await born(log);
  await digestJobFires(log);
  await step(log, { script: RE_ARM_AND_READ });
  await scriptSettles(log, FILES);
  await step(log, {}); // nothing to say
  expect(log.state.owedAnswer).toBeNull();
  expect(log.state.pendingLlmRequestTrigger).toBeNull();
  expect(types(log.events)).not.toContain("agent/answer-reminded");
});

test("a scheduled turn that answered in words is not reminded at its next silent turn", async () => {
  const log = agentLog();
  await born(log);
  await digestJobFires(log);
  await step(log, { prose: DIGEST });
  expect(log.state.owedAnswer).toBeNull();

  await input(log, "[gmail received · personal · id 1] Parcel Co: Out for delivery");
  await step(log, { script: "await itx.kv.put('seen', '1');" });
  await scriptSettles(log);
  expect(types(log.events)).not.toContain("agent/answer-reminded");
  expect(log.state.pendingLlmRequestTrigger).toBeNull();
});

test("turns that may end in silence get no extra request: mail, the project code's reviews, an opted-out job", async () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
    ["[gmail received · personal · id 1] Parcel Co: Out for delivery", { origin: "/" }],
    [
      "[whatsapp personal · review] New messages on Alex's personal WhatsApp are above.",
      {
        origin: "/",
        schedule: {
          key: "whatsapp-personal-review",
          scheduledAtOffset: 2,
          at: "2026-10-03T17:05:34.586Z",
        },
      },
    ],
    [
      "[scheduled check] See whether Robin replied.",
      {
        origin: SCRIPTS,
        schedule: { key: "robin-check", scheduledAtOffset: 2, at: "2026-10-03T17:00:00.000Z" },
      },
      { answerOwed: false },
    ],
  ];
  for (const [content, source, extra] of cases) {
    const log = agentLog();
    await born(log);
    await input(log, content, source, extra);
    expect(log.state.owedAnswer).toBeNull();
    await step(log, {
      script: "await itx.agents.get('/agents/family-chief-of-staff').message('FYI');",
    });
    await scriptSettles(log);
    expect(types(log.events)).not.toContain("agent/answer-reminded");
    expect(notes(log.events).at(-1)!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
    expect(log.state.pendingLlmRequestTrigger).toBeNull();
  }
});

test("words marked answerOwed (a person's request) are owed like a scheduled job", async () => {
  const log = agentLog();
  await born(log);
  const asked = await input(
    log,
    "[whatsapp · Alex · #85] Was there any mention of a spare part in the boiler engineer's emails?",
    { origin: "/" },
    { answerOwed: true },
  );
  expect(log.state).toMatchObject({
    owedAnswer: { offset: asked.offset, why: "the message", reminded: false },
  });
  await step(log, {
    prose: "Checking the boiler thread now.",
    script:
      "await itx.files.get('/agents/chief-of-staff/digest/to-discuss.md').put({ contentType: 'text/markdown', data: new Uint8Array() });",
  });
  await scriptSettles(log);
  // the words beside the call were held back by the relay: the reminder still comes
  expect(types(log.events)).toContain("agent/answer-reminded");
  expect(notes(log.events).at(-1)!.payload.content).toContain("for the message @");
});

test("a turn that goes on anyway is not reminded: a person's new words wait for the script", async () => {
  const log = agentLog();
  await born(log);
  const fired = await digestJobFires(log);
  await step(log, { script: UPDATE_NOTES });
  await input(log, "[whatsapp · Alex · #11] Also, any word from Robin?"); // arrives while it runs
  await scriptSettles(log);
  expect(types(log.events)).not.toContain("agent/answer-reminded");
  expect(notes(log.events).at(-1)!.payload).toMatchObject({
    llmRequestPolicy: { behaviour: "dont-trigger-request" },
  });
  // still owed, unreminded: the next turn may still answer it, and is reminded if it ends silent
  expect(log.state).toMatchObject({
    owedAnswer: {
      offset: fired.offset,
      why: 'the scheduled job "digest-evening"',
      reminded: false,
    },
  });
  await step(log, { script: UPDATE_NOTES });
  await scriptSettles(log);
  expect(types(log.events)).toContain("agent/answer-reminded");
});

test("answerOwedFor: a job a script scheduled, or words marked so; never the project code's schedules unless marked", () => {
  const schedule = { key: "digest-morning", scheduledAtOffset: 1, at: "2026-10-03T08:00:00.000Z" };
  expect(answerOwedFor({ payload: {}, source: { origin: SCRIPTS, schedule } })).toBe(
    'the scheduled job "digest-morning"',
  );
  expect(
    answerOwedFor({
      payload: {},
      source: { origin: "/agents/family-chief-of-staff", schedule },
    }),
  ).toBe('the scheduled job "digest-morning"');
  expect(answerOwedFor({ payload: {}, source: { origin: "/", schedule } })).toBeNull();
  expect(answerOwedFor({ payload: { answerOwed: true }, source: { origin: "/", schedule } })).toBe(
    'the scheduled job "digest-morning"',
  );
  expect(
    answerOwedFor({ payload: { answerOwed: false }, source: { origin: SCRIPTS, schedule } }),
  ).toBeNull();
  expect(answerOwedFor({ payload: {}, source: { origin: "/" } })).toBeNull();
  expect(answerOwedFor({ payload: { answerOwed: true }, source: { origin: "/" } })).toBe(
    "the message",
  );
});

type Row = {
  type: string;
  payload?: Record<string, unknown>;
  source?: Record<string, unknown>;
  idempotencyKey?: string;
};

/** The engine, small: each event is committed at the next offset, validated against the contract
 *  and reduced, then handed to processEvent, whose blocked consequences are committed after it, in
 *  order, as the processor's own. Nothing runs at head (`caughtUp: false`), so no model is called:
 *  the test plays the model's part. */
function agentLog() {
  const processor = new AgentProcessor({
    getItx: () => {
      throw new Error("this test reaches no itx");
    },
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  const events: StreamEvent[] = [];
  let state = processor.contract.initialState();
  const commit = async (row: Row): Promise<StreamEvent> => {
    const parsed = processor.contract.payloadSchemaFor(row.type)?.safeParse(row.payload || {});
    if (parsed && !parsed.success) throw parsed.error;
    const offset = events.length + 1;
    const event = {
      type: row.type,
      payload: parsed ? parsed.data : row.payload,
      offset,
      createdAt: new Date(Date.parse("2026-10-03T17:00:00Z") + offset * 100).toISOString(),
      path: PATH,
      source: { origin: PATH, ...row.source },
      idempotencyKey: row.idempotencyKey,
    } as StreamEvent;
    events.push(event);
    const previousState = state;
    state = processor.reduce({ event, state } as never) ?? state;
    const emitted: Row[] = [];
    const blocked: Array<() => Promise<unknown>> = [];
    processor.processEvent({
      event,
      state,
      previousState,
      append: async (...rows: Row[]) => {
        emitted.push(...rows.map((emittedRow) => ({ ...emittedRow, source: AGENT_LOOP })));
        return [];
      },
      blockProcessorWhile: (work: () => Promise<unknown>) => blocked.push(work),
      runInBackground: () => undefined,
      delivery: { caughtUp: false },
    } as never);
    for (const work of blocked) await work();
    for (const emittedRow of emitted) await commit(emittedRow);
    return event;
  };
  return {
    events,
    commit,
    after: (offset: number) => events.filter((event) => event.offset > offset),
    get state() {
      return state;
    },
  };
}

type Log = ReturnType<typeof agentLog>;

const born = async (log: Log) => {
  await log.commit({ type: "events.iterate.com/agent/create-requested", payload: {} });
  await log.commit({ type: "events.iterate.com/agent/created", payload: { path: PATH } });
};

/** Words into the agent, from `source` (a person's, the project code's, a schedule's). */
const input = (
  log: Log,
  content: string,
  source: Record<string, unknown> = { origin: "/" },
  extra = {},
) =>
  log.commit({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "user", actor: { type: "user" }, content, ...extra },
    source,
  });

const digestJobFires = (log: Log) =>
  input(log, DIGEST_JOB, {
    origin: SCRIPTS,
    schedule: { key: "digest-evening", scheduledAtOffset: 3, at: "2026-10-03T17:00:00.000Z" },
  });

/** One model step for the pending trigger: the intent, then the answer the model wrote (prose,
 *  a call, both, or neither), settled as the loop settles it. */
async function step(log: Log, answer: { prose?: string; script?: string }) {
  const trigger = log.state.pendingLlmRequestTrigger;
  if (!trigger) throw new Error("no request is due: the turn has ended");
  const request = await log.commit({
    type: "events.iterate.com/agent/llm-request-requested",
    payload: { model: "gpt-6.1-sol", expiresAt: 9e15, triggerOffset: trigger.offset },
    source: AGENT_LOOP,
  });
  const prose = answer.prose || "";
  const call = answer.script
    ? { callId: `call_${String(request.offset)}`, status: "Working", script: answer.script }
    : undefined;
  const text = answerText(prose, call);
  await log.commit({
    type: "events.iterate.com/agent/llm-request-settled",
    payload: { requestOffset: request.offset, result: { status: "succeeded", text } },
    source: AGENT_LOOP,
  });
  if (!text) return request; // an empty answer adds no assistant message: nothing was said
  await log.commit({
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "assistant",
      content: text,
      llmRequestOffset: request.offset,
      call,
      providerItems: [
        ...(prose
          ? [
              {
                type: "message",
                id: `msg_${String(request.offset)}`,
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: prose, annotations: [] }],
              },
            ]
          : []),
        ...(call
          ? [
              {
                type: "function_call",
                id: `fc_${String(request.offset)}`,
                call_id: call.callId,
                name: "run",
                arguments: JSON.stringify({ status: call.status, script: call.script }),
                status: "completed",
              },
            ]
          : []),
      ],
      providerModel: "gpt-6.1-sol",
    },
    source: AGENT_LOOP,
  });
  return request;
}

/** The context settles the newest run this loop asked for: with a value, or with nothing. */
async function scriptSettles(log: Log, result?: unknown) {
  const run = log.events.findLast((event) => event.type === "events.iterate.com/itx/run-requested");
  if (!run) throw new Error("no run was requested");
  return log.commit({
    type: "events.iterate.com/itx/run-settled",
    payload: {
      requestOffset: run.offset,
      settlement: result === undefined ? { status: "succeeded" } : { status: "succeeded", result },
    },
  });
}

const types = (events: StreamEvent[]) =>
  events.map((event) => event.type.replace("events.iterate.com/", ""));
const notes = (events: StreamEvent[]) =>
  events.filter(
    (event) =>
      event.type === "events.iterate.com/agent/context-added" &&
      (event.payload as { actor?: { type: string } }).actor?.type === "script",
  ) as Array<
    StreamEvent & { payload: { content: string; llmRequestPolicy?: { behaviour: string } } }
  >;
