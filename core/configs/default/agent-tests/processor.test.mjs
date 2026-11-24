// processor.test.mjs: WHAT THE AGENT IS SHOWN TO DO. First the rules, by the pure fold. Then whole
// exchanges on the platform's in-memory log with a fake `itx`: an input and who sent it, each
// provider, a provider written in this file, the WebSocket, an interrupt, failures, a death of the
// host after every commit, a version bump, a backlog, summaries. A subagent: subagent.test.mjs.
//
// The in-memory log stamps every event at time 0, so time moves only by `agent/timer-fired`, which
// a test appends as the platform's scheduler would (`fire`). Kinds are types without
// `events.iterate.com/`. A fake model answers as a real one is told to: one `<codemode>` block,
// whose script appends the words as `agent-ui/message-sent` (`written` in test-support.mjs). The
// test's runner REALLY RUNS every script against the log.
//
// Run from the config's root: node --test "agent-tests/*.test.mjs"

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { ProcessorEngine } from "iterate/stream/processor";
import { RunEventCatalog } from "iterate/stream/run";
import { memoryStorage, memoryStream, reduceProcessor, settle } from "iterate/stream/test-support";
import { AgentContract, ScheduleEventCatalog } from "../agent/contract.ts";
import { LlmApiProcessor } from "../agent/llm-api.ts";
import { chatCompletions } from "../agent/llm-apis/chat-completions.ts";
import { openaiResponses } from "../agent/llm-apis/openai-responses.ts";
import { LlmRequestContract } from "../agent/llm-request.ts";
import { Agent } from "../agent/processor.ts";
import {
  agentOnALog,
  anthropic,
  fakeWebSocket,
  google,
  heldSse,
  logged,
  openai,
  openaiEvents,
  sha256,
  sse,
  written,
  xai,
} from "./test-support.mjs";

// ── the rules, by the pure fold: fact n is at offset n, n seconds after the epoch ──

test("an input owes one append: the request, its deadline, and its wait for a request maker", () => {
  const state = fold({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "user", content: "hello" },
  });
  assert.deepEqual(owes(state), ["llm-request/requested + itx/schedule-set + itx/schedule-set"]);
  const [owed] = state.obligations;
  const [request, deadline] = owed.events;
  assert.equal(request.idempotencyKey, "llm-request/requested:answer/1");
  // the request says everything a request maker needs: here, the whole conversation is new
  const { instructions, ...asked } = logged(request.payload);
  assert.match(String(instructions), /^You are an agent on the iterate platform/);
  assert.deepEqual(asked, {
    extends: null,
    itemsAdded: [{ atOffset: 1, rank: 0, tag: "words", role: "user", text: "hello" }],
    // the agent's path (the fold's facts are on `/`)
    promptCacheKey: "/",
    reasoningEffort: null,
    maxOutputTokens: null,
    model: "openai/gpt-6.2-sol",
    expiresAtMs: 601_000,
    purpose: "answer",
    triggerOffset: 1,
  });
  assert.deepEqual(deadline.payload, {
    key: "llm-request/requested:answer/1/deadline",
    when: { at: "1970-01-01T00:10:01.000Z" },
    events: [
      {
        type: "events.iterate.com/llm-request/deadline-passed",
        payload: { llmRequestIdempotencyKey: "llm-request/requested:answer/1" },
      },
    ],
  });
});

test("context that does not trigger is read by the next request and owes nothing", () => {
  const state = fold(
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "user",
        content: "fyi",
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    },
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "developer",
        content: "a relay's line",
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    },
  );
  assert.deepEqual(owes(state), []);
  assert.deepEqual(
    state.items.map((item) => [item.atOffset, item.tag, item.role, item.text]),
    [
      [1, "words", "user", "fyi"],
      [2, "context", "developer", "a relay's line"],
    ],
  );
});

test("who sent an input: another context's stamp, else no one", () => {
  const input = (role, origin) => ({
    type: "events.iterate.com/agent/context-added",
    payload: { role, content: "hi" },
    path: "/agents/test",
    ...(origin !== undefined && { source: { origin } }),
  });
  const read = (fact) => fold(fact).items.map((item) => item.text);
  // a script of another context appended it: the platform's stamp names that context
  assert.deepEqual(read(input("user", "/agents/planner")), ["[from /agents/planner]\nhi"]);
  // the agent's own context, the root and the agents API name no sender, nor a fact with no origin
  for (const origin of ["/agents/test", "/", "/agents", undefined])
    assert.deepEqual(read(input("user", origin)), ["hi"], String(origin));
  // a developer input names no sender
  assert.deepEqual(read(input("developer", "/agents/planner")), ["hi"]);
});

const TWO_FILES = [
  {
    contentType: "application/pdf",
    filename: "plan.pdf",
    path: "/agents/test/a1-plan.pdf",
    size: 42,
  },
  { contentType: "image/png", filename: "map.png", path: "/agents/test/b2-map.png", size: 7 },
];

test("an input names files: the request's item names both, and its text holds the words only", () => {
  const state = fold({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "user", content: "read these", files: TWO_FILES },
  });
  const [request] = state.obligations[0].events;
  const [item] = request.payload.itemsAdded;
  assert.deepEqual(item, {
    atOffset: 1,
    rank: 0,
    tag: "words",
    role: "user",
    text: "read these",
    files: TWO_FILES,
  });
});

test("the debounce: the request waits for a timer, counted from the first input, and reads both", () => {
  const configured = {
    type: "events.iterate.com/agent/configured",
    payload: { config: { llmRequestDebounceMs: 3_000 } },
  };
  const input = (content) => ({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "user", content },
  });
  const first = input("one");
  const waiting = fold(configured, first);
  assert.deepEqual(owes(waiting), ["agent/timer-set + itx/schedule-set"]);
  const [timer] = waiting.obligations;
  // the first input came at 2 s: the request is due at 5 s
  assert.deepEqual(timer.events[0].payload, { atMs: 5_000 });
  assert.deepEqual(timer.events[1].payload, {
    key: "agent/timer",
    when: { at: "1970-01-01T00:00:05.000Z" },
    events: [{ type: "events.iterate.com/agent/timer-fired", payload: { atMs: 5_000 } }],
  });
  const set = { type: "events.iterate.com/agent/timer-set", payload: { atMs: 5_000 } };
  const second = input("two");
  assert.deepEqual(
    owes(fold(configured, first, set, second)),
    [],
    "the timer is set: nothing more is owed",
  );
  const fired = { type: "events.iterate.com/agent/timer-fired", payload: { atMs: 5_000 } };
  const due = fold(configured, first, set, second, fired);
  assert.deepEqual(owes(due), ["llm-request/requested + itx/schedule-set + itx/schedule-set"]);
  assert.deepEqual(due.pendingTriggerOffsets, [2, 4]);
});

// ── the trigger fact: "make a request NOW", and why ──

const contextOnly = (content) => ({
  type: "events.iterate.com/agent/context-added",
  payload: { role: "user", content, llmRequestPolicy: { behaviour: "dont-trigger-request" } },
});
const triggerNow = {
  type: "events.iterate.com/agent/llm-request-triggered",
  payload: { reason: "the person asked a direct question", inputOffset: 2 },
};

test("the trigger after context only: a request at once, through a debounce, and it names the trigger", () => {
  const configured = {
    type: "events.iterate.com/agent/configured",
    payload: { config: { llmRequestDebounceMs: 5_000 } },
  };
  assert.deepEqual(owes(fold(configured, contextOnly("is the build green?"))), []);
  const state = fold(configured, contextOnly("is the build green?"), triggerNow);
  // no timer: the debounce is over
  assert.deepEqual(owes(state), ["llm-request/requested + itx/schedule-set + itx/schedule-set"]);
  const payload = state.obligations[0].events[0].payload;
  // the request names the trigger: from it, a reader finds the reason in one step
  assert.equal(payload.triggerOffset, 3);
  assert.deepEqual(
    payload.itemsAdded.map((item) => item.text),
    ["is the build green?"],
  );
  // a trigger with no reason is no trigger
  const reasonless = { ...triggerNow, payload: { reason: "" } };
  assert.deepEqual(owes(fold(configured, contextOnly("is the build green?"), reasonless)), []);
});

test("the trigger while an answer request is open: its cancellation is owed, and the next request reads everything", () => {
  const first = fold({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "user", content: "one" },
  });
  const [request] = first.obligations[0].events;
  const facts = [
    { type: "events.iterate.com/agent/context-added", payload: { role: "user", content: "one" } },
    request, // offset 2
    {
      type: "events.iterate.com/llm-request/attempt-started",
      payload: {
        llmRequestOffset: 2,
        attempt: 0,
        api: "openai-responses",
        transport: "gateway",
        model: "openai/gpt-6.2-sol",
        inputChars: {},
        inputFileBytes: 0,
      },
    },
    contextOnly("two"), // offset 4
    { ...triggerNow, payload: { reason: "two changes the question", inputOffset: 4 } }, // 5
  ];
  const interrupted = fold(...facts);
  assert.deepEqual(owes(interrupted), ["llm-request/cancelled + itx/schedule-set"]);
  assert.deepEqual(interrupted.obligations[0].events[0].payload, {
    llmRequestOffset: 2,
    reason: "interrupted-by-user-input",
  });
  const cancelled = {
    type: "events.iterate.com/llm-request/cancelled",
    payload: { llmRequestOffset: 2, reason: "interrupted-by-user-input" },
  };
  const settled = {
    type: "events.iterate.com/llm-request/settled",
    payload: {
      llmRequestOffset: 2,
      attempt: 0,
      result: { status: "cancelled", reason: "interrupted-by-user-input" },
    },
  };
  const next = fold(...facts, cancelled, settled);
  assert.deepEqual(owes(next), ["llm-request/requested + itx/schedule-set + itx/schedule-set"]);
  const payload = next.obligations[0].events[0].payload;
  assert.equal(payload.triggerOffset, 5);
  // it extends the request before it, and adds the note on that one and the context after it
  assert.deepEqual(payload.extends, { llmRequestOffset: 2, itemCount: 1, response: false });
  assert.deepEqual(
    payload.itemsAdded.map((item) => item.tag),
    ["interrupted-llm-response", "words"],
  );
  assert.deepEqual(
    next.items.map((item) => item.tag),
    ["words", "interrupted-llm-response", "words"],
  );
  assert.deepEqual([next.items[0].text, next.items[2].text], ["one", "two"]);
});

test("the trigger while someone else's pause holds owes nothing", () => {
  const paused = {
    type: "events.iterate.com/agent/paused",
    payload: { reason: "a person holds the agent" },
  };
  assert.deepEqual(owes(fold(paused, contextOnly("hello"), triggerNow)), []);
  assert.deepEqual(owes(fold(contextOnly("hello"), triggerNow)), [
    "llm-request/requested + itx/schedule-set + itx/schedule-set",
  ]);
});

test("a pause of the agent's own that arrives with nothing left to pause for is over at once", () => {
  // An input from outside can overtake a pause on its way to the log: it starts the counts over,
  // so when the pause is read there is no reason left for it, and the agent owes its end.
  const state = fold({
    type: "events.iterate.com/agent/paused",
    payload: { reason: "LLM requests failed: the provider was down", endsAtNextOutsideInput: true },
  });
  assert.deepEqual(owes(state), ["agent/resumed"]);
  const [owed] = state.obligations;
  assert.equal(owed.idempotencyKey, "agent/resumed:1");
});

