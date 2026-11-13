// The dialing side of the awake socket: when a context opens it, how long it holds it and when it
// closes it. The accepting side is the runtime's hibernation API, which only a deployed stack has
// (core/alchemy/scripts/smoke).
import { expect, test, vi } from "vitest";
import {
  AWAKE_CONTEXT_PATH,
  AWAKE_MAX_HOLD_MS,
  AWAKE_QUIET_MS,
  AWAKE_REDIAL_AFTER_MS,
  AWAKE_SUMMARY_EVERY_MS,
  AwakeSocket,
  decideAwakeSocket,
} from "./awake.ts";

test.for([
  { name: "work in flight holds it", sinceEntry: 30_000, busy: true, expected: "hold" },
  { name: "an entry just now holds it", sinceEntry: 200, busy: false, expected: "hold" },
  {
    name: "quiet for the window closes it",
    sinceEntry: AWAKE_QUIET_MS,
    busy: false,
    expected: "close",
  },
  // a count of work in flight that never returns to zero must not hold a context in memory
  {
    name: "the longest hold closes it under work",
    sinceEntry: AWAKE_MAX_HOLD_MS,
    busy: true,
    expected: "close",
  },
])("$name", ({ sinceEntry, busy, expected }) => {
  expect(
    decideAwakeSocket({ now: 1_000_000, lastEntryAt: 1_000_000 - sinceEntry, busy }),
  ).toMatchObject({
    action: expected,
  });
});

