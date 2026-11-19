// THE CATALOG'S FIRST WORDS: which of an agent's messages its row "catalog-first-words"
// (core/lib/src/agents/collection.ts `CATALOG_ROWS`) copies as the agent's title, by the stream's
// own filter evaluation (event-expressions.ts). Here because core/lib has no JSONata of its own.
import type { StreamEvent } from "iterate/stream/processor";
import { expect, test } from "vitest";
import { CATALOG_ROWS } from "../../../lib/src/agents/collection.ts";
import { evaluateFilter, evaluatePayload } from "./event-expressions.ts";

const row = CATALOG_ROWS.find((one) => one.name === "catalog-first-words")!;

test("a call's note is no first words: the title is the first line a member wrote after it", () => {
  const events = [
    added(1, {
      role: "user",
      actor: { type: "user" },
      content: "[call] jo joined the call.",
      callNote: { kind: "joined", who: { actor: "/members/a", name: "jo" } },
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    }),
    added(2, {
      role: "user",
      actor: { type: "user" },
      content: "\nPlan the launch email\nfor Friday",
    }),
  ];
  expect(firstWords(events)).toBe("Plan the launch email");
});

test("a member's message and a message with no actor still title the agent; an agent's own does not", () => {
  expect(firstWords([added(1, { role: "user", content: "Hello there" })])).toBe("Hello there");
  expect(
    firstWords([added(1, { role: "user", actor: { type: "agent" }, content: "from an agent" })]),
  ).toBeUndefined();
});

/** A message on an agent's log, as the stream holds it. */
const added = (offset: number, payload: Record<string, unknown>) =>
  ({
    offset,
    type: "events.iterate.com/agent/context-added",
    payload,
    createdAt: "2026-11-19T16:00:00.000Z",
  }) as unknown as StreamEvent;

/** The title the catalog takes from the first of `events` that passes the row's filter. */
function firstWords(events: StreamEvent[]) {
  const first = events.find((event) => {
    const answer = evaluateFilter(row.filter, event);
    if ("error" in answer) throw answer.error;
    return answer.passes;
  });
  if (!first) return undefined;
  const copy = evaluatePayload(row.target.payload, first);
  if ("error" in copy) throw copy.error;
  return copy.payload.title;
}
