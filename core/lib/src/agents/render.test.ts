// render.test.ts — the agent's requests: folded by the real reduce (processor.ts), rendered by
// render.ts. The property everything rests on: each request's input BEGINS WITH the previous
// request's input, item for item, so OpenAI's prompt cache holds everything before the new items.
// Also: a call is followed by its output, the previous loop's `<codemode>` log converts to calls, a late
// result and a compaction keep the property, and the head and tree render stably.
import { expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import {
  AgentProcessor,
  historyTokensSinceSummary,
  idleAction,
  keepsWarm,
  promptCacheKey,
} from "./processor.ts";
import {
  answerText,
  buildResponsesInput,
  type InputItem,
  type RenderItem,
  renderSectionUpdate,
  sectionChanges,
  stableCapabilityTree,
} from "./render.ts";
import type { AgentState } from "./contract.ts";

const PATH = "/agents/a";

const born: Row[] = [
  at({ type: "events.iterate.com/agent/create-requested", payload: {} }),
  at({ type: "events.iterate.com/agent/created", payload: { path: PATH } }),
];
const HEAD = {
  system: "You are an agent.",
  "AGENTS.md": "AGENTS.md (/repos/config), as it is now:\n\nBe kind.\nBe brief.",
  "capability-tree": "itx.kv — kv",
  identity: 'CURRENT PROJECT: {"path":"/agents/a"}',
};

// A three-request script chain with an instruction change before the second request:
//  3 user · 4 request · 5 snapshot · 6 answer(call) · 7 settled · 8 run · 9 run settled · 10 result
// 11 request · 12 AGENTS.md update · 13 answer(call) · 14 settled · 15 run · 16 settled · 17 result
// 18 request · 19 answer(prose)
const chain: Row[] = [
  ...born,
  user("Count my notes."),
  requested(3),
  sections(4, HEAD, true),
  answer(4, "return (await itx.kv.list('notes')).keys.length", "Let me count."),
  settled(4),
  runRequested(),
  runSettled(8),
  result(8),
  requested(10),
  sections(11, {
    "AGENTS.md": "AGENTS.md (/repos/config), as it is now:\n\nBe kind.\nBe brief.\nBe exact.",
  }),
  answer(11, "return 2"),
  settled(11),
  runRequested(),
  runSettled(15),
  result(15),
  requested(17),
  answer(18, undefined, "You have 1 note."),
];

test("each request of a script chain extends the one before, an instruction change included", () => {
  const state = reduceProcessor(processor(), chain as never) as AgentState;
  const [first, second, third] = [4, 11, 18].map((offset) => inputAt(state, offset));
  expectExtends(first!, second!);
  expectExtends(second!, third!);
  // the head: one developer message per section, the breakpoint after the last shared one
  expect(first!.slice(0, 4).map((item) => item.role)).toEqual(Array(4).fill("developer"));
  expect(JSON.stringify(first![1])).toContain("prompt_cache_breakpoint");
  expect(JSON.stringify(first![2])).not.toContain("prompt_cache_breakpoint");
  // each call is followed by its output; reasoning and ids replay as the provider sent them
  const types = third!.map((item) => item.type ?? item.role);
  expect(types).toEqual([
    "developer",
    "developer",
    "developer",
    "developer", // head
    "user",
    "developer", // the words, the stamp
    "reasoning",
    "message",
    "function_call",
    "function_call_output",
    "developer", // stamp
    "developer", // the AGENTS.md update, where it happened
    "reasoning",
    "function_call",
    "function_call_output",
    "developer", // stamp
  ]);
  expect(third![8]).toMatchObject({ type: "function_call", id: "fc_4", call_id: "call_r4" });
  expect(third![9]).toMatchObject({ type: "function_call_output", call_id: "call_r4" });
  // the reduce folded the update into what the model has been shown
  expect(state.sections["AGENTS.md"]).toContain("Be exact.");
  expect(state).toMatchObject({
    runs: { "8": { callId: "call_r4" }, "15": { callId: "call_r11" } },
  });
});

test("another model's answers replay without reasoning or ids, still followed by their outputs", () => {
  const state = reduceProcessor(processor(), chain as never) as AgentState;
  const input = inputAt(state, 18, "gpt-6.1-sol");
  expect(input.some((item) => item.type === "reasoning")).toBe(false);
  expect(
    input.filter((item) => item.type === "function_call").every((item) => !("id" in item)),
  ).toBe(true);
  expect(input.filter((item) => item.type === "function_call_output")).toHaveLength(2);
});

test("the previous loop's log (codemode answers, system-role results) renders as calls and outputs, append-only", () => {
  const codemode = (llmRequestOffset: number, body: string): Row =>
    at({
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "assistant",
        content: `Checking.\n\n<codemode status="Looking">\n${body}\n</codemode>`,
        llmRequestOffset,
      },
    });
  const legacy: Row[] = [
    ...born,
    at({
      type: "events.iterate.com/agent/context-added",
      idempotencyKey: `agent/system-prompt:${PATH}`,
      payload: { role: "system", content: "OLD PROMPT" },
    }),
    user("hi"),
    requested(4),
    codemode(5, "return 1"),
    settled(5),
    runRequested(),
    runSettled(8),
    result(8),
    requested(10),
  ];
  const state = reduceProcessor(processor(), legacy as never) as AgentState;
  const input = inputAt(state, 11);
  expect(JSON.stringify(input)).not.toContain("OLD PROMPT"); // the birth prompt is superseded
  expect(input.map((item) => item.type ?? item.role)).toEqual([
    "user",
    "developer",
    "assistant",
    "function_call",
    "function_call_output",
    "developer",
  ]);
  expect(input[3]).toMatchObject({
    call_id: "call_6",
    arguments: JSON.stringify({ status: "Looking", script: "return 1" }),
  });
  expect(input[4]).toMatchObject({ call_id: "call_6" });
});