test("a context dials once for a burst of entries and closes its socket a quiet window later", async () => {
  vi.useFakeTimers();
  const far = farEnd();
  const awake = new AwakeSocket({ path: "/agents/a", dial: far.dial, busy: () => false });
  awake.entered();
  await vi.advanceTimersByTimeAsync(400);
  awake.entered();
  await vi.advanceTimersByTimeAsync(AWAKE_QUIET_MS - 1);
  expect(far).toMatchObject({ dials: 1, open: 1 });
  await vi.advanceTimersByTimeAsync(1);
  expect(far).toMatchObject({ dials: 1, open: 0 });
  // no timer is left: a pending timer holds a Durable Object in memory, billed
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

test("work in flight holds the socket, and it closes within a quiet window of the work's end", async () => {
  vi.useFakeTimers();
  const far = farEnd();
  let busy = true;
  const awake = new AwakeSocket({ path: "/agents/a", dial: far.dial, busy: () => busy });
  awake.entered();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(far).toMatchObject({ dials: 1, open: 1 });
  busy = false;
  await vi.advanceTimersByTimeAsync(AWAKE_QUIET_MS);
  expect(far).toMatchObject({ open: 0 });
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

test("work that never ends holds the socket no longer than the longest hold after the last entry", async () => {
  vi.useFakeTimers();
  const far = farEnd();
  const awake = new AwakeSocket({ path: "/agents/a", dial: far.dial, busy: () => true });
  awake.entered();
  await vi.advanceTimersByTimeAsync(AWAKE_MAX_HOLD_MS + AWAKE_QUIET_MS);
  expect(far).toMatchObject({ dials: 1, open: 0 });
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

test("a socket the far end closed under a working context is dialed again", async () => {
  vi.useFakeTimers();
  const far = farEnd();
  const awake = new AwakeSocket({ path: "/agents/a", dial: far.dial, busy: () => true });
  awake.entered();
  await vi.advanceTimersByTimeAsync(10);
  far.closeAll();
  await vi.advanceTimersByTimeAsync(AWAKE_QUIET_MS);
  expect(far).toMatchObject({ dials: 2, open: 1 });
  vi.useRealTimers();
});

test("a dial that fails is not tried again for a while, however often the context is entered", async () => {
  vi.useFakeTimers();
  const far = farEnd();
  far.refuse = true;
  const awake = new AwakeSocket({ path: "/agents/a", dial: far.dial, busy: () => false });
  for (let entry = 0; entry < 50; entry += 1) {
    awake.entered();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(far).toMatchObject({ dials: 1 });
  await vi.advanceTimersByTimeAsync(AWAKE_REDIAL_AFTER_MS);
  far.refuse = false;
  awake.entered();
  await vi.advanceTimersByTimeAsync(10);
  expect(far).toMatchObject({ dials: 2, open: 1 });
  vi.useRealTimers();
});

test("a context sends its summary before it closes, and while it works, only when it changed", async () => {
  vi.useFakeTimers();
  const far = farEnd();
  let busy = true;
  let summary = "one";
  const awake = new AwakeSocket({
    path: "/agents/a",
    dial: far.dial,
    busy: () => busy,
    summary: () => summary,
  });
  awake.entered();
  await vi.advanceTimersByTimeAsync(AWAKE_SUMMARY_EVERY_MS * 3);
  expect(far).toMatchObject({ sent: ["one"] });
  summary = "two";
  await vi.advanceTimersByTimeAsync(AWAKE_SUMMARY_EVERY_MS);
  expect(far).toMatchObject({ sent: ["one", "two"] });
  summary = "three";
  busy = false;
  await vi.advanceTimersByTimeAsync(AWAKE_QUIET_MS);
  expect(far).toMatchObject({ sent: ["one", "two", "three"], open: 0 });
  vi.useRealTimers();
});

test("a dial that lands after the context went quiet still sends the summary, then closes", async () => {
  vi.useFakeTimers();
  const far = farEnd();
  const slowDial = async () => {
    await new Promise((resolve) => setTimeout(resolve, AWAKE_QUIET_MS * 3));
    return far.dial();
  };
  const awake = new AwakeSocket({
    path: "/agents/a",
    dial: slowDial,
    busy: () => false,
    summary: () => "one",
  });
  awake.entered();
  await vi.advanceTimersByTimeAsync(AWAKE_QUIET_MS * 4);
  expect(far).toMatchObject({ dials: 1, sent: ["one"], open: 0 });
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

test("a summary that cannot be made closes the socket all the same", async () => {
  vi.useFakeTimers();
  const far = farEnd();
  const awake = new AwakeSocket({
    path: "/agents/a",
    dial: far.dial,
    busy: () => false,
    summary: () => {
      throw new Error("the log cannot be read");
    },
  });
  awake.entered();
  await vi.advanceTimersByTimeAsync(AWAKE_QUIET_MS);
  expect(far).toMatchObject({ sent: [], open: 0 });
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

test("the context that accepts the sockets dials none", async () => {
  vi.useFakeTimers();
  const far = farEnd();
  new AwakeSocket({ path: AWAKE_CONTEXT_PATH, dial: far.dial, busy: () => true }).entered();
  await vi.advanceTimersByTimeAsync(AWAKE_QUIET_MS);
  expect(far).toMatchObject({ dials: 0 });
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

/** The accepting context, as the dialer sees it: counts dials and the sockets that are open. */
function farEnd() {
  const closers = new Set<() => void>();
  const far = {
    dials: 0,
    open: 0,
    sent: [] as string[],
    refuse: false,
    closeAll: () => closers.forEach((close) => close()),
    dial: async () => {
      far.dials += 1;
      if (far.refuse) return { status: 503 };
      const listeners: (() => void)[] = [];
      const close = () => {
        if (!closers.delete(close)) return;
        far.open -= 1;
        listeners.forEach((listener) => listener());
      };
      return {
        status: 101,
        webSocket: {
          accept: () => {
            far.open += 1;
            closers.add(close);
          },
          close,
          send: (message: string) => void far.sent.push(message),
          // the one cast: a test socket has only what the dialer uses
          addEventListener: ((_type: string, listener: () => void) =>
            void listeners.push(listener)) as WebSocket["addEventListener"],
        },
      };
    },
  };
  return far;
}
