// client/live-state.ts — THE CLIENT HALF of live state (`iterate/client`), framework-free, for
// browsers and node test clients. Two concepts:
//   live state store  — `createLiveStateStore`: the pure reduce — seed from the producer, apply each delta, heal on a gap
//   live state client — `connectLiveState`: wire an itx session's `subscribe` + a seed read to the store

import { z } from "zod";
import { applyPatch, errorCode, type PatchOp } from "../lib.ts";
import { retryWhileUnavailable, versionStartedBy } from "./new-version.ts";

// ── live state store ── THE CLIENT HALF of live state, for browsers and node test clients.
// A deliberately small store for the platform's live-state wire:
//
//   • SEED from the producer — `{rev, state}` read via an RPC method (a processor's
//     `liveSnapshot()`, a mini-app's `state()`).
//   • APPLY each `{key, from, to, patch}` delta the subscription delivers: a patch lands only when
//     its `from` matches the held rev; a mismatch means a missed delta (or a reborn producer's fresh
//     epoch) — resync by re-reading the seed.
//
// The patch format is lib.ts (an RFC-6902 subset), so this store shares ONE applyPatch with
// the producer — no second diff implementation. No capnweb import: a caller wires the transport and
// hands deltas in, so the same store backs a node test client and the React hook (client/react.tsx).

/** One live-state delta off the wire — the payload of an `events.iterate.com/itx/live-state-changed`
 *  ephemeral event, delivered raw to the subscriber. `patch: null` = the change was too large to
 *  send — the rev moved, re-read the seed. */
export type LiveStateDelta = { key: string; from: number; to: number; patch: PatchOp[] | null };

/** The delta as it arrives over the wire — PARSED, never cast: `from`/`to` MUST be real numbers (a
 *  non-numeric rev would poison the held revision and silently wedge every later frame), and each
 *  patch op is a known RFC-6902-subset shape. A frame that fails this heals by re-reading the seed
 *  rather than being applied — the same recovery the store already runs on a revision gap. */
const LiveStateDeltaMessage: z.ZodType<LiveStateDelta> = z.object({
  key: z.string(),
  from: z.number(),
  to: z.number(),
  patch: z
    .array(
      z.union([
        z.object({ op: z.literal("add"), path: z.string(), value: z.unknown() }),
        z.object({ op: z.literal("replace"), path: z.string(), value: z.unknown() }),
        z.object({ op: z.literal("remove"), path: z.string() }),
      ]),
    )
    .nullable(),
});

/** What the producer's seed read returns: the current revision paired with the current value. */
export type LiveStateSeed<S> = { rev: number; state: S };

export type LiveStateStore<S> = {
  /** The current value, or undefined until the first seed lands. */
  get(): S | undefined;
  /** The held revision, or null before the first seed. */
  rev(): number | null;
  /** Subscribe to changes (for React's useSyncExternalStore, or a test's await-loop). */
  subscribe(listener: () => void): () => void;
  /** Seed (or re-seed) from a seed read — the first paint, and the heal after a gap. */
  seed(seed: LiveStateSeed<S>): void;
  /** Hold nothing again (`rev` null, value undefined): the producer whose state it held is gone
   *  (a new version of its context, or its facet no longer hosted). Any seed is taken next. */
  clear(): void;
  /** Reduce one delta in; on a revision gap call `resync` and hold the value until a fresh seed. */
  apply(delta: LiveStateDelta, resync: () => void): void;
};

export function createLiveStateStore<S>(): LiveStateStore<S> {
  // `rev: null` until the first seed lands.
  let held: { rev: number | null; state: S | undefined } = { rev: null, state: undefined };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  return {
    get: () => held.state,
    rev: () => held.rev,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    seed: (seed) => {
      // MONOTONIC: a late-resolving OLDER seed read must never move the store backwards past state
      // deltas have already advanced (a delta-triggered resync can race the initial seed). Revisions
      // are time-seeded epochs plus increments, so "newer" is numeric.
      if (held.rev !== null && seed.rev < held.rev) return;
      held = { rev: seed.rev, state: seed.state };
      notify();
    },
    clear: () => {
      held = { rev: null, state: undefined };
      notify();
    },
    apply: (delta, resync) => {
      // A delta at-or-behind the held rev is a duplicate/out-of-order frame — drop it silently.
      // (Epochs are minted from the clock, so a reborn producer's fresh chain sits numerically above
      // every rev an old chain handed out; a frame wholly behind us is genuinely old. The one
      // exception is a clock that regressed across a producer rebirth — accepted: the next applied
      // or gapped frame resyncs from a fresh seed anyway.)
      if (held.rev !== null && delta.to <= held.rev) return;
      // A gap (its `from` is not the held rev — including "no seed yet") means a missed delta or a
      // reborn epoch, and a `null` patch means the change was too large to send — either way re-read
      // the seed instead of applying onto a diverged base.
      if (delta.from !== held.rev || !delta.patch) {
        resync();
        return;
      }
      held = { rev: delta.to, state: applyPatch(held.state as S, delta.patch) };
      notify();
    },
  };
}