test("an operator's instructions appended right after the birth certificate reach the model", () => {
  const state = reduceProcessor(processor(), [
    ...born,
    at({
      type: "events.iterate.com/agent/context-added",
      payload: { role: "system", content: "Be terse." },
    }),
    user("hi"),
    requested(4),
  ] as never) as AgentState;
  const input = inputAt(state, 5);
  expect(input.map((item) => item.type ?? item.role)).toEqual(["developer", "user", "developer"]);
  expect(input[0]).toEqual({ role: "developer", content: "Be terse." });
});

test("a result that comes back after a request moved on: the call shows 'no result yet', the result arrives as its own message, append-only", () => {
  // 3 user · 4 request · 5 snapshot · 6 answer(call) · 7 settled · 8 run · 9 user · 10 request
  // (the hold ran out) · 11 answer · 12 settled · 13 run settled · 14 result · 15 request
  const late: Row[] = [
    ...born,
    user("Do the slow thing."),
    requested(3),
    sections(4, HEAD, true),
    answer(4, "await slow()"),
    settled(4),
    runRequested(),
    user("Are you there?"),
    requested(9),
    answer(10, undefined, "Still working."),
    settled(10),
    runSettled(8),
    result(8, "Your script returned: done"),
    requested(14),
  ];
  const state = reduceProcessor(processor(), late as never) as AgentState;
  const before = inputAt(state, 10);
  const after = inputAt(state, 15);
  expectExtends(before, after);
  const output = after.find((item) => item.type === "function_call_output");
  expect(output?.output).toContain("No result had come back");
  expect(JSON.stringify(after.at(-2))).toContain("came back after the conversation moved on");
});

test("a compaction collapses the sections into one head snapshot and renders a result whose call was cut as a message", () => {
  const compacted: Row[] = [
    ...chain,
    settled(18),
    user("And now?"),
    // the summary replaces everything through the second answer (13): its result (17) stays
    at({
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "developer",
        content:
          "[Earlier conversation history was compacted through @13. Summary:]\n\nCounted notes.",
        actor: { type: "agent" },
        compaction: { replacesHistoryThrough: 13 },
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    }),
    requested(21),
  ];
  const state = reduceProcessor(processor(), compacted as never) as AgentState;
  const input = inputAt(state, 23);
  const head = input.slice(0, 4).map((item) => JSON.stringify(item));
  expect(head[1]).toContain("Be exact."); // the snapshot carries the folded update
  expect(input.filter((item) => item.type === "function_call")).toHaveLength(0);
  expect(
    input.some((item) =>
      JSON.stringify(item).includes("came back after the conversation moved on"),
    ),
  ).toBe(true);
  expect(Object.keys(state.runs)).toEqual(["15"]);
});

