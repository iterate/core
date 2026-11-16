// mind-now.test.ts — the mind-now note's text for a set of catalog rows: who is shown, in what
// order, how many, how a long row is cut, and when there is nothing to say.
import { expect, test } from "vitest";
import type { AgentListing } from "./api.ts";
import { agentAtWork, mindNowNote } from "./mind-now.ts";

const NOW = Date.parse("2026-11-16T10:42:00Z");
const SELF = "/agents/me";

test("working and waiting first, then the others active in the last hour, newest first; never itself, nor the long idle", () => {
  const note = mindNowNote(
    [
      row(SELF, { status: "working", title: "Me", minutesAgo: 0 }),
      row("/agents/idle-recent", { title: "Done lately", minutesAgo: 5 }),
      row("/agents/email/t4412", {
        status: "waiting",
        title: "Re: March invoice",
        activity: "Waiting for external event",
        minutesAgo: 14,
      }),
      row("/agents/people/jonas/web/a", {
        status: "working",
        title: "Fix the flaky smoke check",
        activity: "Reading the deploy log",
        minutesAgo: 2,
      }),
      row("/agents/claude/beelink/s1", {
        kind: "claude",
        host: "beelink",
        status: "working",
        title: "Dash cleanup",
        activity: "Opening a pull request",
        minutesAgo: 0,
      }),
      row("/agents/old", { title: "Last week", minutesAgo: 600 }),
    ],
    { self: SELF, now: NOW },
  );
  expect(note).toBe(
    [
      "[the mind now, 2026-11-16 10:42 UTC] 3 other agents are at work. `await itx.agents.list()` is this list, live; `await itx.agents.get(path).recent()` is what one of them did lately.",
      'working  /agents/claude/beelink/s1  claude on beelink  "Dash cleanup": Opening a pull request (now)',
      'working  /agents/people/jonas/web/a  "Fix the flaky smoke check": Reading the deploy log (2 min ago)',
      'waiting  /agents/email/t4412  "Re: March invoice": Waiting for external event (14 min ago)',
      'idle     /agents/idle-recent  "Done lately" (5 min ago)',
    ].join("\n"),
  );
});

test("at most 12 rows, the rest counted; a long row is cut in its title or activity, never in its path", () => {
  const path = `/agents/people/someone/web/${"x".repeat(60)}`;
  const rows = Array.from({ length: 15 }, (_, index) =>
    row(`${path}${String(index).padStart(2, "0")}`, {
      status: "working",
      title: "A title that goes on ".repeat(5),
      activity: "Doing something long ".repeat(5),
      minutesAgo: index,
    }),
  );
  const lines = mindNowNote(rows, { self: SELF, now: NOW })!.split("\n");
  expect(lines).toHaveLength(14);
  expect(lines.at(-1)).toBe("…and 3 more that were active in the last hour.");
  for (const [index, line] of lines.slice(1, 13).entries()) {
    expect(line).toContain(`${path}${String(index).padStart(2, "0")}`);
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line).toContain("…");
  }
});

test("at work: working or waiting within a day, or idle with a line from the last ten minutes (a script runs then, though the row says idle)", () => {
  const atWork = (fields: Parameters<typeof row>[1]) => agentAtWork(row("/agents/x", fields), NOW);
  expect(atWork({ status: "working", minutesAgo: 600 })).toBe(true);
  expect(atWork({ status: "waiting", minutesAgo: 25 * 60 })).toBe(false);
  expect(atWork({ status: "idle", activity: "Fetching it", minutesAgo: 3 })).toBe(true);
  expect(atWork({ status: "idle", activity: "Fetching it", minutesAgo: 11 })).toBe(false);
  expect(atWork({ status: "idle", minutesAgo: 1 })).toBe(false);
  expect(atWork({ status: "ended", activity: "Done", minutesAgo: 1 })).toBe(false);
});

test("nothing to say when no other agent was active in the last hour", () => {
  const rows = [
    row(SELF, { status: "working", minutesAgo: 0 }),
    row("/agents/old", { status: "working", minutesAgo: 90 }),
    row("/agents/never", {}),
  ];
  expect(mindNowNote(rows, { self: SELF, now: NOW })).toBeNull();
  expect(mindNowNote([], { self: SELF, now: NOW })).toBeNull();
});

function row(path: string, fields: Partial<AgentListing> & { minutesAgo?: number }): AgentListing {
  const { minutesAgo, ...rest } = fields;
  return {
    path,
    createdAt: "2026-11-01T00:00:00Z",
    parent: null,
    kind: "iterate",
    host: null,
    status: "idle",
    activity: null,
    description: null,
    title: null,
    lastActivityAt:
      minutesAgo === undefined ? null : new Date(NOW - minutesAgo * 60_000).toISOString(),
    ...rest,
  };
}
