// client/live-state.test.ts — the client half's transport pins (the store's own reduce is exercised through it).

import { expect, test } from "vitest";
import { codedError } from "../lib.ts";
import { connectLiveState, type LiveStateDelta, type LiveStateSeed } from "./live-state.ts";

// ── live state client ── `connectLiveState` (client/live-state.ts) over a fake
// itx session and a `readSeed` whose reads the test resolves BY HAND, so the heal window is a thing the
// test controls rather than a race it hopes for. This is the transport: the first paint's seed read, gap heals SINGLE-FLIGHT, and a delta that
// lands WHILE a heal is in flight (the seed being read may predate it).

type Seed = LiveStateSeed<{ n: number }>;

test("a delta delivered WHILE a gap heal is in flight re-reads the seed once the heal lands — the store converges on the producer, never sits behind it", async () => {
  const h = harness();
  const connecting = connectLiveState(h.itx, { key: "k", readSeed: h.readSeed });
  await settle();
  expect(h.seedReads).toHaveLength(1); // the first paint's seed read
  h.seedReads[0]({ rev: 5, state: { n: 5 } });
  const connection = await connecting;
  expect(connection.store.rev()).toBe(5);

  // A gap (from 7, not 5): the store cannot apply onto a diverged base, so it heals — ONE seed read.
  h.deliverDelta({ key: "k", from: 7, to: 8, patch: [{ op: "replace", path: "/n", value: 8 }] });
  await settle();
  expect(h.seedReads).toHaveLength(2);

  // The producer moves on WHILE that read is in flight. Heals are single-flight: no second read yet…
  h.deliverDelta({ key: "k", from: 8, to: 9, patch: [{ op: "replace", path: "/n", value: 9 }] });
  await settle();
  expect(h.seedReads).toHaveLength(2);

  // …but the heal answers with what the producer held when the read was SERVED — revision 8 — so
  // the client knows it is still behind and re-reads the seed exactly once more.
  h.seedReads[1]({ rev: 8, state: { n: 8 } });
  await settle();
  expect(h.seedReads).toHaveLength(3);
  h.seedReads[2]({ rev: 9, state: { n: 9 } });
  await settle();
  expect(h.seedReads).toHaveLength(3); // a clean heal re-triggers nothing
  expect(connection.store.rev()).toBe(9);
  expect(connection.store.get()).toEqual({ n: 9 });
  await connection.dispose();
});

test("the first seed read FAILING disposes the row it just configured — no callback is left lent to a connection nobody holds", async () => {
  let disposals = 0;
  const itx = {
    async subscribe() {
      return {
        [Symbol.dispose]() {
          disposals += 1;
        },
      };
    },
  };
  await expect(
    connectLiveState(itx, {
      key: "k",
      readSeed: () => Promise.reject(new Error("seed read down")),
    }),
  ).rejects.toThrow("seed read down");
  expect(disposals).toBe(1);
});

test("an abort while the FIRST seed is still pending (a component unmounting) recalls the row just configured and rejects the connect — a seed read that never answers leaves nothing lent", async () => {
  let disposals = 0;
  const itx = {
    async subscribe() {
      return {
        [Symbol.dispose]() {
          disposals += 1;
        },
      };
    },
  };
  const unmounted = new AbortController();
  const connecting = connectLiveState(itx, {
    key: "k",
    readSeed: () => new Promise<Seed>(() => {}), // never answers
    signal: unmounted.signal,
  });
  await settle();
  expect(disposals).toBe(0); // configured, waiting on the seed
  unmounted.abort();
  await expect(connecting).rejects.toThrow(/aborted/); // the signal's own reason (a DOMException)
  expect(disposals).toBe(1);
});

test("a malformed delta (a non-numeric rev) heals from a fresh seed instead of poisoning the held rev", async () => {
  const h = harness();
  const connecting = connectLiveState(h.itx, { key: "k", readSeed: h.readSeed });
  await settle();
  h.seedReads[0]({ rev: 5, state: { n: 5 } });
  const connection = await connecting;
  expect(connection.store.rev()).toBe(5);

  // A frame whose `to` is a numeric STRING would, if applied, become the held rev — then every later
  // valid frame reads as "behind" (dropped) and the client wedges forever. It must be rejected at the
  // boundary and healed from a fresh seed, exactly like a revision gap.
  h.deliverRaw({
    key: "k",
    from: 5,
    to: "9999999999999999999",
    patch: [{ op: "replace", path: "/n", value: 9 }],
  });
  await settle();
  expect(connection.store.rev()).toBe(5); // NOT poisoned by the bogus rev
  expect(h.seedReads).toHaveLength(2); // healed from a fresh seed

  // After the heal, a well-formed frame still applies normally — the client is not wedged.
  h.seedReads[1]({ rev: 5, state: { n: 5 } });
  await settle();
  h.deliverDelta({ key: "k", from: 5, to: 6, patch: [{ op: "replace", path: "/n", value: 6 }] });
  await settle();
  expect(connection.store.rev()).toBe(6);
  expect(connection.store.get()).toEqual({ n: 6 });
  await connection.dispose();
});

