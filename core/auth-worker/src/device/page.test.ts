import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { base64url, keyIdOf, signedP256, statementText } from "iterate/signed";
import { expect, test } from "vitest";
import { browserSessionsFake } from "../browser-sessions-fake.ts";
import { sessionCookie } from "../cookies.ts";
import type { Env } from "../env.ts";
import { configVars, keyRows, stackKeyPair } from "../test-support.ts";
import { DEVICE_CONFIRMED, devicePageResponse, pressPayloadOf } from "./page.ts";
import { requesterOf } from "./start.ts";
import { type DeviceRequest, deviceStore } from "./store.ts";

test("the page asks for the passkey and says what it will sign", async () => {
  const stack = await stackOf();
  const page = await stack.get();
  expect(page.text).toContain('<button type="submit" data-continue>Continue with passkey</button>');
  expect(page.text).toContain("Your passkey signs this request.");
  // the request as the page shows it, for the page's script to sign
  expect(page.text).toContain(`"userCode":"${CODE}"`);
  expect(page.text).toContain('"clientId":"client-1"');
});

test("a device's sign-in shows its name as its own claim, what it wants, that it gets everything as the member, and the code", async () => {
  const stack = await stackOf();
  const { text } = await stack.get();
  expect(text).toContain(
    `<div><dt>Device</dt><dd><strong>the laptop</strong><span class="note">The name is the device's own claim.</span></dd></div>`,
  );
  expect(text).toMatch(
    /<dt>Asked <details class="help">.*?<\/details><\/dt><dd>\d+ seconds ago, from London, GB<\/dd>/,
  );
  expect(text).toContain("<div><dt>It wants</dt><dd>the mind's API</dd></div>");
  expect(text).toContain(
    `<div><dt>It gets</dt><dd>everything in this mind, as <strong>owner@example.net</strong><span class="note">It can read and change all of it.</span></dd></div>`,
  );
  expect(text).toContain(
    `<div><dt>Code</dt><dd><strong>${CODE}</strong><span class="note">Continue only if you started this sign-in yourself and the device shows this code.</span></dd></div>`,
  );
});

test("a let-in shows its reason as the asker's word, how long with no renewal, and who asks: a claim, or the key that proved it", async () => {
  const stack = await stackOf({
    device: { ...DEVICE, letIn: { seconds: 3600, reason: "to fix the build" } },
  });
  const { text } = await stack.get();
  expect(text).toContain(
    `<div><dt>Who asks</dt><dd><strong>the laptop</strong><span class="note">The name is its own claim: nothing proves who asks. Continue only if you know where this request comes from.</span></dd></div>`,
  );
  expect(text).toContain(
    `<div><dt>Its reason <details class="help"><summary aria-label="About Its reason">?</summary><p>The asker wrote this. Nobody checked it.</p></details></dt><dd><blockquote>to fix the build</blockquote></dd></div>`,
  );
  expect(text).toContain(
    `<div><dt>It gets</dt><dd>everything in this mind, as <strong>owner@example.net</strong><span class="note">It can read and change all of it.</span></dd></div>`,
  );
  expect(text).toContain(
    `<div><dt>For</dt><dd>60 minutes from your approval<span class="note">It cannot renew this.</span></dd></div>`,
  );
  expect(text).toContain(
    `<div><dt>Code</dt><dd><strong>${CODE}</strong><span class="note">Continue only if you expected this request.</span></dd></div>`,
  );
  const signer = { actor: "cli-bridge", label: "The bridge", key: "p".repeat(43) };
  await stack.start({ ...DEVICE, letIn: { seconds: 7200, reason: "to fix the build", signer } });
  const proved = (await stack.get()).text;
  expect(proved).toContain(
    `<div><dt>Who asks</dt><dd><strong>The bridge</strong><span class="note">It proved who it is with the key this mind trusts for cli-bridge (pppppppp).</span></dd></div>`,
  );
  expect(proved).toContain("<dt>For</dt><dd>2 hours from your approval");
});

test.for([
  ["the Continue of a page whose script did not run", { action: "" }],
  ["a form that says confirm with no statement", { action: "confirm" }],
  ["a statement that is no statement", { action: "confirm", signed: "{}" }],
])("%s signs in no device, and the request waits on", async ([, fields]) => {
  const stack = await stackOf();
  const answer = await stack.post(fields as Record<string, string>);
  expect(answer).toMatchObject({ status: 403 });
  expect(answer.text).toContain("To continue takes a press of your passkey");
  expect(await stack.request()).toMatchObject({ status: "pending" });
});