test("the capability tree renders sorted and without the config commit or publication number", () => {
  const row = (match: string, description: string) => ({
    match,
    description,
    target: ["itx"],
    context: "/agents/a",
  });
  const one = stableCapabilityTree([
    row("itx.kv", "kv"),
    row(
      "itx.config",
      "the project's published config: /repos/config at 72de7b20aae9, publication 5326",
    ),
  ] as never);
  const two = stableCapabilityTree([
    row(
      "itx.config",
      "the project's published config: /repos/config at 1a2b3c4d5e6f, publication 5327",
    ),
    row("itx.kv", "kv"),
  ] as never);
  expect(one).toEqual(two);
  expect(one).not.toContain("72de7b");
});

test("a small change renders as a diff, a large one in full, a removal as a line", () => {
  const before = Array.from({ length: 40 }, (_, i) => `rule ${String(i)}`).join("\n");
  const small = renderSectionUpdate("AGENTS.md", before, `${before}\nrule 40`);
  expect(small).toContain("```diff");
  expect(small).toContain("+rule 40");
  expect(small.length).toBeLessThan(400);
  expect(renderSectionUpdate("AGENTS.md", "a", "b\nc\nd")).toContain("was rewritten");
  expect(renderSectionUpdate("preamble", "x", null)).toContain("no longer applies");
  expect(sectionChanges({ a: "1", b: "2" }, { a: "1", b: "2" })).toBeNull();
  expect(sectionChanges({ a: "1" }, { a: "1", c: "3" })?.sections).toEqual({ c: "3" });
});

test("the cache key: the agent's path, a voice call's client for a voice call", () => {
  expect(promptCacheKey("/agents/chief-of-staff")).toBe("/agents/chief-of-staff");
  expect(promptCacheKey("/agents/voice/whatsapp-447700900001/20261003-ab")).toBe(
    "voice/whatsapp-447700900001",
  );
  expect(Array.from(promptCacheKey(`/agents/${"x".repeat(80)}`))).toHaveLength(64);
});

test("an idle check pings inside the keep-warm window, then compacts, and does nothing once anything happened", () => {
  const small = (rows: Row[]) => {
    const state = reduceProcessor(processor(), rows as never) as AgentState;
    return { ...state, config: { ...state.config, idleCompactionMinNewTokens: 20 } };
  };
  const state = small([...chain, settled(18)]);
  const now = Date.parse("2026-10-03T12:00:00Z");
  const check = { afterRequestOffset: 18, inputTokens: 40_000 };
  const until = (ms: number) => ({ ...check, keepWarmUntil: new Date(now + ms).toISOString() });
  expect(historyTokensSinceSummary(state)).toBeGreaterThan(20);
  expect(idleAction(state, until(2 * 3_600_000), now)).toBe("keep-warm");
  expect(idleAction(state, until(10 * 60_000), now)).toBe("compact"); // the window ends before the next check
  expect(idleAction(state, check, now)).toBe("compact"); // no window: a subagent's or a thread's
  expect(idleAction(state, { ...check, afterRequestOffset: 11 }, now)).toBeUndefined(); // a newer request came
  expect(
    idleAction(
      { ...state, config: { ...state.config, idleCompactionMinNewTokens: 30_000 } },
      check,
      now,
    ),
  ).toBeUndefined(); // too little to summarize
  expect(
    idleAction(small([...chain, settled(18), user("Hello?")]), until(2 * 3_600_000), now),
  ).toBeUndefined(); // a person's words are waiting for a turn
  expect(
    idleAction(small([...chain, settled(18), summary(18, "[summary]")]), until(2 * 3_600_000), now),
  ).toBeUndefined(); // already summarized
  expect([
    keepsWarm("/agents/chief-of-staff"),
    keepsWarm("/agents/chief-of-staff/marketing-cleanup"),
    keepsWarm("/agents/voice/whatsapp-447700900001/20261003"),
  ]).toEqual([true, false, false]);
});

test("an idle summary keeps the earlier summaries word for word, until a merge replaces them all", () => {
  const rows: Row[] = [...chain, settled(18), summary(13, "first"), user("More?"), requested(21)];
  const kept = reduceProcessor(processor(), [
    ...rows,
    summary(23, "second", true),
  ] as never) as AgentState;
  expect(kept.contextItems.filter((item) => item.compaction).map((item) => item.content)).toEqual([
    "first",
    "second",
  ]);
  expect(historyTokensSinceSummary(kept)).toBe(0);
  const input = JSON.stringify(inputAt(kept, 25));
  expect(input.indexOf("first")).toBeLessThan(input.indexOf("second"));
  expect(input).not.toContain("More?");
  const merged = reduceProcessor(processor(), [
    ...rows,
    summary(23, "both"),
  ] as never) as AgentState;
  expect(merged.contextItems.filter((item) => item.compaction).map((item) => item.content)).toEqual(
    ["both"],
  );
});

