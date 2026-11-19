// THE STACK'S WORKING KEY on the Worker's own SQL (./test-support.ts `sqliteStack`): made once,
// shown as a candidate, listed by a record that the intake accepts, and then the key that signs
// for this mind and that another mind's auth Worker takes.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { identityKeyIdOf } from "iterate/mind-identity";
import {
  type Envelope,
  fromBase64url,
  MIND_FETCH_STATEMENT_TYPE,
  signedMlDsa65,
  signedP256,
  type StackKeyDocument,
  statementHeaderOf,
  statementText,
  verifySignature,
} from "iterate/signed";
import { expect, test, vi } from "vitest";
import { newIdentityLog } from "../../lib/src/test-support/identity-log.ts";
import { identityIntakeResponse, identityLogResponse } from "./identity.ts";
import { mindOfSignedRequest } from "./mind-fetch.ts";
import { signedByStack, stackKeyResponse } from "./stack-key.ts";
import { statementsResponse } from "./statements.ts";
import { sqliteStack, stackKeyPair } from "./test-support.ts";

test("a stack makes one ML-DSA-65 key, shows it as a candidate, and signs with it once a record lists it", async () => {
  const mind = await mindAt("mind-one.net");
  const first = await mind.published();
  expect(first).toEqual({
    mind: "mind-one.net",
    mindId: mind.log.mind,
    key: await identityKeyIdOf(first.publicKey),
    publicKey: first.publicKey,
    algorithm: "ML-DSA-65",
    listed: false,
  });
  expect(fromBase64url(first.publicKey)).toHaveLength(1952);
  // one row, kept as the seed
  expect(mind.db.prepare(`select key, length(seed) as seed from stack_key`).all()).toEqual([
    { key: first.key, seed: 43 },
  ]);
  await expect(signedByStack(mind.env, { path: "/x", type: "t" })).rejects.toThrow(
    "lists no working key of this stack yet",
  );
  // the genesis lists no working key; the next record lists the candidate
  expect(await mind.post(mind.log.genesis)).toBe(200);
  expect(await mind.published()).toMatchObject({ listed: false });
  expect(await mind.listsItsKey()).toBe(200);
  expect(await mind.published()).toEqual({ ...first, listed: true });
  const signed = await signedByStack(mind.env, { path: "/x", type: "t" });
  expect(signed.signature).toMatchObject({ format: "ML-DSA-65", key: first.key });
  expect(await verifySignature(signed, first.publicKey, { origin: "", rpId: "" })).toEqual({});
});

test("two minds, up to B's intake's answer: A's stack signs a statement for B, and B's auth Worker takes it through the mind meld and A's published log (the answer's facts; their store on B's log is the boundary's, not here)", async () => {
  const [a, b] = [await mindAt("mind-a.net"), await mindAt("mind-b.net")];
  for (const mind of [a, b]) {
    await mind.post(mind.log.genesis);
    await mind.listsItsKey();
  }
  // B's member let A in under /minds/mind-a.net/ (./minds.test.ts tests the rule itself)
  b.db
    .prepare(
      `insert into mind_melds (domain, append, key, configured_at, configured_by)
       values ('mind-a.net', '["/minds/mind-a.net/"]', null, 1, 'user-owner')`,
    )
    .run();
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    const url = new URL(request.url);
    asked.push(url.href);
    if (url.hostname !== "mind-a.net") return new Response(null, { status: 404 });
    return identityLogResponse(a.env, {
      hostname: url.hostname,
      after: url.searchParams.get("after"),
    });
  });
  const send = async (envelope: unknown) => {
    const answer = await statementsResponse(
      b.env,
      new Request("https://mind-b.net/statements", {
        method: "POST",
        body: JSON.stringify(envelope),
      }),
    );
    return {
      status: answer.status,
      body: (await answer.json()) as unknown,
      facts: decodeFacts(answer.headers.get(FACTS_HEADER) || ""),
    };
  };
  // B by its id: A reads no log to sign
  const signed = await signedByStack(a.env, {
    mind: b.log.mind,
    path: "/minds/mind-a.net/notes",
    type: "events.iterate.com/test/note-added",
    payload: { text: "hello" },
  });
  expect(await send(signed)).toMatchObject({
    status: 200,
    facts: [
      {
        path: "/minds/mind-a.net/notes",
        events: [
          {
            type: "events.iterate.com/test/note-added",
            source: {
              signer: {
                principal: { actor: a.log.mind, kind: "mind", hostname: "mind-a.net" },
                key: (await a.published()).key,
              },
            },
          },
        ],
      },
    ],
  });
  expect(asked).toEqual(["https://mind-a.net/.well-known/iterate"]);
  // beyond its rule A adds nothing, and a statement of A's for another mind is not B's
  const outside = await signedByStack(a.env, { mind: b.log.mind, path: "/agents/x", type: "t" });
  expect(await send(outside)).toMatchObject({ status: 403 });
  const forC = await signedByStack(a.env, {
    mind: "c".repeat(64),
    path: "/minds/mind-a.net/x",
    type: "t",
  });
  expect(await send(forC)).toMatchObject({
    status: 403,
    body: { refused: "the statement is for another mind" },
  });
});

