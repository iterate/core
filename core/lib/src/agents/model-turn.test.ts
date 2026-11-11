// model-turn.test.ts — one model turn against a fake `itx`: the request the loop sends, the first
// response frame, and the usage it settles with, priced at the standard tier only; each answer's
// idle budget, with the key stack's fallback, on a fake clock; and, over an engine's own delivery,
// what a request reads once a summary landed after it was recorded. The whole loop on the worker is
// test/vitest/agents/ (e2e) and agents-workers/ (an eviction mid-call).
import { expect, test, vi } from "vitest";
import { codedError } from "../lib.ts";
import { ProcessorEngine, type StreamEvent, type StreamEventInput } from "../stream/processor.ts";
import { memoryStorage, memoryStream } from "../stream/test-support.ts";
import { type AgentConfigPatch, AgentProcessor } from "./processor.ts";
import { AI_GATEWAY } from "./responses-keys.ts";

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

test("the loop guard's refusal is no model failure: no other key, no retry, and the pause says why", async () => {
  const keysTried = new Set<string | null>();
  const { turn, commit, state } = agentWithModel({
    config: { llm: { apiKeys: KEYS } },
    fetch: async (request) => {
      keysTried.add(request.headers.get("authorization"));
      throw codedError("LOOP_LIMIT", "508: egress refused", { recorded: true });
    },
  });
  const rows = await turn("Count.");
  expect(keysTried).toMatchObject({ size: 1 });
  const settled = rows.find((row) => row.type === "events.iterate.com/agent/llm-request-settled")!;
  expect(settled.payload).toMatchObject({ result: { status: "failed", loopLimit: true } });
  expect(settled.payload).not.toHaveProperty("failedKeys");
  const after = await commit(settled);
  expect(
    after.find((row) => row.type === "events.iterate.com/agent/paused")?.payload,
  ).toMatchObject({
    reason: "the loop guard stopped a chain of reactions running too fast",
  });
  expect(JSON.stringify(after)).toContain("the model never heard it");
  expect(state().pendingLlmRequestTrigger).toBeNull();
});

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

test("with the default order and no secret set, the request goes through the AI Gateway and nothing is sent to fetch", async () => {
  const sentToFetch: Request[] = [];
  const { turn, sent } = agentWithModel({
    config: {
      llm: {
        apiKeys: [
          'getSecret("/secrets/chatgpt", { field: "accessToken" })',
          'getSecret("/secrets/openai")',
          AI_GATEWAY,
        ],
      },
    },
    fetch: async (request) => {
      sentToFetch.push(request);
      return new Response("unexpected", { status: 500 });
    },
  });
  const settled = settledOf(await turn("What is the answer?"));
  expect(settled).toMatchObject({ result: { status: "succeeded", text: "forty-two" } });
  expect(settled).not.toHaveProperty("failedKeys");
  expect({ fetched: sentToFetch.length, gateway: sent.length }).toEqual({ fetched: 0, gateway: 1 });
});

