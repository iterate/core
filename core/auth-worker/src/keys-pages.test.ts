import { base64url, keyIdOf, signedP256, statementText } from "iterate/signed";
import { expect, test } from "vitest";
import { sessionCookie } from "./cookies.ts";
import { statementInParts } from "./key-rules.ts";
import { keysPagesResponse, statementHtml } from "./keys-pages.ts";
import { KEY_REMOVED } from "./signed-change.ts";
import { sqliteStack } from "./test-support.ts";

const facts = { mind: "example.com", key: "key-a-of-a-service", person: "ada@example.com" };

test("the statement marks what the mind checked, what the link said and who signs", () => {
  const html = statementHtml(
    statementInParts(
      { actor: "a-service", label: "A service", publicKey: "pk", paths: ["/integrations/a/"] },
      facts,
    ),
  );
  expect(html).toContain('<span class="part-you">ada@example.com</span>');
  expect(html).toContain('<span class="part-checked">/integrations/a/</span>');
  expect(html).toContain('<span class="part-checked">example.com</span>');
  expect(html).toContain('<span class="part-link">a-service</span>');
  expect(html).toContain('<span class="part-link">“A service”</span>');
});

test("a label that a link wrote as markup is shown as its characters", () => {
  const html = statementHtml(
    statementInParts(
      {
        actor: "a-service",
        label: '<img src=x onerror="alert(1)">',
        publicKey: "pk",
        paths: ["/integrations/a/"],
      },
      facts,
    ),
  );
  expect(html).not.toContain("<img");
  expect(html).toContain("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
});

const ISSUER = "https://iterate.example.com";
const OWNER = "owner@example.net";

test("/keys is the whole page for a member: the keys, a name that is optional, and where the loss of the only passkey leaves them", async () => {
  const stack = await stackOf();
  const html = await pageOf(stack);
  expect({
    heading: html.match(/<h1>([^<]*)<\/h1>/)?.[1],
    listed: html.includes("<li>A phone "),
    nameField: html.match(/<label>[^<]*<input name="label"[^>]*>/)?.[0],
    asksForASecond: html.includes("<strong>Add a second passkey</strong>"),
    // an owner comes back by the recovery command, and by nobody's link
    saysWhoLetsThemBackIn: /Cloudflare account runs the recovery command/.test(html),
  }).toEqual({
    heading: "Your keys for iterate.example.com",
    listed: true,
    nameField:
      '<label>Name, optional <input name="label" maxlength="100" size="28" placeholder="such as YubiKey">',
    asksForASecond: true,
    saysWhoLetsThemBackIn: true,
  });
});

test("a browser with no passkey's session gets no key's id and no page: it is sent to sign in", async () => {
  const { env } = await stackOf();
  const json = await keysPagesResponse(env, new Request(`${ISSUER}/keys.json`));
  expect(json).toMatchObject({ status: 401 });
  const page = await keysPagesResponse(env, new Request(`${ISSUER}/keys?next=%2Fmembers`));
  expect(page!.headers.get("location")).toBe(
    `${ISSUER}/sign-in?next=${encodeURIComponent("/keys?next=%2Fmembers")}`,
  );
});

test("nobody removes their own last passkey: the page has no button for it, the server refuses it, and with a second passkey one of the two goes", async () => {
  const stack = await stackOf();
  // the only passkey has no form to remove it
  expect(await pageOf(stack)).toContain(
    "your only passkey: add another before you remove this one",
  );
  expect(await pageOf(stack)).not.toContain(`name="key" value="passkey-phone"`);
  const refused = await stack.remove("passkey-phone");
  expect(refused).toMatchObject({ status: 409 });
  expect(await refused.text()).toContain("Add another passkey first, then remove this one.");
  expect(stack.livePasskeys()).toEqual(["passkey-phone"]);

  stack.addPasskey("passkey-laptop", "A laptop");
  expect(await pageOf(stack)).toContain(`name="key" value="passkey-phone"`);
  expect(await stack.remove("passkey-laptop")).toMatchObject({ status: 303 });
  expect(stack.livePasskeys()).toEqual(["passkey-phone"]);
  // the one that is left is the last again
  expect(await stack.remove("passkey-phone")).toMatchObject({ status: 409 });
  expect(stack.livePasskeys()).toEqual(["passkey-phone"]);
});

// A passkey from before the address was a member's (../migrations/0016) is no member's: it never
// signs in, so it does not count as a second passkey, and the member's own last one stays.
test("a passkey from before the address was a member's is no second passkey: the last member passkey stays", async () => {
  const stack = await stackOf();
  stack.addPasskey("passkey-old", "An old one");
  stack.db.prepare("update keys set outsider = 1 where id = 'passkey-old'").run();
  expect(await pageOf(stack)).toContain(
    "your only passkey: add another before you remove this one",
  );
  expect(await stack.remove("passkey-phone")).toMatchObject({ status: 409 });
  expect(stack.livePasskeys()).toEqual(["passkey-phone", "passkey-old"]);
});

test("the way back to a page after a removal is the whole address that was checked", async () => {
  const stack = await stackOf();
  stack.addPasskey("passkey-laptop", "A laptop");
  const kept = await stack.remove("passkey-laptop", "https://dash.example.com/?agent=/agents/a");
  expect(kept.headers.get("location")).toBe(
    `/keys?next=${encodeURIComponent("https://dash.example.com/?agent=/agents/a")}`,
  );
  stack.addPasskey("passkey-tablet", "A tablet");
  const elsewhere = (await stack.remove("passkey-tablet", "//evil.example/")).headers.get(
    "location",
  );
  expect(elsewhere).toBe("/keys");
});

/** A stack on SQLite whose owner holds one passkey, "A phone", and is signed in with it. The
 *  owner's statements are signed by a P-256 key of theirs, which stands in for a passkey's
 *  signature: a test has no authenticator. */
async function stackOf() {
  const stack = sqliteStack();
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = base64url(
    new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer),
  );
  const signer = await keyIdOf(publicKey);
  stack.db.prepare("insert into users (id, email) values ('user_owner', ?)").run(OWNER);
  const addKey = stack.db.prepare(
    `insert into keys (id, user_id, public_key, format, credential_id, label, added_via, added_by, added_at)
     values (?, 'user_owner', ?, ?, ?, ?, 'keys-page', 'user_owner', ?)`,
  );
  let added = 0;
  const addPasskey = (id: string, label: string) =>
    void addKey.run(
      id,
      `public-key-of-${id}`,
      "webauthn",
      `credential-of-${id}`,
      label,
      (added += 1),
    );
  addPasskey("passkey-phone", "A phone");
  addKey.run(signer, publicKey, "p256", null, "the test's signer", 0);
  const user = { id: "user_owner", email: OWNER };
  const cookie = (
    await sessionCookie(stack.env, new Request(ISSUER), user, "passkey-phone")
  ).setCookie.split(";")[0]!;
  // the session lives with the passkey that opened it, "A phone": the tests remove the others
  return {
    ...stack,
    cookie,
    addPasskey,
    livePasskeys: () =>
      stack.db
        .prepare(
          "select id from keys where format = 'webauthn' and revoked_at is null order by added_at",
        )
        .all()
        .map((row) => row.id),
    /** The page's own form for a key's removal, with the owner's signed statement of it. */
    remove: async (key: string, next = "") => {
      const now = Date.now();
      const statement = statementText({
        mind: "iterate.example.com",
        path: "/",
        type: KEY_REMOVED,
        payload: { key },
        at: now,
        expires: now + 60_000,
      });
      const signed = JSON.stringify(await signedP256(statement, pair.privateKey, signer));
      const answer = await keysPagesResponse(
        stack.env,
        new Request(`${ISSUER}/keys/remove`, {
          method: "POST",
          headers: { cookie, origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ key, signed, next }),
        }),
      );
      return answer!;
    },
  };
}

async function pageOf(stack: { env: Parameters<typeof keysPagesResponse>[0]; cookie: string }) {
  const page = await keysPagesResponse(
    stack.env,
    new Request(`${ISSUER}/keys`, { headers: { cookie: stack.cookie } }),
  );
  return page!.text();
}
