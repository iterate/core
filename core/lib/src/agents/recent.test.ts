// recent.test.ts — `itx.agents.get(path).recent()`'s fold (recent.ts) over a small log: the window,
// one line per thing done, the newest script whole with its error, and another kind's log.
import { expect, test } from "vitest";
import type { StreamEvent } from "../stream/processor.ts";
import { agentRecent } from "./recent.ts";

test("the window's lines, oldest first, and the newest script whole with its error", () => {
  expect(agentRecent(LOG, { since: at(40), limit: 30, iterate: true })).toEqual({
    did: [
      { at: at(41), what: "message-in", text: "Check the deploy log" },
      { at: at(41), what: "status", text: "Reading the deploy log" },
      { at: at(41), what: "script", text: "const files = 1" },
      { at: at(42), what: "status", text: "Fetching it" },
      { at: at(42), what: "script", text: "await itx.fetch(url)" },
      { at: at(43), what: "summary", text: "Deploy check — waiting for user input" },
      { at: at(43), what: "message-out", text: "The deploy failed: fetch failed." },
    ],
    lastScript: {
      at: at(42),
      status: "Fetching it",
      script: "\n  await itx.fetch(url)\nreturn 1",
      error: "fetch failed",
    },
  });
});

test("the limit keeps the newest lines; an empty window has none and no script", () => {
  const { did } = agentRecent(LOG, { since: at(40), limit: 2, iterate: true });
  expect(did.map((line) => line.what)).toEqual(["summary", "message-out"]);
  expect(agentRecent(LOG, { since: at(50), limit: 30, iterate: true })).toEqual({
    did: [],
    lastScript: null,
  });
});

test("an event it cannot read is skipped, never thrown on, and the loop's mind-now note is no words in", () => {
  const log = [
    { ...event(41, "agent/summary-updated", {}), payload: undefined },
    { ...event(41, "agent/context-added", {}), payload: "not an object" },
    {
      ...event(41, "itx/run-settled", { requestOffset: "x", settlement: null }),
      source: undefined,
    },
    event(41, "agent/context-added", {
      role: "user",
      content: "[the mind now, …]",
      actor: { type: "agent" },
      mindSnapshot: true,
    }),
    event(42, "agent/web-message-sent", { message: "Still here." }),
  ] as unknown as StreamEvent[]; // malformed on purpose: a raw log can hold any payload
  expect(agentRecent(log, { since: at(40), limit: 30, iterate: true })).toEqual({
    did: [{ at: at(42), what: "message-out", text: "Still here." }],
    lastScript: null,
  });
});

test("another kind's log: its words in are `message-received`, and a missing type is no error", () => {
  const log = [
    event(41, "agent/message-received", { message: "Hi", from: "/agents/b" }),
    event(41, "agent/context-added", { role: "user", content: "a bridge's own copy" }),
    event(42, "claude/tool-used", { name: "Bash" }),
  ];
  expect(agentRecent(log, { since: at(40), limit: 30, iterate: false })).toEqual({
    did: [{ at: at(41), what: "message-in", text: "[from /agents/b] Hi" }],
    lastScript: null,
  });
});

test("a mind's own agent: its script is the answer's `<codemode>` block, and its words out are `agent-ui/message-sent`", () => {
  const answer = (text: string) => ({ llmRequestOffset: 2, result: { status: "succeeded", text } });
  const log = [
    event(41, "agent/message-received", { message: "Count the files" }),
    event(41, "agent/context-added", { role: "user", content: "Count the files\n\n— Web UI" }),
    event(41, "llm-request/settled", answer("<codemode>\nconst n = 3\nreturn n\n</codemode>")),
    event(41, "itx/run-requested", { code: "wrapped" }, ownRun),
    event(42, "agent-ui/message-sent", { message: "There are 3 files." }),
    // an answer with no block is no script, and the run after it is not the agent's answer's
    event(43, "llm-request/settled", answer("")),
    event(43, "itx/run-requested", { code: "wrapped" }, ownRun),
  ];
  expect(agentRecent(log, { since: at(40), limit: 30, iterate: true })).toEqual({
    did: [
      { at: at(41), what: "message-in", text: "Count the files — Web UI" },
      { at: at(41), what: "script", text: "const n = 3" },
      { at: at(42), what: "message-out", text: "There are 3 files." },
    ],
    lastScript: { at: at(41), status: "", script: "const n = 3\nreturn n" },
  });
});

const PATH = "/agents/a";
const at = (minute: number) => `2026-11-16T10:${String(minute).padStart(2, "0")}:00.000Z`;
let offset = 0;
function event(minute: number, type: string, payload: unknown, source: object = {}): StreamEvent {
  offset += 1;
  return {
    offset,
    path: PATH,
    type: `events.iterate.com/${type}`,
    payload,
    createdAt: at(minute),
    source: { origin: PATH, ...source },
  } as StreamEvent;
}
const ownRun = { processor: { slug: "agent" } };
const call = (status: string, script: string) => ({
  role: "assistant",
  content: "",
  llmRequestOffset: 1,
  call: { callId: "c", status, script },
});

const LOG = [
  event(30, "agent/context-added", { role: "user", content: "Old words" }),
  event(36, "agent/context-added", call("Listing files", "const files = 1\nreturn files")),
  event(41, "agent/context-added", { role: "user", content: "Check the\ndeploy log" }),
  event(41, "agent/summary-updated", { activity: "Reading the deploy log" }),
  event(41, "itx/run-requested", { code: "wrapped" }, ownRun),
  event(41, "itx/run-settled", { requestOffset: 5, settlement: { status: "succeeded" } }),
  event(42, "agent/context-added", call("Fetching it", "\n  await itx.fetch(url)\nreturn 1")),
  event(42, "agent/summary-updated", { activity: "Fetching it" }),
  event(42, "itx/run-requested", { code: "wrapped" }, ownRun),
  event(42, "itx/run-requested", { code: "someone else's" }),
  event(43, "itx/run-settled", {
    requestOffset: 9,
    settlement: { status: "failed", error: "fetch failed", failureKind: "runtime" },
  }),
  event(43, "agent/summary-updated", { title: "Deploy check", waitingFor: "user_input" }),
  event(43, "agent/web-message-sent", { message: "The deploy failed: fetch failed." }),
];
