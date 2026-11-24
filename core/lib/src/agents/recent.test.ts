// recent.test.ts — `itx.agents.get(path).recent()`'s fold (recent.ts) over a small log of the mind's
// own agent: the window, one line per thing done, the newest script whole with its error; and
// another kind's log.
import { expect, test } from "vitest";
import type { StreamEvent } from "../stream/processor.ts";
import { agentRecent } from "./recent.ts";

test("the window's lines, oldest first, and the newest script whole with its error", () => {
  expect(agentRecent(LOG, { since: at(40), limit: 30, own: true })).toEqual({
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
      status: "",
      script: "  await itx.fetch(url)\nreturn 1",
      error: "fetch failed",
    },
  });
});

test("the limit keeps the newest lines; an empty window has none and no script", () => {
  const { did } = agentRecent(LOG, { since: at(40), limit: 2, own: true });
  expect(did.map((line) => line.what)).toEqual(["summary", "message-out"]);
  expect(agentRecent(LOG, { since: at(50), limit: 30, own: true })).toEqual({
    did: [],
    lastScript: null,
  });
});

test("an event it cannot read is skipped, never thrown on", () => {
  const log = [
    { ...event(41, "agent/summary-updated", {}), payload: undefined },
    { ...event(41, "agent/context-added", {}), payload: "not an object" },
    {
      ...event(41, "itx/run-settled", { requestOffset: "x", settlement: null }),
      source: undefined,
    },
    event(41, "llm-request/settled", { result: "no record" }),
    event(42, "agent-ui/message-sent", { message: "Still here." }),
  ] as unknown as StreamEvent[]; // malformed on purpose: a raw log can hold any payload
  expect(agentRecent(log, { since: at(40), limit: 30, own: true })).toEqual({
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
  expect(agentRecent(log, { since: at(40), limit: 30, own: false })).toEqual({
    did: [{ at: at(41), what: "message-in", text: "[from /agents/b] Hi" }],
    lastScript: null,
  });
});

test("the mind's own agent: its words in are its input, with the sender; an answer with no block is no script", () => {
  const log = [
    event(41, "agent/message-received", { message: "Count the files" }),
    event(41, "agent/context-added", { role: "user", content: "Count the files\n\n— Web UI" }),
    event(41, "agent/context-added", {
      role: "user",
      content: "And the folders",
      from: "/agents/b",
    }),
    event(41, "agent/context-added", { role: "developer", content: "[result 4]\n3" }),
    event(41, "llm-request/settled", answer(block("const n = 3\nreturn n"))),
    event(41, "itx/run-requested", { code: "wrapped" }, ownRun),
    event(42, "agent-ui/message-sent", { message: "There are 3 files." }),
    // the run after an answer with no block is not the script of an answer
    event(43, "llm-request/settled", answer("")),
    event(43, "itx/run-requested", { code: "wrapped" }, ownRun),
  ];
  expect(agentRecent(log, { since: at(40), limit: 30, own: true })).toEqual({
    did: [
      { at: at(41), what: "message-in", text: "Count the files — Web UI" },
      { at: at(41), what: "message-in", text: "[from /agents/b] And the folders" },
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
/** A model's answer as the request maker settles it: the mind's own agent answers with one
 *  `<codemode>` block, which its next run runs. */
const answer = (text: string) => ({ llmRequestOffset: 1, result: { status: "succeeded", text } });
const block = (script: string) => `<codemode>\n${script}\n</codemode>`;

const LOG = [
  event(30, "agent/context-added", { role: "user", content: "Old words" }),
  event(36, "llm-request/settled", answer(block("const files = 1\nreturn files"))),
  event(41, "agent/context-added", { role: "user", content: "Check the\ndeploy log" }),
  event(41, "agent/summary-updated", { activity: "Reading the deploy log" }),
  event(41, "itx/run-requested", { code: "wrapped" }, ownRun),
  event(41, "itx/run-settled", { requestOffset: 5, settlement: { status: "succeeded" } }),
  event(42, "llm-request/settled", answer(block("  await itx.fetch(url)\nreturn 1"))),
  event(42, "agent/summary-updated", { activity: "Fetching it" }),
  event(42, "itx/run-requested", { code: "wrapped" }, ownRun),
  event(42, "itx/run-requested", { code: "someone else's" }),
  event(43, "itx/run-settled", {
    requestOffset: 9,
    settlement: { status: "failed", error: "fetch failed", failureKind: "runtime" },
  }),
  event(43, "agent/summary-updated", { title: "Deploy check", waitingFor: "user_input" }),
  event(43, "agent-ui/message-sent", { message: "The deploy failed: fetch failed." }),
];
