// The intake of a signed identity record, the delivery of each accepted record to the mind's own
// log, and the log that the mind publishes, on the Worker's own tables in SQLite. Every record
// here is truly signed, so the check is the real one. The boundary's delivery is the boundary's
// own code, and `/` is a log with the stream's rule for keys and the contract's own fold.
import { identityHashOf } from "iterate/mind-identity";
import {
  identitiesAfterAccepted,
  identitiesAfterRefused,
  identityOfMind,
  IdentityRecordAccepted,
  IdentityRecordRefused,
  publishedMindOf,
} from "iterate/mind-identity-log";
import type { StreamEventInput } from "iterate/stream/processor";
import { memoryStream } from "iterate/stream/test-support";
import { expect, test, vi } from "vitest";
import { identityIntakeAnswer } from "../../boundary-worker/src/identity-delivery.ts";
import { newIdentityLog, newRootKey } from "../../lib/src/test-support/identity-log.ts";
import type { Env } from "./env.ts";
import { authResponse } from "./http.ts";
import {
  identityFactsDelivered,
  identityFactsToDeliver,
  identityIntakeResponse,
  identityLogResponse,
  identityOf,
} from "./identity.ts";
import { sqliteStack } from "./test-support.ts";

const MIND_HOSTNAME = "iterate.example.com";
const LOG_URL = `https://${MIND_HOSTNAME}/.well-known/iterate`;

test("a genesis and the record after it are accepted, and with a mind that can be reached each is in the mind's own log when its 200 goes out", async () => {
  const stack = await mindWithStack();
  const { log, env, root } = stack;
  expect(await identityOf(env)).toEqual({
    expected: log.mind,
    head: null,
    position: 0,
    current: null,
  });
  expect(await sent(stack, log.genesis)).toEqual({
    status: 200,
    body: { answer: "accepted", mind: log.mind, hash: log.mind, position: 1 },
  });
  // `toEqual`: exactly one event, with exactly this key and payload
  expect(
    root.events.map(({ type, idempotencyKey, payload }) => ({ type, idempotencyKey, payload })),
  ).toEqual([
    {
      type: "events.iterate.com/mind/identity-record-accepted",
      idempotencyKey: `mind/identity-record:${log.mind}`,
      payload: {
        mind: log.mind,
        hash: log.mind,
        record: log.genesis.record,
        signatures: log.genesis.signatures,
        signedBy: [{ key: log.root.id, label: "laptop", algorithm: "ML-DSA-65", signs: "raw" }],
      },
    },
  ]);
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const hash = await identityHashOf(second.record);
  expect(await sent(stack, second)).toEqual({
    status: 200,
    body: { answer: "accepted", mind: log.mind, hash, position: 2 },
  });
  expect(await identityOf(env)).toEqual({
    expected: log.mind,
    head: hash,
    position: 2,
    current: JSON.parse(second.record),
  });
  expect(foldedBy(stack)).toMatchObject({ head: hash, position: 2 });
  expect(await identityFactsToDeliver(env)).toEqual([]);
  expect(rowsIn(stack, "identity_records where delivered_at is not null")).toBe(2);
});

test("a record that was accepted before is known from its row, whatever signatures come with it, and a known record that the log holds is appended nowhere", async () => {
  const stack = await mindWithStack();
  const { log, root } = stack;
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const third = await log.next(second, { alsoKnownAs: [] });
  for (const signed of [log.genesis, second, third]) await sent(stack, signed);
  const appends = vi.spyOn(root.stream, "append");
  // the genesis and a middle record again, each with a signature that is no signature of it
  const forged = [{ key: "A".repeat(43), sig: "AAAA" }];
  expect(await sent(stack, { record: log.genesis.record, signatures: forged })).toEqual({
    status: 200,
    body: { answer: "known", mind: log.mind, hash: log.mind, position: 1 },
  });
  expect(await sent(stack, { record: second.record, signatures: forged })).toEqual({
    status: 200,
    body: {
      answer: "known",
      mind: log.mind,
      hash: await identityHashOf(second.record),
      position: 2,
    },
  });
  // A stranger who sends a public record again makes no append on the root, and no refusal: the
  // check would say that a current root key signed it.
  expect(appends).not.toHaveBeenCalled();
  expect(root.events).toHaveLength(3);
  expect(rowsIn(stack, "identity_refusals")).toBe(0);
  expect(rowsIn(stack, "identity_records")).toBe(3);
});