test("a row replaced under a warm cache (a new database under the same binding) is read at the next use: the stack signs with the key that passed the gate, or not at all", async () => {
  const mind = await mindAt("mind-reset.net");
  await mind.post(mind.log.genesis);
  const a = await mind.published();
  const listing = (publicKey: string) => ({
    workingKeys: [
      {
        signs: "raw" as const,
        algorithm: "ML-DSA-65" as const,
        publicKey,
        label: "stack",
        purpose: "statements",
      },
    ],
  });
  const second = await mind.log.next(mind.log.genesis, listing(a.publicKey));
  expect(await mind.post(second)).toBe(200);
  // warm: this isolate has imported key A
  expect((await signedByStack(mind.env, { path: "/x", type: "t" })).signature).toMatchObject({
    key: a.key,
  });
  const b = await stackKeyPair();
  mind.db.prepare(`delete from stack_key`).run();
  mind.db
    .prepare(`insert into stack_key (id, key, public_key, seed) values (1, ?, ?, ?)`)
    .run(b.key, b.publicKey, b.row.seed);
  // the identity still lists A, and the row is B: nothing signs, and B is a candidate
  expect(await mind.published()).toEqual({
    ...a,
    key: b.key,
    publicKey: b.publicKey,
    listed: false,
  });
  await expect(signedByStack(mind.env, { path: "/x", type: "t" })).rejects.toThrow(
    "lists no working key of this stack yet",
  );
  expect(await mind.post(await mind.log.next(second, listing(b.publicKey)))).toBe(200);
  const signed = await signedByStack(mind.env, { path: "/x", type: "t" });
  expect(signed.signature).toMatchObject({ key: b.key });
  expect(await verifySignature(signed, b.publicKey, { origin: "", rpId: "" })).toEqual({});
  expect(await verifySignature(signed, a.publicKey, { origin: "", rpId: "" })).toHaveProperty(
    "refused",
  );
});

