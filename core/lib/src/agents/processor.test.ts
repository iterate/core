// processor.test.ts — the AgentProcessor's executable spec: the reduce as declarative
// `{ events → state }` rows on the shared harness (iterate/stream/test-support
// `reduceProcessor`), and the assistant-output parser's rows. The effects — the birth saga, the
// model call, the script run, the breakers as appends — are proven end to end on the worker
// (test/vitest/agents/agents.e2e.test.ts, a fake `itx.ai` lent by rule).

import { expect, test, vi } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { type AgentState } from "./contract.ts";
import { AgentProcessor, failedRequestNote, raceAbort } from "./processor.ts";
import { parseCodemodeResponse } from "./codemode-format.ts";

const requested = { type: "events.iterate.com/agent/create-requested", payload: {} };
const created = { type: "events.iterate.com/agent/created", payload: { path: "/agents/support" } };
const failed = { type: "events.iterate.com/agent/create-failed", payload: { error: "boom" } };
const deleteRequested = { type: "events.iterate.com/agent/delete-requested", payload: {} };
const deleted = { type: "events.iterate.com/agent/deleted", payload: { path: "/agents/support" } };
/** Born: the request, then the certificate (offsets 1 and 2 of every row below). */
const born = [requested, created];
const system = {
  type: "events.iterate.com/agent/context-added",
  payload: { role: "system", content: "Be terse." },
};

