// THE STACK'S WORKING KEY on the Worker's own SQL (./test-support.ts `sqliteStack`): made once,
// shown as a candidate, listed by a record that the intake accepts, and then the key that signs
// for this mind and that another mind's auth Worker takes.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { identityKeyIdOf } from "iterate/mind-identity";
import { fromBase64url, type StackKeyDocument, verifySignature } from "iterate/signed";
import { expect, test, vi } from "vitest";
import { newIdentityLog } from "../../lib/src/test-support/identity-log.ts";
import { identityIntakeResponse, identityLogResponse } from "./identity.ts";
import { signedByStack, stackKeyResponse } from "./stack-key.ts";
import { statementsResponse } from "./statements.ts";
import { sqliteStack, stackKeyPair } from "./test-support.ts";

test("a stack makes one ML-DSA-65 key, shows it as a candidate, and signs with it once a record lists it", async () => {
  const mind = await mindAt("mind-one.net");
  const first = await mind.published();
  expect(first).toEqual({
    mind: "mind-one.net",
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
  const signed = await signedByStack(a.env, {
    mind: "mind-b.net",
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
                principal: { actor: "mind-a.net", kind: "mind" },
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
  const outside = await signedByStack(a.env, { mind: "mind-b.net", path: "/agents/x", type: "t" });
  expect(await send(outside)).toMatchObject({ status: 403 });
  const forC = await signedByStack(a.env, {
    mind: "mind-c.net",
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