test("one input: no source of the agent names the old message fact", () => {
  const sources = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return sources(new URL(`${entry.name}/`, directory));
      return entry.name.endsWith(".ts") ? [new URL(entry.name, directory)] : [];
    });
  const files = sources(new URL("../agent/", import.meta.url));
  assert.ok(files.length > 12, "the test reads the agent's sources");
  // the word is split, so that this file does not hold it either
  const word = ["message", "received"].join("-");
  const holding = files.filter((file) => readFileSync(file, "utf8").includes(word));
  assert.deepEqual(
    holding.map((file) => file.pathname),
    [],
  );
});

test("no code of the agent or of the mind's config holds the old word for the agent", () => {
  const sources = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return sources(new URL(`${entry.name}/`, directory));
      return /\.(ts|mjs|json)$/.test(entry.name) ? [new URL(entry.name, directory)] : [];
    });
  const files = [
    ...sources(new URL("../agent/", import.meta.url)),
    ...sources(new URL("../agent-kinds/", import.meta.url)),
    ...sources(new URL("./", import.meta.url)),
    ...["../agent-start.ts", "../agent-prompt.ts", "../agent-ui.ts"].map(
      (file) => new URL(file, import.meta.url),
    ),
  ];
  assert.ok(files.length > 25, "the test reads the agent's code and the config's agent files");
  // the word is built of two parts, so that this file does not hold it either
  const word = ["lo", "op"].join("");
  const holding = files.filter((file) => readFileSync(file, "utf8").toLowerCase().includes(word));
  assert.deepEqual(
    holding.map((file) => file.pathname),
    [],
  );
});

test("the agent is coupled to the request makers by facts alone: it imports none of them, and appends only", () => {
  const importsOf = (file) => {
    const source = readFileSync(new URL(`../agent/${file}`, import.meta.url), "utf8");
    return [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).toSorted();
  };
  assert.deepEqual(importsOf("processor.ts"), [
    "./contract.ts",
    "./llm-request.ts",
    "./script-envelope.ts",
    "iterate/lib",
    "iterate/stream/processor",
  ]);
  const source = readFileSync(new URL("../agent/processor.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /runInBackground|fetch\(|\.ai\.run/);
  // the request maker imports contracts, never the agent
  assert.ok(!importsOf("llm-api.ts").includes("./processor.ts"));
  assert.ok(importsOf("llm-api.ts").includes("./llm-request.ts"));
});

test("contracts depend on contracts: the request protocol has one owner, and both sides list it", () => {
  // the agent lists the protocol and no channel's contract; the request maker lists the protocol
  // and the agent (for `agent/configured`)
  assert.deepEqual(AgentContract.processorDeps, [
    LlmRequestContract,
    RunEventCatalog,
    ScheduleEventCatalog,
  ]);
  // the agent owns the subagent facts, and reads none of them: the mind's worker answers them
  const subagent = ["requested", "started", "failed"].map(
    (fact) => `events.iterate.com/agent/subagent-${fact}`,
  );
  for (const type of subagent) {
    assert.ok(type in AgentContract.events, type);
    assert.ok(!AgentContract.consumes.includes(type), type);
  }
  const maker = makerOf(chatCompletions);
  assert.deepEqual(maker.contract.processorDeps, [
    LlmRequestContract,
    AgentContract,
    ScheduleEventCatalog,
  ]);
  assert.deepEqual(Object.keys(LlmRequestContract.events).toSorted(), [
    "events.iterate.com/llm-request/attempt-started",
    "events.iterate.com/llm-request/cancelled",
    "events.iterate.com/llm-request/deadline-passed",
    "events.iterate.com/llm-request/requested",
    "events.iterate.com/llm-request/response-frame-received",
    "events.iterate.com/llm-request/settled",
    "events.iterate.com/llm-request/wait-ended",
  ]);
  // each request maker owns the namespace of its API shape: its two facts, and what the shape
  // declares
  assert.deepEqual(Object.keys(maker.contract.events).toSorted(), [
    "events.iterate.com/chat-completions/request-started",
    "events.iterate.com/chat-completions/response-frame-received",
  ]);
  const openaiMaker = makerOf(openaiResponses());
  assert.deepEqual(Object.keys(openaiMaker.contract.events).toSorted(), [
    "events.iterate.com/openai-responses/request-started",
    "events.iterate.com/openai-responses/response-frame-received",
    "events.iterate.com/openai-responses/websocket-closed",
    "events.iterate.com/openai-responses/websocket-connected",
  ]);
  // each event type has ONE owner
  const owned = [AgentContract, LlmRequestContract, RunEventCatalog, ScheduleEventCatalog].flatMap(
    (contract) => Object.keys(contract.events),
  );
  assert.equal(new Set(owned).size, owned.length);
  // and every type either side reads or writes has its definition there
  for (const contract of [AgentContract, maker.contract, openaiMaker.contract])
    for (const type of [...contract.consumes, ...contract.emits])
      assert.ok(contract.eventDefinitionFor(type), `${contract.slug}: ${type}`);
});

/** A request maker that is only read, never run. */
const makerOf = (api) =>
  new LlmApiProcessor({
    api,
    getItx: () => assert.fail("not used"),
    fetch: () => assert.fail("not used"),
    now: () => 0,
    report: () => {},
    readEvents: () => assert.fail("not used"),
  });

test("the agent consumes no schedule fact: on the platform, work started in the pass of one never runs", () => {
  // On the platform, a request whose deadline schedule is the last event of its push is never
  // sent. The in-memory log cannot show that, so the contract is held to it here.
  const schedules = AgentContract.consumes.filter((type) =>
    type.startsWith("events.iterate.com/itx/schedule-"),
  );
  assert.deepEqual(schedules, []);
});

test("a config patch merges one level deep, and a patch the schema refuses changes nothing", () => {
  const patch = (config) => ({
    type: "events.iterate.com/agent/configured",
    payload: { config },
  });
  const state = fold(
    patch({ llm: { model: "anthropic/claude-opus-5.5" } }),
    // a model's name starts with its provider: this one names none
    patch({ llm: { model: "claude-opus-5.5" } }),
  );
  assert.equal(state.config.llm.model, "anthropic/claude-opus-5.5");
  assert.equal(
    state.config.llm.streamIdleTimeoutMs,
    60_000,
    "the other keys of `llm` keep their values",
  );
});

test("a provider's `cloudflareAiBinding` and `fetcher` are itx expressions: a patch with other text changes nothing", () => {
  const patch = (provider) => ({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llmProviders: { basement: { api: "chat-completions", ...provider } } } },
  });
  const state = fold(
    patch({ cloudflareAiBinding: "itx.iterateCloud.ai", fetcher: 'itx.minds.get("llm.example")' }),
    // not rooted at `itx`
    patch({ cloudflareAiBinding: "ctx.ai" }),
    // text that the platform's parser refuses
    patch({ fetcher: "itx.minds.get(" }),
  );
  assert.deepEqual(state.config.llmProviders.basement, {
    api: "chat-completions",
    cloudflareAiBinding: "itx.iterateCloud.ai",
    baseUrl: null,
    fetcher: 'itx.minds.get("llm.example")',
    headers: {},
    webSocket: null,
  });
  // a provider that names neither: the mind's AI Gateway, and the facet's own `fetch`
  const { cloudflareAiBinding, fetcher } = state.config.llmProviders.openai;
  assert.deepEqual(
    { cloudflareAiBinding, fetcher },
    { cloudflareAiBinding: "itx.ai", fetcher: null },
  );
});

// ── one exchange, end to end ──

test("one exchange: the request, its exact bytes, the frames, the settlement, the script that says the words", async () => {
  const usage = { input: 1_000, cached: 400, output: 20 };
  const answer = written({ say: "Hello there." });
  const agent = agentOnALog({ model: () => openai({ say: "Hello there.", usage }) });
  const [input] = await agent.say("hello");
  assert.deepEqual(agent.kinds(), [
    // THE INPUT: a person's words, the agent's one input
    "agent/context-added",
    // THE AGENT: what it asks, the request's deadline, and its wait for a request maker
    "llm-request/requested",
    "itx/schedule-set",
    "itx/schedule-set",
    // A REQUEST MAKER: the attempt and its exact bytes (its wait is over), then what came back
    "llm-request/attempt-started",
    "openai-responses/request-started",
    "itx/schedule-cancelled",
    "llm-request/settled",
    "itx/schedule-cancelled",
    "itx/schedule-cancelled",
    // THE AGENT: the response's one script. Its words are its own append, before it settles
    "itx/run-requested",
    "agent-ui/message-sent",
    "itx/run-settled",
  ]);
  assert.deepEqual(agent.invalidFacts(), []);
  assert.deepEqual(input.payload, { role: "user", content: "hello" });
  const [request] = agent.durable("events.iterate.com/llm-request/requested");
  assert.equal(request.payload?.triggerOffset, input.offset);

  // through the AI Gateway, with the provider's own body and no key
  const [call] = agent.calls;
  assert.equal(call.model, "openai/gpt-6.2-sol");
  // the prompt is the first input item, a `developer` message, and the body has no `instructions`:
  // a ChatGPT plan's token reads the prompt cache only then (llm-apis/openai-responses.ts)
  const [prompt, ...conversation] = call.body.input;
  assert.equal(call.body.instructions, undefined);
  assert.equal(prompt.role, "developer");
  assert.deepEqual(conversation, [{ role: "user", content: "hello" }]);
  assert.equal(call.body.prompt_cache_key, "/agents/test");
  assert.equal(call.body.store, false);
  // no tool: the prompt teaches the one `<codemode>` block
  assert.equal(call.body.tools, undefined);
  assert.match(prompt.content, /YOUR RESPONSE IS ONE SCRIPT AND NOTHING ELSE/);
  assert.deepEqual(call.options, {
    returnRawResponse: true,
    gateway: {
      id: "default",
      skipCache: true,
      metadata: {
        streamPath: "/agents/test",
        context: "agent-turn",
        llmRequestOffset: request.offset,
      },
    },
  });

  // THE ATTEMPT STARTS in ONE append, before the bytes leave: the shared fact, the bytes in the
  // request maker's own namespace, and the end of the agent's wait for a request maker
  assert.ok(
    agent
      .appends()
      .some((kinds) =>
        isDeepStrictEqual(kinds, [
          "llm-request/attempt-started",
          "openai-responses/request-started",
          "itx/schedule-cancelled",
        ]),
      ),
  );
  const [started] = agent.durable("events.iterate.com/llm-request/attempt-started");
  assert.equal(started.idempotencyKey, `llm-request/attempt-started:${request.offset}/0`);
  assert.deepEqual(started.payload, {
    llmRequestOffset: request.offset,
    attempt: 0,
    model: "openai/gpt-6.2-sol",
    api: "openai-responses",
    // the request maker's own id: another instance's attempt-started has another body
    instanceId: started.payload?.instanceId,
    transport: "gateway",
    inputChars: { instructions: prompt.content.length, words: 5 },
    inputFileBytes: 0,
  });
  assert.match(String(started.payload?.instanceId), /^[0-9a-f-]{36}$/);
  // the request maker's fact holds the body: a reader rebuilds it and checks the hash
  const [sent] = agent.durable("events.iterate.com/openai-responses/request-started");
  const rebuilt = {
    ...sent.payload?.bodyWithoutInput,
    [String(sent.payload?.inputField)]: sent.payload?.inputItemsAdded,
  };
  assert.deepEqual(rebuilt, call.body);
  assert.equal(sent.payload?.bodySha256, sha256(JSON.stringify(rebuilt)));
  assert.equal(sent.payload?.transport, "gateway");
  assert.equal(sent.payload?.extendsRequestStartedOffset, null);

  // the frames are ephemeral: the words in one shape for every provider, and in the same append
  // the provider's events unmodified, with the same `sequence`
  const pushed = (type) =>
    agent.log.pushedEvents.filter((event) => event.type === `events.iterate.com/${type}`);
  const [frame] = pushed("llm-request/response-frame-received");
  const [providerFrame] = pushed("openai-responses/response-frame-received");
  assert.equal(pushed("llm-request/response-frame-received").length, 1);
  assert.deepEqual([frame.ephemeral, providerFrame.ephemeral], [true, true]);
  assert.ok(
    agent
      .appends()
      .some((kinds) =>
        isDeepStrictEqual(kinds, [
          "llm-request/response-frame-received",
          "openai-responses/response-frame-received",
        ]),
      ),
  );
  assert.equal(agent.durable("events.iterate.com/llm-request/response-frame-received").length, 0);
  assert.deepEqual(frame.payload, {
    llmRequestOffset: request.offset,
    attempt: 0,
    sequence: 0,
    textDelta: answer,
    thinkingDelta: "",
    thinking: false,
  });
  assert.deepEqual(providerFrame.payload, {
    llmRequestOffset: request.offset,
    attempt: 0,
    sequence: 0,
    providerEvents: openaiEvents({ say: "Hello there.", usage }),
  });

  // the settlement: the text, the usage, the cost by the price table
  const [settled] = agent.durable("events.iterate.com/llm-request/settled");
  assert.equal(settled.payload?.llmRequestOffset, request.offset);
  const result = settled.payload?.result;
  assert.equal(result.status, "succeeded");
  assert.equal(result.text, answer);
  assert.deepEqual(result.usage, {
    inputTokens: 1_000,
    outputTokens: 20,
    cachedInputTokens: 400,
    reasoningOutputTokens: 0,
    costUsd: (600 * 2 + 400 * 0.1 + 20 * 10) / 1e6,
  });
  // the words are the script's own append: the agent writes none
  const [words] = agent.durable("events.iterate.com/agent-ui/message-sent");
  assert.deepEqual(words.payload, { message: "Hello there." });
  assert.equal(words.source.processor, undefined);
  // the wait for a request maker ends as it sends; the deadline and the wait end as it settles
  const cancelled = agent.durable("events.iterate.com/itx/schedule-cancelled");
  assert.deepEqual(
    cancelled.map((fact) => fact.payload?.key),
    ["wait", "deadline", "wait"].map((key) => `llm-request/requested:answer/1/${key}`),
  );

  // the script returned nothing: no further request. One wide event of telemetry, nothing owed
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.reports.length, 1);
  assert.equal(agent.reports[0].status, "succeeded");
  const state = await agent.state();
  assert.deepEqual(state.obligations, []);
  assert.equal(state.totals.costUsd, result.usage.costUsd);
});

