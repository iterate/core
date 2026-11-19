// ANOTHER MIND AS A SIGNER, on the Worker's own SQL (./test-support.ts `sqliteStack`): a mind is
// let in by its id, a sender in the hostname form is still taken by its hostname, and
// a rule by hostname is pinned to an id at its first use.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { errorCode } from "iterate/lib";
import { identityHashOf, type SignedRecord } from "iterate/mind-identity";
import {
  base64url,
  type Envelope,
  keyIdOf,
  signedMlDsa65,
  signedP256,
  statementOf,
  statementText,
  verifySignature,
} from "iterate/signed";
import { expect, test, vi } from "vitest";
import { newIdentityLog } from "../../lib/src/test-support/identity-log.ts";
import { identityIntakeResponse } from "./identity.ts";
import { mindKeyOf, mindSignerOf } from "./minds.ts";
import { signedByStack, signedDeliveryByStack, stackKeyResponse } from "./stack-key.ts";
import { statementsResponse } from "./statements.ts";
import { sqliteStack, stackKeyPair } from "./test-support.ts";

const MIND = "iterate.example.com";
const SITE = { origin: `https://${MIND}`, rpId: MIND };
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const NOTE = "events.iterate.com/test/note-added";

test("a member's passkey lets a mind in by its id, the mind's statement lands as itself, and an empty rule ends it", async () => {
  const { send, rule, peer, melds } = await stack("peer-one.net");
  expect(await send(await rule([`/minds/${peer.mind}/`]))).toMatchObject({ status: 200 });
  expect(melds()).toMatchObject([
    {
      domain: "peer-one.net",
      mind: peer.mind,
      append: `["/minds/${peer.mind}/"]`,
      pinned_at: null,
    },
  ]);
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/notes` }))).toMatchObject({
    status: 200,
    facts: [
      {
        path: `/minds/${peer.mind}/notes`,
        events: [
          {
            type: NOTE,
            idempotencyKey: `mind:${peer.mind}:/notes@4`,
            source: {
              signer: {
                principal: { actor: peer.mind, kind: "mind", hostname: "peer-one.net" },
                key: peer.key,
              },
            },
          },
        ],
      },
    ],
  });
  expect(await send(await rule([]))).toMatchObject({ status: 200 });
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/notes` }))).toMatchObject({
    status: 403,
    body: { refused: `${peer.mind} is not let in here` },
  });
});

test("a mind that names its hostname as `from` (the hostname form) is taken as the id that its log proves", async () => {
  const { send, rule, peer } = await stack("peer-old.net");
  await send(await rule([`/minds/${peer.mind}/`]));
  const logged = vi.spyOn(console, "info");
  expect(
    await send(await peer.signs({ path: `/minds/${peer.mind}/notes`, form: "hostname" })),
  ).toMatchObject({
    status: 200,
    facts: [
      {
        events: [
          {
            idempotencyKey: `mind:${peer.mind}:/notes@4`,
            source: {
              signer: { principal: { actor: peer.mind, kind: "mind", hostname: "peer-old.net" } },
            },
          },
        ],
      },
    ],
  });
  expect(logged).toHaveBeenCalledWith({
    event: "auth.mind-statement-hostname-form",
    hostname: "peer-old.net",
  });
});

test("a rule by hostname is pinned at its first use to the id that the hostname serves; then another id there is refused and shown", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { send, peer, melds, db, serve } = await stack("peer-pinned.net");
  // a rule by hostname: by `domain`, with no id
  db.prepare(
    `insert into mind_melds (domain, append, key, configured_at, configured_by)
     values ('peer-pinned.net', '["/minds/peer-pinned.net/"]', null, 1, 'user-owner')`,
  ).run();
  // its sender in the hostname form, then in the id form: both land
  for (const [form, path] of [
    ["hostname", "/minds/peer-pinned.net/notes"],
    ["id", `/minds/${peer.mind}/notes`],
  ] as const)
    expect(await send(await peer.signs({ path, form }))).toMatchObject({
      status: 200,
      facts: [{ path, events: [{ source: { signer: { principal: { actor: peer.mind } } } }] }],
    });
  expect(melds()).toMatchObject([
    { domain: "peer-pinned.net", mind: peer.mind, pinned_at: expect.any(Number), refused: null },
  ]);
  // the hostname now serves another mind: its statement is refused, and the row says so
  const other = await newIdentityLog(["peer-pinned.net"]);
  await serve(other, await other.next(other.genesis, { workingKeys: [peer.entry] }));
  vi.setSystemTime(Date.now() + 61_000);
  expect(
    await send(await peer.signs({ path: "/minds/peer-pinned.net/x", form: "hostname" })),
  ).toMatchObject({ status: 403 });
  expect(JSON.parse(melds()[0]!.refused as string)).toEqual({
    mind: other.mind,
    at: expect.any(Number),
  });
  // and the other id, by its own name, is no mind that is let in
  expect(
    await send(await peer.signs({ path: `/minds/${other.mind}/x`, from: other.mind })),
  ).toMatchObject({
    status: 403,
    body: { refused: "peer-pinned.net is let in here as another mind" },
  });
  vi.useRealTimers();
});

