// at-work.test.ts — whether a catalog row's agent is at work.
import { expect, test } from "vitest";
import { agentAtWork } from "./at-work.ts";

const NOW = Date.parse("2026-11-16T10:42:00Z");

test("at work: working or waiting within a day, or idle with a line from the last ten minutes (a script runs then, though the row says idle)", () => {
  const atWork = (row: {
    status: "working" | "idle" | "waiting" | "ended";
    activity?: string;
    minutesAgo: number;
  }) =>
    agentAtWork(
      {
        status: row.status,
        activity: row.activity || null,
        lastActivityAt: new Date(NOW - row.minutesAgo * 60_000).toISOString(),
      },
      NOW,
    );
  expect(atWork({ status: "working", minutesAgo: 600 })).toBe(true);
  expect(atWork({ status: "waiting", minutesAgo: 25 * 60 })).toBe(false);
  expect(atWork({ status: "idle", activity: "Fetching it", minutesAgo: 3 })).toBe(true);
  expect(atWork({ status: "idle", activity: "Fetching it", minutesAgo: 11 })).toBe(false);
  expect(atWork({ status: "idle", minutesAgo: 1 })).toBe(false);
  expect(atWork({ status: "ended", activity: "Done", minutesAgo: 1 })).toBe(false);
});
