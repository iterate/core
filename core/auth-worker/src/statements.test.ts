import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { base64url, keyIdOf, signedP256, statementHashOf, statementText } from "iterate/signed";
import { expect, test } from "vitest";
import type { Env } from "./env.ts";
import { verifiedStatement } from "./keys.ts";
import { statementsResponse } from "./statements.ts";

const DOMAIN = "example.com";
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

test("the intake takes the same statement again, as the same event to store first", async () => {
  const { env, envelope } = await stackWithCloudKey();
  const sent = async () => {
    const answer = await statementsResponse(
      env,
      new Request("https://iterate.example.com/statements", {
        method: "POST",
        body: JSON.stringify(envelope),
      }),
    );
    return { status: answer.status, facts: decodeFacts(answer.headers.get(FACTS_HEADER) || "") };
  };
  const first = await sent();
  expect(first).toMatchObject({
    status: 200,
    facts: [
      {
        path: "/integrations/x",
        storeFirst: true,
        events: [{ idempotencyKey: `statement:${await statementHashOf(envelope.statement)}` }],
      },
    ],
  });
  // the first try's event may not have been stored: the retry is the same event, by the same key
  expect(await sent()).toEqual(first);
});

test("every other check of a statement still counts it once", async () => {
  const { env, envelope } = await stackWithCloudKey();
  expect(await verifiedStatement(env, envelope)).toMatchObject({
    signer: { principal: { actor: "iterate-cloud" } },
  });
  expect(await verifiedStatement(env, envelope)).toEqual({
    refused: "the statement was seen before",
  });
});

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

/** The two tables a statement's check reads and writes, and nothing else of D1. */
function database(stack: { key: string; publicKey: string; pkcs8: string }) {
  const seen = new Set<unknown>();
  const prepare = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => {
      if (!sql.includes("from stack_key")) throw new Error(`not expected: ${sql}`);
      return { key: stack.key, public_key: stack.publicKey, private_key: stack.pkcs8 };
    },
    counted: () => {
      if (sql.startsWith("delete from statements")) return { meta: { changes: 0 } };
      if (!sql.startsWith("insert into statements")) throw new Error(`not expected: ${sql}`);
      const fresh = !seen.has(bound[0]);
      seen.add(bound[0]);
      return { meta: { changes: fresh ? 1 : 0 } };
    },
  });
  return {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) =>
      statements.map((statement) => statement.counted()),
  };
}

async function stackWithCloudKey() {
  const cloud = await keyPair();
  const keys = [
    {
      actor: "iterate-cloud",
      publicKey: cloud.publicKey,
      label: "Cloud",
      paths: ["/integrations/"],
    },
  ];
  const env = {
    DOMAIN,
    AUTH_SETTINGS: JSON.stringify({
      login: { methods: { email: {} }, allow: [{ email: "owner@example.net" }] },
      keys,
    }),
    DB: database(await keyPair()),
  } as unknown as Env;
  const now = Date.now();
  const statement = statementText({
    mind: DOMAIN,
    path: "/integrations/x",
    type: "events.iterate.com/x/message-received",
    payload: { text: "hello" },
    at: now,
    expires: now + 60_000,
  });
  return { env, envelope: await signedP256(statement, cloud.privateKey, cloud.key) };
}