test("a statement that names an id refuses a hostname whose log is another mind's", async () => {
  const { send, rule, peer, melds } = await stack("peer-liar.net");
  await send(await rule([`/minds/${peer.mind}/`]));
  expect(
    await send(
      await peer.signs({
        path: `/minds/${peer.mind}/x`,
        fromHost: "peer-liar.net",
        from: "c".repeat(64),
      }),
    ),
  ).toMatchObject({
    status: 403,
    body: { refused: "peer-liar.net is let in here as another mind" },
  });
  // its log proves the id that is let in: nothing is shown to the owner
  expect(melds()).toMatchObject([{ refused: null }]);
});

test("a mind's statement is refused, with its own reason, where its rule does not reach", async () => {
  const { send, rule, peer, fetched } = await stack("peer-four.net");
  await send(await rule([`/minds/${peer.mind}/`]));
  expect(await send(await peer.signs({ path: "/agents/one" }))).toEqual({
    status: 403,
    body: {
      refused: `this key adds events under /minds/${peer.mind}/, /minds/peer-four.net/ alone`,
    },
    facts: [],
  });
  for (const path of [`/minds/${peer.mind}/../agents`, `/minds/${peer.mind}/./x`])
    expect(await send(await peer.signs({ path }))).toMatchObject({ status: 403, facts: [] });
  expect(
    await send(
      await peer.signs({
        path: `/minds/${peer.mind}/x`,
        type: "events.iterate.com/itx/subscription-configured",
      }),
    ),
  ).toEqual({
    status: 403,
    body: { refused: "events.iterate.com/itx/subscription-configured is the platform's own" },
    facts: [],
  });
  // one read of the mind's identity log from its genesis, and one on from the head it keeps
  expect(fetched).toEqual([
    "https://peer-four.net/.well-known/iterate",
    `https://peer-four.net/.well-known/iterate?after=${peer.head}`,
  ]);
});

// Each case is its own mind: a reader keeps a log for a minute by its hostname.
test.for([
  {
    name: "a key that the log does not list",
    domain: "peer-ten.net",
    by: "an unlisted key",
    refused: "peer-ten.net lists no such working key",
  },
  {
    name: "a P-256 signature under the listed key's id",
    domain: "peer-fifteen.net",
    by: "P-256",
    refused: "this key signs as ML-DSA-65",
  },
  {
    name: "another ML-DSA-65 key's signature under the listed key's id",
    domain: "peer-sixteen.net",
    by: "a forger",
    refused: "the signature is not this key's",
  },
] as const)("a mind's statement signed by $name is refused", async ({ domain, by, refused }) => {
  const { send, rule, peer } = await stack(domain);
  await send(await rule([`/minds/${peer.mind}/`]));
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/x`, by }))).toEqual({
    status: 403,
    body: { refused },
    facts: [],
  });
});

test("a working key that the log lists for another purpose signs no statement", async () => {
  const { send, rule, peer } = await stack("peer-eleven.net", { peerPurpose: "backups" });
  await send(await rule([`/minds/${peer.mind}/`]));
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/x` }))).toEqual({
    status: 403,
    body: { refused: "peer-eleven.net lists no such working key" },
    facts: [],
  });
});

test("an older rule sent again does not start a meld that a later rule ended, and is refused with no fact", async () => {
  const { send, rule, melds, peer } = await stack("peer-two.net");
  const older = await rule([`/minds/${peer.mind}/`], {}, -1_000);
  expect(await send(await rule([]))).toMatchObject({ status: 200 });
  expect(await send(older)).toEqual({
    status: 403,
    body: { refused: "a newer rule for this mind, or for this hostname, is in force here" },
    facts: [],
  });
  expect(melds()).toMatchObject([{ append: "[]" }]);
});