test("the agent remembers which secrets are set and refreshes that behind each request: the second request waits for no describe, and a key set since is used by the request after", async () => {
  const set = new Set<string>();
  const answers: Array<() => void> = [];
  const model = openAi(() => sse(answered("paid by the key")));
  const { turn, commit, sent } = agentWithModel({
    // no idle check: three turns in a row
    config: {
      llm: { apiKeys: ['getSecret("/secrets/openai")', AI_GATEWAY] },
      keepWarmForMs: 0,
      idleCompactionAfterMs: 0,
    },
    fetch: model.fetch,
    describe: (path) =>
      new Promise((resolve) => answers.push(() => resolve({ path, set: set.has(path) }))),
  });
  const settle = async (rows: Row[]) =>
    void (await commit(rows.find((row) => row.type.endsWith("/llm-request-settled"))!));
  // the incarnation's first request waits for the first answer
  const first = turn("One?");
  await until(() => answers.length === 1);
  expect(sent).toHaveLength(0);
  answers[0]!();
  await settle(await first);
  // the second is sent while its round's describe has not answered
  await settle(await turn("Two?"));
  expect({ describes: answers.length, gateway: sent.length, posts: model.posts.length }).toEqual({
    describes: 2,
    gateway: 2,
    posts: 0,
  });
  set.add("/secrets/openai");
  answers[1]!();
  await new Promise((resolve) => setImmediate(resolve));
  expect(settledOf(await turn("Three?"))).toMatchObject({
    result: { status: "succeeded", text: "paid by the key" },
  });
  expect({ gateway: sent.length, posts: model.posts }).toEqual({
    gateway: 2,
    posts: ['Bearer getSecret("/secrets/openai")'],
  });
  answers[2]!();
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

// ── a summary and the request after it, over the engine's own delivery ──

test.for([
  { delivery: "in the batch that brings the request" },
  { delivery: "before a fresh incarnation revives the request" },
])(
  "a summary that lands after the open request it precedes, $delivery, still reaches that request: the model reads the summary and the new words",
  async ({ delivery }) => {
    const agent = agentOnLog(PATH, () => "Noted.");
    const history = [
      ...BORN,
      words("Remember: my locker code is 4417."),
      requested(3),
      {
        type: "events.iterate.com/agent/llm-request-settled",
        payload: { requestOffset: 4, result: { status: "succeeded", text: "" } },
      },
    ];
    // the person's next words and their request, then the summary of the history through @4,
    // written meanwhile (an engine's live state takes offsets too, so they are counted at commit)
    const race = (at: number) => [
      words("What is my locker code?"),
      requested(at),
      {
        type: "events.iterate.com/agent/context-added",
        payload: {
          role: "developer",
          content:
            "[Earlier conversation history was compacted through @4. Summary:]\n\nThe locker code is 4417.",
          compaction: { replacesHistoryThrough: 4 },
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
    ];
    const batch = delivery === "in the batch that brings the request";
    agent.commit(...history);
    if (batch) await agent.wake().catchUpFromLog();
    const at = agent.nextOffset();
    agent.commit(...race(at));
    if (!batch) await agent.wake().revive();
    await vi.waitFor(() => expect(agent.bodies).toHaveLength(1));
    // the model got the request recorded before the summary landed, not one the loop recorded after
    expect(
      agent.events
        .filter((event) => event.type === "events.iterate.com/agent/llm-request-settled")
        .map((event) => (event.payload as { requestOffset: number }).requestOffset),
    ).toEqual([4, at + 1]);
    const input = JSON.stringify(agent.bodies[0]!.input);
    expect({
      summary: input.includes("The locker code is 4417."),
      newWords: input.includes("What is my locker code?"),
      oldWords: input.includes("Remember: my locker code is 4417."),
    }).toEqual({ summary: true, newWords: true, oldWords: false });
  },
);

test("a voice device's agent has its idle summary once the call goes quiet, and the next call's request reads it in place of the history", async () => {
  const agent = agentOnLog("/agents/voice/kitchen", (body) =>
    body.tool_choice === "none" ? "The locker code is 4417." : "Noted.",
  );
  agent.commit(...BORN, {
    type: "events.iterate.com/agent/configured",
    payload: {
      config: {
        llmRequestDebounceMs: 0,
        idleCompactionAfterMs: 600_000,
        idleCompactionMinNewTokens: 5,
      },
    },
  });
  await agent.wake().catchUpFromLog();
  agent.commit(words("New call.\nPerson: Remember my locker code is 4417."));
  await vi.waitFor(() => expect(agent.scheduled).toHaveLength(1));
  // the agent's schedule fires: nothing happened since the request it names
  const [{ events }] = agent.scheduled[0] as [{ events: Row[] }];
  agent.commit(...events);
  await vi.waitFor(() =>
    expect(
      agent.events.some((event) => (event.payload as { compaction?: unknown }).compaction),
    ).toBe(true),
  );
  agent.commit(words("New call.\nPerson: What is my locker code?"));
  await vi.waitFor(() => expect(agent.bodies).toHaveLength(3));
  const input = JSON.stringify(agent.bodies[2]!.input);
  expect({
    summary: input.includes("while idle") && input.includes("The locker code is 4417."),
    newWords: input.includes("What is my locker code?"),
    oldWords: input.includes("Remember my locker code is 4417."),
  }).toEqual({ summary: true, newWords: true, oldWords: false });
});

test("a long-lived agent keeps warm by default for two hours after its last request: a ping that hits re-arms with its cost, and one that misses ends the window", async () => {
  const pings: Record<string, unknown>[] = [];
  const agent = agentOnLog(
    PATH,
    () => "ok",
    (body) => {
      if (body.tool_choice !== "none") return { input_tokens: 100_000, output_tokens: 20 };
      pings.push(body);
      // the first ping reads the history from the cache, the second finds it gone
      const cached = pings.length === 1 ? 99_000 : 0;
      return {
        input_tokens: 100_050,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: cached },
      };
    },
  );
  agent.commit(...BORN, {
    type: "events.iterate.com/agent/configured",
    payload: { config: { llmRequestDebounceMs: 0 } },
  });
  await agent.wake().catchUpFromLog();
  agent.commit(words("Hello."));
  await vi.waitFor(() => expect(agent.scheduled).toHaveLength(1));
  const due = (call: unknown[]) => {
    const [{ when, events }] = call as [{ when: { at: string }; events: Row[] }];
    return { at: Date.parse(when.at), events, check: events[0]!.payload as Record<string, never> };
  };
  const first = due(agent.scheduled[0]!);
  const readAt = Date.parse(first.check.cacheReadAt);
  expect({
    nextPing: first.at - readAt,
    window: Date.parse(first.check.keepWarmUntil) - readAt,
  }).toEqual({ nextPing: 25 * 60_000, window: 2 * 3_600_000 });

  agent.commit(...first.events);
  await vi.waitFor(() => expect(agent.scheduled).toHaveLength(2));
  expect(pings[0]).toMatchObject({ tool_choice: "none", max_output_tokens: 16 });
  const second = due(agent.scheduled[1]!);
  expect(second.check).toMatchObject({ keepWarmUntil: first.check.keepWarmUntil });
  expect(second.check.keptWarmUsd).toBeGreaterThan(0);

  agent.commit(...second.events);
  await vi.waitFor(() =>
    expect(
      agent.events.filter((event) => event.type === "events.iterate.com/agent/cache-kept-warm"),
    ).toHaveLength(2),
  );
  const kept = agent.events.filter(
    (event) => event.type === "events.iterate.com/agent/cache-kept-warm",
  );
  expect(kept.map((event) => (event.payload as { stopped?: string }).stopped)).toEqual([
    undefined,
    "missed",
  ]);
  // idle compaction is off by default: the window ends with no further check
  expect(agent.scheduled).toHaveLength(2);
});

type WarmedAgent = ReturnType<typeof agentOnLog>;

test.for<{
  name: string;
  config?: AgentConfigPatch;
  /** What the ping sends that the next request does not share: its own words, by default. */
  unshared?: number;
  prepare(agent: WarmedAgent): Promise<void>;
}>([
  {
    name: "after earlier turns, with a call's brief since",
    prepare: async (agent) => {
      agent.commit(words("New call.\nPerson: My locker code is 4417."));
      await vi.waitFor(() =>
        expect(
          agent.events.some(
            (event) => event.type === "events.iterate.com/agent/llm-request-settled",
          ),
        ).toBe(true),
      );
      agent.commit(BRIEF);
    },
  },
  {
    name: "on a fresh agent, whose head no request has written",
    prepare: async (agent) => agent.commit(BRIEF),
  },
  {
    name: "up to a standing file that changed since the last request, which each renders last",
    unshared: 2,
    prepare: async (agent) => {
      agent.commit(words("New call.\nPerson: My locker code is 4417."));
      await vi.waitFor(() =>
        expect(
          agent.events.some(
            (event) => event.type === "events.iterate.com/agent/llm-request-settled",
          ),
        ).toBe(true),
      );
      agent.commit(BRIEF);
      agent.standingFile.text = "Be briefer.";
    },
  },
  {
    name: "after a summary, a prefix no request has cached",
    config: { idleCompactionAfterMs: 600_000, idleCompactionMinNewTokens: 5 },
    prepare: async (agent) => {
      agent.commit(words("New call.\nPerson: My locker code is 4417."));
      await vi.waitFor(() => expect(agent.scheduled).toHaveLength(1));
      const [{ events }] = agent.scheduled[0] as [{ events: Row[] }];
      agent.commit(...events);
      await vi.waitFor(() =>
        expect(
          agent.events.some((event) => (event.payload as { compaction?: unknown }).compaction),
        ).toBe(true),
      );
      agent.commit(BRIEF);
    },
  },
])(
  "a warm-up pings the conversation as it stands, $name: the next request's input starts with the ping's, and the ping changes neither the conversation nor the schedule",
  async ({ config, unshared = 1, prepare }) => {
    const agent = agentOnLog("/agents/voice/kitchen", (body) =>
      body.tool_choice === "none" ? "The locker code is 4417." : "Noted.",
    );
    agent.commit(...BORN, {
      type: "events.iterate.com/agent/configured",
      payload: { config: { llmRequestDebounceMs: 0, ...config } },
    });
    await agent.wake().catchUpFromLog();
    await prepare(agent);
    const asked = agent.bodies.length;
    const armed = agent.scheduled.length;
    agent.commit(WARM_UP);
    await vi.waitFor(() => expect(kept(agent)).toHaveLength(1));

    const ping = agent.bodies[asked]!;
    expect(ping).toMatchObject({ tool_choice: "none", max_output_tokens: 16 });
    const pingInput = ping.input as unknown[];
    expect(JSON.stringify(pingInput)).toContain("[call brief]");
    const ask = agent.events.find((event) => event.type === WARM_UP.type)!;
    expect(kept(agent)[0]!.payload).toMatchObject({ afterRequestOffset: ask.offset });
    expect(kept(agent)[0]!.payload).not.toHaveProperty("stopped");
    expect(
      agent.events.filter(
        (event) =>
          event.offset > ask.offset && event.type === "events.iterate.com/agent/context-added",
      ),
    ).toEqual([]);
    expect(agent.scheduled).toHaveLength(armed);

    agent.commit(words("New call.\nPerson: What is my locker code?"));
    await vi.waitFor(() => expect(agent.bodies).toHaveLength(asked + 2));
    const next = agent.bodies[asked + 1]!;
    expect(next).toMatchObject({ tool_choice: "auto" });
    expect((next.input as unknown[]).slice(0, pingInput.length - unshared)).toEqual(
      pingInput.slice(0, -unshared),
    );
  },
);

test("a paused agent sends no ping, and pings once resumed", async () => {
  const agent = agentOnLog("/agents/voice/kitchen", () => "ok");
  agent.commit(...BORN, CONFIGURED_WITHOUT_DEBOUNCE);
  await agent.wake().catchUpFromLog();
  agent.commit(
    { type: "events.iterate.com/agent/paused", payload: { reason: "a test" } },
    WARM_UP,
    { type: "events.iterate.com/agent/resumed", payload: {} },
    WARM_UP,
  );
  await vi.waitFor(() => expect(kept(agent)).toHaveLength(1));
  expect(agent.bodies).toHaveLength(1);
});

test("a press while a warm-up's ping runs sends no second ping", async () => {
  const release = Promise.withResolvers<void>();
  const agent = agentOnLog("/agents/voice/kitchen", () => "ok", undefined, release.promise);
  agent.commit(...BORN, CONFIGURED_WITHOUT_DEBOUNCE);
  const engine = agent.wake();
  await engine.catchUpFromLog();
  agent.commit(WARM_UP);
  await vi.waitFor(() => expect(agent.bodies).toHaveLength(1));
  const second = agent.nextOffset();
  agent.commit(WARM_UP);
  await engine.waitUntilProcessed({ offset: second });
  release.resolve();
  await vi.waitFor(() => expect(kept(agent)).toHaveLength(1));
  expect(agent.bodies).toHaveLength(1);
});

type Row = { type: string; payload?: unknown };

const WARM_UP: Row = { type: "events.iterate.com/agent/warm-up-requested", payload: {} };
const CONFIGURED_WITHOUT_DEBOUNCE: Row = {
  type: "events.iterate.com/agent/configured",
  payload: { config: { llmRequestDebounceMs: 0 } },
};
/** What a phone bridge tells a call's agent before the press: context, which starts no turn. */
const BRIEF: Row = {
  type: "events.iterate.com/agent/context-added",
  payload: {
    role: "user",
    content: "[call brief] The owner rang you.",
    llmRequestPolicy: { behaviour: "dont-trigger-request" },
  },
};
const kept = ({ events }: WarmedAgent) =>
  events.filter((event) => event.type === "events.iterate.com/agent/cache-kept-warm");

const BORN: Row[] = [
  { type: "events.iterate.com/agent/create-requested", payload: {} },
  { type: "events.iterate.com/agent/created", payload: { path: PATH } },
];
const words = (content: string): Row => ({
  type: "events.iterate.com/agent/context-added",
  payload: { role: "user", content, actor: { type: "user" } },
});
const requested = (triggerOffset: number): Row => ({
  type: "events.iterate.com/agent/llm-request-requested",
  payload: { model: "gpt-6.1-sol", expiresAt: 600_000, triggerOffset },
});

/** The agent as a facet hosts it: its processor in an engine over an in-memory log at `path`, the
 *  `itx` of agentWithModel with the agent's own schedule (`scheduled` keeps each call), and a model
 *  that answers `answer(body)`, reporting `usage(body)` when given. `commit` appends events in one
 *  batch, pushed to the incarnation `wake` started last over the same log and checkpoint; `bodies`
 *  are the requests the model got. */
function agentOnLog(
  path: string,
  answer: (body: Record<string, unknown>) => string,
  usage?: (body: Record<string, unknown>) => Record<string, unknown>,
  /** Holds every model call until it settles. */
  held?: Promise<void>,
) {
  const log = memoryStream(path);
  const storage = memoryStorage();
  const bodies: Record<string, unknown>[] = [];
  const scheduled: unknown[][] = [];
  const standingFile = { text: "Be brief." };
  const itx = {
    whoami: async () => ({ projectId: "prj_t", path, projectSlug: "t" }),
    repos: {
      get: async () => ({
        readFile: async (file: string) => (file === "AGENTS.md" ? standingFile.text : null),
      }),
    },
    cd: () => ({ rewriteRules: { list: async () => [] } }),
    schedules: { set: async (...args: unknown[]) => void scheduled.push(args) },
    ai: {
      run: async (_model: string, body: Record<string, unknown>) => {
        bodies.push(body);
        await held;
        return sse(answered(answer(body), undefined, usage?.(body)));
      },
    },
    [Symbol.dispose]: () => undefined,
  };
  return {
    commit: (...rows: Row[]) => void log.stream.append(...(rows as StreamEventInput[])),
    wake: () => {
      const processor = new AgentProcessor({
        getItx: () => itx as never,
        now: () => 0,
        sleep: async () => undefined,
      });
      const engine = new ProcessorEngine(processor, { stream: log.stream, storage });
      log.engines.splice(0, log.engines.length, engine);
      return engine;
    },
    nextOffset: () => (log.pushedEvents.at(-1)?.offset ?? 0) + 1,
    bodies,
    scheduled,
    events: log.events,
    standingFile,
  };
}

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
  /** `itx.secrets.describe`; by default no secret is set. */
  describe?: (path: string) => Promise<{ path: string; set: boolean }>;
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
    secrets: { describe: options.describe || (async (path: string) => ({ path, set: false })) },
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
function answered(
  prose: string,
  callId?: string,
  usage: Record<string, unknown> = { input_tokens: 9, output_tokens: 3 },
): unknown[] {
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
      response: { output, usage },
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