test("only this member's statement of this request continues it", async () => {
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

test("a statement counts once, and Decline takes no passkey", async () => {
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

test.for([
  ["approved", "This code was used: the device is signed in. You can close this page."],
  ["redeemed", "This code was used: the device is signed in. You can close this page."],
] as const)(
  "a code that was %s says so when its page opens again, with no form and no alert",
  async ([status, words]) => {
    const stack = await stackOf();
    await stack.start({ ...DEVICE, status, confirmedBy: "user_owner" });
    const page = await stack.get();
    expect({
      status: page.status,
      said: page.text.includes(`<p>${words}</p>`),
      form: page.text.includes("<form"),
      alert: page.text.includes('<p role="alert"'),
    }).toEqual({ status: 200, said: true, form: false, alert: false });
    // a let-in's code says it in its own words
    await stack.start({ ...DEVICE, status, letIn: { seconds: 3600, reason: "a test" } });
    expect((await stack.get()).text).toContain(
      "<p>This code was used: it is let in. You can close this page.</p>",
    );
  },
);

test("a code that is unknown, or that ran out unused, keeps the form and its words", async () => {
  const stack = await stackOf();
  const unknown = await stack.get("BCDF-GHJK");
  const words = "No device is waiting for this code. It may have expired.";
  expect({ status: unknown.status, said: unknown.text.includes(words) }).toEqual({
    status: 400,
    said: true,
  });
  expect(unknown.text).toContain('<input name="user_code" value="BCDF-GHJK"');
  await stack.start({ ...DEVICE, expiresAt: Date.now() - 1 });
  expect((await stack.get()).text).toContain(words);
});

test("a let-in's statement names how long and why, and one for a plain sign-in lets nothing in", async () => {
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

test("a let-in that another mind signed is headed by the mind's verified hostname, never by the label it gave its own key", async () => {
  const signer = {
    principal: { actor: "e".repeat(64), kind: "mind" as const, hostname: "peer.example.net" },
    key: "p".repeat(43),
    label: "owner@example.net's passkey, trust me",
    member: false,
  };
  const asked = requesterOf(signer);
  expect(asked).toEqual({
    actor: "e".repeat(64),
    label: `peer.example.net (${"e".repeat(12)}…)`,
    key: signer.key,
  });
  // a person's or a service's key keeps the label that a member gave it
  expect(requesterOf({ ...signer, principal: { actor: "cli-bridge" } })).toMatchObject({
    label: "owner@example.net's passkey, trust me",
  });
  const stack = await stackOf({
    device: { ...DEVICE, letIn: { seconds: 3600, reason: "to fix the build", signer: asked } },
  });
  const { text } = await stack.get();
  expect(text).toContain(`<h1>Let peer.example.net (${"e".repeat(12)}…) in?</h1>`);
  expect(text).not.toContain("trust me");
});

const MIND = "iterate.example.com";
const ISSUER = `https://${MIND}`;
const CODE = "WDJB-MJHT";
const KEY = "k".repeat(43);
const DEVICE: DeviceRequest = {
  status: "pending",
  clientId: "client-1",
  clientName: "the laptop",
  resource: `${ISSUER}/api`,
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
async function stackOf({ device = DEVICE } = {}) {
  const [ownerKey, otherKey, stackKey] = [await keyPair(), await keyPair(), await stackKeyPair()];
  const seen = new Set<unknown>();
  const sessions = browserSessionsFake();
  // each person's key stands in for their passkey: a statement it signs is theirs
  const keys = await keyRows([
    { actor: "owner-key", email: "owner@example.net", publicKey: ownerKey.publicKey, label: "O" },
    { actor: "other-key", email: "other@example.org", publicKey: otherKey.publicKey, label: "X" },
  ]);
  const prepare = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => {
      const session = sessions.statementOf(sql, bound);
      if (session) return session.first();
      if (sql.includes("from keys k left join users u")) return keys(bound[0]);
      if (sql.includes("from stack_key")) return stackKey.row;
      if (sql.includes("from members where email")) return { 1: 1 };
      throw new Error(`not expected: ${sql}`);
    },
    counted: () => {
      const session = sessions.statementOf(sql, bound);
      if (session) return session.results();
      if (sql.startsWith("delete from statements")) return { meta: { changes: 0 } };
      if (!sql.startsWith("insert into statements")) throw new Error(`not expected: ${sql}`);
      const fresh = !seen.has(bound[0]);
      seen.add(bound[0]);
      return { meta: { changes: fresh ? 1 : 0 } };
    },
  });
  const kept = new Map<string, string>();
  const env = {
    ...configVars(),
    DB: {
      prepare,
      batch: async (statements: ReturnType<typeof prepare>[]) =>
        statements.map((statement) => statement.counted()),
    },
    OAUTH_KV: {
      // a mind with no logo of its own, read just now (../mind-mark.ts): no page here asks the
      // mind's website, which would be a request to the real internet
      get: async (key: string) =>
        key === "iterate-mind-mark"
          ? { icon: null, askAfter: Number.MAX_SAFE_INTEGER }
          : (kept.get(key) ?? null),
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
    await sessionCookie(
      env,
      new Request(ISSUER),
      { id: "user_owner", email: "owner@example.net" },
      "key-1",
    )
  ).setCookie.split(";")[0]!;
  const member = (pair: Awaited<ReturnType<typeof keyPair>>) => ({
    signed: async (type: string, payload: Record<string, unknown>) => {
      const now = Date.now();
      const statement = statementText({
        mind: MIND,
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
    get: async (userCode = CODE) =>
      answered(
        await devicePageResponse(
          env,
          new Request(`${ISSUER}/oauth2/device?user_code=${userCode}`, { headers: { cookie } }),
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