test("a rule dated more than a minute ahead is refused, so an end signed after a rule always ends it", async () => {
  const { send, rule, melds, peer } = await stack("peer-future.net");
  expect(await send(await rule([`/minds/${peer.mind}/`], {}, 120_000))).toEqual({
    status: 403,
    body: { refused: "the statement is dated more than a minute from now" },
    facts: [],
  });
  expect(melds()).toEqual([]);
  expect(await send(await rule([`/minds/${peer.mind}/`], {}, 30_000))).toMatchObject({
    status: 200,
  });
  expect(await send(await rule([], {}, 31_000))).toMatchObject({ status: 200 });
  expect(melds()).toMatchObject([{ append: "[]" }]);
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/x` }))).toMatchObject({
    status: 403,
  });
  // and a day back is the other bound: a statement that still lives, dated 25 hours ago
  expect(await send(await rule([], {}, -25 * 3600_000, 26 * 3600_000))).toMatchObject({
    status: 403,
    body: { refused: "the statement is dated more than a day ago" },
  });
});

test("a rule by id for a mind that moved takes its row to the new hostname", async () => {
  const { send, rule, melds, peer } = await stack("peer-moved.net");
  await send(await rule([`/minds/${peer.mind}/`], { name: "peer-before.net" }, -1_000));
  await send(await rule([`/minds/${peer.mind}/`]));
  expect(melds()).toMatchObject([{ domain: "peer-moved.net", mind: peer.mind }]);
});

test("an end changes the row at its name alone: a leftover row by hostname ends, and the same mind's row at its new hostname stays", async () => {
  const { send, rule, melds, peer, db } = await stack("peer-live.net");
  db.prepare(
    `insert into mind_melds (domain, append, key, configured_at, configured_by)
     values ('peer-leftover.net', '["/minds/peer-leftover.net/"]', null, 1, 'user-owner')`,
  ).run();
  expect(await send(await rule([`/minds/${peer.mind}/`]))).toMatchObject({ status: 200 });
  expect(await send(await rule([], { name: "peer-leftover.net" }, 1_000))).toMatchObject({
    status: 200,
  });
  expect(melds()).toMatchObject([
    { domain: "peer-leftover.net", mind: null, append: "[]" },
    { domain: "peer-live.net", mind: peer.mind, append: `["/minds/${peer.mind}/"]` },
  ]);
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/x` }))).toMatchObject({
    status: 200,
  });
  // an end older than the row it names is refused, and says so
  expect(await send(await rule([], { name: "peer-live.net" }, -5_000))).toMatchObject({
    status: 403,
    body: {
      refused: "a newer rule at peer-live.net, or a rule there for another mind, is in force here",
    },
  });
});

test("a rule by id lets in a sender in the hostname form at its hostname's path too", async () => {
  const { send, rule, peer } = await stack("peer-older.net");
  await send(await rule([`/minds/${peer.mind}/`]));
  expect(
    await send(await peer.signs({ path: "/minds/peer-older.net/notes", form: "hostname" })),
  ).toMatchObject({ status: 200, facts: [{ path: "/minds/peer-older.net/notes" }] });
});

