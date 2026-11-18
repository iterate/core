import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { base64url, keyIdOf, signedP256, statementHashOf, statementText } from "iterate/signed";
import { expect, test } from "vitest";
// the secrets Worker's own signing, so a statement a mind's secret signs is checked by this intake
import {
  generatedSigningMaterial,
  signedStatement,
  signingKeyOf,
} from "../../secrets-worker/src/secret/key-ops.ts";
import type { Env } from "./env.ts";
import { personKeyRefusal, verifiedStatement } from "./keys.ts";
import { statementsResponse } from "./statements.ts";
import { configVars, keyRows, stackKeyPair } from "./test-support.ts";

const MIND = "iterate.example.com";
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

test("a statement signed by a key that a mind's secret holds (itx.secrets.signStatement) is taken, under the key's paths alone", async () => {
  const material = await generatedSigningMaterial();
  const { publicKey } = await signingKeyOf(material);
  const { env } = await stackWithCloudKey(publicKey);
  const sent = async (path: string) => {
    const answer = await statementsResponse(
      env,
      new Request("https://iterate.example.com/statements", {
        method: "POST",
        body: JSON.stringify(
          await signedStatement(material, {
            mind: MIND,
            path,
            type: "events.iterate.com/x/message-received",
          }),
        ),
      }),
    );
    return { status: answer.status, body: await answer.json() };
  };
  expect(await sent("/integrations/x")).toMatchObject({
    status: 200,
    body: { path: "/integrations/x" },
  });
  expect(await sent("/agents/one")).toMatchObject({ status: 403 });
});

test("a person's key adds an event while its address is a member, and none once the member is removed", async () => {
  const { env, person } = await stackWithCloudKey();
  const sent = async (email: string) => {
    const answer = await statementsResponse(
      env,
      new Request("https://iterate.example.com/statements", {
        method: "POST",
        body: JSON.stringify(await person(email)),
      }),
    );
    return { status: answer.status, body: await answer.json() };
  };
  // a person's key has no paths: it adds at any path, here an agent's
  expect(await sent("owner@example.net")).toMatchObject({
    status: 200,
    body: { path: "/agents/one" },
  });
  // removal takes the members row and leaves the key: the key is live, and its address no member
  expect(await sent("gone@example.net")).toEqual({
    status: 403,
    body: {
      refused:
        "gone@example.net is not a member here, so its key signs only at its own context, /people/gone@example.net",
    },
  });
});

test.for([
  ["a service's key, which has no address", { actor: "bridge" }, {}, null],
  ["a member's key", { actor: "u1", email: "jo@example.net" }, { member: true }, null],
  [
    "a member's passkey that checked the person",
    { actor: "u1", email: "jo@example.net" },
    { member: true, userVerified: true },
    null,
  ],
  [
    "a removed member's key",
    { actor: "u1", email: "jo@example.net" },
    { member: false, userVerified: true },
    "jo@example.net is not a member here, so its key signs only at its own context, /people/jo@example.net",
  ],
  [
    "a member's passkey that checked nobody",
    { actor: "u1", email: "jo@example.net" },
    { member: true, userVerified: false },
    "the passkey did not check that it is you, by a PIN, a fingerprint or a face",
  ],
] as const)("%s signs, or says why not", ([, principal, standing, refusal]) => {
  expect(
    personKeyRefusal({ principal, key: "k", label: "a key", member: false, ...standing }),
  ).toBe(refusal);
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

/** The tables a statement's check reads and writes, and nothing else of D1. `keys`: the rows of
 *  the keys this stack knows (./test-support.ts `keyRows`). */
function database(
  stack: { row: Awaited<ReturnType<typeof stackKeyPair>>["row"] },
  keys: Awaited<ReturnType<typeof keyRows>>,
) {
  const seen = new Set<unknown>();
  const prepare = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => {
      if (sql.includes("from keys k left join users u")) return keys(bound[0]);
      // nobody was added by hand: the members are the owners
      if (sql.includes("from members")) return null;
      if (!sql.includes("from stack_key")) throw new Error(`not expected: ${sql}`);
      return stack.row;
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

/** `cloudKey`: the Cloud's public key, when a test signs with a key it holds elsewhere. */
async function stackWithCloudKey(cloudKey?: string) {
  const cloud = await keyPair();
  // two persons' keys: the owner is a member by the config, and the other address is none
  const persons = { "owner@example.net": await keyPair(), "gone@example.net": await keyPair() };
  const keys = [
    {
      actor: "iterate-cloud",
      publicKey: cloudKey || cloud.publicKey,
      label: "Cloud",
      paths: ["/integrations/"],
    },
    ...Object.entries(persons).map(([email, { publicKey }]) => ({
      actor: `user-${email}`,
      email,
      publicKey,
      label: "a person's key",
    })),
  ];
  const env = {
    ...configVars(),
    DB: database(await stackKeyPair(), await keyRows(keys)),
  } as unknown as Env;
  const now = Date.now();
  const statement = statementText({
    mind: MIND,
    path: "/integrations/x",
    type: "events.iterate.com/x/message-received",
    payload: { text: "hello" },
    at: now,
    expires: now + 60_000,
  });
  /** A statement at an agent's context, signed by that person's key. */
  const person = (email: string) => {
    const { privateKey, key } = persons[email as keyof typeof persons];
    return signedP256(
      statementText({
        mind: MIND,
        path: "/agents/one",
        type: "events.iterate.com/x/message-received",
        payload: { text: "hello" },
        at: now,
        expires: now + 60_000,
      }),
      privateKey,
      key,
    );
  };
  return { env, person, envelope: await signedP256(statement, cloud.privateKey, cloud.key) };
}