test("thinking with no words: a frame says `thinking` at once, and each window's two frames share a `sequence`", async () => {
  // OpenAI's encrypted reasoning: an item opens and closes, and gives no words
  const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "…", summary: [] };
  const agent = agentOnALog({
    model: () =>
      sse([
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
        { type: "response.output_item.done", item: reasoning },
        ...openaiEvents({ say: "Done thinking." }),
      ]),
  });
  await agent.say("think hard");
  const pushed = (type) =>
    agent.log.pushedEvents
      .filter((event) => event.type === `events.iterate.com/${type}`)
      .map((event) => event.payload);
  const frames = pushed("llm-request/response-frame-received");
  // the first window ends at once: thinking began, and there are no words for it
  assert.deepEqual(frames[0], {
    llmRequestOffset: frames[0].llmRequestOffset,
    attempt: 0,
    sequence: 0,
    textDelta: "",
    thinkingDelta: "",
    thinking: true,
  });
  // the next window ends at once too, as thinking ends; the words come after it
  assert.deepEqual(
    frames.map((frame) => [frame.sequence, frame.thinking]),
    [
      [0, true],
      [1, false],
      [2, false],
    ],
  );
  assert.equal(frames.map((frame) => frame.textDelta).join(""), written({ say: "Done thinking." }));
  // the provider's events of each window, with the same `sequence`
  const providerFrames = pushed("openai-responses/response-frame-received");
  assert.deepEqual(
    providerFrames.map((frame) => frame.sequence),
    frames.map((frame) => frame.sequence),
  );
  assert.deepEqual(providerFrames[0].providerEvents, [
    { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
  ]);
  assert.deepEqual(agent.said(), ["Done thinking."]);
});

// ── the input, and every way it is written ──

test("an input is read once, whoever hosts the agent", async () => {
  const agent = agentOnALog({ model: () => openai({ say: "Got it." }) });
  const [input] = await agent.say("read this");
  assert.equal(agent.calls[0].body.input.at(-1).content, "read this");

  // a new host reads the same input again and writes nothing new
  await agent.wake().revive();
  await agent.quiet();
  assert.equal(agent.durable("events.iterate.com/agent/context-added").length, 1);
  assert.equal(
    agent.durable("events.iterate.com/llm-request/requested")[0].payload?.triggerOffset,
    input.offset,
  );
  assert.equal(agent.calls.length, 1);
  assert.deepEqual(agent.invalidFacts(), []);
});

test("an input that is context only says so, and starts no request", async () => {
  const agent = agentOnALog({ model: () => openai({ say: "Both read." }) });
  const policy = { behaviour: "dont-trigger-request" };
  const [quiet] = await agent.say("for your information", { llmRequestPolicy: policy });
  assert.deepEqual(quiet.payload?.llmRequestPolicy, policy);
  assert.equal(agent.calls.length, 0);
  await agent.say("what did I tell you?");
  assert.deepEqual(
    agent.calls[0].body.input.slice(1).map((item) => item.content),
    ["for your information", "what did I tell you?"],
  );
});

test("anything else writes the agent's input directly, with the policy it wants", async () => {
  const agent = agentOnALog({ model: () => openai({ say: "Noted." }) });
  await agent.add("the build is green", {
    role: "developer",
    llmRequestPolicy: { behaviour: "dont-trigger-request" },
  });
  assert.equal(agent.calls.length, 0);
  await agent.add("deploy it");
  assert.deepEqual(agent.calls[0].body.input.slice(1), [
    { role: "developer", content: "the build is green" },
    { role: "user", content: "deploy it" },
  ]);
});

// ── scripts ──

test("one block: its script runs, its result answers it, and the chain goes on", async () => {
  // two things at once are `Promise.all` inside the one script
  const script = "const [a, b] = await Promise.all([1, itx.whoami()]);\nreturn { a, b };";
  const agent = agentOnALog({
    runScriptsByHand: true,
    itx: { whoami: async () => ({ path: "/agents/test" }) },
    model: (_call, calls) =>
      calls.length === 1 ? openai({ say: "Looking.", script }) : openai({ say: "Both done." }),
  });
  await agent.say("do two things");
  assert.deepEqual(agent.kinds().slice(-1), ["itx/run-requested"]);
  // the script goes out in its envelope (script-envelope.ts); this is the model's own code in it
  assert.deepEqual(agent.scripts(), [
    written({ say: "Looking.", script }).split("\n").slice(1, -1).join("\n"),
  ]);
  assert.deepEqual(agent.said(), [], "no words until the script says them");
  assert.equal(agent.calls.length, 1, "the next request waits for the result");

  await agent.runScripts();
  assert.deepEqual(agent.said(), ["Looking."]);
  assert.equal(agent.calls.length, 2);
  assert.deepEqual(agent.calls[1].body.input.slice(1), [
    { role: "user", content: "do two things" },
    // the model's own output items, verbatim: its one block
    ...answerItems({ say: "Looking.", script }),
    // the result begins with its number: the offset of its settled fact
    {
      role: "developer",
      content: `Result of script 1:\n${agent.resultHead(0)}\n{"a":1,"b":{"path":"/agents/test"}}`,
    },
  ]);
  await agent.runScripts();
  assert.deepEqual(agent.said(), ["Looking.", "Both done."]);
  assert.deepEqual((await agent.state()).scriptCalls, []);
  assert.deepEqual(agent.invalidFacts(), []);
});

test("a script that returns nothing asks for no further request; one that fails does", async () => {
  const agent = agentOnALog({
    itx: { send: async () => {} },
    model: (_call, calls) =>
      openai(
        [
          { say: "Answer 1.", script: "await itx.send()" },
          { script: "await itx.x()" },
          {}, // silence
        ][calls.length - 1],
      ),
  });
  await agent.say("send it");
  assert.equal(agent.calls.length, 1);
  const state = await agent.state();
  assert.equal(state.items.at(-1)?.text, "Result of script 1:\n(it returned nothing)");
  assert.deepEqual(state.obligations, []);

  await agent.say("again");
  assert.equal(agent.calls.length, 3);
  // a failure says what its kind means for what already ran
  assert.equal(
    agent.calls[2].body.input.at(-1).content,
    `Result of script 1:\n${agent.resultHead(1)} The script failed (runtime): itx.x is not a function\n` +
      "It threw: anything before the throw ran. Look at the state before you try again.",
  );
});

test("text after the block: the block runs, and a note for next time says the rule; the note starts no request", async () => {
  const script = [
    'itx.append({ type: "events.iterate.com/agent/summary-updated", payload: { activity: "Greeting" } });',
    'itx.append({ type: "events.iterate.com/agent-ui/message-sent", payload: { message: "Hi." } });',
  ].join("\n");
  const raw = `<codemode>\n${script}\n</codemode>\nI hope that helps.`;
  const agent = agentOnALog({
    model: (_call, calls) => openai(calls.length === 1 ? { raw } : { say: "Again." }),
  });
  await agent.say("hello");
  assert.deepEqual(agent.scripts(), [script]);
  // the status and the words are the script's own appends, not awaited, and both landed
  const [summary] = agent.durable("events.iterate.com/agent/summary-updated");
  assert.deepEqual(summary.payload, { activity: "Greeting" });
  assert.deepEqual(agent.said(), ["Hi."]);
  assert.equal(agent.calls.length, 1, "the note asks for no request");

  await agent.say("and?");
  const told = agent.calls[1].body.input.slice(-3);
  assert.deepEqual(told, [
    { role: "developer", content: "Result of script 1:\n(it returned nothing)" },
    {
      role: "developer",
      content:
        "Your last response had text after its closing `</codemode>` line. Only a single `<codemode>` block is allowed per response, with nothing before or after it: its script ran, and that text reached nobody.",
    },
    { role: "user", content: "and?" },
  ]);
  assert.deepEqual(agent.invalidFacts(), []);
});