test("a mind's signed request: D signs a GET for E's URL, E's auth Worker answers D by the id its log proves, with no rule, and answers the same statement again", async () => {
  const [d, e] = [await mindAt("mind-d.net"), await mindAt("mind-e.net")];
  for (const mind of [d, e]) {
    await mind.post(mind.log.genesis);
    await mind.listsItsKey();
  }
  let reads = 0;
  vi.stubGlobal("fetch", async (request: Request) => {
    const url = new URL(request.url);
    reads += 1;
    if (url.hostname !== "mind-d.net") return new Response(null, { status: 404 });
    return identityLogResponse(d.env, {
      hostname: url.hostname,
      after: url.searchParams.get("after"),
    });
  });
  const url = "https://cloud.mind-e.net/secret-proxy/api.openai.com/v1/responses?x=1";
  const signed = (fields: Partial<Parameters<typeof signedByStack>[1]> = {}) =>
    signedByStack(d.env, {
      mind: e.log.mind,
      path: "/",
      type: MIND_FETCH_STATEMENT_TYPE,
      payload: { method: "GET", url },
      expiresInSeconds: 300,
      ...fields,
    });
  const check = async (envelope: Envelope, asked = { method: "get", url }) =>
    mindOfSignedRequest(e.env, { statement: statementHeaderOf(envelope), ...asked });
  const good = await signed();
  const answer = await check(good);
  expect(answer).toEqual({
    principal: { actor: d.log.mind, kind: "mind", hostname: "mind-d.net" },
    expiresAt: Math.floor(JSON.parse(good.statement).expires / 1000),
  });
  // e has no mind_melds row: who asks is not what they may do
  expect(e.db.prepare(`select count(*) as rows from mind_melds`).all()).toEqual([{ rows: 0 }]);
  // the same statement again, as a sender that reuses it sends it: the same answer, with no log
  // read and no row of the statements table; another method or URL is still refused
  const readsBefore = reads;
  expect(await check(good)).toEqual(answer);
  expect(await check(good, { method: "POST", url })).toEqual({
    refused: "the statement is for GET, not POST",
  });
  expect(await check(good, { method: "GET", url: `${url}&y=2` })).toEqual({
    refused: "the statement is for another URL",
  });
  expect(reads).toBe(readsBefore);
  expect(e.db.prepare(`select count(*) as rows from statements`).all()).toEqual([{ rows: 0 }]);
  expect(await check(await signed(), { method: "POST", url })).toEqual({
    refused: "the statement is for GET, not POST",
  });
  expect(await check(await signed(), { method: "GET", url: `${url}&y=2` })).toEqual({
    refused: "the statement is for another URL",
  });
  expect(await check(await signed({ type: "events.iterate.com/test/note-added" }))).toEqual({
    refused: `the statement is no ${MIND_FETCH_STATEMENT_TYPE}`,
  });
  expect(await check(await signed({ mind: "f".repeat(64) }))).toEqual({
    refused: "the statement is for another mind",
  });
  expect(await check(await signed({ path: "/x" }))).toEqual({
    refused: 'a signed request\'s statement has the path "/"',
  });
  expect(await check(await signed({ expiresInSeconds: 600 }))).toEqual({
    refused:
      "a signed request's statement starts before it ends, now, and lives five minutes at most",
  });
  expect(await check(await signed({ payload: { method: "GET", url, more: 1 } }))).toEqual({
    refused: "the statement's payload is { method, url }",
  });
  const changed = await signed();
  const forged = { ...changed, statement: changed.statement.replace('"GET"', '"PUT"') };
  expect(await check(forged, { method: "PUT", url })).toEqual({
    refused: "the signature is not this key's",
  });
  expect(
    await mindOfSignedRequest(e.env, { statement: "not a statement", method: "GET", url }),
  ).toEqual({ refused: "iterate-auth-statement holds no signed statement" });
  const ended = await signed();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 301_000);
  expect(await check(ended)).toEqual({ refused: "the statement has expired" });
  // a statement answered once is never answered past its end
  expect(await check(good)).toEqual({ refused: "the statement has expired" });
  clock.mockRestore();
  // a statement that E's own stack signed for E: a mind is no caller of itself
  const own = await signedByStack(e.env, {
    path: "/",
    type: MIND_FETCH_STATEMENT_TYPE,
    payload: { method: "GET", url },
  });
  expect(await check(own)).toEqual({
    refused: "the stack's own key signs for others, not for this stack",
  });
  // refused on its text before any log is read: an `at` an hour ahead, a URL that is no URL,
  // another URL; whatever key signed it
  const before = reads;
  const stranger = await stackKeyPair();
  const at = Date.now() + 3_600_000;
  const ahead = await signedMlDsa65(
    statementText({
      mind: "mind-e.net",
      from: "mind-d.net",
      path: "/",
      type: MIND_FETCH_STATEMENT_TYPE,
      payload: { method: "GET", url },
      at,
      expires: Date.now() + 60_000,
    }),
    stranger.privateKey,
    stranger.key,
  );
  expect(await check(ahead)).toEqual({
    refused:
      "a signed request's statement starts before it ends, now, and lives five minutes at most",
  });
  expect(
    await mindOfSignedRequest(e.env, {
      statement: statementHeaderOf(await signed()),
      method: "GET",
      url: "relative",
    }),
  ).toEqual({ refused: "the request's URL is no absolute URL" });
  expect(await check(await signed(), { method: "GET", url: "https://elsewhere.example/" })).toEqual(
    { refused: "the statement is for another URL" },
  );
  // a format that no working key signs
  const p256 = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const otherFormat = await signedP256(
    statementText({
      mind: "mind-e.net",
      from: "mind-d.net",
      path: "/",
      type: MIND_FETCH_STATEMENT_TYPE,
      payload: { method: "GET", url },
      at: Date.now(),
      expires: Date.now() + 60_000,
    }),
    p256.privateKey,
    "a-p256-key",
  );
  expect(await check(otherFormat)).toEqual({
    refused: "a mind's signed request is signed with its working key, ML-DSA-65",
  });
  expect(reads).toBe(before);
});

