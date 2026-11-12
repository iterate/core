import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { base64url, keyIdOf, signedP256, statementText } from "iterate/signed";
import { expect, test } from "vitest";
import { sessionCookie } from "../cookies.ts";
import type { Env } from "../env.ts";
import { DEVICE_CONFIRMED, devicePageResponse, pressPayloadOf } from "./page.ts";
import { type DeviceRequest, deviceStore } from "./store.ts";

test("with no switch in the config, Continue goes on with the session alone, as before", async () => {
  const stack = await stackOf({ passkey: false });
  const page = await stack.get();
  expect(page.text).toContain('value="confirm">Continue</button>');
  expect(page.text).not.toContain("passkey");

  const answer = await stack.post({ action: "confirm" });
  expect(answer).toMatchObject({ status: 303, facts: [] });
  expect(answer.location).toMatch(/^\/oauth2\/auth\?/);
  expect(await stack.request()).toMatchObject({ status: "confirmed", confirmedBy: "user_owner" });
});

test("with the switch, the page asks for the passkey and says what it will sign", async () => {
  const stack = await stackOf();
  const page = await stack.get();
  expect(page.text).toContain("Continue with your passkey");
  expect(page.text).toContain("a session alone signs in no device");
  // the request as the page shows it, for the page's script to sign
  expect(page.text).toContain(`"userCode":"${CODE}"`);
  expect(page.text).toContain('"clientId":"client-1"');
});

test.for([
  ["the Continue of a page whose script did not run", { action: "" }],
  ["a form that says confirm with no statement", { action: "confirm" }],
  ["a statement that is no statement", { action: "confirm", signed: "{}" }],
])("with the switch, %s signs in no device, and the request waits on", async ([, fields]) => {
  const stack = await stackOf();
  const answer = await stack.post(fields as Record<string, string>);
  expect(answer).toMatchObject({ status: 403 });
  expect(answer.text).toContain("To continue takes a press of your passkey");
  expect(await stack.request()).toMatchObject({ status: "pending" });
});

test("with the switch, only this member's statement of this request continues it", async () => {
  const stack = await stackOf();
  const asked = pressPayloadOf(CODE, DEVICE);
  const refusals = [
    // another device's code, another client, and a smaller thing than was asked
    [await stack.owner.signed(DEVICE_CONFIRMED, { ...asked, userCode: "BCDF-GHJK" }), "another"],
    [await stack.owner.signed(DEVICE_CONFIRMED, { ...asked, clientId: "client-2" }), "another"],
    [await stack.owner.signed(DEVICE_CONFIRMED, { userCode: CODE }), "for another request"],
    // another member's passkey is no press of this member's
    [await stack.other.signed(DEVICE_CONFIRMED, asked), "signed by another person"],
    // a statement of another kind, such as the one that adds a key
    [await stack.owner.signed("events.iterate.com/account/key-added", asked), "is not"],
  ] as const;
  for (const [signed, why] of refusals) {
    const answer = await stack.post({ action: "confirm", signed });
    expect(answer).toMatchObject({ status: 403 });
    expect(answer.text).toContain(why);
  }
  expect(await stack.request()).toMatchObject({ status: "pending" });

  const answer = await stack.post({
    action: "confirm",
    signed: await stack.owner.signed(DEVICE_CONFIRMED, asked),
  });
  expect(answer).toMatchObject({ status: 303 });
  expect(answer.location).toMatch(/^\/oauth2\/auth\?/);
  expect(await stack.request()).toMatchObject({ status: "confirmed", confirmedBy: "user_owner" });
  // the account's record of the press: what was signed, and by which key
  expect(answer.facts).toMatchObject([
    {
      path: "/users/user_owner",
      events: [
        {
          type: DEVICE_CONFIRMED,
          payload: { ...asked, signer: { principal: { email: "owner@example.net" } } },
        },
      ],
    },
  ]);
});

test("with the switch, a statement counts once, and Decline takes no passkey", async () => {
  const stack = await stackOf();
  const signed = await stack.owner.signed(DEVICE_CONFIRMED, pressPayloadOf(CODE, DEVICE));
  expect(await stack.post({ action: "confirm", signed })).toMatchObject({ status: 303 });
  // the same statement for the same request again: it was used
  await stack.start(DEVICE);
  expect(await stack.post({ action: "confirm", signed })).toMatchObject({ status: 403 });

  expect(await stack.post({ action: "decline" })).toMatchObject({
    status: 303,
    location: "/oauth2/device?outcome=declined",
  });
  expect(await stack.request()).toMatchObject({ status: "ended", error: "access_denied" });
});

test("with the switch, a let-in's statement names how long and why, and one for a plain sign-in lets nothing in", async () => {
  const letIn = { ...DEVICE, letIn: { seconds: 3600, reason: "to fix the build" } };
  const stack = await stackOf({ device: letIn });
  expect((await stack.get()).text).toContain(
    '"letIn":{"seconds":3600,"reason":"to fix the build"}',
  );
  const plain = await stack.owner.signed(DEVICE_CONFIRMED, pressPayloadOf(CODE, DEVICE));
  expect(await stack.post({ action: "confirm", signed: plain })).toMatchObject({ status: 403 });
  const longer = await stack.owner.signed(DEVICE_CONFIRMED, {
    ...pressPayloadOf(CODE, letIn),
    letIn: { seconds: 86400, reason: "to fix the build" },
  });
  expect(await stack.post({ action: "confirm", signed: longer })).toMatchObject({ status: 403 });
  const signed = await stack.owner.signed(DEVICE_CONFIRMED, pressPayloadOf(CODE, letIn));
  expect(await stack.post({ action: "confirm", signed })).toMatchObject({ status: 303 });
});