test("a response that is not one block runs nothing: the model is told why and asked again", async () => {
  const cases = [
    [
      "Sure.\n<codemode>\nreturn 1\n</codemode>",
      "it began with words, not with the line `<codemode>`",
    ],
    ["Hello. Write a <codemode> tag to run code.", "it held no `<codemode>` block"],
    ['<codemode status="Counting">\nreturn 1\n</codemode>', "its `<codemode>` tag had attributes"],
    [
      "<codemode>\nreturn 1\n</codemode>\n<codemode>\nreturn 2\n</codemode>",
      "it held a second `<codemode>` block",
    ],
    [
      "<codemode>\nreturn 1\n</codemode><codemode>\nreturn 2\n</codemode>",
      "it held a second `<codemode>` block",
    ],
    ["<codemode>\nreturn 1", "its `<codemode>` block was never closed"],
    ["<codemode>\n</codemode>", "its `<codemode>` block was empty"],
  ];
  for (const [raw, problem] of cases) {
    const agent = agentOnALog({
      model: (_call, calls) => openai(calls.length === 1 ? { raw } : { say: "Fixed." }),
    });
    await agent.say("go");
    assert.equal(agent.calls.length, 2, `a new request at once: ${problem}`);
    assert.deepEqual(agent.calls[1].body.input.at(-1), {
      role: "developer",
      content: `Nothing of your last response ran: ${problem}.\nA response is exactly one \`<codemode>\` block and nothing else: its first line is \`<codemode>\`, with no attributes, and its last line is \`</codemode>\`. To do nothing, answer with nothing.`,
    });
    assert.equal(
      agent.durable("events.iterate.com/itx/run-requested").length,
      1,
      "only the good one ran",
    );
    assert.deepEqual(agent.said(), ["Fixed."]);
    assert.equal(
      (await agent.state()).failedLlmRequestsInARow.answer,
      0,
      "a good one starts the count over",
    );
  }
  // a `</codemode>` line inside a template literal does not cut the script: the LAST one ends it
  const literal = "const end = `\n</codemode>\n`;\nreturn end.length";
  const agent = agentOnALog({
    model: (_call, calls) => openai(calls.length === 1 ? { script: literal } : {}),
  });
  await agent.say("go");
  assert.deepEqual(agent.scripts(), [literal]);
});

test("`maxAttempts` responses in a row that break the rule pause the agent with the reason", async () => {
  const agent = agentOnALog({ model: () => openai({ raw: "Hello there." }) });
  await agent.say("hello");
  assert.equal(agent.calls.length, 3);
  assert.equal(agent.durable("events.iterate.com/itx/run-requested").length, 0);
  assert.deepEqual(agent.said(), []);
  const [paused] = agent.durable("events.iterate.com/agent/paused");
  assert.equal(
    paused.payload?.reason,
    "LLM requests failed: a response broke the one-block rule: Nothing of your last response ran: it held no `<codemode>` block.",
  );
  // an input from outside ends the pause, as for any failure
  assert.deepEqual((await agent.state()).obligations, []);
});

test("an empty response is silence: nothing runs, nothing is said, no note", async () => {
  for (const raw of ["", "  \n\t\n"]) {
    const agent = agentOnALog({ model: () => openai({ raw }) });
    await agent.say("thanks, bye");
    assert.equal(agent.calls.length, 1);
    assert.equal(agent.durable("events.iterate.com/itx/run-requested").length, 0);
    const state = await agent.state();
    assert.deepEqual(state.pendingTriggerOffsets, []);
    assert.deepEqual(
      state.items.map((item) => item.tag),
      ["words", "llm-response"],
    );
    assert.equal(state.totals.silentLlmResponses, 1);
    assert.deepEqual(state.obligations, []);
  }
});

// ── the other providers, and a change of model ──