test("the rows never wait for the mind's log: a record whose append on `/` failed is accepted with a 200, the next one too, and a later request delivers both in order", async () => {
  const stack = await mindWithStack();
  const { log, env, root } = stack;
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const accepted = (position: number) => ({ status: 200, body: { answer: "accepted", position } });
  // A, the genesis: its row is written, its append on `/` fails, and its answer is the rows'
  expect(await sent(stack, log.genesis, { append: "fails" })).toMatchObject(accepted(1));
  // B, the next record: accepted at once against the stored head, while A is not in the log
  expect(await sent(stack, second, { append: "fails" })).toMatchObject(accepted(2));
  expect(root).toMatchObject({ events: [] });
  expect(await identityOf(env)).toMatchObject({ position: 2 });
  // both are owed, in the order of the log
  expect((await identityFactsToDeliver(env)).map(({ id, mind }) => ({ id, mind }))).toEqual([
    { id: `accepted:${log.mind}`, mind: log.mind },
    { id: `accepted:${await identityHashOf(second.record)}`, mind: log.mind },
  ]);
  // A later request of anyone, here a stranger who sends the public genesis again, delivers A
  // and then B.
  expect(await sent(stack, log.genesis)).toMatchObject({ status: 200, body: { answer: "known" } });
  expect(root.events.map((event) => Object(event.payload).hash)).toEqual([
    log.mind,
    await identityHashOf(second.record),
  ]);
  expect(foldedBy(stack)).toMatchObject({
    head: await identityHashOf(second.record),
    position: 2,
  });
  expect(await identityFactsToDeliver(env)).toEqual([]);
});

test("a delivery that fails at a record appends no later record of that mind id, so the mind's log never gets a record before the one it follows", async () => {
  const stack = await mindWithStack();
  const { log, envOf, root } = stack;
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const third = await log.next(second, { alsoKnownAs: [] });
  const unreachable = { append: "fails" } as const;
  for (const signed of [log.genesis, second, third]) await sent(stack, signed, unreachable);
  // another mind id's genesis, and a record of the first id that is refused with an event
  const other = await newIdentityLog([MIND_HOSTNAME]);
  const fork = await log.next(log.genesis, { alsoKnownAs: ["did:example:grace"] });
  expect(await sent(stack, fork, unreachable)).toMatchObject({ status: 409 });
  const after = { ...stack, env: envOf({ mindId: other.mind }) };
  expect(await sent(after, other.genesis, unreachable)).toMatchObject({ status: 200 });
  expect(root).toMatchObject({ events: [] });
  // The mind is back, and the append of the first id's SECOND record fails. The genesis before
  // it is appended, the third record after it is not, and the other id's genesis and the
  // refusal are: neither has a place in that log's order.
  const secondHash = await identityHashOf(second.record);
  expect(
    await sent(after, log.genesis, {
      append: (event) => Object(event.payload).hash === secondHash,
    }),
  ).toMatchObject({ status: 200, body: { answer: "known" } });
  const delivered = root.events.map(
    (event) => `${event.type.split("/").at(-1)} ${Object(event.payload).hash}`,
  );
  expect(delivered.toSorted()).toEqual(
    [
      `identity-record-accepted ${log.mind}`,
      `identity-record-accepted ${other.mind}`,
      `identity-record-refused ${await identityHashOf(fork.record)}`,
    ].toSorted(),
  );
  expect(foldedBy(stack)).toMatchObject({ head: log.mind, position: 1 });
  expect((await identityFactsToDeliver(after.env)).map(({ id }) => id)).toEqual([
    `accepted:${secondHash}`,
    `accepted:${await identityHashOf(third.record)}`,
  ]);
  // the next request delivers the two in order
  expect(await sent(after, log.genesis)).toMatchObject({ status: 200 });
  expect(foldedBy(stack)).toMatchObject({ head: await identityHashOf(third.record), position: 3 });
  expect(foldedBy({ log: other, root })).toMatchObject({ head: other.mind, position: 1 });
});

test("a Worker that ends between the row and the append leaves a record that the next request delivers", async () => {
  const stack = await mindWithStack();
  const { log, env, root } = stack;
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  // the row is written, and nothing after the intake's own answer runs
  const answer = await identityIntakeResponse(env, requestOf(log.genesis));
  expect(await answer.json()).toMatchObject({ answer: "accepted", position: 1 });
  expect(root).toMatchObject({ events: [] });
  // nobody sends the genesis again: the next record's request delivers what is owed, in order
  expect(await sent(stack, second)).toMatchObject({ status: 200, body: { answer: "accepted" } });
  expect(foldedBy(stack)).toMatchObject({
    head: await identityHashOf(second.record),
    position: 2,
  });
});

