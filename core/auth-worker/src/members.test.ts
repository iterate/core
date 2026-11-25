import { base64url, keyIdOf, signedP256, statementText } from "iterate/signed";
import { expect, test } from "vitest";
import { browserSessionsFake } from "./browser-sessions-fake.ts";
import { sessionCookie } from "./cookies.ts";
import type { Env } from "./env.ts";
import { membersResponse } from "./members.ts";
import { configVars, keyRows, stackKeyPair } from "./test-support.ts";

const LINK = "events.iterate.com/account/member-link-made";
const REMOVE_KEYS = "events.iterate.com/account/member-keys-removed";

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
  const linkPage = await stack.post({ action: "link", email: "member@example.org", signed });
  expect(linkPage).toContain("Sign-in link for member@example.org");
  expect(linkPage).toContain("Give this link to member@example.org");
  expect(linkPage).toContain('data-copy="https://iterate.example.com/keys/first#');
  expect(linkPage).toContain(">Copy link</button>");
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

test("removing a lost passkey with make-link removes keys, ends access, and immediately makes a sign-in link with a copy button", async () => {
  const stack = await stackOf({
    withPasskey: ["member@example.org"],
    kept: [
      "grant:user_member:g1",
      "token:user_member:g1:t1",
      "grant:user_other:g9",
      "token:user_other:g9:t1",
    ],
  });
  const signed = await stack.owner.signed(REMOVE_KEYS, {
    email: "member@example.org",
    makeLink: true,
  });
  const page = await stack.post({
    action: "remove-keys",
    email: "member@example.org",
    "make-link": "1",
    signed,
  });
  expect(page).toContain("Sign-in link for member@example.org");
  expect(page).toContain(
    "member@example.org has no keys now, and is signed out of every app and device.",
  );
  expect(page).toContain('data-copy="https://iterate.example.com/keys/first#');
  expect(page).toContain(">Copy link</button>");
  expect(page).toContain("Give this link to member@example.org");
  expect(stack).toMatchObject({
    changed: ["keys removed of member@example.org", "a link for member@example.org"],
    kept: ["grant:user_other:g9", "token:user_other:g9:t1"],
  });
});

test("removing a lost passkey without make-link removes keys and makes no sign-in link", async () => {
  const stack = await stackOf({ withPasskey: ["member@example.org"] });
  const signed = await stack.owner.signed(REMOVE_KEYS, { email: "member@example.org" });
  const page = await stack.post({
    action: "remove-keys",
    email: "member@example.org",
    signed,
  });
  expect(page).toContain(
    "member@example.org has no keys now, and is signed out of every app and device.",
  );
  expect(page).toContain("Make a sign-in link for this member below when you are ready");
  expect(page).not.toContain('class="link-callout"');
  expect(stack).toMatchObject({ changed: ["keys removed of member@example.org"] });
});

test("a remove-keys signature must match whether a sign-in link is requested", async () => {
  const stack = await stackOf({ withPasskey: ["member@example.org"] });
  const withoutLink = await stack.owner.signed(REMOVE_KEYS, { email: "member@example.org" });
  expect(
    await stack.post({
      action: "remove-keys",
      email: "member@example.org",
      "make-link": "1",
      signed: withoutLink,
    }),
  ).toContain("the signed statement does not match this request");
  const withLink = await stack.owner.signed(REMOVE_KEYS, {
    email: "member@example.org",
    makeLink: true,
  });
  expect(
    await stack.post({
      action: "remove-keys",
      email: "member@example.org",
      signed: withLink,
    }),
  ).toContain("the signed statement does not match this request");
  expect(stack).toMatchObject({ changed: [] });
});

test("removing keys of a former member with make-link removes keys but makes no sign-in link", async () => {
  const stack = await stackOf({
    members: ["member@example.org"],
    withPasskey: ["former@example.org"],
  });
  const signed = await stack.owner.signed(REMOVE_KEYS, {
    email: "former@example.org",
    makeLink: true,
  });
  const page = await stack.post({
    action: "remove-keys",
    email: "former@example.org",
    "make-link": "1",
    signed,
  });
  expect(page).toContain("No sign-in link was made because former@example.org is not a member.");
  expect(page).not.toContain('class="link-callout"');
  expect(stack).toMatchObject({ changed: ["keys removed of former@example.org"] });
});

test("GET /members offers making a sign-in link by default when removing a lost passkey", async () => {
  const stack = await stackOf();
  const page = await stack.get();
  expect(page).toContain('name="make-link" value="1" checked');
  expect(page).toContain("Remove keys and make a sign-in link");
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

const MIND = "iterate.example.com";
const ISSUER = `https://${MIND}`;
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
  members = ["member@example.org", "other@example.org"],
  withPasskey = [],
  kept = [],
}: { members?: string[]; withPasskey?: string[]; kept?: string[] } = {}) {
  const [ownerKey, otherKey, stackKey] = [await keyPair(), await keyPair(), await stackKeyPair()];
  const changed: string[] = [];
  const heldPasskeys = new Set(withPasskey);
  // the OAuth library's store, by its keys: a grant, and each token of it under the grant's name
  const store = new Map(
    kept.map((name) => [name, { id: name.split(":")[2], userId: name.split(":")[1] }]),
  );
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
      if (sql.startsWith("delete from members where email")) {
        changed.push(`${String(bound[0])} removed`);
        return { email: bound[0] };
      }
      if (sql.includes("from members where email"))
        return members.includes(String(bound[0])) ? { 1: 1 } : null;
      if (sql.startsWith("select id from users where email"))
        return { id: `user_${String(bound[0]).split("@")[0]}` };
      if (sql.includes("format = 'webauthn'"))
        return heldPasskeys.has(String(bound[0])) ? { 1: 1 } : null;
      throw new Error(`not expected: ${sql}`);
    },
    all: async () => {
      const session = sessions.statementOf(sql, bound);
      if (session) return session.all();
      if (sql.startsWith("update keys set revoked_at")) {
        const email = String(bound[1]);
        if (!heldPasskeys.has(email)) return { results: [] };
        heldPasskeys.delete(email);
        changed.push(`keys removed of ${email}`);
        return {
          results: [{ id: "key_1", label: "Passkey", userId: `user_${email.split("@")[0]}` }],
        };
      }
      return { results: [] };
    },
    run: async () => {
      const session = sessions.statementOf(sql, bound);
      if (session) return session.run();
      if (!sql.startsWith("insert into member_tickets")) throw new Error(`not expected: ${sql}`);
      changed.push(`a link for ${String(bound[1])}`);
      return { meta: { changes: 1 } };
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
  const env = {
    ...configVars(),
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
  return {
    changed,
    /** What the OAuth library's store still holds. */
    get kept() {
      return [...store.keys()];
    },
    owner: member(ownerKey),
    other: member(otherKey),
    /** The members page itself, fetched by the owner's session. */
    get: async () => {
      const answer = await membersResponse(
        env,
        new Request(`${ISSUER}/members`, { method: "GET", headers: { cookie } }),
        async () => null,
      );
      if (!answer) throw new Error("the members page did not answer");
      return (await answer.text()).replaceAll(/&#(\d+);/g, (_all, code) =>
        String.fromCharCode(Number(code)),
      );
    },
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