const DOMAIN = "example.com";
const ISSUER = "https://iterate.example.com";
const CODE = "WDJB-MJHT";
const KEY = "k".repeat(43);
const DEVICE: DeviceRequest = {
  status: "pending",
  clientId: "client-1",
  clientName: "the laptop",
  resource: `https://iterate.${DOMAIN}/api`,
  requestedFrom: { city: "London", country: "GB" },
  createdAt: Date.now(),
  expiresAt: Date.now() + 300_000,
};
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

/** A stack with an owner who is signed in with a passkey, another member, and one device that
 *  waits. Of D1 and KV, what the device page and a statement's check read and write. */
async function stackOf({ passkey = true, device = DEVICE } = {}) {
  const [ownerKey, otherKey, stackKey] = [await keyPair(), await keyPair(), await keyPair()];
  const seen = new Set<unknown>();
  const prepare = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => {
      if (sql.includes("from stack_key"))
        return { key: stackKey.key, public_key: stackKey.publicKey, private_key: stackKey.pkcs8 };
      // the session's own passkey is live
      if (sql.includes("from keys where id = ?1 and user_id = ?2")) return { 1: 1 };
      if (sql.includes("from members where email")) return { 1: 1 };
      throw new Error(`not expected: ${sql}`);
    },
    counted: () => {
      if (sql.startsWith("delete from statements")) return { meta: { changes: 0 } };
      if (!sql.startsWith("insert into statements")) throw new Error(`not expected: ${sql}`);
      const fresh = !seen.has(bound[0]);
      seen.add(bound[0]);
      return { meta: { changes: fresh ? 1 : 0 } };
    },
  });
  const kept = new Map<string, string>();
  const env = {
    DOMAIN,
    AUTH_SIGNING_KEY: "a-signing-key-for-tests-only",
    AUTH_SETTINGS: JSON.stringify({
      login: { allow: [{ email: "owner@example.net" }, { email: "other@example.org" }] },
      ...(passkey && { devices: { passkey: true } }),
      // each person's key of the config stands in for their passkey: a statement it signs is theirs
      keys: [
        {
          actor: "owner-key",
          email: "owner@example.net",
          publicKey: ownerKey.publicKey,
          label: "O",
        },
        {
          actor: "other-key",
          email: "other@example.org",
          publicKey: otherKey.publicKey,
          label: "X",
        },
      ],
    }),
    DB: {
      prepare,
      batch: async (statements: ReturnType<typeof prepare>[]) =>
        statements.map((statement) => statement.counted()),
    },
    OAUTH_KV: {
      get: async (key: string) => kept.get(key) ?? null,
      put: async (key: string, value: string) => void kept.set(key, value),
    },
    // the cast: the device page reads these bindings and no other
  } as unknown as Env;
  const store = deviceStore(env.OAUTH_KV);
  const start = async (request: DeviceRequest) => {
    kept.clear();
    await store.start(KEY, CODE, request);
  };
  await start(device);
  const cookie = (
    await sessionCookie(env, { id: "user_owner", email: "owner@example.net" }, "passkey", "key-1")
  ).split(";")[0]!;
  const member = (pair: Awaited<ReturnType<typeof keyPair>>) => ({
    signed: async (type: string, payload: Record<string, unknown>) => {
      const now = Date.now();
      const statement = statementText({
        mind: DOMAIN,
        path: "/",
        type,
        payload,
        at: now,
        expires: now + 60_000,
      });
      return JSON.stringify(await signedP256(statement, pair.privateKey, pair.key));
    },
  });
  const answered = async (answer: Response) => ({
    status: answer.status,
    location: answer.headers.get("location"),
    facts: answer.headers.has(FACTS_HEADER) ? decodeFacts(answer.headers.get(FACTS_HEADER)!) : [],
    // the page writes a quote as a numbered entity
    text: (await answer.text()).replaceAll(/&#(\d+);/g, (_all, code) =>
      String.fromCharCode(Number(code)),
    ),
  });
  return {
    owner: member(ownerKey),
    other: member(otherKey),
    start,
    /** The device's request as the store holds it now. */
    request: () => store.byKey(KEY),
    get: async () =>
      answered(
        await devicePageResponse(
          env,
          new Request(`${ISSUER}/oauth2/device?user_code=${CODE}`, { headers: { cookie } }),
        ),
      ),
    /** The page's own form, posted by the owner's session. */
    post: async (fields: Record<string, string>) =>
      answered(
        await devicePageResponse(
          env,
          new Request(`${ISSUER}/oauth2/device`, {
            method: "POST",
            headers: {
              cookie,
              origin: ISSUER,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ user_code: CODE, ...fields }),
          }),
        ),
      ),
  };
}