test("a mind's signed request that ends while its sender's log is read is not stamped", async () => {
  const [g, h] = [await mindAt("mind-g.net"), await mindAt("mind-h.net")];
  for (const mind of [g, h]) {
    await mind.post(mind.log.genesis);
    await mind.listsItsKey();
  }
  const started = Date.now();
  vi.stubGlobal("fetch", async (request: Request) => {
    // the log read takes two seconds by this clock
    vi.spyOn(Date, "now").mockReturnValue(started + 2_000);
    const url = new URL(request.url);
    return identityLogResponse(g.env, {
      hostname: url.hostname,
      after: url.searchParams.get("after"),
    });
  });
  const url = "https://mind-h.net/x";
  const signed = await signedByStack(g.env, {
    mind: h.log.mind,
    path: "/",
    type: MIND_FETCH_STATEMENT_TYPE,
    payload: { method: "GET", url },
    expiresInSeconds: 1,
  });
  try {
    expect(
      await mindOfSignedRequest(h.env, {
        statement: statementHeaderOf(signed),
        method: "GET",
        url,
      }),
    ).toEqual({ refused: "the statement has expired" });
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  expect(h.db.prepare(`select count(*) as rows from statements`).all()).toEqual([{ rows: 0 }]);
});

test("a mind is no caller of itself: a statement from this mind under a second working key of its own is refused before its log is read", async () => {
  const k = await mindAt("mind-k.net");
  await k.post(k.log.genesis);
  const { publicKey } = await k.published();
  const second = await stackKeyPair("second");
  const listing = (key: string, label: string) => ({
    signs: "raw" as const,
    algorithm: "ML-DSA-65" as const,
    publicKey: key,
    label,
    purpose: "statements",
  });
  expect(
    await k.post(
      await k.log.next(k.log.genesis, {
        workingKeys: [listing(publicKey, "stack"), listing(second.publicKey, "second")],
      }),
    ),
  ).toBe(200);
  vi.stubGlobal("fetch", async (request: Request) => {
    const url = new URL(request.url);
    return identityLogResponse(k.env, {
      hostname: url.hostname,
      after: url.searchParams.get("after"),
    });
  });
  const url = "https://mind-k.net/x";
  const now = Date.now();
  const own = await signedMlDsa65(
    statementText({
      mind: "mind-k.net",
      from: "mind-k.net",
      path: "/",
      type: MIND_FETCH_STATEMENT_TYPE,
      payload: { method: "GET", url },
      at: now,
      expires: now + 60_000,
    }),
    second.privateKey,
    second.key,
  );
  try {
    expect(
      await mindOfSignedRequest(k.env, { statement: statementHeaderOf(own), method: "GET", url }),
    ).toEqual({ refused: "a mind is no caller of itself: the statement is from this mind" });
  } finally {
    vi.unstubAllGlobals();
  }
});

test("migration 0018 takes the P-256 key of 0004 away, and the table keeps a seed", () => {
  const db = new DatabaseSync(":memory:");
  const folder = new URL("../migrations/", import.meta.url).pathname;
  const files = readdirSync(folder).sort();
  for (const name of files.filter((file) => file < "0018"))
    db.exec(readFileSync(`${folder}${name}`, "utf8"));
  db.prepare(
    `insert into stack_key (id, key, public_key, private_key) values (1, 'k', 'spki', 'pkcs8')`,
  ).run();
  for (const name of files.filter((file) => file >= "0018"))
    db.exec(readFileSync(`${folder}${name}`, "utf8"));
  expect(db.prepare(`select * from stack_key`).all()).toEqual([]);
  expect(db.prepare(`select name from pragma_table_info('stack_key')`).all()).toEqual([
    { name: "id" },
    { name: "key" },
    { name: "public_key" },
    { name: "seed" },
  ]);
});

/** A mind at `hostname` on SQLite, with its identity log made by a root key that the test holds.
 *  `listsItsKey` posts the record that its owner's command posts after a deploy: the genesis's
 *  content plus the candidate that `/keys/stack.json` shows. */
async function mindAt(hostname: string) {
  const log = await newIdentityLog([hostname]);
  const { env, db } = sqliteStack({
    mindId: log.mind,
    controlPlaneHostname: hostname,
    zones: [hostname],
  });
  const published = async () => (await (await stackKeyResponse(env)).json()) as StackKeyDocument;
  const post = async (signed: unknown) =>
    (
      await identityIntakeResponse(
        env,
        new Request(`https://${hostname}/.well-known/iterate`, {
          method: "POST",
          body: JSON.stringify(signed),
        }),
      )
    ).status;
  return {
    log,
    env,
    db,
    published,
    post,
    listsItsKey: async () => {
      const { publicKey } = await published();
      return post(
        await log.next(log.genesis, {
          workingKeys: [
            {
              signs: "raw",
              algorithm: "ML-DSA-65",
              publicKey,
              label: "stack",
              purpose: "statements",
            },
          ],
        }),
      );
    },
  };
}