// ── live state client ── wire an itx session's `subscribe` + a seed read to a LiveStateStore.
// This is the whole cleanroom client: a subscription that consumes the live-state event type
// (`itx.subscribe({ target, consumes: ["events.iterate.com/itx/live-state-changed", …] })`) delivers
// every key's deltas in batches, and the `itx/created` of the context's next version; this filters the watched `key` and reduces each delta into the store; a
// `readSeed` thunk reads `{rev, state}` for the first paint and every gap heal. Transport lives here so
// the store above and the React hook stay pure.

/** The slice of an itx session this needs — a capnweb `IterateContextRpcTarget` proxy satisfies it structurally:
 *  `subscribe` hands back a DISPOSABLE handle (disposing it removes the subscription server-side). */
export type LiveStateItx = {
  subscribe(input: {
    name?: string;
    consumes?: string[];
    target: (events: unknown[], range: unknown) => void;
    // `name`: the subscription row's name. Over RPC the handle is a stub, which answers a property
    // as a promise.
  }): Promise<{ [Symbol.dispose](): void; name?: string | PromiseLike<string> }>;
};

/** A connected live-state subscription: the store rendering it, and the dispose that removes the
 *  server-side subscription (the handle's disposer; the session's end does the same). */
export type LiveStateConnection<S> = {
  store: LiveStateStore<S>;
  /** Unsubscribe on the server and stop reducing deltas. Safe to call more than once. */
  dispose(): Promise<void>;
};

/** Subscribe to a producer's live state and reduce it into a store. `readSeed` reads the seed
 *  (`itx.invoke("itx.facets.get('slug').liveSnapshot()")` for a processor, or a mini-app's
 *  own `state()` method). Subscribe happens BEFORE the first seed, so a delta racing the seed just
 *  triggers one seed re-read — never a lost update. Gap heals are SINGLE-FLIGHT (a burst of gapped
 *  frames triggers one seed read, not one per frame); a failed heal is reported through `onResync`
 *  and retried by the next delivered delta (its `from` still mismatches, so it re-triggers).
 *
 *  The store never holds an earlier version's state (`itx.newVersion`, core/lib/README.md "A new
 *  version of a context"). When the context starts a later version, its `itx/created` reaches the
 *  row (the kernel's last batch to every row, whatever it consumes): the store is cleared, the
 *  connection subscribes again — the row went with the earlier version — and reads the new
 *  producer's seed. A seed read that fails with code `NO_FACET` clears the store too: the facet
 *  whose state it held is not hosted now. */
