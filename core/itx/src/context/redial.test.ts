import { expect, test } from "vitest";
import { redial } from "./redial.ts";

test("a re-dial nobody wants any more ends at once, whether it waits on a dial or between two", async () => {
  // The session that held the lend is over. Its invocation has ended, and what it handed to
  // waitUntil has 30 seconds: a re-dial that waits out its own minute is cut there, with a warning.
  for (const dial of [
    // the object is resetting and does not answer
    never,
    // the object answers "not ready" each time, so the re-dial waits longer between dials
    async () => ({ status: 503 }),
  ]) {
    let wanted = true;
    setTimeout(() => (wanted = false), 300);
    const started = Date.now();
    expect(await redial(dial, () => !wanted, 60_000)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_500);
  }
});

test("a wanted re-dial is as before: a socket ends it, a refusal ends it, and its time runs out", async () => {
  const socket = { accept() {}, close() {} } as unknown as WebSocket;
  let dials = 0;
  const ready = await redial(
    async () => ((dials += 1) < 3 ? { status: 503 } : { status: 101, webSocket: socket }),
    () => false,
    10_000,
  );
  expect(ready).toMatchObject({ socket, dials: 3 });
  expect(
    await redial(
      async () => ({ status: 403 }),
      () => false,
      10_000,
    ),
  ).toEqual({
    gaveUp: "the context answered 403",
    dials: 1,
  });
  expect(await redial(never, () => false, 400)).toEqual({
    gaveUp: "no answer within 0.4 s of the drop",
    dials: 1,
  });
});

/** A dial that never answers: the object is resetting. */
function never() {
  return new Promise<{ status: number }>(() => {});
}
