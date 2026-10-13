// model-turn.test.ts — one model turn against a fake `itx`: the request the loop sends, the first
// response frame, and the usage it settles with, priced at the standard tier only; and each answer's
// idle budget, with the key stack's fallback, on a fake clock. The whole loop on the worker is
// test/vitest/agents/ (e2e) and agents-workers/ (an eviction mid-call).
import { expect, test, vi } from "vitest";
import type { StreamEvent } from "../stream/processor.ts";
import { type AgentConfigPatch, AgentProcessor } from "./processor.ts";

const PATH = "/agents/a";
const AT = Date.parse("2026-10-10T12:00:00Z");

test.for([
  { tier: undefined, priced: true },
  { tier: "default", priced: true },
  { tier: "priority", priced: false },
])(
  "a turn asks the model with its cache key, shows its first words at once, and settles priced at the standard tier only (served: $tier)",
  async ({ tier, priced }) => {
    const { turn, sent, sleeps } = agentWithModel({ servedTier: tier });
    const appended = await turn("What is the answer?");
    expect(sent).toMatchObject([{ prompt_cache_key: PATH, stream: true }]);
    // the debounce after a person's words, then the first frame's window at once, the next 150 ms
    expect(sleeps).toEqual([250, 0, 150]);
    const settled = appended.find(
      (row) => row.type === "events.iterate.com/agent/llm-request-settled",
    );
    expect(settled?.payload).toMatchObject({
      result: {
        status: "succeeded",
        text: "forty-two",
        usage: { inputTokens: 1_000, outputTokens: 4 },
      },
    });
    const { usage } = (settled!.payload as { result: { usage: { costUsd?: number } } }).result;
    expect(usage.costUsd !== undefined).toBe(priced);
  },
);

test("an agent's service tier is asked for, and an unset one is not sent", async () => {
  for (const serviceTier of ["priority", undefined]) {
    const { turn, sent } = agentWithModel({ serviceTier });
    await turn("hi");
    expect(sent[0]?.service_tier).toBe(serviceTier);
    // on the wire an unset tier is no field at all
    expect(JSON.stringify(sent[0]).includes('"service_tier"')).toBe(Boolean(serviceTier));
  }
});

// ── each answer's idle budget, and the key stack's fallback, on a fake clock ──

