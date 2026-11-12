import { base64url, keyIdOf, signedP256, statementText } from "iterate/signed";
import { expect, test } from "vitest";
import { sessionCookie } from "./cookies.ts";
import type { Env } from "./env.ts";
import { membersResponse } from "./members.ts";

const LINK = "events.iterate.com/account/member-link-made";

test.for([
  ["a sign-in link for a member", "link"],
  ["the removal of a member's keys", "remove-keys"],
])("an owner's session alone does not do %s: it takes the owner's passkey", async ([, action]) => {
  const stack = await stackOf();
  const page = await stack.post({ action, email: "member@example.org" });
  expect(page).toContain("This takes a press of your passkey");
  expect(stack).toMatchObject({ changed: [] });
});

test("the owner's passkey signs a link for a member who has no passkey, and for no other member", async () => {
  const stack = await stackOf();
  const forAnother = await stack.owner.signed(LINK, { email: "other@example.org" });
  expect(
    await stack.post({ action: "link", email: "member@example.org", signed: forAnother }),
  ).toContain("the signed statement names another member");
  // a statement for the other act is no statement for this one
  const ofAnotherKind = await stack.owner.signed("events.iterate.com/account/member-keys-removed", {
    email: "member@example.org",
  });
  expect(
    await stack.post({ action: "link", email: "member@example.org", signed: ofAnotherKind }),
  ).toContain("This takes a press of your passkey");
  expect(stack).toMatchObject({ changed: [] });
  const signed = await stack.owner.signed(LINK, { email: "member@example.org" });
  expect(await stack.post({ action: "link", email: "member@example.org", signed })).toContain(
    "Give this link to member@example.org",
  );
  expect(stack).toMatchObject({ changed: ["a link for member@example.org"] });
});

test("another member's passkey is no press of the owner's, and a member with a passkey gets no link", async () => {
  const stack = await stackOf({ withPasskey: ["member@example.org"] });
  const byAnother = await stack.other.signed(LINK, { email: "member@example.org" });
  expect(
    await stack.post({ action: "link", email: "member@example.org", signed: byAnother }),
  ).toContain("signed by another person");
  const signed = await stack.owner.signed(LINK, { email: "member@example.org" });
  expect(await stack.post({ action: "link", email: "member@example.org", signed })).toContain(
    "member@example.org has a passkey here",
  );
  expect(stack).toMatchObject({ changed: [] });
});

test("removal of a member ends what the member was given, each grant with its tokens, and no other person's", async () => {
  const stack = await stackOf({
    kept: [
      "grant:user_member:g1",
      "token:user_member:g1:t1",
      "token:user_member:g1:t2",
      "grant:user_member:g2",
      "grant:user_other:g9",
      "token:user_other:g9:t1",
    ],
  });
  await stack.post({ action: "remove", email: "member@example.org" });
  expect(stack).toMatchObject({
    changed: ["member@example.org removed"],
    kept: ["grant:user_other:g9", "token:user_other:g9:t1"],
  });
});

const DOMAIN = "example.com";
const ISSUER = "https://iterate.example.com";
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

/** A stack with an owner who is signed in with a passkey, and two added members. Of D1, what the
 *  members page and a statement's check read and write. `changed` names each write that counts. */
async function stackOf({
  withPasskey = [],
  kept = [],
}: { withPasskey?: string[]; kept?: string[] } = {}) {
  const [ownerKey, otherKey, stackKey] = [await keyPair(), await keyPair(), await keyPair()];
  const changed: string[] = [];
  // the OAuth library's store, by its keys: a grant, and each token of it under the grant's name
  const store = new Map(
    kept.map((name) => [name, { id: name.split(":")[2], userId: name.split(":")[1] }]),
  );
  const seen = new Set<unknown>();
  const prepare = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => {
      if (sql.includes("from stack_key"))
        return { key: stackKey.key, public_key: stackKey.publicKey, private_key: stackKey.pkcs8 };
      // the session's own passkey is live
      if (sql.includes("from keys where id = ?1 and user_id = ?2")) return { 1: 1 };
      if (sql.startsWith("delete from members where email")) {
        changed.push(`${String(bound[0])} removed`);
        return { email: bound[0] };
      }
      if (sql.includes("from members where email")) return { 1: 1 };
      if (sql.startsWith("select id from users where email"))
        return { id: `user_${String(bound[0]).split("@")[0]}` };
      if (sql.includes("format = 'webauthn'"))
        return withPasskey.includes(String(bound[0])) ? { 1: 1 } : null;
      throw new Error(`not expected: ${sql}`);
    },
    all: async () => {
      if (sql.startsWith("update keys set revoked_at"))
        changed.push(`keys removed of ${String(bound[1])}`);
      return { results: [] };
    },
    run: async () => {
      if (!sql.startsWith("insert into member_tickets")) throw new Error(`not expected: ${sql}`);
      changed.push(`a link for ${String(bound[1])}`);
      return { meta: { changes: 1 } };
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
    AUTH_SIGNING_KEY: "a-signing-key-for-tests-only",
    AUTH_SETTINGS: JSON.stringify({
      login: { allow: [{ email: "owner@example.net" }] },
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
      list: async ({ prefix }: { prefix: string }) => ({
        keys: [...store.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
      get: async (name: string) => store.get(name) ?? null,
      delete: async (name: string) => void store.delete(name),
    },
    // the cast: the members page reads these bindings and no other
  } as unknown as Env;
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
  return {
    changed,
    /** What the OAuth library's store still holds. */
    get kept() {
      return [...store.keys()];
    },
    owner: member(ownerKey),
    other: member(otherKey),
    /** The members page's own form, posted by the owner's session. Answers the page's text. */
    post: async (fields: Record<string, string>) => {
      const answer = await membersResponse(
        env,
        new Request(`${ISSUER}/members`, {
          method: "POST",
          headers: { cookie, origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields),
        }),
        // no token comes with the page's own form
        async () => null,
      );
      if (!answer) throw new Error("the members page did not answer");
      // a change that ends with a redirect has no page
      if (answer.status === 303) return "";
      // the page writes an apostrophe as a numbered entity
      return (await answer.text()).replaceAll(/&#(\d+);/g, (_all, code) =>
        String.fromCharCode(Number(code)),
      );
    },
  };
}