test.for<{
  name: string;
  events: { type: string; payload?: unknown }[];
  state: Partial<AgentState>;
}>([
  {
    name: "the empty state",
    events: [],
    state: { creation: null, deletion: null, contextItems: [] },
  },
  {
    name: "a request opens the creation, at its offset",
    events: [requested],
    state: { creation: { status: "requested", offset: 1 } },
  },
  {
    name: "a failure closes the attempt at its offset (the error is on that event, not in state)",
    events: [requested, failed],
    state: { creation: { status: "failed", offset: 2 } },
  },
  {
    name: "a request after a failure is a new attempt",
    events: [requested, failed, requested],
    state: { creation: { status: "requested", offset: 3 } },
  },
  {
    name: "born once: a request after the certificate is a harmless fact",
    events: [...born, requested],
    state: { creation: { status: "created", offset: 2 } },
  },
  {
    name: "a failure after the certificate is a harmless fact too: the entity stays created",
    events: [requested, created, failed],
    state: { creation: { status: "created", offset: 2 } },
  },
  {
    name: "the empty state has moved never",
    events: [],
    state: { lastActivityAt: null },
  },
  {
    name: "every change stamps the event's time; a harmless fact after it stamps nothing",
    events: [...born, requested],
    state: { lastActivityAt: new Date(2000).toISOString() },
  },
  {
    name: "a delete request opens the deletion at its offset; creation is untouched",
    events: [...born, deleteRequested],
    state: {
      creation: { status: "created", offset: 2 },
      deletion: { status: "requested", offset: 3 },
    },
  },
  {
    name: "the death certificate completes it, at its offset; creation is still untouched",
    events: [...born, deleteRequested, deleted],
    state: {
      creation: { status: "created", offset: 2 },
      deletion: { status: "deleted", offset: 4 },
    },
  },
  {
    name: "dies once, not re-creatable: a second delete request and a create request after the certificate are harmless facts",
    events: [...born, deleteRequested, deleted, deleteRequested, requested],
    state: {
      creation: { status: "created", offset: 2 },
      deletion: { status: "deleted", offset: 4 },
    },
  },
  {
    name: "born with its prompt: the creation is complete, the system item is in the context, nothing is triggered",
    events: [...born, system],
    state: {
      creation: { status: "created", offset: 2 },
      contextItems: [{ offset: 3, role: "system", content: "Be terse." }],
      pendingLlmRequestTrigger: null,
    },
  },
  {
    name: "a person's words raise an external trigger; the request records against it and clears it",
    events: [...born, system, user("hi"), llmRequested(4)],
    state: {
      pendingLlmRequestTrigger: null,
      openRequest: {
        requestedAtOffset: 5,
        expiresAt: 999_999,
        model: "m",
        triggerSource: "external",
      },
      autonomousTurnCount: 0,
    },
  },
  {
    name: "a late intent — no trigger pending — is a harmless fact; so is one while a request is open",
    events: [...born, system, user("hi"), llmRequested(4), llmRequested(4)],
    state: {
      openRequest: {
        requestedAtOffset: 5,
        expiresAt: 999_999,
        model: "m",
        triggerSource: "external",
      },
    },
  },
  {
    name: "success settles the request and lands the assistant's words, which trigger nothing",
    events: [
      ...born,
      system,
      user("hi"),
      llmRequested(4),
      settled(5, { status: "succeeded", text: "ok" }),
      assistant("ok", 5),
    ],
    state: {
      openRequest: null,
      pendingLlmRequestTrigger: null,
      consecutiveLlmFailures: 0,
      contextItems: [
        { offset: 3, role: "system", content: "Be terse." },
        { offset: 4, role: "user", content: "hi", actor: { type: "user" } },
        {
          offset: 5,
          role: "developer",
          content: "Requested at: 1970-01-01T00:00:05.000Z (UTC)",
          actor: { type: "agent" },
        },
        { offset: 7, role: "assistant", content: "ok", llmRequestOffset: 5 },
      ],
    },
  },
  {
    name: "a compaction summary replaces the history through its barrier: the system items, the summary, then what came after it; an older summary is a harmless fact",
    events: [...born, system, user("a"), user("b"), compaction("S1", 4), compaction("S0", 3)],
    state: {
      contextItems: [
        { offset: 3, role: "system", content: "Be terse." },
        { offset: 6, role: "developer", content: "S1", compaction: { replacesHistoryThrough: 4 } },
        { offset: 5, role: "user", content: "b" },
      ],
      pendingLlmRequestTrigger: { offset: 5, atMs: 5_000, source: "external" },
    },
  },
  {
    name: "own runs: a run the loop asked for is pending until it settles, then joins results (inline, or by its file when large); anyone else's run is not the loop's",
    events: [
      ...born,
      run("requested", { code: "async () => 1" }, { processor: { slug: "agent" } }),
      run("requested", { code: "async () => 2" }),
      run("requested", { code: "async () => 3" }, { processor: { slug: "agent" } }),
      run("settled", { requestOffset: 3, settlement: { status: "succeeded", result: { n: 1 } } }),
      run("settled", { requestOffset: 4, settlement: { status: "succeeded", result: 2 } }),
      run("settled", {
        requestOffset: 5,
        settlement: { status: "succeeded", result: "x".repeat(5_000) },
      }),
    ],
    state: {
      pendingRuns: {},
      scriptResults: [
        { offset: 6, requestOffset: 3, kind: "data", json: '{"n":1}' },
        {
          offset: 8,
          requestOffset: 5,
          kind: "large",
          path: "/agents/a/script-results/5.txt",
          text: true,
        },
      ],
    },
  },
  {
    name: "the agent's summary merges field by field; a person's words clear what it was waiting for, its own script results do not",
    events: [
      ...born,
      summaryUpdated({ title: "Weekly shop", activity: "Checking the trolley" }),
      summaryUpdated({ waitingFor: "timer", description: "Keeps the order on track." }),
      {
        type: "events.iterate.com/agent/context-added",
        payload: {
          role: "developer",
          content: "result",
          actor: { type: "script", requestOffset: 3 },
        },
      },
      summaryUpdated({ activity: "Waiting for the slot" }),
    ],
    state: {
      summary: {
        title: "Weekly shop",
        activity: "Waiting for the slot",
        waitingFor: "timer",
        description: "Keeps the order on track.",
      },
    },
  },
  {
    name: "a person's words answer the wait",
    events: [...born, summaryUpdated({ title: "T", waitingFor: "user_input" }), user("yes")],
    state: { summary: { title: "T", activity: null, waitingFor: null, description: null } },
  },
  {
    name: "preamble entries keep first-set order; setting a key again replaces its code in place, null removes it",
    events: [
      ...born,
      preambleSet("a", "const a = 1"),
      preambleSet("b", "const b = 2"),
      preambleSet("a", "const a = 3"),
      preambleSet("b", null),
    ],
    state: { preamble: [{ key: "a", code: "const a = 3" }] },
  },
  {
    name: "a failure counts and hands the trigger back with the request's source, for the retry",
    events: [
      ...born,
      system,
      user("hi"),
      llmRequested(4),
      settled(5, { status: "failed", errorMessage: "boom" }),
    ],
    state: {
      openRequest: null,
      consecutiveLlmFailures: 1,
      pendingLlmRequestTrigger: { offset: 5, atMs: 6_000, source: "external" },
    },
  },
  {
    name: "expiry drops the turn: no request, no trigger",
    events: [
      ...born,
      system,
      user("hi"),
      llmRequested(4),
      settled(5, { status: "cancelled", reason: "expired" }),
    ],
    state: { openRequest: null, pendingLlmRequestTrigger: null, consecutiveLlmFailures: 0 },
  },
  {
    name: "a settlement naming another request is ignored",
    events: [
      ...born,
      system,
      user("hi"),
      llmRequested(4),
      settled(99, { status: "succeeded", text: "?" }),
    ],
    state: {
      openRequest: {
        requestedAtOffset: 5,
        expiresAt: 999_999,
        model: "m",
        triggerSource: "external",
      },
    },
  },
  {
    name: "a script's result is agent-loop input: the next request records an agent-loop trigger and counts an autonomous turn",
    events: [
      ...born,
      system,
      user("hi"),
      llmRequested(4),
      {
        type: "events.iterate.com/itx/run-requested",
        payload: { code: "async (itx) => 1" },
      },
      {
        type: "events.iterate.com/itx/run-settled",
        payload: {
          requestOffset: 6,
          settlement: { status: "succeeded", result: 1 },
        },
      },
      settled(5, { status: "succeeded", text: "<codemode>\nreturn 1\n</codemode>" }),
      scriptResult(6),
      llmRequested(9),
    ],
    state: {
      pendingLlmRequestTrigger: null,
      openRequest: {
        requestedAtOffset: 10,
        expiresAt: 999_999,
        model: "m",
        triggerSource: "agent-loop",
      },
      autonomousTurnCount: 1,
    },
  },
  {
    name: "a pause drops the parked trigger — the retry that tripped the breaker cannot resume it",
    events: [
      ...born,
      system,
      user("hi"),
      llmRequested(4),
      settled(5, { status: "failed", errorMessage: "boom" }),
      { type: "events.iterate.com/agent/paused", payload: { reason: "enough" } },
    ],
    state: { paused: { reason: "enough", atOffset: 7 }, pendingLlmRequestTrigger: null },
  },
  {
    name: "a person's next words reset the autonomous count; paused parks, resumed clears both counts",
    events: [
      ...born,
      system,
      scriptResult(1), // a script result as the trigger: agent-loop input
      llmRequested(4),
      settled(5, { status: "failed", errorMessage: "boom" }),
      { type: "events.iterate.com/agent/paused", payload: { reason: "enough" } },
      user("again"),
      { type: "events.iterate.com/agent/resumed", payload: {} },
    ],
    state: {
      paused: null,
      autonomousTurnCount: 0,
      consecutiveLlmFailures: 0,
      pendingLlmRequestTrigger: { offset: 8, atMs: 8_000, source: "external" },
    },
  },
  {
    name: "configured merges: a model change keeps every other knob",
    events: [
      ...born,
      {
        type: "events.iterate.com/agent/configured",
        payload: { config: { llm: { model: "gpt-6-luna" }, maxAutonomousTurns: 2 } },
      },
    ],
    state: {
      config: {
        llm: { model: "gpt-6-luna", reasoningEffort: "medium" },
        maxAutonomousTurns: 2,
        llmRequestExpiryMs: 600_000,
        llmRequestDebounceMs: 250,
        llmRequestRetryPolicy: { maxAttempts: 3, backoffBaseMs: 2_000, backoffMaxMs: 60_000 },
        scriptResultHistoryLimit: 30_000,
        compactionTriggerFraction: 0.5,
        idleCompactionAfterMs: 0,
        idleCompactionMinNewTokens: 30_000,
        idleSummariesMaxChars: 40_000,
        keepWarmForMs: 0,
        keepWarmEveryMs: 25 * 60_000,
      },
    },
  },
  {
    name: "words with dont-trigger-request are seen, never answered; a malformed item is skipped",
    events: [
      ...born,
      {
        type: "events.iterate.com/agent/context-added",
        payload: {
          role: "developer",
          content: "fyi",
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
      {
        type: "events.iterate.com/agent/context-added",
        payload: { role: "nope", content: "x" },
      },
    ],
    state: {
      contextItems: [{ offset: 3, role: "developer", content: "fyi" }],
      pendingLlmRequestTrigger: null,
    },
  },
])("the reduce: $name", ({ events, state }) => {
  expect(reduceProcessor(processor(), events)).toMatchObject(state);
});

test.for<{ name: string; source?: { origin: string }; from?: string; label?: string }>([
  {
    name: "another agent's append: its stamp",
    source: { origin: "/agents/a" },
    label: "/agents/a",
  },
  { name: "the agent's own words: no sender", source: { origin: "/agents/b" } },
  { name: "the root's append (a member's session, the dash): a person's", source: { origin: "/" } },
  {
    name: "relayed by its own facet (`message`): the sender handed over",
    source: { origin: "/agents/b" },
    from: "/agents/a",
    label: "/agents/a",
  },
  {
    name: "relayed from the root's collection: a person's",
    source: { origin: "/agents/b" },
    from: "/",
  },
  {
    name: "a foreign stamp beats a relayed sender",
    source: { origin: "/agents/c" },
    from: "/agents/a",
    label: "/agents/c",
  },
])("the reduce names who sent words to /agents/b — $name", ({ source, from, label }) => {
  const { contextItems } = reduceProcessor(processor(), [
    ...born,
    { ...user("hi"), payload: { ...user("hi").payload, from }, source, path: "/agents/b" },
  ]);
  expect(contextItems.at(-1)).toMatchObject({ content: "hi", from: label });
});

// ── the note a failed model request leaves for the next turn ──

test.for<{ name: string; attempt: number; errorMessage: string; note: string }>([
  {
    name: "a provider's message that ends with a period keeps that one period",
    attempt: 1,
    errorMessage: "openai: Our servers are currently overloaded. Please try again later.",
    note: "The model request @14 failed (attempt 1 of 3): openai: Our servers are currently overloaded. Please try again later. Retrying.",
  },
  {
    name: "a message with no end mark gets a period",
    attempt: 2,
    errorMessage: "stream idle for 25000 ms",
    note: "The model request @14 failed (attempt 2 of 3): stream idle for 25000 ms. Retrying.",
  },
  {
    name: "a question mark or an exclamation mark ends the sentence too; trailing whitespace goes",
    attempt: 1,
    errorMessage: "Did you mean gpt-6?\n",
    note: "The model request @14 failed (attempt 1 of 3): Did you mean gpt-6? Retrying.",
  },
  {
    name: "the last attempt gives up",
    attempt: 3,
    errorMessage: "Rate limited!",
    note: "The model request @14 failed (attempt 3 of 3): Rate limited! Giving up until the next message.",
  },
])("failedRequestNote: $name", ({ attempt, errorMessage, note }) => {
  expect(failedRequestNote({ requestOffset: 14, attempt, maxAttempts: 3, errorMessage })).toBe(
    note,
  );
});

// ── the assistant's output, parsed (the codemode-tag grammar, codemode-format.ts) ──

test.for<{ name: string; content: string; expected: object }>([
  {
    name: "prose, one tag with a status, trailing prose: bare statements get the async envelope, the prose halves join",
    content:
      'Let me look.\n\n<codemode status="Checking">\nconst n = 1\nreturn { n }\n</codemode>\n\nDone soon.',
    expected: {
      kind: "script",
      code: "async (itx) => {\nconst n = 1\nreturn { n }\n}",
      status: "Checking",
      prose: "Let me look.\n\nDone soon.",
    },
  },
  {
    name: "a body that is already an async function passes through untouched; no status, no prose",
    content: "<codemode>\nasync (itx) => 1\n</codemode>",
    expected: { kind: "script", code: "async (itx) => 1" },
  },
  {
    name: "no tag is a turn's end, the prose still delivered; nothing at all is none",
    content: "All done — the value is 42.",
    expected: { kind: "none", prose: "All done — the value is 42." },
  },
  { name: "an empty answer is none without prose", content: "  \n", expected: { kind: "none" } },
  {
    name: "a mid-line mention never opens a tag",
    content: "To run code, use a <codemode> tag on its own line.",
    expected: { kind: "none", prose: "To run code, use a <codemode> tag on its own line." },
  },
  {
    name: "two openers run nothing",
    content: "<codemode>\nreturn 1\n</codemode>\n<codemode>\nreturn 2\n</codemode>",
    expected: { kind: "multiple" },
  },
  {
    name: "an unclosed tag is malformed",
    content: "<codemode>\nreturn 1",
    expected: { kind: "malformed" },
  },
  {
    name: "a stray closer before the opener is malformed",
    content: "</codemode>\n<codemode>\nreturn 1\n</codemode>",
    expected: { kind: "malformed" },
  },
  {
    name: "an empty body is malformed",
    content: "<codemode>\n\n</codemode>",
    expected: { kind: "malformed" },
  },
  {
    name: "the body ends at the LAST closer: a closing line inside a template literal stays in the script",
    content: "<codemode>\nconst s = `\n</codemode>\n`\nreturn s\n</codemode>",
    expected: {
      kind: "script",
      code: "async (itx) => {\nconst s = `\n</codemode>\n`\nreturn s\n}",
    },
  },
])("parseCodemodeResponse: $name", ({ content, expected }) => {
  expect(parseCodemodeResponse(content)).toMatchObject(expected);
});

test.for([
  { answer: "a Response", wrap: (body: ReadableStream) => new Response(body) },
  { answer: "a bare stream", wrap: (body: ReadableStream) => body },
])(
  "raceAbort: an abort during the dial rejects at once, and $answer the dial answers after it is cancelled with the abort's reason",
  async ({ wrap }) => {
    const controller = new AbortController();
    let answer!: (value: unknown) => void;
    const raced = raceAbort(
      controller.signal,
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const interrupted = new Error("interrupted");
    controller.abort(interrupted);
    await expect(raced).rejects.toBe(interrupted);
    const { body, watch } = watchedBody();
    answer(wrap(body));
    await vi.waitFor(() => expect(watch).toMatchObject({ cancelled: interrupted }));
  },
);

test("raceAbort: a dial that answers before any abort hands its body over unread, and a later abort leaves it to the reader", async () => {
  const controller = new AbortController();
  const { body, watch } = watchedBody();
  const response = new Response(body);
  expect(await raceAbort(controller.signal, Promise.resolve(response))).toBe(response);
  controller.abort(new Error("interrupted"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(watch).toEqual({});
  expect(response).toMatchObject({ bodyUsed: false });
});

/** The reduce never reaches the context; the saga and the model call are the e2e's. */
const processor = () =>
  new AgentProcessor({
    getItx: () => {
      throw new Error("the reduce reaches no itx");
    },
    now: () => 0,
    sleep: () => Promise.resolve(),
  });

// Row builders are function declarations: the rows call them while the file is collected.
function user(content: string) {
  return {
    type: "events.iterate.com/agent/context-added",
    payload: { role: "user", content, actor: { type: "user" } },
  };
}

function llmRequested(triggerOffset: number) {
  return {
    type: "events.iterate.com/agent/llm-request-requested",
    payload: { model: "m", expiresAt: 999_999, triggerOffset },
  };
}

function settled(requestOffset: number, result: unknown) {
  return {
    type: "events.iterate.com/agent/llm-request-settled",
    payload: { requestOffset, result },
  };
}

function compaction(content: string, replacesHistoryThrough: number) {
  return {
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "developer",
      content,
      compaction: { replacesHistoryThrough },
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    },
  };
}

function run(kind: "requested" | "settled", payload: unknown, source?: Record<string, unknown>) {
  return { type: `events.iterate.com/itx/run-${kind}`, payload, source, path: "/agents/a" };
}

function summaryUpdated(payload: Record<string, unknown>) {
  return { type: "events.iterate.com/agent/summary-updated", payload };
}

function preambleSet(key: string, code: string | null) {
  return { type: "events.iterate.com/agent/preamble-entry-set", payload: { key, code } };
}

function assistant(content: string, llmRequestOffset: number) {
  return {
    type: "events.iterate.com/agent/context-added",
    payload: { role: "assistant", content, llmRequestOffset },
  };
}

function scriptResult(requestOffset: number) {
  return {
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "developer",
      content: "Your script returned: 1",
      actor: { type: "script", requestOffset },
    },
  };
}

/** A body that records whether, and why, its reader cancelled it. */
const watchedBody = () => {
  const watch: { cancelled?: unknown } = {};
  const body = new ReadableStream({
    cancel(reason) {
      watch.cancelled = reason;
    },
  });
  return { body, watch };
};