test("a move takes the id's kept log state to the new hostname, and a refusal at another hostname is written on no row", async () => {
  const { send, rule, melds, peer, serveAt } = await stack("peer-new.net", {
    peerHostnames: ["peer-new.net", "peer-first.net"],
  });
  await serveAt("peer-first.net", [peer.log.genesis, peer.second]);
  await send(await rule([`/minds/${peer.mind}/`], { name: "peer-first.net" }, -1_000));
  expect(
    await send(await peer.signs({ path: `/minds/${peer.mind}/x`, fromHost: "peer-first.net" })),
  ).toMatchObject({ status: 200 });
  const kept = melds()[0]!.state;
  expect(kept).toEqual(expect.any(String));
  await send(await rule([`/minds/${peer.mind}/`]));
  expect(melds()).toMatchObject([{ domain: "peer-new.net", mind: peer.mind, state: kept }]);
  // another mind's log at a hostname that is not the row's: refused, and the row says nothing
  const other = await newIdentityLog(["peer-other.net"]);
  await serveAt("peer-other.net", [other.genesis]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
  expect(
    await send(await peer.signs({ path: `/minds/${peer.mind}/x`, fromHost: "peer-other.net" })),
  ).toMatchObject({ status: 403 });
  expect(melds()).toMatchObject([{ refused: null }]);
  vi.useRealTimers();
});

test("a stale move deletes nothing: a newer rule at the new hostname stays, the moved mind's row stays, and the move is refused", async () => {
  const { send, rule, owner, melds, peer } = await stack("peer-moved.net");
  const other = "d".repeat(64);
  expect(
    await send(await rule([`/minds/${peer.mind}/`], { name: "peer-before.net" }, -2_000)),
  ).toMatchObject({ status: 200 });
  expect(
    await send(
      await owner(`/minds/${other}`, { append: [`/minds/${other}/`], name: "peer-moved.net" }),
    ),
  ).toMatchObject({ status: 200 });
  expect(await send(await rule([`/minds/${peer.mind}/`], {}, -1_000))).toEqual({
    status: 403,
    body: { refused: "a newer rule for this mind, or for this hostname, is in force here" },
    facts: [],
  });
  expect(melds()).toMatchObject([
    { domain: "peer-before.net", mind: peer.mind },
    { domain: "peer-moved.net", mind: other },
  ]);
});

test("a statement that fails its checks pins no row by hostname: a bad signature, then the right one pins it", async () => {
  const { send, peer, melds, db } = await stack("peer-unpinned.net");
  db.prepare(
    `insert into mind_melds (domain, append, key, configured_at, configured_by)
     values ('peer-unpinned.net', '["/minds/peer-unpinned.net/"]', null, 1, 'user-owner')`,
  ).run();
  for (const by of ["a forger", "P-256"] as const)
    expect(
      await send(await peer.signs({ path: "/minds/peer-unpinned.net/x", form: "hostname", by })),
    ).toMatchObject({ status: 403 });
  expect(melds()).toMatchObject([{ mind: null, pinned_at: null }]);
  expect(
    await send(await peer.signs({ path: "/minds/peer-unpinned.net/x", form: "hostname" })),
  ).toMatchObject({ status: 200 });
  expect(melds()).toMatchObject([{ mind: peer.mind, pinned_at: expect.any(Number) }]);
});

test("the log state belongs to the id: a second hostname that serves an older head, which still lists a revoked key, gets nothing", async () => {
  const { send, rule, peer, env, serveAt } = await stack("peer-main.net", {
    peerHostnames: ["peer-main.net", "peer-second.net"],
  });
  await send(await rule([`/minds/${peer.mind}/`]));
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/x` }))).toMatchObject({
    status: 200,
  });
  // the mind revokes its key: the third record lists another one, at its main hostname
  const next = await stackKeyPair();
  const third = await peer.log.next(peer.second, { workingKeys: [next.entry] });
  await serveAt("peer-main.net", [peer.log.genesis, peer.second, third]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/x` }))).toMatchObject({
    status: 403,
    body: { refused: "peer-main.net lists no such working key" },
  });
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/x`, by: next }))).toMatchObject({
    status: 200,
  });
  // the second hostname serves the log as it stood before the revocation
  await serveAt("peer-second.net", [peer.log.genesis, peer.second]);
  const stale = await peer.signs({ path: `/minds/${peer.mind}/x`, fromHost: "peer-second.net" });
  expect(await send(stale)).toMatchObject({ status: 403 });
  expect(await mindSignerOf(env, stale)).toMatchObject({ refused: expect.any(String) });
  // and a signed request in the hostname form from there, which names no id: the log proves the
  // id, and the state kept for that id refuses the older head
  const staleByHostname = await peer.signs({
    path: "/x",
    form: "hostname",
    fromHost: "peer-second.net",
  });
  expect(await mindSignerOf(env, staleByHostname)).toMatchObject({
    refused: expect.stringContaining("peer-second.net gave no keys"),
  });
  vi.useRealTimers();
});

test("a row that ended keeps its mind's log state to itself: another mind at that hostname signs a request in the hostname form", async () => {
  const { send, rule, peer, env, serveAt } = await stack("peer-handed.net");
  await send(await rule([`/minds/${peer.mind}/`]));
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/x` }))).toMatchObject({
    status: 200,
  });
  expect(await send(await rule([], {}, 1_000))).toMatchObject({ status: 200 });
  // the hostname now serves another mind's log, which lists the same working key
  const other = await newIdentityLog(["peer-handed.net"]);
  const otherSecond = await other.next(other.genesis, {
    workingKeys: [{ ...peer.entry, purpose: "statements" }],
  });
  await serveAt("peer-handed.net", [other.genesis, otherSecond], other.mind);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
  expect(await mindSignerOf(env, await peer.signs({ path: "/x", form: "hostname" }))).toMatchObject(
    { mind: other.mind },
  );
  vi.useRealTimers();
});

test("only a member's passkey sets a rule: a service's key and a melded mind are refused", async () => {
  const { send, rule, cloud, peer } = await stack("peer-three.net");
  await send(await rule([`/minds/${peer.mind}/`]));
  const refusal = { status: 403, body: { refused: "only a member's passkey sets a mind meld" } };
  expect(
    await send(
      await cloud(`/minds/${peer.mind}`, "events.iterate.com/mind-meld/configured", {
        append: ["/"],
        name: "peer-three.net",
      }),
    ),
  ).toMatchObject(refusal);
  expect(
    await send(
      await peer.signs({
        path: `/minds/${peer.mind}/x`,
        type: "events.iterate.com/mind-meld/configured",
        payload: { append: ["/agents/"], name: "peer-three.net" },
      }),
    ),
  ).toMatchObject(refusal);
});

test.for([
  ["the mind's own id", `/minds/${"a".repeat(64)}`, { append: [], name: "peer.net" }],
  ["the mind's own hostname as its name", `/minds/${"b".repeat(64)}`, { append: [], name: MIND }],
  ["a hostname in the path", "/minds/peer.net", { append: [], name: "peer.net" }],
  ["no name", `/minds/${"b".repeat(64)}`, { append: [] }],
  ["a name not in lowercase", `/minds/${"b".repeat(64)}`, { append: [], name: "Peer.net" }],
  ["a path that is no meld's", "/agents/peer.net", { append: [], name: "peer.net" }],
  [
    "a path with ..",
    `/minds/${"b".repeat(64)}`,
    { append: ["/minds/../agents/"], name: "peer.net" },
  ],
  [
    "more than 20 paths",
    `/minds/${"b".repeat(64)}`,
    { append: Array(21).fill("/x/"), name: "peer.net" },
  ],
  [
    "a field the rule has not got",
    `/minds/${"b".repeat(64)}`,
    { append: [], name: "peer.net", until: 1 },
  ],
] as const)("a rule with %s is refused", async ([, path, payload]) => {
  const { send, owner, melds } = await stack("peer.net", { ownId: "a".repeat(64) });
  expect(await send(await owner(path, payload))).toMatchObject({ status: 403 });
  expect(melds()).toEqual([]);
});