test("an append that is stored but not said to be stored is the same event at the next delivery: the log holds it once", async () => {
  const stack = await mindWithStack();
  const { log, env, root } = stack;
  expect(await sent(stack, log.genesis, { mark: "fails" })).toMatchObject({ status: 200 });
  expect(root.events).toHaveLength(1);
  expect(await identityFactsToDeliver(env)).toHaveLength(1);
  expect(await sent(stack, log.genesis)).toMatchObject({ status: 200, body: { answer: "known" } });
  expect(root.events).toHaveLength(1);
  expect(await identityFactsToDeliver(env)).toEqual([]);
  // a mark that names no fact marks nothing
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  await identityIntakeResponse(env, requestOf(second));
  const hash = await identityHashOf(second.record);
  await identityFactsDelivered(env, ["", "accepted:nothing", `accepted:${hash}:2`, `x:${hash}`]);
  expect((await identityFactsToDeliver(env)).map(({ id }) => id)).toEqual([`accepted:${hash}`]);
});

test("a record that a current root key signed and that does not continue the log is refused with one event, which is delivered as it first came until it is stored", async () => {
  const stack = await mindWithStack();
  const { log, root } = stack;
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  await sent(stack, log.genesis);
  await sent(stack, second);
  // a second record after the genesis, which the root key signed too
  const fork = await log.next(log.genesis, { alsoKnownAs: ["did:example:grace"] });
  const hash = await identityHashOf(fork.record);
  const refusal = {
    status: 409,
    body: {
      answer: "refused",
      reason: "not-next",
      message: "The record's `prev` is not the hash of the last accepted record.",
    },
  };
  // the refusal's own append fails: the answer is the refusal, and the event is still owed
  expect(await sent(stack, fork, { append: "fails" })).toEqual(refusal);
  expect(root.events).toHaveLength(2);
  // The same record again, with another signature beside the true one: the event that is
  // delivered now is the one of the request that was refused.
  const other = { key: "A".repeat(43), sig: "AAAA" };
  expect(await sent(stack, { ...fork, signatures: [...fork.signatures, other] })).toEqual(refusal);
  expect(
    root.events
      .slice(2)
      .map(({ type, idempotencyKey, payload }) => ({ type, idempotencyKey, payload })),
  ).toEqual([
    {
      type: "events.iterate.com/mind/identity-record-refused",
      idempotencyKey: `mind/identity-record-refused:${hash}`,
      payload: {
        hash,
        mind: log.mind,
        reason: "not-next",
        message: refusal.body.message,
        record: fork.record,
        signatures: fork.signatures,
      },
    },
  ]);
  expect(foldedBy(stack)).toMatchObject({ position: 2, refused: { reason: "not-next" } });
  // sent again as it was: the same answer, and no second event
  expect(await sent(stack, fork)).toEqual(refusal);
  expect(root.events).toHaveLength(3);
  expect(rowsIn(stack, "identity_refusals")).toBe(1);
  expect(rowsIn(stack, "identity_records")).toBe(2);
});

test("a refusal is written only against the head that the check read: a root key that a record removed meanwhile refuses nothing", async () => {
  const stack = await mindWithStack();
  const { log, env } = stack;
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  await sent(stack, log.genesis);
  await sent(stack, second);
  const fork = await log.next(log.genesis, { alsoKnownAs: ["did:example:grace"] });
  // between the check of the fork and its refusal, a record replaces the root key
  const newRoot = await newRootKey("new laptop");
  const rotation = await log.next(second, { rootKeys: [newRoot.entry] }, [log.root, newRoot]);
  const racing = withStep(env, "insert into identity_refusals", async () => {
    expect(await sent(stack, rotation)).toMatchObject({ body: { answer: "accepted" } });
  });
  // refused, as a record that is not the next: and the key that signed it is no root key now
  expect(await sent({ ...stack, env: racing }, fork)).toMatchObject({
    status: 409,
    body: { answer: "refused", reason: "not-next" },
  });
  expect(rowsIn(stack, "identity_refusals")).toBe(0);
});

test("a record that is accepted between another request's lookup and its check is known to that request, never refused", async () => {
  const stack = await mindWithStack();
  const { log, env, root } = stack;
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const third = await log.next(second, { alsoKnownAs: [] });
  await sent(stack, log.genesis);
  // this request looks the second record up and finds no row; then two others accept it and
  // the record after it
  const overtaken = withStep(env, "select mind, position from identity_records", async () => {
    await sent(stack, second);
    await sent(stack, third);
  });
  expect(await sent({ ...stack, env: overtaken }, second)).toMatchObject({
    status: 200,
    body: { answer: "known", position: 2 },
  });
  expect(rowsIn(stack, "identity_refusals")).toBe(0);
  expect(root.events.map(({ type }) => type)).toEqual(
    Array(3).fill("events.iterate.com/mind/identity-record-accepted"),
  );
});