test("an event with an OMITTED payload heals and does not skip a later valid delta in the batch", async () => {
  const h = harness();
  const connecting = connectLiveState(h.itx, { key: "k", readSeed: h.readSeed });
  await settle();
  h.seedReads[0]({ rev: 5, state: { n: 5 } });
  const connection = await connecting;
  expect(connection.store.rev()).toBe(5);

  // A batch whose FIRST event has no payload — `JSON.parse(JSON.stringify(undefined))` throws before
  // validation; an unguarded callback would throw out and drop the valid second delta. The decode is
  // guarded, so the malformed one heals (a seed read) and the valid one still applies.
  h.deliverEvents([
    {}, // no payload key
    { payload: { key: "k", from: 5, to: 6, patch: [{ op: "replace", path: "/n", value: 6 }] } },
  ]);
  await settle();
  expect(connection.store.rev()).toBe(6); // the valid delta was NOT skipped
  expect(connection.store.get()).toEqual({ n: 6 });

  // The malformed event also kicked off a heal; answer it stale — monotonic seed must not move back.
  h.seedReads[1]?.({ rev: 5, state: { n: 5 } });
  await settle();
  expect(connection.store.rev()).toBe(6);
  await connection.dispose();
});

test("a patch applyPatch REJECTS heals from a fresh seed instead of escaping the callback", async () => {
  const h = harness();
  const connecting = connectLiveState(h.itx, { key: "k", readSeed: h.readSeed });
  await settle();
  h.seedReads[0]({ rev: 5, state: { n: 5 } });
  const connection = await connecting;
  expect(connection.store.rev()).toBe(5);

  // A schema-valid delta whose patch applyPatch REFUSES (a `/__proto__` path a legitimate state with an
  // own `__proto__` key would produce). store.apply throws; without a guard it escapes and skips later
  // frames. It must heal from a fresh seed and keep going.
  const before = h.seedReads.length;
  h.deliverDelta({
    key: "k",
    from: 5,
    to: 6,
    patch: [{ op: "add", path: "/__proto__", value: {} }],
  });
  await settle();
  expect(h.seedReads.length).toBe(before + 1); // healed from a fresh seed
  h.seedReads[h.seedReads.length - 1]({ rev: 6, state: { n: 6 } });
  await settle();

  // A later valid delta still applies — the callback was not wedged.
  h.deliverDelta({ key: "k", from: 6, to: 7, patch: [{ op: "replace", path: "/n", value: 7 }] });
  await settle();
  expect(connection.store.rev()).toBe(7);
  expect(connection.store.get()).toEqual({ n: 7 });
  await connection.dispose();
});

// ── a new version of the context (`itx.newVersion`) ──

/** The kernel's last batch to every row when the context starts version 2. */
const versionTwo = [
  { type: "events.iterate.com/itx/version-ended", offset: 40, payload: { version: 1 } },
  { type: "events.iterate.com/itx/created", offset: 41, payload: { path: "/", version: 2 } },
];