function processor() {
  return new AgentProcessor({
    getItx: () => {
      throw new Error("the reduce reaches no itx");
    },
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
}

// ── event builders: every event lands on /agents/a, numbered from 1 by the harness ──
type Row = {
  type: string;
  payload?: unknown;
  source?: unknown;
  path?: string;
  idempotencyKey?: string;
};
function at(row: Row): Row {
  return { path: PATH, source: { origin: PATH }, ...row };
}
function user(content: string): Row {
  return at({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "user", content, actor: { type: "user" } },
  });
}
function requested(triggerOffset: number): Row {
  return at({
    type: "events.iterate.com/agent/llm-request-requested",
    payload: { model: "gpt-6-astra", expiresAt: 999_999, triggerOffset },
  });
}
function sections(
  llmRequestOffset: number,
  set: Record<string, string | null>,
  snapshot = false,
): Row {
  return at({
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "system",
      content: snapshot
        ? "[standing instructions: the head snapshot]"
        : `[update] ${Object.keys(set).join(", ")}`,
      sections: set,
      llmRequestOffset,
      ...(snapshot && { snapshot: true }),
    },
  });
}
/** An answer of this loop: the response's items as OpenAI returns them, and the call. */
function answer(llmRequestOffset: number, script?: string, prose = ""): Row {
  const callId = `call_r${String(llmRequestOffset)}`;
  const providerItems = [
    {
      type: "reasoning",
      id: `rs_${String(llmRequestOffset)}`,
      summary: [],
      encrypted_content: "enc",
    },
    ...(prose
      ? [
          {
            type: "message",
            id: `msg_${String(llmRequestOffset)}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: prose, annotations: [] }],
          },
        ]
      : []),
    ...(script
      ? [
          {
            type: "function_call",
            id: `fc_${String(llmRequestOffset)}`,
            call_id: callId,
            name: "run",
            arguments: JSON.stringify({ status: "Working", script }),
            status: "completed",
          },
        ]
      : []),
  ];
  const call = script ? { callId, status: "Working", script } : undefined;
  return at({
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "assistant",
      content: answerText(prose, call),
      llmRequestOffset,
      call,
      providerItems,
      providerModel: "gpt-6-astra",
    },
  });
}
function settled(requestOffset: number): Row {
  return at({
    type: "events.iterate.com/agent/llm-request-settled",
    payload: { requestOffset, result: { status: "succeeded", text: "x" } },
  });
}
function runRequested(): Row {
  return at({
    type: "events.iterate.com/itx/run-requested",
    payload: { code: "async (itx) => 1" },
    source: { origin: PATH, processor: { slug: "agent" } },
  });
}
function runSettled(requestOffset: number): Row {
  return at({
    type: "events.iterate.com/itx/run-settled",
    payload: { requestOffset, settlement: { status: "succeeded", result: 1 } },
  });
}
function result(
  requestOffset: number,
  content = "Your script returned (in 1s):\n```json\n1\n```",
): Row {
  return at({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "developer", content, actor: { type: "script", requestOffset } },
  });
}

function summary(through: number, content: string, keepsEarlierSummaries?: boolean): Row {
  return at({
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "developer",
      content,
      actor: { type: "agent" },
      compaction: { replacesHistoryThrough: through, keepsEarlierSummaries },
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    },
  });
}

/** The input the processor sends for the request at `requestOffset`, from the log folded to its end
 *  (later items all sit after it, except the section item written for it). */
function inputAt(state: AgentState, requestOffset: number, model = "gpt-6-astra"): InputItem[] {
  const items = state.contextItems.filter(
    (item) =>
      item.offset <= requestOffset || (item.sections && item.llmRequestOffset === requestOffset),
  ) as RenderItem[];
  return buildResponsesInput({
    items,
    images: new Map(),
    runs: state.runs,
    model,
    ownPath: PATH,
  });
}

/** Request `next` extends request `previous`: the same items, in order, then more. */
function expectExtends(previous: InputItem[], next: InputItem[]) {
  expect(next.length).toBeGreaterThan(previous.length);
  expect(next.slice(0, previous.length)).toEqual(previous);
}