test("Anthropic: its body, its stream, its cache counts, and a script's result in the next request", async () => {
  const usage = { input: 1_000, cached: 900, output: 30 };
  const agent = agentOnALog({
    config: { llm: { model: "anthropic/claude-opus-5.5" } },
    model: (_call, calls) =>
      calls.length === 1
        ? anthropic({ say: "Hi.", script: "return 1", usage })
        : anthropic({ say: "One." }),
  });
  await agent.say("hello");
  const { body } = agent.calls[0];
  assert.equal(agent.calls[0].model, "anthropic/claude-opus-5.5");
  assert.equal(body.model, "claude-opus-5.5");
  assert.equal(body.max_tokens, 8_192);
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(body.messages, [
    {
      role: "user",
      content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
    },
  ]);
  assert.equal(body.tools, undefined);

  const [settled] = agent.durable("events.iterate.com/llm-request/settled");
  const result = settled.payload?.result;
  // the request maker gives the text as it came; the agent reads the block out of it
  const block = written({ say: "Hi.", script: "return 1" });
  assert.deepEqual(result.providerItems, [{ type: "text", text: block }]);
  assert.equal(agent.scripts()[0], block.split("\n").slice(1, -1).join("\n"));
  // `inputTokens` is every input token; Anthropic counts the cached ones beside
  assert.equal(result.usage.inputTokens, 1_000);
  assert.equal(result.usage.cachedInputTokens, 900);
  assert.equal(result.usage.costUsd, (100 * 3 + 900 * 0.3 + 30 * 15) / 1e6);

  // the script ran at once, as the platform runs it
  assert.deepEqual(agent.calls[1].body.messages.slice(1), [
    { role: "assistant", content: result.providerItems },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Result of script 1:\n${agent.resultHead(0)}\n1`,
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ]);
  assert.deepEqual(agent.invalidFacts(), []);
});

test("Google: one JSON answer, its parts given back with their signatures", async () => {
  const agent = agentOnALog({
    config: { llm: { model: "google/gemini-3.8-flash" } },
    model: (_call, calls) =>
      calls.length === 1 ? google({ script: "return 1" }) : google({ say: "One." }),
  });
  await agent.say("hello");
  const { body } = agent.calls[0];
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "hello" }] }]);
  assert.equal(body.tools, undefined);
  assert.ok(body.systemInstruction.parts[0].text.length > 0);
  assert.equal(agent.scripts()[0], "return 1");
  assert.deepEqual(agent.calls[1].body.contents.slice(1), [
    {
      role: "model",
      parts: [{ text: "<codemode>\nreturn 1\n</codemode>", thoughtSignature: "sig" }],
    },
    { role: "user", parts: [{ text: `Result of script 1:\n${agent.resultHead(0)}\n1` }] },
  ]);
  assert.deepEqual(agent.said(), ["One."]);
  assert.deepEqual(agent.invalidFacts(), []);
});

test("Grok (xAI), through Chat Completions: the text in pieces, the counts in a last chunk", async () => {
  const price = { input: 1.25, cachedInput: 0.2, cacheWriteInput: 1.25, output: 2.5 };
  const usage = { input: 200, cached: 100, output: 20 };
  const agent = agentOnALog({
    // a new provider's model gets its price by config: the contract knows none of its models
    config: { llm: { model: "xai/grok-4.3" }, prices: { "xai/grok-4.3": price } },
    model: (_call, calls) =>
      calls.length === 1
        ? xai({ say: "Looking.", script: "return 6 * 7", usage })
        : xai({ say: "It is 42." }),
  });
  await agent.say("what is six times seven?");
  const { model, body } = agent.calls[0];
  // through the same gateway call as every other provider, in xAI's own format
  assert.equal(model, "xai/grok-4.3");
  assert.equal(body.messages[0].role, "system");
  assert.deepEqual(body.messages.slice(1), [{ role: "user", content: "what is six times seven?" }]);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.tools, undefined);
  const [sent] = agent.durable("events.iterate.com/chat-completions/request-started");
  assert.equal(sent.payload?.inputField, "messages");

  const [settled] = agent.durable("events.iterate.com/llm-request/settled");
  const result = settled.payload?.result;
  assert.match(agent.scripts()[0], /\nreturn 6 \* 7$/);
  assert.deepEqual(result.usage, {
    inputTokens: 200,
    outputTokens: 20,
    cachedInputTokens: 100,
    reasoningOutputTokens: 0,
    costUsd: (100 * 1.25 + 100 * 0.2 + 20 * 2.5) / 1e6,
  });

  // the next request gives Grok its own message back, and the script's numbered result
  assert.deepEqual(agent.calls[1].body.messages.slice(2), [
    { role: "assistant", content: written({ say: "Looking.", script: "return 6 * 7" }) },
    { role: "user", content: `Result of script 1:\n${agent.resultHead(0)}\n42` },
  ]);
  assert.deepEqual(agent.said(), ["Looking.", "It is 42."]);
  assert.deepEqual(agent.invalidFacts(), []);
});

test("an API shape written here: one more request maker beside the four, and one config fact; the agent does not change", async () => {
  // An API nobody has heard of. Its format: the conversation is `lines`, an answer is one event.
  const parrot = {
    name: "parrot-lines",
    direct: { path: () => "/lines", modelInBody: true },
    filePart: () => null,
    body: ({ instructions, items }) => ({
      bodyWithoutInput: { preamble: instructions },
      inputField: "lines",
      input: items.map((item) => `${item.role}: ${item.text}`),
    }),
    read(response, event) {
      response.text += String(event.say);
      response.usage = { inputTokens: 7, outputTokens: 3 };
      response.done = true;
    },
  };
  const config = {
    llm: { model: "parrot/polly-1" },
    llmProviders: { parrot: { api: "parrot-lines" } },
  };
  const agent = agentOnALog({
    apis: [parrot],
    config,
    model: (call) =>
      Response.json({ say: written({ say: `You said: ${call.body.lines.at(-1)}` }) }),
  });
  await agent.say("hello");
  // the request maker did the rest: the gateway call, the attempt's facts, the settlement
  const [call] = agent.calls;
  assert.equal(call.model, "parrot/polly-1");
  assert.deepEqual(call.body.lines, ["user: hello"]);
  const [started] = agent.durable("events.iterate.com/llm-request/attempt-started");
  assert.equal(started.payload?.transport, "gateway");
  assert.equal(started.payload?.api, "parrot-lines");
  // the API shape has a namespace of its own, made from its name: it holds the bytes
  const [sent] = agent.durable(`events.iterate.com/${parrot.name}/request-started`);
  assert.equal(sent.payload?.inputField, "lines");
  assert.equal(sent.payload?.bodySha256, sha256(JSON.stringify(call.body)));
  const [settled] = agent.durable("events.iterate.com/llm-request/settled");
  // a model with no price is counted in tokens, not in dollars
  assert.deepEqual(settled.payload.result.usage, {
    inputTokens: 7,
    outputTokens: 3,
  });
  const [words] = agent.durable("events.iterate.com/agent-ui/message-sent");
  assert.equal(words.payload?.message, "You said: user: hello");

  // the same API with a way of its own to its model: no gateway call, and the fact says so
  const byPigeon = {
    ...parrot,
    transport: async () => ({
      name: "carrier-pigeon",
      async *events(body) {
        yield { say: written({ say: `By pigeon: ${body.lines.length} lines.` }) };
      },
    }),
  };
  const direct = agentOnALog({
    apis: [byPigeon],
    config,
    model: () => assert.fail("the gateway is not used"),
  });
  await direct.say("hello");
  const [flown] = direct.durable("events.iterate.com/llm-request/attempt-started");
  assert.equal(flown.payload?.transport, "carrier-pigeon");
  const [carried] = direct.durable("events.iterate.com/agent-ui/message-sent");
  assert.equal(carried.payload?.message, "By pigeon: 1 lines.");
  assert.deepEqual([...agent.invalidFacts(), ...direct.invalidFacts()], []);
});

test("a request no processor makes: after `llmProviderWaitMs` the agent settles it itself, and the agent pauses with the reason", async () => {
  const agent = agentOnALog({
    config: { llm: { model: "nobody/x-1" } },
    model: () => assert.fail("no request leaves"),
  });
  await agent.say("hello");
  // the agent cannot know that no processor is there: it waits, by a timer in the log
  assert.equal(agent.durable("events.iterate.com/llm-request/settled").length, 0);
  await agent.fire("llm-request/requested:answer/1/wait");
  const [settled] = agent.durable("events.iterate.com/llm-request/settled");
  const errorMessage =
    'no processor made the request for nobody/x-1 within 10 s. Is a processor for the API of the provider "nobody" (config.llmProviders.nobody.api) loaded in this context?';
  assert.deepEqual(settled.payload?.result, {
    status: "failed",
    failureKind: "refused",
    errorMessage,
  });
  // no bytes left, so there is no sent fact
  assert.equal(agent.durable("events.iterate.com/llm-request/attempt-started").length, 0);
  assert.equal((await agent.state()).paused?.reason, `LLM requests failed: ${errorMessage}`);
  assert.deepEqual(agent.invalidFacts(), []);
});

test("a request maker that is not loaded: the same, for a provider whose API shape has no facet", async () => {
  const agent = agentOnALog({
    withoutApis: ["anthropic-messages"],
    config: { llm: { model: "anthropic/claude-opus-5.5" } },
    model: () => assert.fail("no request leaves"),
  });
  await agent.say("hello");
  await agent.fire("llm-request/requested:answer/1/wait");
  const [settled] = agent.durable("events.iterate.com/llm-request/settled");
  assert.match(String(settled.payload.result.errorMessage), /anthropic/);
});

test("a server in a basement: one config fact, and its Chat Completions are asked straight there, through the egress", async () => {
  const seen = [];
  const agent = agentOnALog({
    config: {
      llm: { model: "basement/llama-5" },
      llmProviders: {
        basement: {
          api: "chat-completions",
          baseUrl: "https://llm.basement.example/v1/",
          headers: { authorization: 'Bearer getSecret("/secrets/basement")' },
        },
      },
    },
    model: () => assert.fail("the gateway is not used"),
    fetch: async (request) => {
      seen.push({
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.json(),
      });
      return xai({ say: "Hello from the basement." });
    },
  });
  await agent.say("hello");
  const [asked] = seen;
  assert.equal(asked.url, "https://llm.basement.example/v1/chat/completions");
  // the secret's placeholder goes as it is: the egress puts the secret in its place
  assert.equal(asked.headers.authorization, 'Bearer getSecret("/secrets/basement")');
  assert.equal(asked.body.model, "llama-5");
  assert.deepEqual(asked.body.messages.at(-1), { role: "user", content: "hello" });
  const [sent] = agent.durable("events.iterate.com/llm-request/attempt-started");
  assert.equal(sent.payload?.transport, "direct");
  const [words] = agent.durable("events.iterate.com/agent-ui/message-sent");
  assert.equal(words.payload?.message, "Hello from the basement.");
  // the other providers keep their API shapes: the config merges by provider
  const { llmProviders } = (await agent.state()).config;
  assert.deepEqual(Object.keys(llmProviders).sort(), [
    "anthropic",
    "basement",
    "google",
    "openai",
    "xai",
  ]);
  assert.deepEqual(agent.invalidFacts(), []);
});

/** OpenAI straight at its own address, paid by a ChatGPT plan: the provider of the next three tests. */
const openaiByPlan = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  headers: { authorization: 'Bearer getSecret("/secrets/chatgpt", { field: "accessToken" })' },
};

/** An answer with no content-type, as OpenAI sends a ChatGPT plan token's stream. */
const withNoContentType = (text) => new Response(new TextEncoder().encode(text));

test("a ChatGPT plan's token straight to OpenAI: its stream has no content-type and is read as server-sent events, and the request names its session", async () => {
  const seen = [];
  const agent = agentOnALog({
    config: { llmProviders: { openai: openaiByPlan } },
    model: () => assert.fail("the gateway is not used"),
    fetch: async (request) => {
      seen.push({ headers: Object.fromEntries(request.headers), body: await request.json() });
      // as OpenAI sends it: an `event:` line and a `data:` line for each event
      const events = openaiEvents({ say: "Hello from the plan." });
      return withNoContentType(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      );
    },
  });
  await agent.say("hello");
  assert.deepEqual(agent.said(), ["Hello from the plan."]);
  const [sent] = agent.durable("events.iterate.com/llm-request/attempt-started");
  assert.equal(sent.payload?.transport, "direct");
  // the session is the agent's cache key: over HTTP a plan's token reads the prompt cache only
  // with it, and only with the prompt as the first input item
  const [asked] = seen;
  assert.equal(asked.headers.session_id, "/agents/test");
  assert.equal(asked.body.prompt_cache_key, "/agents/test");
  assert.equal(asked.body.instructions, undefined);
  assert.equal(asked.body.input[0].role, "developer");
  assert.deepEqual(agent.invalidFacts(), []);
});

test("an answer with no content-type that is one JSON body is read as JSON", async () => {
  const agent = agentOnALog({
    config: { llmProviders: { openai: openaiByPlan } },
    model: () => assert.fail("the gateway is not used"),
    // every event of the answer in one JSON array
    fetch: async () =>
      withNoContentType(`\n${JSON.stringify(openaiEvents({ say: "Hello in one body." }))}`),
  });
  await agent.say("hello");
  assert.deepEqual(agent.said(), ["Hello in one body."]);
  assert.deepEqual(agent.invalidFacts(), []);
});

test("a cache key that a header cannot hold goes escaped in `session_id`, and a provider's own header wins", async () => {
  const seen = [];
  const asks = (provider) =>
    agentOnALog({
      config: { llm: { promptCacheKey: "/agents/zoë ☃" }, llmProviders: { openai: provider } },
      model: () => assert.fail("the gateway is not used"),
      fetch: async (request) => {
        seen.push(request.headers.get("session_id"));
        return openai({ say: "Hello." });
      },
    }).say("hello");
  await asks(openaiByPlan);
  await asks({ ...openaiByPlan, headers: { ...openaiByPlan.headers, session_id: "my-own" } });
  assert.deepEqual(seen, ["/agents/zo%C3%AB%20%E2%98%83", "my-own"]);
});

test("an AI binding by expression: one config fact, and the requests go through its `run`, not `itx.ai`", async () => {
  const lent = [];
  const agent = agentOnALog({
    config: {
      llmProviders: {
        openai: { api: "openai-responses", cloudflareAiBinding: "itx.iterateCloud.ai" },
      },
    },
    model: () => assert.fail("`itx.ai` is not used"),
    roots: {
      iterateCloud: {
        ai: {
          run: async (model, body, options) => {
            lent.push({ model, body, options });
            return openai({ say: "Hello from the Cloud." });
          },
        },
      },
    },
  });
  await agent.say("hello");
  assert.equal(lent.length, 1);
  // the binding gets what `itx.ai` gets: the model's whole name, the body, the raw stream asked for
  assert.equal(lent[0].model, "openai/gpt-6.2-sol");
  assert.deepEqual(lent[0].body.input.at(-1), { role: "user", content: "hello" });
  assert.equal(lent[0].options.returnRawResponse, true);
  assert.deepEqual(Object.keys(lent[0].options.gateway.metadata), [
    "streamPath",
    "context",
    "llmRequestOffset",
  ]);
  const [sent] = agent.durable("events.iterate.com/llm-request/attempt-started");
  assert.equal(sent.payload?.transport, "gateway");
  const [words] = agent.durable("events.iterate.com/agent-ui/message-sent");
  assert.equal(words.payload?.message, "Hello from the Cloud.");
  assert.deepEqual(agent.invalidFacts(), []);
});

test("a fetcher by expression: the requests to a `baseUrl` go through its `fetch`, not the facet's own", async () => {
  const seen = [];
  const fetchThrough = (through) => async (request) => {
    const body = await request.json();
    seen.push({
      through,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      model: body.model,
    });
    return xai({ say: `Hello through ${through}.` });
  };
  const provider = (fetcher) => ({
    api: "chat-completions",
    baseUrl: "https://llm.example/v1",
    fetcher,
    headers: { "x-team": "lab" },
  });
  const agent = agentOnALog({
    config: {
      llm: { model: "other/llama-5" },
      llmProviders: {
        // a server of another mind: `minds.get(…).fetch` signs the request as this mind
        other: provider('itx.minds.get("llm.example")'),
        // the context's own `itx.fetch`
        own: provider("itx"),
      },
    },
    model: () => assert.fail("no AI binding is used"),
    fetch: () => assert.fail("the facet's own fetch is not used"),
    roots: {
      minds: { get: (domain) => ({ fetch: fetchThrough(`minds.get(${domain})`) }) },
      fetch: fetchThrough("itx.fetch"),
    },
  });
  await agent.say("hello");
  await agent.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "own/llama-5" } } },
  });
  await agent.say("hello again");
  assert.deepEqual(
    seen.map(({ through, url, model }) => ({ through, url, model })),
    [
      {
        through: "minds.get(llm.example)",
        url: "https://llm.example/v1/chat/completions",
        model: "llama-5",
      },
      { through: "itx.fetch", url: "https://llm.example/v1/chat/completions", model: "llama-5" },
    ],
  );
  assert.equal(seen[0].headers["x-team"], "lab");
  assert.deepEqual(
    agent
      .durable("events.iterate.com/llm-request/attempt-started")
      .map((sent) => sent.payload?.transport),
    ["direct", "direct"],
  );
  assert.deepEqual(
    agent
      .durable("events.iterate.com/agent-ui/message-sent")
      .map((words) => words.payload?.message),
    ["Hello through minds.get(llm.example).", "Hello through itx.fetch."],
  );
  assert.deepEqual(agent.invalidFacts(), []);
});

test("several requests at once: one request maker has them all in flight together, and each settles on its own", async () => {
  // Three requests for one API shape in one append, as a council of models would ask them. The
  // request maker needs nothing for it: every request is an attempt of its own.
  const streams = [heldSse(), heldSse(), heldSse()];
  const agent = agentOnALog({ model: (_call, calls) => streams[calls.length - 1].response });
  const asked = (n) => ({
    type: "events.iterate.com/llm-request/requested",
    idempotencyKey: `council/${n}`,
    payload: {
      model: "openai/gpt-6.2-sol",
      expiresAtMs: 600_000,
      purpose: "answer",
      triggerOffset: 0,
      instructions: `You are expert ${n}.`,
      extends: null,
      itemsAdded: [{ atOffset: 1, rank: 0, tag: "words", role: "user", text: "what now?" }],
      promptCacheKey: "/agents/test",
      reasoningEffort: null,
      maxOutputTokens: null,
    },
  });
  await agent.append(asked(1), asked(2), asked(3));
  assert.equal(agent.calls.length, 3, "all three are sent before any answers");
  // (in flight together, they reach the model in any order)
  assert.deepEqual(agent.calls.map((call) => call.body.input[0].content).toSorted(), [
    "You are expert 1.",
    "You are expert 2.",
    "You are expert 3.",
  ]);
  // they answer out of order
  for (const index of [2, 0, 1]) {
    for (const event of openaiEvents({ say: `Expert ${index + 1} says so.` }))
      streams[index].send(event);
    streams[index].end();
    await agent.quiet();
  }
  const settled = agent
    .durable("events.iterate.com/llm-request/settled")
    .map((fact) => fact.payload.result.text);
  assert.deepEqual(
    settled,
    [3, 1, 2].map((n) => written({ say: `Expert ${n} says so.` })),
  );
});

test("the model changes mid-conversation: its own items verbatim, another model's as the text it wrote", async () => {
  const agent = agentOnALog({
    runScriptsByHand: true,
    model: (call) =>
      call.model.startsWith("openai/")
        ? openai({ say: "Looking.", script: "return 1" })
        : anthropic({ say: "It is 1." }),
  });
  await agent.say("look");
  const model = (name) => ({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: name } } },
  });
  await agent.append(model("anthropic/claude-opus-5.5"));
  await agent.runScripts();
  assert.equal(agent.calls[1].model, "anthropic/claude-opus-5.5");
  assert.deepEqual(agent.calls[1].body.messages, [
    { role: "user", content: [{ type: "text", text: "look" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: written({ say: "Looking.", script: "return 1" }) }],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Result of script 1:\n${agent.resultHead(0)}\n1`,
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ]);

  await agent.runScripts();
  await agent.append(model("openai/gpt-6.2-sol"));
  await agent.say("thanks");
  const { input } = agent.calls[2].body;
  // (after the prompt and the first words)
  assert.equal(input[2].type, "message", "OpenAI's own first response is given back verbatim");
  assert.deepEqual(input.slice(-3), [
    { role: "assistant", content: written({ say: "It is 1." }) },
    { role: "developer", content: "Result of script 1:\n(it returned nothing)" },
    { role: "user", content: "thanks" },
  ]);
});