test("a record that no current root key signed is an HTTP error and no event: a stranger writes nothing into the mind", async () => {
  const stack = await mindWithStack();
  const { log, root } = stack;
  const stranger = await newIdentityLog([MIND_HOSTNAME]);
  // before the genesis: another mind's genesis
  expect(await sent(stack, stranger.genesis)).toMatchObject({
    status: 400,
    body: { answer: "refused", reason: "wrong-genesis" },
  });
  await sent(stack, log.genesis);
  const refusedAll = [
    // the next record, signed by a key that is no root key of the mind
    [await log.next(log.genesis, {}, [await newRootKey("stranger")]), "unknown-signer"],
    // the mind's own root key's signature of another record
    [
      {
        record: (await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] })).record,
        signatures: log.genesis.signatures,
      },
      "bad-signature",
    ],
    ["{", "not-a-signed-record"],
    [{ record: log.genesis.record }, "not-a-signed-record"],
    [{ record: "x".repeat(300 * 1024), signatures: log.genesis.signatures }, "not-a-signed-record"],
    // The body is bounded before it is parsed: the genesis that was accepted, which would be
    // known, with spaces after it up to more than the intake reads.
    [JSON.stringify(log.genesis) + " ".repeat(256 * 1024), "not-a-signed-record"],
  ] as const;
  for (const [body, reason] of refusedAll)
    expect(await sent(stack, body), reason).toMatchObject({
      status: 400,
      body: { answer: "refused", reason },
    });
  expect(root.events).toHaveLength(1);
  expect(rowsIn(stack, "identity_refusals")).toBe(0);
  expect(rowsIn(stack, "identity_records")).toBe(1);
});