test("an answer that thinks for 30 s without a byte, past the 25 s the loop once allowed, completes inside the default 60 s", async () => {
  using _clock = fakeClock();
  let streams = 0;
  const { turn } = agentWithModel({
    model: () => {
      streams += 1;
      return sse([{ type: "response.created" }, 30_000, ...answered("forty-two")]);
    },
  });
  const turning = turn("What is the answer?");
  await until(() => streams === 1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(settledOf(await turning)).toMatchObject({
    result: { status: "succeeded", text: "forty-two" },
  });
  expect(streams).toBe(1);
});

test("an answer silent past its budget fails, and with one credential the request settles failed", async () => {
  using _clock = fakeClock();
  let streams = 0;
  const { turn } = agentWithModel({
    model: () => {
      streams += 1;
      return sse([{ type: "response.created" }, STALL]);
    },
  });
  const turning = turn("What is the answer?");
  await until(() => streams === 1);
  await vi.advanceTimersByTimeAsync(59_999);
  await vi.advanceTimersByTimeAsync(1);
  expect(settledOf(await turning)).toMatchObject({
    result: { status: "failed", errorMessage: "the model stream stalled: nothing for 60 s" },
  });
});

test("the first key's answer stalls part way: the next key answers once the configured budget ends, and nothing of the stalled answer is kept or shown with it", async () => {
  using _clock = fakeClock();
  const model = openAi(
    () =>
      sse([
        { type: "response.created" },
        { type: "response.output_text.delta", delta: "Half an ans" },
        {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "call_stalled", name: "run", arguments: "{}" },
        },
        STALL,
      ]),
    () => sse([{ type: "response.created" }, ...answered("Counting now.", "call_backup")]),
  );
  const { turn } = agentWithModel({
    config: { llm: { apiKeys: KEYS, streamIdleTimeoutMs: 120_000 } },
    fetch: model.fetch,
  });
  const turning = turn("Count.");
  await until(() => model.posts.length === 1);
  await vi.advanceTimersByTimeAsync(119_999);
  expect(model.posts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  const rows = await turning;
  expect(model).toMatchObject({ posts: KEYS.map((key) => `Bearer ${key}`) });
  const text = '<codemode status="Counting">\nasync () => 42\n</codemode>';
  // the settlement says which key failed, and why
  expect(settledOf(rows)).toMatchObject({
    failedKeys: [{ key: 1, error: "Error: the model stream stalled: nothing for 120 s" }],
    result: { status: "succeeded", text: expect.stringContaining("Counting now.") },
  });
  const assistant = rows.find(
    (row) =>
      row.type === "events.iterate.com/agent/context-added" &&
      (row.payload as { role: string }).role === "assistant",
  )?.payload;
  expect(assistant).toMatchObject({
    role: "assistant",
    call: { callId: "call_backup", status: "Counting", script: "async () => 42" },
  });
  const { content, providerItems } = assistant as { content: string; providerItems: unknown[] };
  expect(content).toContain(text);
  expect(content).not.toContain("Half");
  expect(JSON.stringify(providerItems)).not.toContain("call_stalled");
  // the feed's windows: the stalled answer's, then the backup's, numbered so a feed starts over
  expect(framesOf(rows)).toEqual([
    expect.objectContaining({ responseDelta: "Half an ans", sequence: 0 }),
    expect.objectContaining({ responseDelta: "Counting now.", attempt: 1 }),
  ]);
  expect(framesOf(rows)[0]).not.toHaveProperty("attempt");
});

test("a stalled answer whose cancellation rejects its pending read, as workerd's own streams do, is recorded as stalled", async () => {
  using _clock = fakeClock();
  const model = openAi(
    () => bodyRejectedByCancel([{ type: "response.created" }]),
    () => sse([{ type: "response.created" }, ...answered("forty-two")]),
  );
  const { turn } = agentWithModel({ config: { llm: { apiKeys: KEYS } }, fetch: model.fetch });
  const turning = turn("What is the answer?");
  await until(() => model.posts.length === 1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settledOf(await turning)).toMatchObject({
    failedKeys: [{ key: 1, error: "Error: the model stream stalled: nothing for 60 s" }],
    result: { status: "succeeded", text: "forty-two" },
  });
});

test("a key whose stream ends before its response does hands the request to the next key", async () => {
  const model = openAi(
    () => sse([{ type: "response.created" }, { type: "response.output_text.delta", delta: "Hal" }]),
    () => sse([{ type: "response.created" }, ...answered("forty-two")]),
  );
  const { turn } = agentWithModel({ config: { llm: { apiKeys: KEYS } }, fetch: model.fetch });
  expect(settledOf(await turn("What is the answer?"))).toMatchObject({
    failedKeys: [{ key: 1, error: "Error: openai: the stream ended before the response did" }],
    result: { status: "succeeded", text: "forty-two" },
  });
  expect(model.posts).toHaveLength(2);
});

test("the person's next words during the first key's answer end the turn: the next key is never sent, and the partial kept is that answer's", async () => {
  using _clock = fakeClock();
  const model = openAi(
    () =>
      sse([
        { type: "response.created" },
        { type: "response.output_text.delta", delta: "Half" },
        STALL,
      ]),
    () => sse(answered("never sent")),
  );
  const { turn, commit } = agentWithModel({
    config: { llm: { apiKeys: KEYS } },
    fetch: model.fetch,
  });
  const turning = turn("Count.");
  await until(() => model.posts.length === 1);
  await vi.advanceTimersByTimeAsync(1_000);
  const interrupted = await commit({
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "user",
      content: "Stop.",
      actor: { type: "user" },
      llmRequestPolicy: { behaviour: "interrupt-current-request" },
    },
  });
  await turning;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(model.posts).toHaveLength(1);
  expect(settledOf(interrupted)).toMatchObject({
    result: { status: "cancelled", reason: "interrupted-by-user-input", partialText: "Half" },
  });
});

test("the request's expiry during the first key's silence ends the turn: the next key is never sent", async () => {
  using _clock = fakeClock();
  const model = openAi(
    () => sse([{ type: "response.created" }, STALL]),
    () => sse(answered("never sent")),
  );
  const { turn } = agentWithModel({
    config: { llm: { apiKeys: KEYS }, llmRequestExpiryMs: 30_000 },
    fetch: model.fetch,
  });
  const turning = turn("Count.");
  await until(() => model.posts.length === 1);
  await vi.advanceTimersByTimeAsync(30_000);
  const settled = settledOf(await turning);
  expect(settled).toMatchObject({
    result: {
      status: "failed",
      errorMessage: "the model did not finish before the request expired",
    },
  });
  // the turn's own end is no key's failure
  expect(settled).not.toHaveProperty("failedKeys");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(model.posts).toHaveLength(1);
});