// ── OpenAI's Responses API over a kept WebSocket ──

test("the WebSocket: dialled once, kept between requests, OpenAI's own frames, no HTTP call; its own facts say when it was dialled and when it closed", async () => {
  const dialled = [];
  const { socket, frames } = fakeWebSocket((frame) =>
    openaiEvents({ say: `Answer to ${frame.input.at(-1).content}.` }),
  );
  const webSocket = {
    url: "https://cloud.example/ai-ws/openai/responses",
    authorization: 'Bearer getSecret("/secrets/iterate-cloud")',
  };
  const agent = agentOnALog({
    // the WebSocket is the OpenAI Responses API's own way: configured on the provider
    config: { llmProviders: { openai: { api: "openai-responses", webSocket } } },
    model: () => assert.fail("the HTTP route is not used"),
    openWebSocket: async (url, headers) => {
      dialled.push({ url, headers });
      return socket;
    },
  });
  await agent.say("one");
  await agent.say("two");
  assert.deepEqual(dialled, [
    {
      url: webSocket.url,
      headers: {
        authorization: webSocket.authorization,
        "x-iterate-stream-path": "/agents/test",
        "x-iterate-context": "agent-turn",
      },
    },
  ]);
  assert.deepEqual(
    frames.map((frame) => [frame.type, frame.model, frame.stream]),
    [
      ["response.create", "gpt-6.2-sol", undefined],
      ["response.create", "gpt-6.2-sol", undefined],
    ],
  );
  assert.deepEqual(agent.said(), ["Answer to one.", "Answer to two."]);
  const [first, second] = agent.durable("events.iterate.com/openai-responses/request-started");
  assert.equal(first.payload?.transport, "websocket");
  // the second request's fact repeats nothing: it extends the first (then the answer, its result
  // and the new words)
  assert.equal(second.payload?.extendsRequestStartedOffset, first.offset);
  // (what it shares with the first: the prompt and the first words)
  assert.equal(second.payload?.inputItemCountBefore, 2);
  assert.equal(second.payload.inputItemsAdded.length, 3);
  // the socket's own fact: dialled once for two requests (the test's clock stands still)
  assert.deepEqual(
    agent
      .durable("events.iterate.com/openai-responses/websocket-connected")
      .map((fact) => fact.payload),
    [{ url: webSocket.url, dialMs: 0 }],
  );
  assert.deepEqual(agent.durable("events.iterate.com/openai-responses/websocket-closed"), []);
  assert.deepEqual(agent.invalidFacts(), []);

  // it closes while no request rides it: the next attempt writes that, then dials again
  socket.close();
  await agent.say("three");
  const facts = agent.kinds().filter((kind) => kind.startsWith("openai-responses/websocket"));
  assert.deepEqual(facts, [
    "openai-responses/websocket-connected",
    "openai-responses/websocket-closed",
    "openai-responses/websocket-connected",
  ]);
  const [closed] = agent.durable("events.iterate.com/openai-responses/websocket-closed");
  assert.deepEqual(logged(closed.payload), { url: webSocket.url, requests: 2 });
  assert.equal(dialled.length, 2);
  assert.deepEqual(agent.said(), ["Answer to one.", "Answer to two.", "Answer to three."]);
});

const openaiWebSocket = {
  llmProviders: {
    openai: {
      api: "openai-responses",
      webSocket: { url: "https://cloud.example/ws", authorization: "Bearer x" },
    },
  },
};

test("the WebSocket cannot be dialled: the request goes through `itx.ai.run`", async () => {
  const agent = agentOnALog({
    config: openaiWebSocket,
    model: () => openai({ say: "By HTTP." }),
    openWebSocket: async () => {
      throw new Error("HTTP 403");
    },
  });
  await agent.say("hello");
  assert.equal(
    agent.durable("events.iterate.com/llm-request/attempt-started")[0].payload?.transport,
    "gateway",
  );
  assert.equal(
    agent.durable("events.iterate.com/agent-ui/message-sent")[0].payload?.message,
    "By HTTP.",
  );
  assert.equal(agent.reports[0].event, "agent.websocket-not-opened");
});

test("the WebSocket closes mid-request: the request fails, and the next dials a new socket", async () => {
  let dials = 0;
  const agent = agentOnALog({
    config: openaiWebSocket,
    model: () => assert.fail("the HTTP route is not used"),
    openWebSocket: async () => {
      dials += 1;
      const answered = fakeWebSocket(() => openaiEvents({ say: "Second try." }));
      if (dials > 1) return answered.socket;
      // the first socket closes when the request has reached it, and answers nothing
      const closing = fakeWebSocket(() => {
        closing.socket.close();
        return [];
      });
      return closing.socket;
    },
  });
  await agent.say("hello");
  const [failed] = agent.durable("events.iterate.com/llm-request/settled");
  assert.deepEqual(failed.payload?.result, {
    status: "failed",
    failureKind: "transport",
    errorMessage: "the WebSocket closed",
  });
  await agent.fire("agent/timer");
  assert.equal(dials, 2);
  assert.equal(
    agent.durable("events.iterate.com/agent-ui/message-sent")[0].payload?.message,
    "Second try.",
  );
  // the close is recorded by the attempt it broke, before that attempt's settlement
  const kinds = agent.kinds();
  assert.ok(
    kinds.indexOf("openai-responses/websocket-closed") < kinds.indexOf("llm-request/settled"),
  );
  assert.deepEqual(
    agent
      .durable("events.iterate.com/openai-responses/websocket-closed")
      .map((fact) => logged(fact.payload)),
    [{ url: "https://cloud.example/ws", requests: 1 }],
  );
  assert.equal(agent.durable("events.iterate.com/openai-responses/websocket-connected").length, 2);
});

// ── an interrupt ──

test("an interrupt: the request is cancelled with what it had written, and the next one is told", async () => {
  const held = heldSse();
  const agent = agentOnALog({
    config: { llmRequestPolicy: { behaviour: "interrupt-current-request" } },
    model: (_call, calls) => (calls.length === 1 ? held.response : openai({ say: "Stopping." })),
  });
  await agent.say("write me a long story");
  held.send({ type: "response.output_text.delta", delta: "Once upon a ti" });
  await agent.quiet();
  await agent.say("stop, a short one please");

  const [cancelled, answered] = agent.durable("events.iterate.com/llm-request/settled");
  const result = cancelled.payload?.result;
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "interrupted-by-user-input");
  assert.equal(result.partialText, "Once upon a ti");
  // a cancelled request cost its input: estimated, and said so
  assert.equal(result.usage.estimated, true);
  assert.ok(result.usage.inputTokens > 0 && result.usage.costUsd > 0);
  assert.equal(answered.payload.result.status, "succeeded");

  assert.deepEqual(agent.calls[1].body.input.slice(1), [
    { role: "user", content: "write me a long story" },
    {
      role: "developer",
      content:
        "Your previous response was interrupted by a newer input before it finished. Nothing of it was said or run.\nWhat you had written so far:\nOnce upon a ti",
    },
    { role: "user", content: "stop, a short one please" },
  ]);
  const said = agent
    .durable("events.iterate.com/agent-ui/message-sent")
    .map((words) => words.payload?.message);
  assert.deepEqual(said, ["Stopping."], "nothing of the interrupted response was said");
  assert.deepEqual(agent.invalidFacts(), []);
});

test("words that wait: by default a second message waits for the open request, then gets its own", async () => {
  const held = heldSse();
  const agent = agentOnALog({
    model: (_call, calls) => (calls.length === 1 ? held.response : openai({ say: "Second." })),
  });
  await agent.say("first");
  await agent.say("second");
  assert.equal(agent.calls.length, 1);
  for (const event of openaiEvents({ say: "First." })) held.send(event);
  held.end();
  await agent.quiet();
  assert.equal(agent.calls.length, 2);
  assert.deepEqual(
    agent.calls[1].body.input.slice(1).map((item) => item.type ?? item.content),
    ["first", "message", "Result of script 1:\n(it returned nothing)", "second"],
  );
  assert.deepEqual(agent.said(), ["First.", "Second."]);
});

// ── failures: retry, pause, deadline ──

test("a failing provider: retried after a back-off that doubles, then the agent pauses with the reason", async () => {
  let down = true;
  const agent = agentOnALog({
    model: () =>
      down ? new Response("upstream is down", { status: 503 }) : openai({ say: "Back." }),
  });
  await agent.say("hello");
  const timers = () =>
    agent
      .durable("events.iterate.com/itx/schedule-set")
      .filter((set) => set.payload?.key === "agent/timer");
  assert.deepEqual(
    timers().map((set) => set.payload?.when),
    [{ at: "1970-01-01T00:00:02.000Z" }],
  );
  await agent.fire("agent/timer");
  assert.deepEqual(timers().at(-1)?.payload?.when, { at: "1970-01-01T00:00:06.000Z" });
  await agent.fire("agent/timer");
  assert.equal(agent.calls.length, 3);
  const results = agent
    .durable("events.iterate.com/llm-request/settled")
    .map((settled) => settled.payload?.result);
  assert.deepEqual(results.at(-1), {
    status: "failed",
    failureKind: "provider",
    errorMessage: "HTTP 503: upstream is down",
  });
  const [paused] = agent.durable("events.iterate.com/agent/paused");
  assert.deepEqual(paused.payload, {
    reason: "LLM requests failed: HTTP 503: upstream is down",
    endsAtNextOutsideInput: true,
  });
  // paused: nothing is owed, and no timer is set for a retry that cannot come
  assert.deepEqual((await agent.state()).obligations, []);
  assert.equal(timers().length, 2);

  // An input from outside ends the agent's own pause: a person is there again. The end is a fact
  // that the agent writes, named after the input, and then it asks again.
  down = false;
  const [again] = await agent.append({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "user", content: "are you there?" },
    source: { cause: { chain: "2026-11-21T09:05:00.000Z with a person ~b2", depth: 0 } },
  });
  const [resumed] = agent.durable("events.iterate.com/agent/resumed");
  assert.deepEqual(resumed.payload, { reason: "an input from outside" });
  assert.equal(resumed.idempotencyKey, `agent/resumed:${again.offset}`);
  assert.equal(
    agent.durable("events.iterate.com/agent-ui/message-sent")[0].payload?.message,
    "Back.",
  );
  assert.equal((await agent.state()).paused, null);
  assert.deepEqual(agent.invalidFacts(), []);
});

test("a pause that someone else wrote holds through new words, until someone writes the resume", async () => {
  const agent = agentOnALog({ model: () => openai({ say: "Here." }) });
  await agent.append({ type: "events.iterate.com/agent/paused", payload: { reason: "hold on" } });
  await agent.say("hello");
  assert.equal(agent.calls.length, 0);
  assert.equal(agent.durable("events.iterate.com/agent/resumed").length, 0);
  await agent.append({ type: "events.iterate.com/agent/resumed", payload: {} });
  assert.equal(agent.calls.length, 1);
});