export async function connectLiveState<S>(
  itx: LiveStateItx,
  opts: {
    key: string;
    name?: string;
    readSeed: () => Promise<LiveStateSeed<S>>;
    /** Called after each gap heal attempt: "healed" on a fresh seed, the error when the seed read
     *  failed (the store keeps its last value, or holds nothing after `NO_FACET`; the next delta
     *  retries), or when the subscribe of a new version failed. */
    onResync?: (result: "healed" | Error) => void;
    /** Abort while the FIRST seed is still pending (a component unmounting): the row just configured
     *  is recalled and the connect rejects — a seed read that never answers leaves nothing lent. */
    signal?: AbortSignal;
  },
): Promise<LiveStateConnection<S>> {
  const store = createLiveStateStore<S>();
  let healing = false;
  let healWantedAgain = false; // a gap seen WHILE a heal was in flight: the seed may predate it
  let disposed = false;
  let subscription: { [Symbol.dispose](): void } | undefined;
  /** How many later versions of the context the connection has followed: a row's delivery and a
   *  seed read begun in an earlier version answer into nothing. */
  let versions = 0;
  const reseed = () => {
    if (disposed) return;
    if (healing) {
      healWantedAgain = true;
      return;
    }
    healing = true;
    const of = versions;
    const settled = () => {
      healing = false;
      if (disposed || !healWantedAgain) return;
      healWantedAgain = false;
      reseed();
    };
    void opts.readSeed().then(
      (s) => {
        if (!disposed && versions === of) {
          store.seed(s);
          opts.onResync?.("healed");
        }
        settled();
      },
      (e: unknown) => {
        if (!disposed && versions === of) {
          if (errorCode(e) === "NO_FACET") store.clear();
          opts.onResync?.(e instanceof Error ? e : new Error(String(e)));
        }
        settled();
      },
    );
  };
  /** A batch the row of version `of` delivers: live-state deltas (every key's; the watched key's
   *  are kept), and the kernel's events of a new version. */
  const take = (of: number, events: unknown[]) => {
    if (disposed || versions !== of) return;
    for (const e of events) {
      // capnweb hands each event as a live proxy value — deep-copy to a plain object, then PARSE
      // the frame (never cast network data). An event that does not decode (`undefined` makes
      // `JSON.parse(JSON.stringify(undefined))` throw) fails the parse below like a malformed
      // one: any throw here would skip every later delta in the batch. A malformed OR undecodable
      // frame heals from a fresh seed instead of poisoning the held rev or escaping this callback.
      let event: unknown;
      try {
        event = JSON.parse(JSON.stringify(e));
      } catch {
        event = undefined;
      }
      const started = versionStartedBy(event);
      if (started !== undefined && started > 1) {
        startOver();
        return;
      }
      // `itx/version-ended`, which comes first in the kernel's last batch, and a first version's
      // `itx/created`: no delta, and no gap
      if (KernelVersionEvent.safeParse(event).success) continue;
      const parsed = LiveStateDeltaEvent.safeParse(event);
      if (!parsed.success) {
        reseed();
        continue;
      }
      if (parsed.data.payload.key !== opts.key) continue;
      // `store.apply` runs `applyPatch`, which THROWS on a patch it refuses (a `/__proto__` path a
      // legitimate state with an own `__proto__` key produces, say). Contain it per frame: heal from
      // a fresh seed — which re-seeds the state DIRECTLY, no patch to reject — instead of escaping this
      // callback and skipping every later frame.
      try {
        store.apply(parsed.data.payload, reseed);
      } catch {
        reseed();
      }
    }
  };
  /** Subscribe the row for the version held. False when it is of no use (disposed, or a later
   *  version started while it was made). */
  const subscribeRow = async () => {
    const of = versions;
    const handle = await retryWhileUnavailable(
      () =>
        itx.subscribe({
          name: opts.name,
          consumes: ["events.iterate.com/itx/live-state-changed", "events.iterate.com/itx/created"],
          target: (events: unknown[]) => take(of, events),
        }),
      () => disposed || versions !== of,
    );
    if (!handle) return false;
    if (disposed || versions !== of) {
      disposeRow(handle);
      return false;
    }
    subscription = handle;
    return true;
  };
  /** The context started a later version: its producer and this connection's row are gone. */
  const startOver = () => {
    versions += 1;
    const earlier = subscription;
    subscription = undefined;
    disposeRow(earlier);
    store.clear();
    void subscribeRow().then(
      (subscribed) => subscribed && reseed(),
      (e: unknown) => !disposed && opts.onResync?.(e instanceof Error ? e : new Error(String(e))),
    );
  };
  await subscribeRow();
  try {
    const seed = opts.readSeed();
    const { signal } = opts;
    const aborted =
      signal &&
      new Promise<never>((_, reject) => {
        const abort = () =>
          reject(
            signal.reason ??
              new Error("connectLiveState: aborted while the first seed was pending"),
          );
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    if (aborted) seed.catch(() => undefined); // the seed read may still settle after the abort — quietly
    const first = await (aborted ? Promise.race([seed, aborted]) : seed);
    // a new version that started while the first seed was read reads its own seed
    if (versions === 0) store.seed(first);
  } catch (error) {
    // The seed failed after the row was configured: recall it, or the server keeps delivering to a
    // callback no one holds (and the session's other rows wait behind it).
    disposed = true;
    disposeRow(subscription);
    throw error;
  }
  return {
    store,
    async dispose() {
      if (disposed) return;
      disposed = true;
      disposeRow(subscription); // the server removes the row and recalls the lent callback
    },
  };
}

/** The delta event as the subscription delivers it. */
const LiveStateDeltaEvent = z.object({ payload: LiveStateDeltaMessage });

/** The kernel's events of a version's border, which reach every row whatever it consumes. */
const KernelVersionEvent = z.object({
  type: z.enum(["events.iterate.com/itx/version-ended", "events.iterate.com/itx/created"]),
});

function disposeRow(row: { [Symbol.dispose](): void } | undefined) {
  try {
    row?.[Symbol.dispose]();
  } catch {
    // a dead session has already removed it — the socket close disposed every handle — and a
    // row of an earlier version went with that version
  }
}