test("after a border the store holds nothing, the connection subscribes again and takes the new producer's seed whatever its revision, and nothing of the earlier version lands after", async () => {
  const h = harness();
  const resyncs: ("healed" | Error)[] = [];
  const connecting = connectLiveState(h.itx, {
    key: "k",
    readSeed: h.readSeed,
    onResync: (result) => resyncs.push(result),
  });
  await settle();
  h.seedReads[0]({ rev: 5, state: { n: 5 } });
  const connection = await connecting;
  // a heal of the earlier version is in flight when the border arrives
  h.deliverDelta({ key: "k", from: 7, to: 8, patch: [{ op: "replace", path: "/n", value: 8 }] });
  await settle();
  expect(h.seedReads).toHaveLength(2);

  h.deliverEvents(versionTwo);
  await settle();
  expect(connection.store.get()).toBeUndefined();
  expect(connection.store.rev()).toBeNull();
  expect(h.rows.map((row) => row.disposed)).toEqual([true, false]);
  expect(h.rows[1]).toMatchObject({
    consumes: ["events.iterate.com/itx/live-state-changed", "events.iterate.com/itx/created"],
  });

  // the earlier version's heal answers late: it is not taken, and the new version's seed is read
  h.seedReads[1]({ rev: 9, state: { n: 9 } });
  await settle();
  expect(connection.store.rev()).toBeNull();
  expect(h.seedReads).toHaveLength(3);
  h.seedReads[2]({ rev: 1, state: { n: 1 } });
  await settle();
  expect(connection.store.rev()).toBe(1);
  expect(connection.store.get()).toEqual({ n: 1 });
  expect(resyncs).toEqual(["healed"]);

  // a delta that the earlier row delivers after the border is not applied
  h.deliverOn(0, [
    { payload: { key: "k", from: 1, to: 2, patch: [{ op: "replace", path: "/n", value: 2 }] } },
  ]);
  await settle();
  expect(connection.store.rev()).toBe(1);
  // the new row's deltas are
  h.deliverDelta({ key: "k", from: 1, to: 2, patch: [{ op: "replace", path: "/n", value: 2 }] });
  await settle();
  expect(connection.store.get()).toEqual({ n: 2 });
  await connection.dispose();
  expect(h.rows.map((row) => row.disposed)).toEqual([true, true]);
});

test("a seed read that fails with NO_FACET clears the store; any other failure keeps the value", async () => {
  const h = harness();
  const resyncs: ("healed" | Error)[] = [];
  const connecting = connectLiveState(h.itx, {
    key: "k",
    readSeed: h.readSeed,
    onResync: (result) => resyncs.push(result),
  });
  await settle();
  h.seedReads[0]({ rev: 5, state: { n: 5 } });
  const connection = await connecting;

  h.deliverDelta({ key: "k", from: 7, to: 8, patch: null });
  await settle();
  h.seedFailures[1]!(new Error("seed read down"));
  await settle();
  expect(connection.store.get()).toEqual({ n: 5 });
  expect(connection.store.rev()).toBe(5);

  h.deliverDelta({ key: "k", from: 8, to: 9, patch: null });
  await settle();
  h.seedFailures[2]!(codedError("NO_FACET", "no facet k"));
  await settle();
  expect(connection.store.get()).toBeUndefined();
  expect(connection.store.rev()).toBeNull();
  expect(resyncs.map((result) => (result instanceof Error ? result.message : result))).toEqual([
    "seed read down",
    "no facet k",
  ]);

  // a producer hosted again: its first delta heals from its seed
  h.deliverDelta({ key: "k", from: 1, to: 2, patch: null });
  await settle();
  h.seedReads[3]({ rev: 2, state: { n: 2 } });
  await settle();
  expect(connection.store.get()).toEqual({ n: 2 });
  await connection.dispose();
});

/** A fake itx session (its `subscribe` hands the delivery callback to the test; a delivery goes to
 *  the newest row) and a `readSeed` whose every read parks until the test answers or fails it. */
function harness() {
  const rows: {
    consumes: string[] | undefined;
    deliver: (events: unknown[], range: unknown) => void;
    disposed: boolean;
  }[] = [];
  const itx = {
    async subscribe(input: {
      name?: string;
      consumes?: string[];
      target: (events: unknown[], range: unknown) => void;
    }) {
      const row = { consumes: input.consumes, deliver: input.target, disposed: false };
      rows.push(row);
      return {
        [Symbol.dispose]() {
          row.disposed = true;
        },
      };
    },
  };
  const deliver = (events: unknown[]) => rows.at(-1)!.deliver(events, {});
  const seedReads: ((seed: Seed) => void)[] = [];
  const seedFailures: ((error: Error) => void)[] = [];
  return {
    itx,
    rows,
    readSeed: () =>
      new Promise<Seed>((resolve, reject) => {
        seedReads.push(resolve);
        seedFailures.push(reject);
      }),
    seedReads,
    seedFailures,
    deliverDelta: (delta: LiveStateDelta) => deliver([{ payload: delta }]),
    deliverRaw: (payload: unknown) => deliver([{ payload }]),
    deliverEvents: (rawEvents: unknown[]) => deliver(rawEvents),
    deliverOn: (index: number, rawEvents: unknown[]) => rows[index]!.deliver(rawEvents, {}),
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
