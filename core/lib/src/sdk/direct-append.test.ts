// sdk/direct-append.test.ts — the append a push hands a facet, held only while used.
import { expect, test, vi } from "vitest";
import { DirectAppendHolder, DIRECT_APPEND_IDLE_MS, type DirectAppend } from "./direct-append.ts";

test("a held append carries the facet's appends under their cause, and is let go once idle for DIRECT_APPEND_IDLE_MS — never while an append is in flight", async () => {
  using _timers = fakeTimers();
  const pushed = fakeAppend();
  const holder = new DirectAppendHolder();
  expect(holder).toMatchObject({ held: false });
  holder.hold(pushed.append);
  // a stub handed in a call is released when the call ends
  expect(pushed).toMatchObject({ log: ["dup"] });
  await expect(holder.append("cause-1", [{ type: "speaker-frame" }])).resolves.toEqual([
    { type: "speaker-frame", offset: 1 },
  ]);
  expect(pushed).toMatchObject({ log: ["dup", "append cause-1 speaker-frame"] });

  // an append that takes longer than the idle time keeps it until it settles, with no timer
  // polling meanwhile
  pushed.slow = true;
  const slow = holder.append("cause-2", [{ type: "speaker-frame" }]);
  const timers = vi.spyOn(globalThis, "setTimeout");
  await vi.advanceTimersByTimeAsync(DIRECT_APPEND_IDLE_MS * 3);
  expect(holder).toMatchObject({ held: true });
  expect(timers.mock.calls.length).toBeLessThanOrEqual(1);
  pushed.finish();
  await slow;
  await vi.advanceTimersByTimeAsync(DIRECT_APPEND_IDLE_MS - 1);
  expect(holder).toMatchObject({ held: true });
  await vi.advanceTimersByTimeAsync(1);
  expect(holder).toMatchObject({ held: false });
  expect(pushed.log.at(-1)).toBe("dispose");

  // the next push hands it over again
  holder.hold(pushed.append);
  expect(holder).toMatchObject({ held: true });
});

test("each push's append replaces the one held, which is let go once the append in flight on it settles", async () => {
  using _timers = fakeTimers();
  const first = fakeAppend();
  const next = fakeAppend();
  const holder = new DirectAppendHolder();
  holder.hold(first.append);
  first.slow = true;
  const inFlight = holder.append("in flight", [{ type: "speaker-frame" }]);
  holder.hold(next.append); // a push arrives while the append is in flight
  expect(first.log).not.toContain("dispose");
  first.finish();
  await expect(inFlight).resolves.toEqual([{ type: "speaker-frame", offset: 1 }]);
  expect(first.log.at(-1)).toBe("dispose");
  await holder.append("after", [{ type: "speaker-frame" }]);
  expect(next).toMatchObject({ log: ["dup", "append after speaker-frame"] });
});

test("pushes that replace the held append while one append is slow let each replaced one go once its own appends settle", async () => {
  using _timers = fakeTimers();
  const slow = fakeAppend();
  const holder = new DirectAppendHolder();
  holder.hold(slow.append);
  slow.slow = true;
  const inFlight = holder.append("in flight", [{ type: "speaker-frame" }]);
  const pushed = Array.from({ length: 50 }, () => fakeAppend());
  for (const each of pushed) holder.hold(each.append);
  // every one a later push replaced, with no append in flight on it, is gone already; the last is
  // held
  expect(pushed.slice(0, -1).every((each) => each.log.at(-1) === "dispose")).toBe(true);
  expect(pushed.at(-1)).toMatchObject({ log: ["dup"] });
  expect(slow.log).not.toContain("dispose");
  slow.finish();
  await inFlight;
  expect(slow.log.at(-1)).toBe("dispose");
});

test("with no append held, append answers nothing: the engine takes its other way", async () => {
  await expect(new DirectAppendHolder().append(undefined, [])).resolves.toBeUndefined();
});

/** Vitest's fake timers until the block ends. */
function fakeTimers(): Disposable {
  vi.useFakeTimers();
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}

/** A pushed append that logs what it is asked, answering each append with its events at offset 1;
 *  `slow` holds an append until `finish()`. A released stub refuses every call, as workerd's
 *  does. */
function fakeAppend() {
  let release: () => void = () => {};
  const fake = {
    log: [] as string[],
    slow: false,
    finish: () => release(),
    // answers events with an offset alone, not whole StreamEvents: all the holder passes on
    append: Object.assign(
      async (cause: unknown, events: { type: string }[]) => {
        if (fake.log.at(-1) === "dispose") throw new Error("a released stub");
        fake.log.push(`append ${String(cause)} ${events.map((event) => event.type).join(",")}`);
        if (fake.slow) await new Promise<void>((resolve) => (release = resolve));
        return events.map((event) => ({ ...event, offset: 1 }));
      },
      {
        dup: (): DirectAppend => {
          fake.log.push("dup");
          return fake.append;
        },
        [Symbol.dispose]: () => void fake.log.push("dispose"),
      },
    ) as unknown as DirectAppend,
  };
  return fake;
}
