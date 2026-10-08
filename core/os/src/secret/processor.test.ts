// src/secret/processor.test.ts — the SecretProcessor's executable spec: the reduce as declarative
// `{ events → state }` rows (iterate/stream/test-support `reduceProcessor`). The verbs — `itx.secrets.set`
// landing the fact on the path and on the owner's root, the value in the facet, egress substituting
// it — are pinned end to end in test/vitest/os/secrets.e2e.test.ts and test/vitest/os/secrets-connections.e2e.test.ts.

import { expect, test } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import { SecretProcessor } from "./processor.ts";
import type { SecretState } from "./contract.ts";

const set = {
  type: "events.iterate.com/secret/set",
  payload: { path: "/secrets/shop", urls: ["https://shop.example"] },
};
const setWithRefresh = {
  type: "events.iterate.com/secret/set",
  payload: {
    path: "/secrets/shop",
    urls: ["https://shop.example"],
    refresh: "oauth-refresh-token",
  },
};
const deleted = { type: "events.iterate.com/secret/deleted", payload: { path: "/secrets/shop" } };
const used = {
  type: "events.iterate.com/secret/used",
  payload: { method: "GET", url: "https://shop.example/pets", status: 200 },
};
const refreshed = {
  type: "events.iterate.com/secret/refreshed",
  payload: { kind: "oauth-refresh-token", ok: true },
};
/** A cell as a fact carries it; `nonce` tells one write's from another's. */
const cellOf = (nonce: string) => ({
  context: "prj_1.iterate/secrets/shop",
  urls: ["https://shop.example"],
  refresh: null,
  nonce,
  material: { algorithm: "AES-256-GCM+SECRET-V1" as const, iv: "aXY=", ciphertext: "Y2lwaGVy" },
});
const sealedSet = {
  type: "events.iterate.com/secret/set",
  payload: { path: "/secrets/shop", urls: ["https://shop.example"], sealed: cellOf("w1") },
};
/** A mint that refreshed the write at `basedOn`. */
const minted = (basedOn: number, nonce: string) => ({
  type: "events.iterate.com/secret/refreshed",
  payload: { kind: "oauth-refresh-token", ok: true, sealed: cellOf(nonce), basedOn },
});
const resealed = (basedOn: number, nonce: string) => ({
  type: "events.iterate.com/secret/resealed",
  payload: { sealed: cellOf(nonce), basedOn },
});

const rows: {
  name: string;
  events: { type: string; payload?: unknown }[];
  state: SecretState;
}[] = [
  {
    name: "the empty state",
    events: [],
    state: { material: null, deletion: null, borrowed: null },
  },
  {
    name: "a set puts material there, at its offset",
    events: [set],
    state: { material: { offset: 1, setAt: 1 }, deletion: null, borrowed: null },
  },
  {
    name: "a set carries its cell, which the state keeps",
    events: [sealedSet],
    state: {
      material: { offset: 1, setAt: 1, setNonce: "w1", sealed: cellOf("w1") },
      deletion: null,
      borrowed: null,
    },
  },
  {
    name: "a mint of the current write is the material, at the mint's offset",
    events: [sealedSet, minted(1, "m1")],
    state: {
      material: { offset: 2, setAt: 1, setNonce: "w1", sealed: cellOf("m1") },
      deletion: null,
      borrowed: null,
    },
  },
  {
    name: "a mint of a write a set replaced meanwhile changes nothing: the set is the material",
    events: [
      sealedSet,
      { ...sealedSet, payload: { ...sealedSet.payload, sealed: cellOf("w2") } },
      minted(1, "m1"),
    ],
    state: {
      material: { offset: 2, setAt: 2, setNonce: "w2", sealed: cellOf("w2") },
      deletion: null,
      borrowed: null,
    },
  },
  {
    name: "a reseal of the current write (a rotation) is the material; one of an older write is not",
    events: [sealedSet, resealed(1, "r1"), resealed(1, "r2")],
    state: {
      material: { offset: 2, setAt: 1, setNonce: "w1", sealed: cellOf("r1") },
      deletion: null,
      borrowed: null,
    },
  },
  {
    name: "a refresh that failed, and one with no cell, change nothing",
    events: [
      sealedSet,
      { ...refreshed, payload: { ...refreshed.payload, ok: false, error: "401" } },
      refreshed,
    ],
    state: {
      material: { offset: 1, setAt: 1, setNonce: "w1", sealed: cellOf("w1") },
      deletion: null,
      borrowed: null,
    },
  },
  {
    name: "a second set is the latest write (a rotation, a strategy added)",
    events: [set, setWithRefresh],
    state: { material: { offset: 2, setAt: 2 }, deletion: null, borrowed: null },
  },
  {
    name: "a deletion empties it, at its offset",
    events: [set, deleted],
    state: { material: null, deletion: { offset: 2 }, borrowed: null },
  },
  {
    name: "re-settable: a set after the deletion brings the secret back and clears the deletion",
    events: [set, deleted, set],
    state: { material: { offset: 3, setAt: 3 }, deletion: null, borrowed: null },
  },
  {
    name: "dies once: a second deletion after the certificate is a harmless fact",
    events: [set, deleted, deleted],
    state: { material: null, deletion: { offset: 2 }, borrowed: null },
  },
  {
    name: "the use and refresh facts (not consumed) and an unrelated event leave the state as it was",
    events: [set, used, refreshed, { type: "note" }],
    state: { material: { offset: 1, setAt: 1 }, deletion: null, borrowed: null },
  },
  {
    name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
    events: [set, { type: "events.iterate.com/secret/set", payload: { path: 1, urls: [] } }],
    state: { material: { offset: 1, setAt: 1 }, deletion: null, borrowed: null },
  },
  {
    name: "a lend arriving is the borrowed path's material; its own revocation empties it",
    events: [borrowed("lend_a"), revoked("lend_b"), revoked("lend_a")],
    state: { material: null, deletion: { offset: 3 }, borrowed: null },
  },
  {
    name: "a borrowed path stands on its lend until that lend is revoked",
    events: [borrowed("lend_a"), revoked("lend_b")],
    state: { material: { offset: 1, setAt: 1 }, deletion: null, borrowed: { lendId: "lend_a" } },
  },
  {
    name: "on the lender's path a lend and its revocation leave the material as it was",
    events: [
      set,
      {
        type: "events.iterate.com/secret/lent",
        payload: { path: "/secrets/g", lendId: "lend_a", to: "prj_1", as: "/secrets/g" },
      },
      revoked("lend_a"),
    ],
    state: { material: { offset: 1, setAt: 1 }, deletion: null, borrowed: null },
  },
];
for (const { name, events, state } of rows)
  test(`SecretProcessor — the reduce: ${name}`, () =>
    expect(reduceProcessor(new SecretProcessor(), events)).toEqual(state));

function borrowed(lendId: string) {
  return {
    type: "events.iterate.com/secret/borrowed",
    payload: { path: "/secrets/g", lendId, lender: { userId: "user_1" }, urls: ["https://g.test"] },
  };
}

function revoked(lendId: string) {
  return {
    type: "events.iterate.com/secret/lend-revoked",
    payload: { path: "/secrets/g", lendId, reason: "lender" },
  };
}