test("a conversation that already holds half an emoji, in a person's words and in a replayed answer, keeps answering: the model reads U+FFFD, the conversation keeps what was stored, and the repair is counted without its text", async () => {
  using info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const bodies: string[] = [];
  const { turn, state } = agentWithModel({
    config: { llm: { apiKeys: KEYS } },
    fetch: async (request) => {
      if (request.headers.get("upgrade") === "websocket")
        return new Response(null, { status: 426 });
      bodies.push(await request.text());
      return sse([{ type: "response.created" }, ...answered("Noted.")]);
    },
  });
  // stored before this turn, as a `slice` left them: a high surrogate with no low one after it
  const cut = "Party 🎉 and a cut \uD83C";
  const replayed = "Counted \uDF89";
  const history: Row[] = [
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", content: cut, actor: { type: "user" } },
    },
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "assistant",
        content: replayed,
        llmRequestOffset: 4,
        providerItems: [{ type: "message", content: [{ type: "output_text", text: replayed }] }],
        providerModel: "gpt-6.1-sol",
      },
    },
  ];
  expect(settledOf(await turn("And now?", history))).toMatchObject({
    repairedStrings: 2,
    result: { status: "succeeded", text: "Noted." },
  });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain("Party 🎉 and a cut \uFFFD");
  expect(bodies[0]).toContain("Counted \uFFFD");
  // JSON.stringify's escape of a lone surrogate, which OpenAI refuses
  expect(bodies[0]).not.toMatch(/\\ud[89a-f]/i);
  expect(state()).toMatchObject({
    contextItems: expect.arrayContaining([
      expect.objectContaining({ role: "user", content: cut }),
      expect.objectContaining({ role: "assistant", content: replayed }),
    ]),
  });
  expect(info.mock).toMatchObject({
    calls: [[{ event: "agent.request-strings-repaired", strings: 2 }]],
  });
});

type Row = { type: string; payload?: unknown };

/** An agent whose `itx` answers the few things a turn asks: who it is, its config repo (an
 *  AGENTS.md), its capability tree (none), and the model, which streams "forty-two" in two deltas
 *  and completes with usage and `servedTier` (or answers `model`'s Response). `config` is appended
 *  once it is born, and `fetch` is the isolate's, which `llm.apiKeys` sends through. `turn` commits
 *  a person's words and every intent the loop asks for, at head, and answers what the loop appended;
 *  `commit` commits one more event the same way, and `history` is committed before the words. */
function agentWithModel(options: {
  servedTier?: string;
  serviceTier?: string;
  config?: AgentConfigPatch;
  model?: () => Response;
  fetch?: (request: Request) => Promise<Response>;
}) {
  const sent: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  const itx = {
    whoami: async () => ({ projectId: "prj_t", path: PATH, projectSlug: "t" }),
    repos: {
      get: async () => ({
        readFile: async (file: string) => (file === "AGENTS.md" ? "Be brief." : null),
      }),
    },
    cd: () => ({ rewriteRules: { list: async () => [] } }),
    ai: {
      run: async (_model: string, body: Record<string, unknown>) => {
        sent.push(body);
        if (options.model) return options.model();
        return sse([
          { type: "response.output_text.delta", delta: "forty" },
          { type: "response.output_text.delta", delta: "-two" },
          {
            type: "response.completed",
            response: {
              output: [{ type: "message", content: [{ type: "output_text", text: "forty-two" }] }],
              usage: { input_tokens: 1_000, output_tokens: 4 },
              service_tier: options.servedTier, // unset: no field in the stream's JSON
            },
          },
        ]);
      },
    },
    [Symbol.dispose]: () => undefined,
  };
  const processor = new AgentProcessor({
    getItx: () => itx as never,
    fetch: options.fetch,
    now: () => AT,
    sleep: async (ms: number) => void sleeps.push(ms),
  });
  const events: StreamEvent[] = [];
  let state = processor.contract.initialState();
  const commit = async (row: Row): Promise<Row[]> => {
    const parsed = processor.contract.payloadSchemaFor(row.type)?.safeParse(row.payload || {});
    if (parsed && !parsed.success) throw parsed.error;
    const event = {
      type: row.type,
      payload: parsed ? parsed.data : row.payload,
      offset: events.length + 1,
      createdAt: new Date(AT).toISOString(),
      path: PATH,
      source: { origin: PATH },
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
      append: async (...rows: Row[]) => void appended.push(...rows),
      blockProcessorWhile: (work: () => Promise<unknown>) => void background.push(work),
      runInBackground: (work: () => Promise<unknown>) => void background.push(work),
      delivery: { caughtUp: true },
    } as never);
    while (background.length > 0) await background.shift()!();
    return appended;
  };
  const turn = async (words: string, history: Row[] = []): Promise<Row[]> => {
    await commit({ type: "events.iterate.com/agent/create-requested", payload: {} });
    await commit({ type: "events.iterate.com/agent/created", payload: { path: PATH } });
    const config =
      options.config || (options.serviceTier && { llm: { serviceTier: options.serviceTier } });
    if (config) await commit({ type: "events.iterate.com/agent/configured", payload: { config } });
    for (const row of history) await commit(row);
    const asked = await commit({
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", content: words, actor: { type: "user" } },
    });
    const intent = asked.find(
      (row) => row.type === "events.iterate.com/agent/llm-request-requested",
    );
    if (!intent) throw new Error("the loop asked for no request");
    return commit(intent);
  };
  return { turn, commit, sent, sleeps, state: () => state };
}

