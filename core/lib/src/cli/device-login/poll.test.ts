import { expect, onTestFinished, test, vi } from "vitest";
import { pollUntilAnswered, type PollAnswer } from "./poll.ts";

test.for<{ name: string; answers: PollAnswer<string>[]; polledAt: number[]; retries: number[] }>([
  {
    name: "polls at once, then every interval until the tokens",
    answers: [{ kind: "pending" }, { kind: "pending" }, { kind: "tokens", value: "t" }],
    polledAt: [0, 5_000, 10_000],
    retries: [],
  },
  {
    name: "adds five seconds to the interval for good after a slow_down",
    answers: [{ kind: "slow-down" }, { kind: "pending" }, { kind: "tokens", value: "t" }],
    polledAt: [0, 10_000, 20_000],
    retries: [],
  },
  {
    name: "tries again after a transient failure, its backoff doubling from the interval",
    answers: [
      { kind: "transient", reason: "503" },
      { kind: "transient", reason: "fetch failed" },
      { kind: "pending" },
      { kind: "tokens", value: "t" },
    ],
    polledAt: [0, 5_000, 15_000, 20_000],
    retries: [5_000, 10_000],
  },
])("$name", async ({ answers, polledAt, retries }) => {
  const clock = fakeClock();
  const polls: number[] = [];
  const waits: number[] = [];
  const done = pollUntilAnswered({
    intervalSeconds: 5,
    deadline: Date.now() + 300_000,
    poll: async () => {
      polls.push(Date.now() - clock.start);
      return answers.shift()!;
    },
    onRetry: (_reason, waitMs) => waits.push(waitMs),
  });
  await vi.runAllTimersAsync();
  expect(await done).toBe("t");
  expect({ polls, waits }).toEqual({ polls: polledAt, waits: retries });
});

test.for<{ name: string; answer: PollAnswer<string>; message: string }>([
  {
    name: "a declined sign-in",
    answer: { kind: "refused", error: "access_denied" },
    message: "Sign-in was declined.",
  },
  {
    name: "an expired code",
    answer: { kind: "refused", error: "expired_token" },
    message: "The code expired before anyone approved it. Run `iterate login` again.",
  },
  {
    name: "any other refusal",
    answer: { kind: "refused", error: "invalid_grant", description: "Unknown device code" },
    message: "Sign-in failed (invalid_grant: Unknown device code). Run `iterate login` again.",
  },
])("ends at $name", async ({ answer, message }) => {
  fakeClock();
  const done = pollUntilAnswered({
    intervalSeconds: 5,
    deadline: Date.now() + 300_000,
    poll: async () => answer,
    onRetry: () => {},
  });
  await expect(done).rejects.toThrow(message);
});

test("gives up at the deadline, even while the platform keeps failing", async () => {
  const clock = fakeClock();
  let polls = 0;
  const done = pollUntilAnswered({
    intervalSeconds: 5,
    deadline: Date.now() + 300_000,
    poll: async () => {
      polls++;
      return { kind: "transient", reason: "503" };
    },
    onRetry: () => {},
  });
  const settled = expect(done).rejects.toThrow("The code expired before anyone approved it.");
  await vi.runAllTimersAsync();
  await settled;
  // 0, 5, 15, 35, 65, 95 … s: the backoff stops doubling at 30 s, and no poll is after 300 s
  expect({ polls, last: Date.now() - clock.start }).toMatchObject({ polls: 12, last: 275_000 });
});

/** Fake `setTimeout` and `Date`, restored when the test ends; `start` is the test's zero. */
function fakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  onTestFinished(() => void vi.useRealTimers());
  return { start: Date.now() };
}