test("a refusal is not retried: a 401, or the gateway's spend rule, pauses the agent at once", async () => {
  for (const refusal of [
    new Response("no", { status: 401 }),
    new Response('{"success":false,"errors":[{"code":2045,"message":"spend limit"}]}', {
      status: 429,
    }),
  ]) {
    const agent = agentOnALog({ model: () => refusal.clone() });
    await agent.say("hello");
    assert.equal(agent.calls.length, 1);
    assert.equal(agent.durable("events.iterate.com/agent/paused").length, 1);
    const [settled] = agent.durable("events.iterate.com/llm-request/settled");
    assert.equal(settled.payload.result.failureKind, "refused");
  }
});

test("the deadline: the scheduler ends a request no one answers, and its attempt stops", async () => {
  const agent = agentOnALog({ model: () => heldSse().response });
  await agent.say("hello");
  await agent.fire("llm-request/requested:answer/1/deadline");
  const state = await agent.state();
  assert.deepEqual(state.llmRequests, []);
  assert.equal(state.failedLlmRequestsInARow.answer, 1);
  assert.equal(state.lastLlmRequestError, "it was cancelled: expired");
  // the attempt that was stopped still writes what it knows, which changes nothing but the cost
  const [late] = agent.durable("events.iterate.com/llm-request/settled");
  assert.deepEqual(late.payload?.result, { status: "cancelled", reason: "expired" });
  assert.deepEqual(owes(state), [], "the retry's timer is set");
  assert.equal(state.timer.atMs, 2_000);
});

test("a provider that goes silent fails the attempt after `streamIdleTimeoutMs`", async () => {
  const agent = agentOnALog({
    config: { llm: { streamIdleTimeoutMs: 30 } },
    model: () => heldSse().response,
  });
  await agent.say("hello");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await agent.quiet();
  const [settled] = agent.durable("events.iterate.com/llm-request/settled");
  assert.deepEqual(settled.payload?.result, {
    status: "failed",
    failureKind: "transport",
    errorMessage: "nothing came for 30 ms",
  });
});

test("the agent's own turns are bounded: it pauses at its limit, and only an input from outside ends that", async () => {
  const agent = agentOnALog({
    runScriptsByHand: true,
    config: { maxLlmRequestsWithoutOutsideInput: 2 },
    model: (_call, calls) => openai({ script: `return ${calls.length}` }, String(calls.length)),
  });
  // The agent's own input, with the cause the platform stamps on every fact. (Written directly: the
  // in-memory log stamps no cause on what a processor appends.)
  const input = (content, chain) => ({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "user", content },
    source: { cause: { chain, depth: 0 } },
  });
  const morning = "2026-11-21T09:00:00.000Z with a person ~a1";
  await agent.append(input("go", morning));
  await agent.runScripts();
  await agent.runScripts();
  assert.equal(agent.calls.length, 2);
  const [paused] = agent.durable("events.iterate.com/agent/paused");
  assert.deepEqual(paused.payload, {
    reason: "2 LLM requests with no input from outside",
    endsAtNextOutsideInput: true,
  });

  // an input that the agent's own chain caused (its script wrote it) ends nothing
  await agent.append(input("a note to myself", morning));
  assert.equal(agent.calls.length, 2);
  // a new chain of causes from outside does, and the agent writes the fact that says so
  await agent.append(input("carry on", "2026-11-21T09:05:00.000Z with a person ~b2"));
  assert.equal(agent.durable("events.iterate.com/agent/resumed").length, 1);
  assert.equal(agent.calls.length, 3);
  assert.equal((await agent.state()).paused, null);
  assert.deepEqual(agent.invalidFacts(), []);
});

// ── crashes ──

test("a death of the host after every commit: the same scripts run once, so the same words are said once", async () => {
  const exchange = async (dieAfterCommit) => {
    const agent = agentOnALog({
      dieAfterCommit,
      config: { llm: { streamIdleTimeoutMs: 100 } },
      // the answer depends on what the request holds, as a model's does, not on how often it was asked
      model: (call) =>
        call.body.input.some((item) => String(item.content).startsWith("Result of script"))
          ? openai({ say: "Both done." })
          : openai({ say: "Looking.", script: "return await Promise.all([1, 2])" }),
    });
    await agent.say("do two things");
    await agent.quiet();
    return {
      commits: agent.commits(),
      said: agent
        .durable("events.iterate.com/agent-ui/message-sent")
        .map((words) => words.payload?.message),
      // a death moves the offset of a later request, so the scope's `llmRequestOffset` is not compared
      ran: agent
        .durable("events.iterate.com/itx/run-requested")
        .map((run) => String(run.payload?.code).replace(/const llmRequestOffset = \d+;/, "")),
      answered: agent
        .durable("events.iterate.com/llm-request/settled")
        .map((settled) => settled.payload.result.text),
      owed: (await agent.state()).obligations,
      invalid: agent.invalidFacts(),
    };
  };
  const { commits, ...undisturbed } = await exchange();
  assert.deepEqual(undisturbed.said, ["Looking.", "Both done."]);
  assert.equal(undisturbed.ran.length, 2);
  // the config, the input, and for each of two requests: the agent's request, the request maker's
  // sent and settled facts, the script's run, its words, its result: 14
  assert.equal(commits, 14);
  for (let commit = 1; commit <= commits; commit++) {
    const { commits: _, ...survived } = await exchange(commit);
    assert.deepEqual(survived, undisturbed, `a death after commit ${commit}`);
  }
});

test("a host that dies `maxAttempts` times mid-request: the request fails, with the count as the reason", async () => {
  // (a dead host's timers die with it; here they run out, so the idle time is short)
  const agent = agentOnALog({
    config: { llm: { streamIdleTimeoutMs: 1_500 } },
    model: () => heldSse().response,
  });
  await agent.say("hello");
  for (const _death of [1, 2, 3]) {
    await agent.wake().revive();
    await agent.quiet();
  }
  const sent = agent
    .durable("events.iterate.com/llm-request/attempt-started")
    .map((fact) => fact.payload?.attempt);
  assert.deepEqual(sent, [0, 1, 2]);
  const [settled] = agent.durable("events.iterate.com/llm-request/settled");
  assert.deepEqual(settled.payload?.result, {
    status: "failed",
    failureKind: "transport",
    errorMessage: "its host died 3 times before the model answered",
  });
  assert.equal((await agent.state()).totals.deadLlmRequestAttempts, 2);
});

// ── a new host: a version bump, a backlog ──

test("a version bump re-reduces the whole log and starts nothing", async () => {
  const agent = agentOnALog({
    model: (_call, calls) =>
      openai(calls.length === 1 ? { say: "Looking.", script: "return 1" } : { say: "One." }),
  });
  await agent.say("look");
  const before = agent.log.events.length;

  class NextVersion extends Agent {
    contract = { ...AgentContract, version: "2" };
  }
  // the same facet storage, so the engine finds a checkpoint of version 1 and re-reduces from 0
  const next = new NextVersion();
  const engine = new ProcessorEngine(next, { stream: agent.log.stream, storage: agent.storage });
  await engine.revive();
  await agent.quiet();
  assert.equal(agent.log.events.length, before);
  const { state } = await engine.snapshot();
  assert.deepEqual(state.obligations, []);
  // the words, two responses and the result of each one's script
  assert.equal(state.items.length, 5);
});

test("a backlog is read, not acted on: a new host on a finished log appends nothing; on an unanswered input, one request", async () => {
  const agent = agentOnALog({
    model: (_call, calls) => openai({ say: `Answer ${calls.length}.` }),
  });
  await agent.say("one");
  await agent.say("two");
  const finished = agent.log.events.length;
  await agent.wake().revive();
  await agent.quiet();
  assert.equal(agent.log.events.length, finished);

  // three inputs arrive while no host lives: the next host answers them with one request
  agent.log.engines.length = 0;
  for (const content of ["three", "four", "five"])
    agent.log.stream.append({
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", content },
    });
  await agent.wake().revive();
  await agent.quiet();
  assert.equal(agent.calls.length, 3);
  const words = agent.calls[2].body.input.filter((item) => item.role === "user");
  assert.deepEqual(
    words.map((item) => item.content),
    ["one", "two", "three", "four", "five"],
  );
});

// ── summaries ──

const isSummaryAsk = (call) =>
  String(call.body.input.at(-1).content).startsWith("Write the summary");

test("rent or purchase: when the rent paid reaches a summary's cost, a summary replaces the history", async () => {
  const agent = agentOnALog({
    config: { summary: { minInputTokens: 100, keepNewestItems: 0, rentFactor: 0.3 } },
    model: (call) =>
      isSummaryAsk(call)
        ? openai({ raw: "The user greeted; nothing is open." })
        : openai({ say: "Hello.", usage: { input: 100_000, cached: 100_000, output: 10 } }),
  });
  await agent.say("hello");
  // reading 100,000 tokens again cost $0.01; a summary costs about $0.03, and at a rent factor of
  // 0.3 it pays at $0.009: as soon as the response's script has its result
  assert.equal(agent.calls.length, 2);
  const [answer, summary] = agent.durable("events.iterate.com/llm-request/requested");
  assert.equal(answer.payload?.purpose, "answer");
  assert.deepEqual(
    { purpose: summary.payload?.purpose, through: summary.payload?.replacesHistoryThroughOffset },
    { purpose: "summary", through: answer.offset },
  );
  // the summary request reads the same history with the same instructions and tools: a cache hit
  assert.deepEqual(agent.calls[1].body.input.slice(1, -1), [
    { role: "user", content: "hello" },
    ...answerItems({ say: "Hello." }),
    { role: "developer", content: "Result of script 1:\n(it returned nothing)" },
  ]);
  assert.deepEqual(agent.calls[1].body.tools, agent.calls[0].body.tools);
  assert.deepEqual(agent.calls[1].body.input[0], agent.calls[0].body.input[0]);

  const state = await agent.state();
  assert.deepEqual(
    state.items.map((item) => [item.atOffset, item.tag, item.text]),
    [
      [
        answer.offset,
        "summary",
        "Summary of the conversation before this point:\nThe user greeted; nothing is open.",
      ],
    ],
  );
  assert.equal(state.history.rentUsd, 0);
  await agent.say("and now?");
  assert.deepEqual(agent.calls[2].body.input.slice(1), [
    {
      role: "developer",
      content: "Summary of the conversation before this point:\nThe user greeted; nothing is open.",
    },
    { role: "user", content: "and now?" },
  ]);
  assert.deepEqual(agent.invalidFacts(), []);
});

test("a cold read is not rent, and a long system prompt is not history: neither pays for a summary", async () => {
  // tokens the provider had not read before are no rent: so the first read after a summary, which
  // is cold, never pays for the next summary
  const cold = agentOnALog({
    config: { summary: { minInputTokens: 100, keepNewestItems: 0, rentFactor: 0.3 } },
    model: (call) =>
      isSummaryAsk(call)
        ? openai({ raw: "A summary." })
        : openai({ say: "Hello.", usage: { input: 100_000, cached: 0, output: 10 } }),
  });
  await cold.say("hello");
  assert.equal(cold.calls.length, 1);
  assert.equal((await cold.state()).history.rentUsd, 0);

  // the instructions are read by every request whatever is summarised: 400,000 characters of them
  // are 100,000 tokens that no summary can replace, so the history is still too small
  const prompted = agentOnALog({
    config: {
      instructions: "x".repeat(400_000),
      summary: { minInputTokens: 100, keepNewestItems: 0, rentFactor: 0.3 },
    },
    model: (call) =>
      isSummaryAsk(call)
        ? openai({ raw: "A summary." })
        : openai({ say: "Hello.", usage: { input: 100_050, cached: 100_000, output: 10 } }),
  });
  await prompted.say("hello");
  assert.equal(prompted.calls.length, 1);
});