/** `frames` as the Responses API streams them. A number among them is that many milliseconds of
 *  silence; `STALL`, a silence that never ends. */
function sse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const frame of frames) {
          if (frame === STALL) return;
          if (typeof frame === "number") await new Promise((resolve) => setTimeout(resolve, frame));
          else controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const STALL = Symbol("stall");
const KEYS = ["fake-plan-token", "fake-api-key"];

/** An answer the way OpenAI streams it, ending with `prose` and, if given, a call of `run`. */
function answered(prose: string, callId?: string): unknown[] {
  const output = [
    { type: "message", content: [{ type: "output_text", text: prose }] },
    ...(callId
      ? [
          {
            type: "function_call",
            call_id: callId,
            name: "run",
            arguments: JSON.stringify({ status: "Counting", script: "async () => 42" }),
          },
        ]
      : []),
  ];
  return [
    { type: "response.output_text.delta", delta: prose },
    {
      type: "response.completed",
      response: { output, usage: { input_tokens: 9, output_tokens: 3 } },
    },
  ];
}

/** api.openai.com behind the isolate's `fetch`: a socket upgrade is refused, so each key's request
 *  comes over HTTP, and the n-th POST is answered with `answers[n]`. */
function openAi(...answers: Array<() => Response>) {
  const posts: string[] = [];
  const fetch = async (request: Request) => {
    if (request.headers.get("upgrade") === "websocket") return new Response(null, { status: 426 });
    posts.push(request.headers.get("authorization") || "");
    return answers[posts.length - 1]!();
  };
  return { fetch, posts };
}

/** Let the turn's promises run, on the real event loop, until `check` holds. */
async function until(check: () => boolean) {
  for (let pass = 0; pass < 1_000 && !check(); pass++)
    await new Promise((resolve) => setImmediate(resolve));
  expect(check()).toBe(true);
}

/** A fake clock for the test that holds it, real again once it is disposed. */
function fakeClock(): Disposable {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}
const settledOf = (rows: Row[]) =>
  rows.find((row) => row.type === "events.iterate.com/agent/llm-request-settled")?.payload;
const framesOf = (rows: Row[]) =>
  rows
    .filter((row) => row.type === "events.iterate.com/agent/llm-response-frame")
    .map((row) => row.payload);

/** A 200 whose body sends `frames` and then nothing, and whose pending read rejects when the reader
 *  cancels it ("Stream was cancelled."), as workerd's own response bodies do; Node's resolve it. */
function bodyRejectedByCancel(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const queue = frames.map((frame) => encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
  let interrupt: (error: Error) => void = () => undefined;
  const body = {
    getReader: () => ({
      read: () =>
        queue.length > 0
          ? Promise.resolve({ done: false, value: queue.shift() })
          : new Promise((_resolve, reject) => (interrupt = reject)),
      cancel: async () => interrupt(new Error("Stream was cancelled.")),
      releaseLock: () => undefined,
    }),
  };
  return { ok: true, status: 200, body } as unknown as Response;
}
