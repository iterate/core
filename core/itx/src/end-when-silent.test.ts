// When a session's peer counts as gone: the probe and the end, in fake time with the production
// timings. The socket itself (its frames, its close, the teardown) is session.ts's.
import { expect, test, vi } from "vitest";
import { endWhenSilent, SILENCE } from "./end-when-silent.ts";

test("a peer heard more often than the silence allows is never probed nor ended", () => {
  using watched = watchedPeer();
  for (let beat = 0; beat < 20; beat++) {
    vi.advanceTimersByTime(SILENCE.silentMs - 1);
    watched.watch.heard();
  }
  expect(watched).toMatchObject({ seen: { probes: 0, ends: [] } });
});

test("silence makes exactly one probe, and no end while the probe may still be answered", () => {
  using watched = watchedPeer();
  vi.advanceTimersByTime(SILENCE.silentMs);
  expect(watched).toMatchObject({ seen: { probes: 1, ends: [] } });
  vi.advanceTimersByTime(SILENCE.answerWithinMs - 1);
  expect(watched).toMatchObject({ seen: { probes: 1, ends: [] } });
});

test("a frame after the probe cancels the end, and a later silence probes again", () => {
  using watched = watchedPeer();
  vi.advanceTimersByTime(SILENCE.silentMs + 1_000);
  watched.watch.heard();
  // the check that would have ended the session finds the peer heard
  vi.advanceTimersByTime(SILENCE.answerWithinMs);
  expect(watched).toMatchObject({ seen: { probes: 1, ends: [] } });
  // checks run on their own beat, so the second probe comes at the first check after the silence
  vi.advanceTimersByTime(SILENCE.silentMs);
  expect(watched).toMatchObject({ seen: { probes: 2, ends: [] } });
});

test("no frame after the probe ends the session once, with how long the peer was silent", () => {
  using watched = watchedPeer();
  vi.advanceTimersByTime(SILENCE.silentMs + SILENCE.answerWithinMs);
  expect(watched).toMatchObject({
    seen: { probes: 1, ends: [SILENCE.silentMs + SILENCE.answerWithinMs] },
  });
  vi.advanceTimersByTime(10 * 60_000);
  expect(watched).toMatchObject({
    seen: { probes: 1, ends: [SILENCE.silentMs + SILENCE.answerWithinMs] },
  });
  // the watch stopped itself: nothing keeps the Worker's invocation busy
  expect(vi.getTimerCount()).toBe(0);
});

test("stop() clears every timer, and an end that was due never comes", () => {
  using watched = watchedPeer();
  vi.advanceTimersByTime(SILENCE.silentMs);
  watched.watch.stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(10 * 60_000);
  expect(watched).toMatchObject({ seen: { probes: 1, ends: [] } });
});

/** A watch in fake time that counts its probes and records each end's silent time. */
function watchedPeer() {
  vi.useFakeTimers();
  const seen = { probes: 0, ends: [] as number[] };
  const watch = endWhenSilent({
    probe: () => {
      seen.probes += 1;
    },
    end: (silentForMs) => seen.ends.push(silentForMs),
  });
  return {
    seen,
    watch,
    [Symbol.dispose]() {
      watch.stop();
      vi.useRealTimers();
    },
  };
}
