import { expect, test } from "vitest";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import { defineItxHost } from "../host.ts";
import { CoreContract, reduceCoreEventBatch } from "./core-processor.ts";
import { eventsOwedAtWake } from "./wake-events.ts";

const ROW: StreamEventInput = {
  type: "events.iterate.com/itx/subscription-configured",
  idempotencyKey: "itx/platform-subscription",
  payload: { name: "platform", target: "itx.builtins.platformHook.deliverEvents", afterOffset: 0 },
};

test("a context born while the host named no wake event gets it at its first wake after the host does, once", () => {
  const born = context();
  // telemetry off: the host names nothing, and nothing is appended
  expect(born.wake([])).toEqual([]);
  // on: the first wake appends the row, and no later one does
  expect(born.wake([ROW])).toEqual([ROW]);
  expect(born.wake([ROW])).toEqual([]);
  expect(born.wake([ROW])).toEqual([]);
});

test("a row that its owner removed stays removed: the key is spent", () => {
  const owned = context();
  owned.wake([ROW]);
  owned.subscriptions.delete("platform");
  expect(owned.wake([ROW])).toEqual([]);
});

test("a context that holds the subscription already, from its birth, is not given it again", () => {
  // a row set again would start its delivery again from the row's first offset
  const old = context();
  old.subscriptions.add("platform");
  expect(old.wake([ROW])).toEqual([]);
});

test("a context whose row a member appended by hand, with no key, is not given it again: the row stands by any means", () => {
  // the row as a member's connection appends it, reduced by the kernel's own reducer
  const byHand: StreamEvent = {
    offset: 9,
    path: "/agents/web/one",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: { origin: "/agents/web/one" },
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "platform",
      target: "itx.builtins.platformHook.deliverEvents",
      afterOffset: 0,
    },
  };
  const state = reduceCoreEventBatch([byHand], CoreContract.initialState(), (error) => {
    throw error;
  });
  expect(state.subscriptions.platform).toMatchObject({ configuredAtOffset: 9 });
  // no key in the log, and still nothing is owed: a second row would send the whole log twice
  expect(eventsOwedAtWake([ROW], () => false, Object.keys(state.subscriptions))).toEqual([]);
});

test("a paused context is owed nothing, and gets the event at its first wake after the resume", () => {
  // a paused stream refuses a batch that holds anything but its own records: an owed event in
  // the wake's batch would fail every wake, the one that resumes it too
  expect(eventsOwedAtWake([ROW], () => false, [], true)).toEqual([]);
  // the key is unspent, so the wake after the resume appends it
  expect(eventsOwedAtWake([ROW], () => false, [], false)).toEqual([ROW]);
});

test("a wake event with no key is refused: it would be appended at every wake", () => {
  expect(() => eventsOwedAtWake([{ ...ROW, idempotencyKey: undefined }], () => false, [])).toThrow(
    "idempotencyKey",
  );
});

/** A context's log, as far as a wake reads it: the keys it holds and the subscriptions that stand. */
function context() {
  const keys = new Set<string>();
  const subscriptions = new Set<string>();
  return {
    subscriptions,
    /** One wake with the host's `events`: what is appended, applied as the stream would. */
    wake(events: readonly StreamEventInput[]) {
      const owed = eventsOwedAtWake(events, (key) => keys.has(key), [...subscriptions]);
      for (const event of owed) {
        keys.add(event.idempotencyKey!);
        subscriptions.add((event.payload as { name: string }).name);
      }
      return owed;
    },
  };
}

// the kernel's reducer reads the host's roots when it resolves a row's target
defineItxHost({ firstPartyFacets: {} });