test("a text over the record's bound in bytes, an upload that is cut off and an upload that stalls are each a 400, before any hash and any row is read", async () => {
  const stack = await mindWithStack();
  const { log, env } = stack;
  const prepared = vi.spyOn(env.DB, "prepare");
  const digested = vi.spyOn(crypto.subtle, "digest");
  const refusal = { status: 400, body: { answer: "refused", reason: "not-a-signed-record" } };
  // 30 000 characters of three bytes each: within the schema's bound in characters, and
  // 90 000 bytes
  expect(
    await sent(stack, { record: "€".repeat(30_000), signatures: log.genesis.signatures }),
  ).toMatchObject(refusal);
  const cutOff = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"record":"'));
      controller.error(new Error("the connection was reset"));
    },
  });
  expect(await sent(stack, cutOff)).toMatchObject(refusal);
  vi.useFakeTimers();
  try {
    const stalled = sent(
      stack,
      new ReadableStream({
        start: (controller) => controller.enqueue(new TextEncoder().encode('{"record":"')),
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await stalled).toMatchObject(refusal);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
  // the three refusals read no row; what the boundary asks afterwards is not the intake's
  expect(prepared.mock.calls.filter(([sql]) => !sql.includes("delivered_at is null"))).toEqual([]);
  expect(digested).not.toHaveBeenCalled();
});

test("of two records that pass the check against the same head, one is written, and the other is refused as not the next", async () => {
  const stack = await mindWithStack();
  const { log, env } = stack;
  await sent(stack, log.genesis);
  const [ada, grace] = await Promise.all(
    ["did:example:ada", "did:example:grace"].map((name) =>
      log.next(log.genesis, { alsoKnownAs: [name] }),
    ),
  );
  const racing = { ...stack, env: writesTogether(env) };
  const answers = await Promise.all([sent(racing, ada), sent(racing, grace)]);
  expect(answers.map(({ status }) => status).toSorted()).toEqual([200, 409]);
  expect(rowsIn(stack, "identity_records")).toBe(2);
  // the loser is a record that the current root key signed: it is refused with its one event
  expect(answers.find(({ status }) => status === 409)).toMatchObject({
    body: { answer: "refused", reason: "not-next" },
  });
  expect(foldedBy(stack)).toMatchObject({ position: 2, refused: { reason: "not-next" } });
  expect(await identityOf(env)).toMatchObject({ position: 2 });
});

test("one record sent twice at the same moment is written once, and the log holds it once", async () => {
  const stack = await mindWithStack();
  const { log, env, root } = stack;
  const racing = { ...stack, env: writesTogether(env) };
  const answers = await Promise.all([sent(racing, log.genesis), sent(racing, log.genesis)]);
  expect(answers.map(({ body }) => Object(body).answer).toSorted()).toEqual(["accepted", "known"]);
  expect(rowsIn(stack, "identity_records")).toBe(1);
  expect(rowsIn(stack, "identity_refusals")).toBe(0);
  expect(root.events).toHaveLength(1);
});

test("the table itself refuses a second record at a place, a second record after a record, and a genesis that is not the first", async () => {
  const stack = await mindWithStack();
  const insert = (row: { hash: string; mind: string; prev: string | null; position: number }) =>
    stack.db
      .prepare(
        `insert into identity_records
           (hash, mind, prev, position, record, signatures, signed_by, page_bytes, accepted_at)
         values (?, ?, ?, ?, '{}', '[]', '[]', 1, 0)`,
      )
      .run(row.hash, row.mind, row.prev, row.position);
  insert({ hash: "m", mind: "m", prev: null, position: 1 });
  insert({ hash: "b", mind: "m", prev: "m", position: 2 });
  for (const row of [
    // a second genesis of the mind, which `unique (mind, prev)` alone lets through: null is
    // never equal to null
    { hash: "m2", mind: "m", prev: null, position: 1 },
    { hash: "c", mind: "m", prev: "x", position: 2 },
    { hash: "c", mind: "m", prev: "m", position: 3 },
    // a genesis whose hash is not the mind id, at a later position, or with a record before it
    { hash: "g", mind: "n", prev: null, position: 1 },
    { hash: "n", mind: "n", prev: null, position: 2 },
    { hash: "n", mind: "n", prev: "m", position: 1 },
    { hash: "z", mind: "m", prev: "b", position: 0 },
  ])
    expect(() => insert(row), JSON.stringify(row)).toThrow(/constraint failed/);
  expect(rowsIn(stack, "identity_records")).toBe(2);
});

test("a mind that gets another id starts a new log, and a record of the id before stays known", async () => {
  const stack = await mindWithStack();
  const { log, envOf } = stack;
  await sent(stack, log.genesis);
  const reborn = await newIdentityLog([MIND_HOSTNAME]);
  const after = { ...stack, env: envOf({ mindId: reborn.mind }) };
  expect(await identityOf(after.env)).toMatchObject({ expected: reborn.mind, head: null });
  expect(await sent(after, reborn.genesis)).toMatchObject({
    status: 200,
    body: { answer: "accepted", mind: reborn.mind, position: 1 },
  });
  // the old genesis again: known from its row, under the id it was accepted for
  expect(await sent(after, log.genesis)).toMatchObject({
    status: 200,
    body: { answer: "known", mind: log.mind, position: 1 },
  });
  expect(await identityOf(after.env)).toMatchObject({ expected: reborn.mind, head: reborn.mind });
});

test("a record of a mind id that the config no longer names is delivered like any other, and what is owed for one mind id holds no answer of another back", async () => {
  const stack = await mindWithStack();
  const { log, envOf, root } = stack;
  const unreachable = { append: "fails" } as const;
  // the first id's genesis, and a record of it that is refused with an event: both stay owed
  expect(await sent(stack, log.genesis, unreachable)).toMatchObject({ status: 200 });
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  expect(await sent(stack, second, unreachable)).toMatchObject({ status: 200 });
  const fork = await log.next(log.genesis, { alsoKnownAs: ["did:example:grace"] });
  expect(await sent(stack, fork, unreachable)).toMatchObject({ status: 409 });
  // the mind gets another id: its genesis and its next record are a 200 each, at once
  const other = await newIdentityLog([MIND_HOSTNAME]);
  const after = { ...stack, env: envOf({ mindId: other.mind }) };
  expect(await sent(after, other.genesis, unreachable)).toEqual({
    status: 200,
    body: { answer: "accepted", mind: other.mind, hash: other.mind, position: 1 },
  });
  const next = await other.next(other.genesis, { alsoKnownAs: ["did:example:ada"] });
  expect(await sent(after, next, unreachable)).toMatchObject({
    status: 200,
    body: { position: 2 },
  });
  expect(root).toMatchObject({ events: [] });
  // with the mind back, one request delivers every mind id's records, and the refusal
  expect(await sent(after, log.genesis)).toEqual({
    status: 200,
    body: { answer: "known", mind: log.mind, hash: log.mind, position: 1 },
  });
  expect(foldedBy(stack)).toMatchObject({ position: 2, refused: { reason: "not-next" } });
  expect(foldedBy({ log: other, root })).toMatchObject({ position: 2 });
  expect(await identityFactsToDeliver(after.env)).toEqual([]);
});

test("the log is published oldest first, from the record after `after`, before the genesis with no record, and never for a cache to keep", async () => {
  const stack = await mindWithStack();
  const { log, env } = stack;
  expect(await logAt(env, MIND_HOSTNAME)).toEqual({
    status: 200,
    cache: "no-store",
    body: { version: 1, mind: log.mind, head: null, records: [] },
  });
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  const third = await log.next(second, { alsoKnownAs: [] });
  for (const signed of [log.genesis, second, third]) await sent(stack, signed);
  const head = await identityHashOf(third.record);
  expect(await logAt(env, MIND_HOSTNAME)).toEqual({
    status: 200,
    cache: "no-store",
    body: { version: 1, mind: log.mind, head, records: [log.genesis, second, third] },
  });
  expect(await logAt(env, MIND_HOSTNAME, log.mind)).toMatchObject({
    body: { head, records: [second, third] },
  });
  expect(await logAt(env, MIND_HOSTNAME, head)).toMatchObject({ body: { head, records: [] } });
  // a well-formed hash that is no record of the log, and what is no hash at all
  expect(await logAt(env, MIND_HOSTNAME, "f".repeat(64))).toMatchObject({ status: 404 });
  for (const after of ["", "x", "F".repeat(64), `${log.mind}'`])
    expect(await logAt(env, MIND_HOSTNAME, after), after).toMatchObject({
      status: 400,
      cache: "no-store",
    });
});

test("a published page is one view: a record that is accepted while the page is read is not in a page whose head does not name it", async () => {
  const stack = await mindWithStack();
  const { log, env } = stack;
  const second = await log.next(log.genesis, { alsoKnownAs: ["did:example:ada"] });
  await sent(stack, log.genesis);
  const during = withStep(
    env,
    "sum(page_bytes)",
    () => sent(stack, second).then(() => {}),
    "before",
  );
  expect(await logAt(during, MIND_HOSTNAME)).toMatchObject({
    body: { head: log.mind, records: [log.genesis] },
  });
  expect(await logAt(env, MIND_HOSTNAME)).toMatchObject({
    body: { records: [log.genesis, second] },
  });
});

test("a hostname of the mind's zones answers the log only while the log's last record lists it", async () => {
  const stack = await mindWithStack();
  const { log, env } = stack;
  expect(await logAt(env, "www.example.com")).toMatchObject({ status: 404, cache: "no-store" });
  await sent(stack, log.genesis);
  expect(await logAt(env, "www.example.com")).toMatchObject({ status: 404 });
  const listed = await log.next(log.genesis, { hostnames: [MIND_HOSTNAME, "www.example.com"] });
  await sent(stack, listed);
  expect(await logAt(env, "www.example.com")).toMatchObject({
    status: 200,
    cache: "no-store",
    body: { mind: log.mind, records: [log.genesis, listed] },
  });
  const unlisted = await log.next(listed, { hostnames: [MIND_HOSTNAME] });
  await sent(stack, unlisted);
  expect(await logAt(env, "www.example.com")).toMatchObject({ status: 404 });
  // the control plane's hostname answers whatever the record lists
  await sent(stack, await log.next(unlisted, { hostnames: ["elsewhere.example.org"] }));
  expect(await logAt(env, MIND_HOSTNAME)).toMatchObject({ status: 200, body: { mind: log.mind } });
  expect(await logAt(env, "elsewhere.example.org")).toMatchObject({ status: 200 });
});

test("a long log is published in pages that the database cuts, and a reader that checks every record reads it to its head", async () => {
  const stack = await mindWithStack();
  const { log, env } = stack;
  // 24 records of about 30 KB each: more than one page holds
  const attested = { ...log.root.entry, attestation: "A".repeat(22_000) };
  let last = log.genesis;
  await sent(stack, last);
  for (let position = 2; position <= 24; position++) {
    last = await log.next(last, {
      rootKeys: [attested],
      alsoKnownAs: [`did:example:${position}`],
    });
    await sent(stack, last);
  }
  expect(rowsIn(stack, "identity_records")).toBe(24);
  const answer = await identityLogResponse(env, { hostname: MIND_HOSTNAME, after: null });
  const page = await answer.text();
  const { records } = JSON.parse(page) as { records: unknown[] };
  expect(records.length).toBeGreaterThan(1);
  expect(records.length).toBeLessThan(24);
  // a page ends with the record that takes it to 512 KiB, less 1 KiB for the page's own fields
  expect(page.length).toBeGreaterThan(511 * 1024);
  expect(page.length).toBeLessThan((511 + 64) * 1024);
  const asked: string[] = [];
  const published = await publishedMindOf(MIND_HOSTNAME, async (request) => {
    const url = new URL(request.url);
    asked.push(url.search);
    return identityLogResponse(env, {
      hostname: url.hostname,
      after: url.searchParams.get("after"),
    });
  });
  expect(published).toMatchObject({
    expected: log.mind,
    head: await identityHashOf(last.record),
    position: 24,
  });
  expect(asked).toHaveLength(2);
});

test("a page is cut by the bytes that are sent: records full of characters that JSON writes with a backslash never make a page that a reader refuses", async () => {
  const stack = await mindWithStack();
  const { log, env, db } = stack;
  // The worst case for a count of stored characters: a small record, almost all of it
  // backslashes. Each is two bytes in the record's text and four in a page, where the text is
  // a JSON string.
  // a hostname of its own for this log: a reader keeps its answer for a hostname a minute
  const hostname = "pages.example.com";
  let last = log.genesis;
  await sent(stack, last);
  for (let position = 2; position <= 40; position++) {
    last = await log.next(last, {
      hostnames: [MIND_HOSTNAME, hostname],
      alsoKnownAs: Array.from(
        { length: 16 },
        (_, index) => `r${position}x${index}:${"\\".repeat(490)}`,
      ),
    });
    expect(await sent(stack, last), `record ${position}`).toMatchObject({ status: 200 });
  }
  // what a reader takes, and no more: a page's budget and one request's body
  const readerTakes = (512 + 256) * 1024;
  const pages: { bytes: number; records: number }[] = [];
  const published = await publishedMindOf(hostname, async (request) => {
    const url = new URL(request.url);
    const answer = await identityLogResponse(env, {
      hostname: url.hostname,
      after: url.searchParams.get("after"),
    });
    const body = await answer.text();
    pages.push({
      bytes: new TextEncoder().encode(body).length,
      records: Object(JSON.parse(body)).records.length,
    });
    return new Response(body);
  });
  expect(published).toMatchObject({ head: await identityHashOf(last.record), position: 40 });
  expect(pages.length).toBeGreaterThan(2);
  for (const page of pages) expect(page.bytes, JSON.stringify(pages)).toBeLessThan(readerTakes);
  // Each row holds what its record takes in a page, to the byte: the first page is the sum of
  // its rows and its own few fields.
  const stored = Number(
    db
      .prepare("select sum(page_bytes) as bytes from identity_records where position <= ?")
      .get(pages[0]!.records)?.bytes,
  );
  expect(pages[0]!.bytes - stored).toBeGreaterThan(0);
  expect(pages[0]!.bytes - stored).toBeLessThan(1024);
  // A count of the stored characters, which are half of these bytes, would have put more
  // records into the first page than a reader takes.
  const charactersOfARecord = last.record.length + JSON.stringify(last.signatures).length;
  const byCharacters = Math.floor((512 * 1024) / charactersOfARecord) + 1;
  expect(byCharacters * (pages[0]!.bytes / pages[0]!.records)).toBeGreaterThan(readerTakes);
});

test("the control plane routes the path: a GET reads the log, a POST is the intake, with no sign-in", async () => {
  const { log, env } = await mindWithStack();
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
  const posted = await authResponse(requestOf(log.genesis), env, ctx);
  expect(await posted.json()).toMatchObject({ answer: "accepted", position: 1 });
  const read = await authResponse(new Request(`${LOG_URL}?after=${log.mind}`), env, ctx);
  expect(await read.json()).toEqual({ version: 1, mind: log.mind, head: log.mind, records: [] });
});

/** A mind with its stack on SQLite, and its root context: a log with the stream's own rule for
 *  idempotency keys. */
async function mindWithStack() {
  const log = await newIdentityLog([MIND_HOSTNAME]);
  return { log, ...sqliteStack({ mindId: log.mind }), root: memoryStream("/") };
}

type MindWithStack = Awaited<ReturnType<typeof mindWithStack>>;

/** The request that posts `body` to the intake. */
function requestOf(body: unknown) {
  const sendsBytes = typeof body === "string" || body instanceof ReadableStream;
  return new Request(LOG_URL, {
    method: "POST",
    body: sendsBytes ? body : JSON.stringify(body),
    // a stream as a request's body needs this in Node
    ...(body instanceof ReadableStream && { duplex: "half" }),
  });
}

/** What a sender gets for `body`: the intake's answer as the boundary gives it out, and the
 *  delivery of the facts to `/` that runs after it under `waitUntil`, awaited here before this
 *  answers (core/boundary-worker src/identity-delivery.ts).
 *  `append: "fails"`: the mind cannot be reached; a function: the appends of the events that it
 *  names fail. `mark: "fails"`: the event is stored and the auth Worker is not told. */
async function sent(
  { env, root }: Pick<MindWithStack, "env" | "root">,
  body: unknown,
  fails: { append?: "fails" | ((event: StreamEventInput) => boolean); mark?: "fails" } = {},
) {
  const delivery: Promise<unknown>[] = [];
  const answer = identityIntakeAnswer(
    await identityIntakeResponse(env, requestOf(body)),
    {
      identityFactsToDeliver: () => identityFactsToDeliver(env),
      identityFactsDelivered: async (ids) => {
        if (fails.mark) throw new Error("the auth Worker was not reached");
        await identityFactsDelivered(env, ids);
      },
    },
    async (events) => {
      const failing = fails.append === "fails" || (fails.append && events.some(fails.append));
      if (failing) throw new Error("the mind was not reached");
      // as the mind Worker appends what the boundary hands it: as the platform
      root.stream.append(
        ...events.map((event) => ({ ...event, source: { platform: true as const } })),
      );
    },
    (work) => delivery.push(work),
  );
  await Promise.all(delivery);
  return { status: answer.status, body: await answer.json() };
}

/** The log of the mind `log.mind` that `/` has folded from its events, as the Mind contract's
 *  reduce folds them: each event into the log of the mind id that it names. */
function foldedBy({
  log,
  root,
}: {
  log: Pick<MindWithStack["log"], "mind">;
  root: MindWithStack["root"];
}) {
  let identities = {};
  for (const event of root.events) {
    const next =
      event.type === "events.iterate.com/mind/identity-record-accepted"
        ? identitiesAfterAccepted(identities, IdentityRecordAccepted.parse(event.payload))
        : identitiesAfterRefused(
            identities,
            IdentityRecordRefused.parse(event.payload),
            event.offset,
          );
    identities = next || identities;
  }
  return identityOfMind(identities, log.mind);
}

/** How many rows the stack's database has in `table`, which may end with a `where`. */
function rowsIn({ db }: Pick<MindWithStack, "db">, table: string) {
  return db.prepare(`select count(*) as rows from ${table}`).get()?.rows;
}

/** `env` whose first statement that contains `sql` runs `step` once, after the statement's own
 *  work or `"before"` it: what another request does in the middle of this one. */
function withStep(
  env: Env,
  sql: string,
  step: () => Promise<void>,
  when: "after" | "before" = "after",
): Env {
  let stepped = false;
  const once = async () => {
    if (stepped) return;
    stepped = true;
    await step();
  };
  const interleaved = (statement: D1PreparedStatement): D1PreparedStatement =>
    ({
      ...statement,
      bind: (...values: unknown[]) => interleaved(statement.bind(...values)),
      first: async () => {
        const row = await statement.first();
        await once();
        return row;
      },
      all: async () => {
        if (when === "before") await once();
        return statement.all();
      },
      run: async () => {
        await once();
        return statement.run();
      },
      // the cast: of a prepared statement, the Worker calls these four members alone
    }) as D1PreparedStatement;
  return {
    ...env,
    DB: {
      ...env.DB,
      prepare: (text: string) =>
        text.includes(sql) ? interleaved(env.DB.prepare(text)) : env.DB.prepare(text),
    },
    // the cast: the fake database has the members that the Worker calls, as in `sqliteStack`
  } as Env;
}

/** `env` whose writes of an accepted record wait until two of them are asked for: two requests
 *  that both passed the check against one head, and write only then. */
function writesTogether(env: Env): Env {
  let arrived = 0;
  let release = () => {};
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = (statement: D1PreparedStatement): D1PreparedStatement =>
    ({
      ...statement,
      bind: (...values: unknown[]) => waiting(statement.bind(...values)),
      run: async () => {
        arrived += 1;
        if (arrived === 2) release();
        await both;
        return statement.run();
      },
      // the cast: of a prepared statement, the intake's write calls `bind` and `run` alone
    }) as D1PreparedStatement;
  return {
    ...env,
    DB: {
      ...env.DB,
      prepare: (sql: string) =>
        sql.includes("insert into identity_records")
          ? waiting(env.DB.prepare(sql))
          : env.DB.prepare(sql),
    },
    // the cast: the fake database has the members that the Worker calls, as in `sqliteStack`
  } as Env;
}

/** The published log as `hostname` answers it. */
async function logAt(env: Env, hostname: string, after: string | null = null) {
  const answer = await identityLogResponse(env, { hostname, after });
  return {
    status: answer.status,
    cache: answer.headers.get("cache-control"),
    body: answer.status === 200 ? await answer.json() : null,
  };
}