test("nothing is read for a mind that is not let in, and a mind that is let in is read from its genesis once, then on from its head", async () => {
  const { send, rule, peer, fetched } = await stack("peer-twelve.net");
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/x` }))).toMatchObject({
    status: 403,
    body: { refused: `${peer.mind} is not let in here` },
  });
  expect(fetched).toEqual([]);
  await send(await rule([`/minds/${peer.mind}/`]));
  for (const path of [`/minds/${peer.mind}/x`, `/minds/${peer.mind}/y`])
    expect(await send(await peer.signs({ path }))).toMatchObject({ status: 200 });
  expect(fetched).toEqual([
    "https://peer-twelve.net/.well-known/iterate",
    `https://peer-twelve.net/.well-known/iterate?after=${peer.head}`,
  ]);
});

test("mindSignerOf answers the mind id that the log proves, the hostname and the listed key, and checks no rule; mindKeyOf asks the rule first", async () => {
  const { env, peer, fetched, ownId } = await stack("peer-seven.net");
  const listed = await peer.signs({ path: `/minds/${peer.mind}/x` });
  // no rule lets the mind in: mindKeyOf fetches nothing
  expect(await mindKeyOf(env, listed)).toEqual({ refused: `${peer.mind} is not let in here` });
  expect(fetched).toEqual([]);
  expect(await mindSignerOf(env, listed)).toEqual({
    mind: peer.mind,
    hostname: "peer-seven.net",
    key: {
      principal: { actor: peer.mind, kind: "mind", hostname: "peer-seven.net" },
      publicKey: peer.publicKey,
      label: "stack",
      format: "ML-DSA-65",
    },
  });
  expect(fetched).toEqual(["https://peer-seven.net/.well-known/iterate"]);
  // it checks no signature: a forger's statement under the listed id gets the same key back,
  // and the signature's check refuses it (the test above)
  expect(await mindSignerOf(env, await peer.signs({ path: "/x", by: "a forger" }))).toMatchObject({
    mind: peer.mind,
  });
  expect(await mindSignerOf(env, await peer.signs({ path: "/x", by: "an unlisted key" }))).toEqual({
    refused: "peer-seven.net lists no such working key",
  });
  // an id that the log at its fromHost does not prove
  expect(await mindSignerOf(env, await peer.signs({ path: "/x", from: "c".repeat(64) }))).toEqual({
    refused: "peer-seven.net serves the log of another mind than the statement's from",
  });
  // a fromHost that is no hostname
  expect(await mindSignerOf(env, await peer.signs({ path: "/x", fromHost: "Peer.net" }))).toEqual({
    refused: "a statement's from is a mind's id, with its hostname as fromHost",
  });
  // a statement that names no mind is no mind's
  const { privateKey, key } = await stackKeyPair();
  const own = await signedMlDsa65(
    statementText({ mind: ownId, path: "/x", type: "t", at: 0, expires: 1 }),
    privateKey,
    key,
  );
  expect(await mindSignerOf(env, own)).toBeNull();
  expect(await mindKeyOf(env, own)).toBeNull();
});

test.for([
  { name: "has no record", listed: "no record" },
  { name: "lists another working key", listed: "another key" },
] as const)(
  "while the mind's identity $name, the mind signs nothing as itself and takes no statement from another mind",
  async ({ listed }) => {
    const { env, send, rule, peer, fetched } = await stack(`peer-six-${listed.length}.net`, {
      listed,
    });
    const refusal = await signedByStack(env, { path: "/x", type: NOTE }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      message:
        "the mind's identity lists no working key of this stack yet, so the mind signs nothing as itself",
    });
    // No code: this ends when a record lists the key, so a subscription that sends to another
    // mind tries again with its back-off. A coded FORBIDDEN would halt its row for good.
    expect(errorCode(refusal)).toBeUndefined();
    await expect(
      signedDeliveryByStack(env, {
        mind: peer.mind,
        path: "/integrations/github/7",
        type: "events.iterate.com/github/webhook-received",
      }),
    ).rejects.toThrow("the mind's identity lists no working key of this stack yet");
    // a member's rule is a member's statement, and is taken
    expect(await send(await rule([`/minds/${peer.mind}/`]))).toMatchObject({ status: 200 });
    expect(await send(await peer.signs({ path: `/minds/${peer.mind}/x` }))).toEqual({
      status: 403,
      body: {
        refused:
          "this mind's identity lists no working key of its stack yet, so it takes no statement from another mind",
      },
      facts: [],
    });
    expect(fetched).toEqual([]);
    // the key is a candidate
    expect(await (await stackKeyResponse(env)).json()).toMatchObject({ listed: false });
  },
);