test("before the cache is dropped: a timer two minutes before, and a summary if a cold read would cost more", async () => {
  const agent = agentOnALog({
    config: { summary: { minInputTokens: 100, keepNewestItems: 0, rentFactor: 1_000 } },
    model: (call) =>
      isSummaryAsk(call)
        ? openai({ raw: "A summary." })
        : openai({ say: "Hello.", usage: { input: 100_000, cached: 99_000, output: 10 } }),
  });
  await agent.say("hello");
  assert.equal(agent.calls.length, 1, "the rent is small: no summary yet");
  const state = await agent.state();
  assert.equal(state.timer.atMs, 28 * 60_000);
  await agent.fire("agent/timer");
  assert.equal(agent.calls.length, 2);
  assert.ok(isSummaryAsk(agent.calls[1]));
  const after = await agent.state();
  assert.equal(after.items[0].tag, "summary");
  assert.deepEqual(after.obligations, [], "summarised: no timer, no cache to lose");
});

test("the conversation no longer fits the model: a summary of the older half first, then the answer", async () => {
  let full = false;
  const agent = agentOnALog({
    model: (call, calls) => {
      if (isSummaryAsk(call)) return openai({ raw: "The older half, summarised." });
      if (full && !call.body.input.some((item) => String(item.content).startsWith("Summary of")))
        return new Response('{"error":{"code":"context_length_exceeded","message":"too long"}}', {
          status: 400,
        });
      return openai({ say: `Answer ${calls.length}.` });
    },
  });
  await agent.say("one");
  await agent.say("two");
  full = true;
  await agent.say("three");
  const kinds = agent.durable("events.iterate.com/llm-request/settled").map((settled) => {
    const result = settled.payload?.result;
    return result.failureKind ?? result.status;
  });
  assert.deepEqual(kinds, ["succeeded", "succeeded", "context-window", "succeeded"]);
  const summary = agent.durable("events.iterate.com/llm-request/requested").at(-1);
  assert.equal(summary?.payload?.purpose, "summary");
  await agent.fire("agent/timer");
  const answer = agent.calls.at(-1)?.body.input;
  // (after the prompt)
  assert.equal(
    answer[1].content,
    "Summary of the conversation before this point:\nThe older half, summarised.",
  );
  assert.deepEqual(answer.at(-1), { role: "user", content: "three" });
  assert.equal((await agent.state()).contextWindowExceeded, false);
});

// ── a request off any earlier request ──

test("a `side` request, the small fact, off the second of seven requests: its base's instructions, items and response, the new input, the same bytes and key, and the agent adopts nothing", async () => {
  const side = "What did you count, in one word?";
  const agent = agentOnALog({
    model: (call) =>
      JSON.stringify(call.body.input).includes(side)
        ? openai({ raw: "Seven." })
        : openai({ script: "const counted = 1;" }),
  });
  for (const word of ["one", "two", "three", "four", "five", "six", "seven"]) await agent.say(word);
  const requests = agent.durable("events.iterate.com/llm-request/requested");
  assert.equal(requests.length, 7);
  const second = requests[1];
  const before = await agent.state();
  const runs = agent.durable("events.iterate.com/itx/run-requested").length;

  await agent.append(sideRequest(second, { text: side }));
  const sideCall = agent.calls.at(-1);
  const secondCall = agent.calls[1];
  // its conversation: the second request's items, then its response, then the new input
  assert.deepEqual(sideCall.body.input, [
    ...secondCall.body.input,
    ...answerItems({ script: "const counted = 1;" }),
    { role: "user", content: side },
  ]);
  // its body begins with the bytes of the second request's body, and carries the same key
  const secondBytes = JSON.stringify(secondCall.body);
  assert.ok(JSON.stringify(sideCall.body).startsWith(secondBytes.slice(0, -"]}".length)));
  assert.deepEqual(sideCall.body.input[0], secondCall.body.input[0]);
  assert.equal(sideCall.body.prompt_cache_key, "/agents/test");
  // the request maker read its base from the log: it holds only the newest two
  const settled = agent.durable("events.iterate.com/llm-request/settled").at(-1);
  assert.equal(settled.payload.result.text, "Seven.");

  // the agent starts no script for it, holds no request for it and counts nothing
  const after = await agent.state();
  assert.equal(agent.durable("events.iterate.com/itx/run-requested").length, runs);
  assert.deepEqual(after.llmRequests, []);
  assert.deepEqual(after.llmRequestCounts, before.llmRequestCounts);
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.llmRequestBases, before.llmRequestBases);
  assert.equal(after.totals.llmRequests, before.totals.llmRequests);
  assert.deepEqual(agent.invalidFacts(), []);
});

test("a script appends a side request, the small fact, and waits for its settled fact with `itx.waitForEvent`: the answer is the script's value", async () => {
  // the two lines of README.md, "A request off any request": `llmRequestOffset` is in the scope
  const ask = [
    'const [request] = await itx.append({ type: "events.iterate.com/llm-request/requested", payload: { purpose: "side", model: "openai/gpt-6.2-sol", extends: { llmRequestOffset, itemCount: null, response: true }, itemsAdded: [{ role: "user", text: "the side question" }] } });',
    'const settled = await itx.waitForEvent({ type: "events.iterate.com/llm-request/settled", payload: { llmRequestOffset: request.offset }, afterOffset: request.offset, timeoutMs: 120000 });',
    "return settled.payload.result.text;",
  ].join("\n");
  const agent = agentOnALog({
    // by the newest input
    model: (call) => {
      const newest = call.body.input.at(-1).content;
      if (newest === "the side question") return openai({ raw: "forty-two" });
      if (newest === "hello") return openai({ script: "const nothing = 0;" });
      if (newest === "ask on the side") return openai({ script: ask });
      return openai({});
    },
  });
  await agent.say("hello");
  await agent.say("ask on the side");
  const requests = agent.durable("events.iterate.com/llm-request/requested");
  const [side] = requests.filter((request) => request.payload?.purpose === "side");
  // the request whose answer held the script
  const asked = requests.filter((request) => request.payload?.purpose !== "side")[1];
  assert.deepEqual(side.payload?.extends, {
    llmRequestOffset: asked.offset,
    itemCount: null,
    response: true,
  });
  // its settled fact holds the answer, and the script returned it
  const settled = agent
    .durable("events.iterate.com/llm-request/settled")
    .find((fact) => fact.payload?.llmRequestOffset === side.offset);
  assert.equal(settled.payload.result.text, "forty-two");
  const runs = agent.durable("events.iterate.com/itx/run-settled");
  assert.deepEqual(runs.at(-1)?.payload?.settlement, { status: "succeeded", result: "forty-two" });
  // the model reads the value in its next request
  assert.match(agent.calls.at(-1).body.input.at(-1).content, /\[result \d+\]\nforty-two$/);
  assert.deepEqual(
    agent.calls.map((call) => call.body.input.at(-1).content.split("\n")[0]),
    ["hello", "ask on the side", "the side question", "Result of script 1:"],
  );
  assert.deepEqual(agent.invalidFacts(), []);
});

test("a base that is no request, and a base with no response when one is asked for: refused, with the reason", async () => {
  const agent = agentOnALog({
    model: () => new Response('{"error":"bad request"}', { status: 400 }),
  });
  const [input] = await agent.say("hello");
  const [failed] = agent.durable("events.iterate.com/llm-request/requested");
  await agent.append(sideRequest(input, { text: "a" }));
  await agent.append(sideRequest(failed, { text: "b" }));
  const refusals = agent
    .durable("events.iterate.com/llm-request/settled")
    .slice(-2)
    .map((settled) => settled.payload?.result);
  assert.deepEqual(
    refusals.map((result) => [result.status, result.failureKind]),
    [
      ["failed", "refused"],
      ["failed", "refused"],
    ],
  );
  assert.match(String(refusals[0].errorMessage), /at offset 1, is not an LLM request/);
  assert.match(String(refusals[1].errorMessage), /has no response: it did not succeed/);
  // neither reached the model: only the first request did
  assert.equal(agent.calls.length, 1);
});

test("`config.llm.promptCacheKey`: the request and OpenAI's body carry it", async () => {
  const agent = agentOnALog({
    model: () => openai({}),
    config: { llm: { promptCacheKey: "team-planning" } },
  });
  await agent.say("hello");
  const [request] = agent.durable("events.iterate.com/llm-request/requested");
  assert.equal(request.payload?.promptCacheKey, "team-planning");
  assert.equal(agent.calls[0].body.prompt_cache_key, "team-planning");
});

test("two request makers of one API shape on one log: the second one's attempt is refused, and one stream is sent", async () => {
  const log = memoryStream("/agents/test");
  const calls = [];
  const itx = {
    ai: {
      run: async () => {
        calls.push(1);
        return openai({ raw: "once" });
      },
    },
    [Symbol.dispose]: () => undefined,
  };
  const makers = [1, 2].map(
    () =>
      new ProcessorEngine(
        new LlmApiProcessor({
          api: openaiResponses(),
          getItx: () => itx,
          fetch: () => assert.fail("no egress"),
          now: () => 0,
          report: () => {},
          readEvents: (after, limit) => log.stream.read(after, limit),
        }),
        { stream: log.stream, storage: memoryStorage() },
      ),
  );
  log.engines.push(...makers);
  await log.stream.append({
    type: "events.iterate.com/llm-request/requested",
    idempotencyKey: "llm-request/requested:answer/1",
    payload: {
      model: "openai/gpt-6.2-sol",
      expiresAtMs: 600_000,
      purpose: "answer",
      triggerOffset: 0,
      instructions: "be brief",
      extends: null,
      itemsAdded: [{ atOffset: 1, rank: 0, tag: "words", role: "user", text: "hi" }],
      promptCacheKey: "/agents/test",
      reasoningEffort: null,
      maxOutputTokens: null,
    },
  });
  await settle(60);
  const of = (type) => log.events.filter((event) => event.type === type);
  assert.equal(calls.length, 1);
  assert.equal(of("events.iterate.com/llm-request/attempt-started").length, 1);
  assert.equal(of("events.iterate.com/llm-request/settled").length, 1);
});

// ── test functions ──

/** Fold facts through the pure reduce, exactly as the engine does. */
function fold(...facts) {
  // the agent needs nothing of a host: what is owed follows from the facts alone
  return reduceProcessor(new Agent(), facts);
}

/** A `side` request off `base`, with its response, then `text`: the small fact a script appends.
 *  What it leaves out is the base's. */
function sideRequest(base, { text }) {
  return {
    type: "events.iterate.com/llm-request/requested",
    payload: {
      purpose: "side",
      model: "openai/gpt-6.2-sol",
      extends: { llmRequestOffset: base.offset, itemCount: null, response: true },
      itemsAdded: [{ role: "user", text }],
    },
  };
}

/** What a state owes, in short: the kinds of each append. */
function owes(state) {
  return state.obligations.map((owed) =>
    owed.events.map((event) => event.type.replace("events.iterate.com/", "")).join(" + "),
  );
}

/** The output items of a fake OpenAI answer, as the next request gives them back. */
function answerItems(answer) {
  return openaiEvents(answer)
    .filter((event) => event.type === "response.output_item.done")
    .map((event) => event.item);
}
