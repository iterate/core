import { base64url, keyIdOf, signedP256, statementText } from "iterate/signed";
import { expect, test } from "vitest";
import type { Env } from "./env.ts";
import { KEY_ADDED, KEY_REMOVED, signedChangeBy } from "./signed-change.ts";

test("a form's signed field counts as the press of the person whose session posts it, once", async () => {
  const { env, owner } = await stack();
  const field = JSON.stringify(await owner.signed(KEY_REMOVED, { key: "key-1" }));
  expect(await signedChangeBy(env, field, KEY_REMOVED, "Owner@Example.net")).toMatchObject({
    signer: { principal: { actor: "owner-key", email: "owner@example.net" } },
    payload: { key: "key-1" },
  });
  // the press is spent: the same field removes nothing a second time
  expect(await signedChangeBy(env, field, KEY_REMOVED, "owner@example.net")).toEqual({
    refused: "the statement was seen before",
  });
});

test.for<[string, string | undefined]>([
  ["no field: a session alone, or a page that posts the form for the member", undefined],
  ["a field that is no JSON", "allow"],
  ["a statement with no signature", JSON.stringify({ statement: "{}" })],
])("a form with %s changes nothing", async ([, field]) => {
  const { env } = await stack();
  expect(await signedChangeBy(env, field, KEY_REMOVED, "owner@example.net")).toEqual({
    refused: "it needs a statement a member's key signed",
  });
});

test("another member's statement, and a statement of another kind, are no press of this person's for this", async () => {
  const { env, owner, other } = await stack();
  const byOther = JSON.stringify(await other.signed(KEY_REMOVED, { key: "key-1" }));
  const ofAnotherKind = JSON.stringify(await owner.signed(KEY_ADDED, { key: "key-1" }));
  expect([
    await signedChangeBy(env, byOther, KEY_REMOVED, "owner@example.net"),
    await signedChangeBy(env, ofAnotherKind, KEY_REMOVED, "owner@example.net"),
  ]).toEqual([
    { refused: "the statement is signed by another person's key" },
    { refused: `the statement is not ${KEY_REMOVED} at /` },
  ]);
});

const DOMAIN = "example.com";
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

async function keyPair() {
  const pair = (await crypto.subtle.generateKey(P256, true, ["sign", "verify"])) as CryptoKeyPair;
  const exported = async (format: "spki" | "pkcs8", key: CryptoKey) =>
    base64url(new Uint8Array((await crypto.subtle.exportKey(format, key)) as ArrayBuffer));
  const publicKey = await exported("spki", pair.publicKey);
  return {
    key: await keyIdOf(publicKey),
    publicKey,
    pkcs8: await exported("pkcs8", pair.privateKey),
    privateKey: pair.privateKey,
  };
}

/** A stack with two members, each with a root key of the config. Of D1, the stack's own key and
 *  the table that counts a statement once. */
async function stack() {
  const [ownerKey, otherKey, stackKey] = [await keyPair(), await keyPair(), await keyPair()];
  const seen = new Set<unknown>();
  const prepare = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => {
      if (!sql.includes("from stack_key")) throw new Error(`not expected: ${sql}`);
      return { key: stackKey.key, public_key: stackKey.publicKey, private_key: stackKey.pkcs8 };
    },
    counted: () => {
      if (sql.startsWith("delete from statements")) return { meta: { changes: 0 } };
      if (!sql.startsWith("insert into statements")) throw new Error(`not expected: ${sql}`);
      const fresh = !seen.has(bound[0]);
      seen.add(bound[0]);
      return { meta: { changes: fresh ? 1 : 0 } };
    },
  });
  const env = {
    DOMAIN,
    AUTH_SETTINGS: JSON.stringify({
      login: { allow: [{ email: "owner@example.net" }, { email: "other@example.net" }] },
      keys: [
        {
          actor: "owner-key",
          email: "owner@example.net",
          publicKey: ownerKey.publicKey,
          label: "Owner",
        },
        {
          actor: "other-key",
          email: "other@example.net",
          publicKey: otherKey.publicKey,
          label: "Other",
        },
      ],
    }),
    DB: {
      prepare,
      batch: async (statements: ReturnType<typeof prepare>[]) =>
        statements.map((statement) => statement.counted()),
    },
    // the cast: a statement's check reads these bindings and no other
  } as unknown as Env;
  const member = (pair: Awaited<ReturnType<typeof keyPair>>) => ({
    signed: (type: string, payload: Record<string, unknown>) => {
      const now = Date.now();
      const statement = statementText({
        mind: DOMAIN,
        path: "/",
        type,
        payload,
        at: now,
        expires: now + 60_000,
      });
      return signedP256(statement, pair.privateKey, pair.key);
    },
  });
  return { env, owner: member(ownerKey), other: member(otherKey) };
}