test("a rule that names a key takes that key alone", async () => {
  const { send, rule, peer } = await stack("peer-five.net");
  await send(await rule([`/minds/${peer.mind}/`], { key: "another" }));
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/x` }))).toMatchObject({
    status: 403,
    body: { refused: "the rule names another key" },
  });
  await send(await rule([`/minds/${peer.mind}/`], { key: peer.key }));
  expect(await send(await peer.signs({ path: `/minds/${peer.mind}/x` }))).toMatchObject({
    status: 200,
  });
});

test("the stack signs with ML-DSA-65 under the key that it publishes, with the mind's id beside its hostname, and a reader verifies it there", async () => {
  const { env, peer, ownId } = await stack("peer-fourteen.net");
  const published = (await (await stackKeyResponse(env)).json()) as Record<string, unknown>;
  expect(published).toEqual({
    mind: MIND,
    mindId: ownId,
    key: expect.any(String),
    publicKey: expect.any(String),
    algorithm: "ML-DSA-65",
    listed: true,
  });
  const signed = await signedByStack(env, { mind: peer.mind, path: "/x", type: NOTE });
  expect(signed.signature).toMatchObject({ format: "ML-DSA-65", key: published.key });
  const publicKey = published.publicKey as string;
  expect(await verifySignature(signed, publicKey, SITE)).toEqual({});
  const changed = { ...signed, statement: signed.statement.replace("note", "nope") };
  expect(await verifySignature(changed, publicKey, SITE)).toEqual({
    refused: "the signature is not this key's",
  });
  // another algorithm's key is no key for this signature
  expect(await verifySignature(signed, (await keyPair()).publicKey, SITE)).toEqual({
    refused: "malformed key or signature",
  });
});

test("signedByStack names this mind's hostname as `mind` alone, or the other mind's id as `mind` and this one's as `from`, with `fromHost`; an id reads no log, a hostname is read once a minute", async () => {
  const { env, peer, fetched, ownId } = await stack("peer-eight.net");
  const read = (envelope: Envelope) => statementOf(envelope.statement);
  const input = { path: "/x", type: NOTE };
  expect(await signedByStack(env, input).then(read)).not.toHaveProperty("from");
  expect(await signedByStack(env, input).then(read)).toMatchObject({ mind: MIND });
  // THE HOT PATH: a proxy secret's cell that holds the id signs with no read
  for (let n = 0; n < 3; n++)
    expect(await signedByStack(env, { ...input, mind: peer.mind }).then(read)).toMatchObject({
      mind: peer.mind,
      from: ownId,
      fromHost: MIND,
    });
  expect(fetched).toEqual([]);
  // a cell that still holds a hostname: one read, then the reader's minute
  for (let n = 0; n < 3; n++)
    expect(await signedByStack(env, { ...input, mind: "peer-eight.net" }).then(read)).toMatchObject(
      { mind: peer.mind, from: ownId },
    );
  expect(fetched).toEqual(["https://peer-eight.net/.well-known/iterate"]);
  for (const self of [MIND, ownId])
    await expect(signedByStack(env, { ...input, mind: self })).rejects.toThrow(/another mind/);
  // a hostname with no log signs nothing, with no code, so a row tries again
  const unread = await signedByStack(env, { ...input, mind: "nobody.net" }).catch(
    (error: unknown) => error,
  );
  expect(unread).toMatchObject({ message: expect.stringContaining("nobody.net gave no identity") });
  expect(errorCode(unread)).toBeUndefined();
});

test("a delivery is signed as this mind on /minds/<this mind's id>/integrations/<provider>/<account>, and on no other path", async () => {
  const { env, peer, ownId } = await stack("peer-nine.net");
  const type = "events.iterate.com/github/webhook-received";
  const signed = await signedDeliveryByStack(env, {
    mind: peer.mind,
    path: "/integrations/github/7",
    type,
    about: ["cloud:github:d-1"],
  });
  expect(statementOf(signed.statement)).toMatchObject({
    mind: peer.mind,
    from: ownId,
    fromHost: MIND,
    path: `/minds/${ownId}/integrations/github/7`,
    type,
    about: ["cloud:github:d-1"],
  });
  for (const path of [
    "/agents/onboarding",
    "/integrations/github",
    "/integrations/github/7/more",
    "/integrations/../..",
    "/integrations/./x",
    "/integrations/../x",
    "/integrations/github/..",
    `/minds/${ownId}/integrations/github/7`,
    "/",
  ])
    await expect(signedDeliveryByStack(env, { mind: peer.mind, path, type })).rejects.toThrow(
      /a delivery's path/,
    );
  await expect(
    signedDeliveryByStack(env, { mind: "", path: "/integrations/github/7", type }),
  ).rejects.toThrow(/names the mind/);
});

test("migration 0021 adds columns alone: a Worker that knows no ids selects and upserts by domain on the migrated table", () => {
  const db = new DatabaseSync(":memory:");
  const folder = new URL("../migrations/", import.meta.url).pathname;
  for (const name of readdirSync(folder).sort()) db.exec(readFileSync(`${folder}${name}`, "utf8"));
  db.prepare("insert into users (id, email) values ('user-owner', 'owner@example.net')").run();
  // the upsert (configuredMeld) and the select (mindKeyOf) of a Worker that predates 0021
  const upsert = db.prepare(
    `insert into mind_melds (domain, append, key, configured_at, configured_by)
     values (?1, ?2, ?3, ?4, ?5)
     on conflict (domain) do update set append = excluded.append, key = excluded.key,
       configured_at = excluded.configured_at, configured_by = excluded.configured_by
     where excluded.configured_at >= mind_melds.configured_at`,
  );
  upsert.run("peer.net", '["/minds/peer.net/"]', null, 1, "user-owner");
  // a pinned row, then changed by that Worker
  db.prepare("update mind_melds set mind = ?1, pinned_at = 2 where domain = 'peer.net'").run(
    "b".repeat(64),
  );
  upsert.run("peer.net", '["/minds/peer.net/x/"]', null, 3, "user-owner");
  expect(
    db
      .prepare(`select append, key from mind_melds where domain = ?1 and append != '[]'`)
      .get("peer.net"),
  ).toEqual({ append: '["/minds/peer.net/x/"]', key: null });
  // one id has one row
  expect(() =>
    db
      .prepare(
        `insert into mind_melds (domain, mind, append, configured_at, configured_by)
         values ('other.net', ?1, '[]', 4, 'user-owner')`,
      )
      .run("b".repeat(64)),
  ).toThrow(/UNIQUE/);
});

async function keyPair() {
  const pair = (await crypto.subtle.generateKey(P256, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = base64url(
    new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer),
  );
  return { key: await keyIdOf(publicKey), publicKey, privateKey: pair.privateKey };
}

/** A mind at `MIND` on SQLite whose owner is a member by the config, with the Cloud's key under
 *  `/integrations/`, and the mind at `peerDomain`, whose identity log, truly signed, lists one
 *  ML-DSA-65 working key for `peerPurpose`, behind a fake `fetch` (`serve` puts another log
 *  there). `listed`: what this mind's own identity lists as its working key; its records go
 *  through the intake. `ownId`: this mind's id in the config, for a case that reads no log of its
 *  own. */
async function stack(
  peerDomain: string,
  {
    listed = "the stack's key",
    peerPurpose = "statements",
    ownId,
    peerHostnames = [peerDomain],
  }: {
    listed?: "the stack's key" | "another key" | "no record";
    peerPurpose?: string;
    ownId?: string;
    peerHostnames?: string[];
  } = {},
) {
  const [otherStackKey, peerWorking, peerUnlisted] = await Promise.all(
    Array.from({ length: 3 }, () => stackKeyPair()),
  );
  const [ownerKey, cloudKey, peerP256] = await Promise.all(Array.from({ length: 3 }, keyPair));
  const ownLog = await newIdentityLog([MIND]);
  const { env, db } = sqliteStack({ mindId: ownId || ownLog.mind });
  db.prepare("insert into users (id, email) values ('user-owner', 'owner@example.net')").run();
  const addKey = db.prepare(
    `insert into keys (id, user_id, actor, paths, public_key, format, label, added_via, added_by, added_at)
     values (?1, ?2, ?3, ?4, ?5, 'p256', ?6, 'test', 'user-owner', 0)`,
  );
  addKey.run(ownerKey.key, "user-owner", null, null, ownerKey.publicKey, "a passkey");
  addKey.run(
    cloudKey.key,
    null,
    "iterate-cloud",
    '["/integrations/"]',
    cloudKey.publicKey,
    "Cloud",
  );
  // THIS MIND'S OWN LOG, through the intake: the genesis, then the record that lists its key
  const intake = (signed: unknown) =>
    identityIntakeResponse(
      env,
      new Request(`https://${MIND}/.well-known/iterate`, {
        method: "POST",
        body: JSON.stringify(signed),
      }),
    );
  if (listed !== "no record" && !ownId) {
    const { publicKey } = (await (await stackKeyResponse(env)).json()) as { publicKey: string };
    await intake(ownLog.genesis);
    const ownKey =
      listed === "another key" ? otherStackKey.entry : { ...peerWorking.entry, publicKey };
    await intake(await ownLog.next(ownLog.genesis, { workingKeys: [ownKey] }));
  }
  const peerLog = await newIdentityLog(peerHostnames);
  const peerSecond = await peerLog.next(peerLog.genesis, {
    workingKeys: [{ ...peerWorking.entry, purpose: peerPurpose }],
  });
  type Served = { version: number; mind: string; head: string; records: SignedRecord[] };
  const servedAt = new Map<string, Served>();
  const logOf = async (mind: string, records: SignedRecord[]): Promise<Served> => ({
    version: 1,
    mind,
    head: await identityHashOf(records.at(-1)!.record),
    records,
  });
  servedAt.set(peerDomain, await logOf(peerLog.mind, [peerLog.genesis, peerSecond]));
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    const url = new URL(request.url);
    const served = servedAt.get(url.hostname);
    if (!served) return new Response(null, { status: 404 });
    fetched.push(request.url);
    // `?after=<hash>`: the records after that one, as a mind's log answers
    const after = url.searchParams.get("after");
    if (!after) return Response.json(served);
    const hashes = await Promise.all(served.records.map(({ record }) => identityHashOf(record)));
    const at = hashes.indexOf(after);
    return at < 0
      ? new Response(null, { status: 404 })
      : Response.json({ ...served, records: served.records.slice(at + 1) });
  });
  /** `at`: how far from now it is dated; `lives`: how long after that it expires. */
  const statementFor = ({
    lives = 60_000,
    ...fields
  }: Partial<Parameters<typeof statementText>[0]> & {
    path: string;
    type: string;
    lives?: number;
  }) => {
    const at = Date.now() + (fields.at ?? 0);
    return statementText({ mind: MIND, ...fields, at, expires: at + lives });
  };
  const send = async (envelope: Envelope) => {
    const answer = await statementsResponse(
      env,
      new Request(`https://${MIND}/statements`, {
        method: "POST",
        body: JSON.stringify(envelope),
      }),
    );
    return {
      status: answer.status,
      body: await answer.json(),
      facts: decodeFacts(answer.headers.get(FACTS_HEADER) || ""),
    };
  };
  /** The owner's rule: `at` is how far from now it was signed, `lives` how long it lives then. */
  const owner = (path: string, payload: Record<string, unknown>, at = 0, lives?: number) =>
    signedP256(
      statementFor({ path, type: "events.iterate.com/mind-meld/configured", payload, at, lives }),
      ownerKey.privateKey,
      ownerKey.key,
    );
  return {
    env,
    db,
    ownId: ownId || ownLog.mind,
    melds: () => db.prepare("select * from mind_melds order by domain").all(),
    fetched,
    send,
    owner,
    /** The owner's rule for the peer, by its id, with the name the owner saw. */
    rule: (append: string[], more: Record<string, unknown> = {}, at = 0, lives?: number) =>
      owner(`/minds/${peerLog.mind}`, { append, name: peerDomain, ...more }, at, lives),
    cloud: (path: string, type: string, payload: Record<string, unknown>) =>
      signedP256(statementFor({ path, type, payload }), cloudKey.privateKey, cloudKey.key),
    /** Another log at the peer's hostname from now on. */
    serve: async (
      log: Awaited<ReturnType<typeof newIdentityLog>>,
      head: Awaited<ReturnType<typeof peerLog.next>>,
    ) => servedAt.set(peerDomain, await logOf(log.mind, [log.genesis, head])),
    /** The peer's own log, these records of it, at `hostname` from now on. */
    serveAt: async (hostname: string, records: SignedRecord[], mind = peerLog.mind) =>
      servedAt.set(hostname, await logOf(mind, records)),
    peer: {
      log: peerLog,
      second: peerSecond,
      mind: peerLog.mind,
      head: await identityHashOf(peerSecond.record),
      key: peerWorking.key,
      publicKey: peerWorking.publicKey,
      entry: peerWorking.entry,
      /** A statement from the peer, as `itx.minds` sends one, signed with the working key that
       *  its log lists: by id, or by hostname (the hostname form).
       *  `by`: signed with a key that the log does not list, under its own id; or under the
       *  listed key's id with a P-256 key, or with another ML-DSA-65 key. */
      signs: (fields: {
        path: string;
        type?: string;
        payload?: Record<string, unknown>;
        by?: "an unlisted key" | "P-256" | "a forger" | Awaited<ReturnType<typeof stackKeyPair>>;
        form?: "id" | "hostname";
        from?: string;
        fromHost?: string;
      }) => {
        const sender =
          fields.form === "hostname"
            ? { mind: MIND, from: fields.fromHost || peerDomain }
            : {
                mind: ownId || ownLog.mind,
                from: fields.from || peerLog.mind,
                fromHost: fields.fromHost || peerDomain,
              };
        const statement = statementFor({
          ...sender,
          path: fields.path,
          type: fields.type || NOTE,
          payload: fields.payload || { text: "hello" },
          about: ["/notes@4"],
        });
        if (typeof fields.by === "object")
          return signedMlDsa65(statement, fields.by.privateKey, fields.by.key);
        if (fields.by === "an unlisted key")
          return signedMlDsa65(statement, peerUnlisted.privateKey, peerUnlisted.key);
        if (fields.by === "P-256")
          return signedP256(statement, peerP256.privateKey, peerWorking.key);
        if (fields.by === "a forger")
          return signedMlDsa65(statement, peerUnlisted.privateKey, peerWorking.key);
        return signedMlDsa65(statement, peerWorking.privateKey, peerWorking.key);
      },
    },
  };
}
