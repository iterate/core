import { base64url, keyIdOf, signedP256, statementText } from "iterate/signed";
import { expect, test, vi } from "vitest";
import { sessionCookie } from "./cookies.ts";
import { enrolPayloadOf, statementInParts } from "./key-rules.ts";
import { keysPagesResponse, statementHtml } from "./keys-pages.ts";
import { KEY_ADDED, KEY_REMOVED } from "./signed-change.ts";
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
const CLOUD = "https://cloud.example.com";

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

test("iterate Cloud's key: the page names the Cloud's host, the passkey signs the origin, and the key gets the name only after the origin published it at the page and at the press", async () => {
  const stack = await stackOf();
  const { publicKey, key } = await cloudKeyOf();
  const read = cloudsPublish({ [CLOUD]: cloudDocument(publicKey) });
  const link = cloudLink(publicKey);
  const page = await stack.enrolPage({ ...link, label: "Your bank" });
  const html = await page.text();
  expect({
    status: page.status,
    heading: html.match(/<h1>([^<]*)<\/h1>/)?.[1],
    saysWhatFollows: html.includes(
      "With this key it can add events under /integrations/, and iterate.example.com reads them as GitHub&#39;s, Slack&#39;s, Google&#39;s and X&#39;s own. It can read nothing and change nothing else.",
    ),
    // the label is the link's claim: the passkey signs it, and no word of the page shows it
    namesTheLabel: html.replace(/<[^>]*>/g, "").includes("Your bank"),
    sendsTheOrigin: html.includes(`name="cloud" value="${CLOUD}"`),
    // no word of this statement is the link's alone
    marksAWordOfTheLink: html.includes('class="part-link"'),
  }).toEqual({
    status: 200,
    heading: "iterate Cloud at cloud.example.com asks to add events to iterate.example.com",
    saysWhatFollows: true,
    namesTheLabel: false,
    sendsTheOrigin: true,
    marksAWordOfTheLink: false,
  });
  const ask = { ...link, paths: ["/integrations/"] };
  const answer = await stack.enrolPost(
    link,
    await stack.signed(KEY_ADDED, enrolPayloadOf(key, ask)),
  );
  expect(answer).toMatchObject({ status: 200 });
  expect(stack.serviceKeys()).toEqual([
    { actor: "iterate-cloud", paths: '["/integrations/"]', origin: CLOUD, label: "iterate Cloud" },
  ]);
  // once for the page and once for the press, and never by a redirect
  expect(read).toEqual([
    `${CLOUD}/.well-known/iterate-cloud manual`,
    `${CLOUD}/.well-known/iterate-cloud manual`,
  ]);
  expect(await pageOf(stack)).toContain(
    "a key for iterate-cloud, published by cloud.example.com: it can add events under /integrations/",
  );
});

test("iterate Cloud's name goes to no key that its origin does not publish, by a redirect, from an address that is not https, or that the origin changed before the press", async () => {
  const stack = await stackOf();
  const { publicKey, key } = await cloudKeyOf();
  const other = await cloudKeyOf();
  const read = cloudsPublish({
    [CLOUD]: cloudDocument(other.publicKey),
    "https://moved.example.com": new Response(null, {
      status: 302,
      headers: { location: `${CLOUD}/.well-known/iterate-cloud` },
    }),
  });
  const refusalOf = async (fields: Record<string, string>) => {
    const page = await stack.enrolPage(fields);
    return { status: page.status, said: (await page.text()).includes("Nothing was added") };
  };
  expect({
    anotherKey: await refusalOf(cloudLink(publicKey)),
    aRedirect: await refusalOf(cloudLink(publicKey, "https://moved.example.com")),
    noAnswer: await refusalOf(cloudLink(publicKey, "https://gone.example.com")),
  }).toEqual({
    anotherKey: { status: 400, said: true },
    aRedirect: { status: 400, said: true },
    noAnswer: { status: 400, said: true },
  });
  // an address that is not https is never read
  expect(await stack.enrolPage(cloudLink(publicKey, "http://cloud.example.com"))).toMatchObject({
    status: 400,
  });
  expect(read.some((url) => url.startsWith("http:"))).toBe(false);
  // the page was shown while the origin published this key; at the press it publishes another
  const signed = await stack.signed(
    KEY_ADDED,
    enrolPayloadOf(key, { ...cloudLink(publicKey), paths: ["/integrations/"] }),
  );
  expect(await stack.enrolPost(cloudLink(publicKey), signed)).toMatchObject({ status: 400 });
  expect(stack.serviceKeys()).toEqual([]);
});

test("a press for one Cloud's origin allows no other, and a session alone allows nothing", async () => {
  const stack = await stackOf();
  const { publicKey, key } = await cloudKeyOf();
  // two origins publish the one key: the signature still names one of them
  cloudsPublish({
    [CLOUD]: cloudDocument(publicKey),
    "https://other.example.com": cloudDocument(publicKey),
  });
  const signedFor = await stack.signed(
    KEY_ADDED,
    enrolPayloadOf(key, { ...cloudLink(publicKey), paths: ["/integrations/"] }),
  );
  const other = cloudLink(publicKey, "https://other.example.com");
  expect(await stack.enrolPost(other, signedFor)).toMatchObject({ status: 403 });
  expect(await stack.enrolPost(cloudLink(publicKey), "")).toMatchObject({ status: 403 });
  // without the origin, the same signature is no request for the name at all
  const { cloud: _, ...noOrigin } = cloudLink(publicKey);
  expect(await stack.enrolPost(noOrigin, signedFor)).toMatchObject({ status: 400 });
  expect(stack.serviceKeys()).toEqual([]);
});

test("one key of iterate Cloud at a time: a second Cloud's page says which host holds the name, and adds nothing", async () => {
  const stack = await stackOf();
  const first = await cloudKeyOf();
  const second = await cloudKeyOf();
  cloudsPublish({
    [CLOUD]: cloudDocument(first.publicKey),
    "https://other.example.com": cloudDocument(second.publicKey),
  });
  const added = await stack.enrolPost(
    cloudLink(first.publicKey),
    await stack.signed(
      KEY_ADDED,
      enrolPayloadOf(first.key, { ...cloudLink(first.publicKey), paths: ["/integrations/"] }),
    ),
  );
  expect(added).toMatchObject({ status: 200 });
  const page = await stack.enrolPage(cloudLink(second.publicKey, "https://other.example.com"));
  expect(page).toMatchObject({ status: 409 });
  expect(await page.text()).toContain(
    "The name iterate-cloud is held now by the key that cloud.example.com publishes",
  );
  const pressed = await stack.enrolPost(
    cloudLink(second.publicKey, "https://other.example.com"),
    await stack.signed(
      KEY_ADDED,
      enrolPayloadOf(second.key, {
        ...cloudLink(second.publicKey, "https://other.example.com"),
        paths: ["/integrations/"],
      }),
    ),
  );
  expect(pressed).toMatchObject({ status: 409 });
  expect(stack.serviceKeys()).toMatchObject([{ origin: CLOUD }]);
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
  /** The owner's signed statement, as a page's script makes it with a press of a passkey. */
  const signed = async (type: string, payload: Record<string, unknown>) => {
    const now = Date.now();
    const statement = statementText({
      mind: "iterate.example.com",
      path: "/",
      type,
      payload,
      at: now,
      expires: now + 60_000,
    });
    return JSON.stringify(await signedP256(statement, pair.privateKey, signer));
  };
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
    signed,
    remove: async (key: string, next = "") => {
      const answer = await keysPagesResponse(
        stack.env,
        new Request(`${ISSUER}/keys/remove`, {
          method: "POST",
          headers: { cookie, origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            key,
            signed: await signed(KEY_REMOVED, { key }),
            next,
          }),
        }),
      );
      return answer!;
    },
    /** `/keys/enrol` as a member's browser opens the link `fields`. */
    enrolPage: async (fields: Record<string, string>) =>
      (await keysPagesResponse(
        stack.env,
        new Request(`${ISSUER}/keys/enrol?${new URLSearchParams(fields)}`, {
          headers: { cookie },
        }),
      ))!,
    /** The consent page's form for `fields`, posted with `signed`. */
    enrolPost: async (fields: Record<string, string>, signed: string) =>
      (await keysPagesResponse(
        stack.env,
        new Request(`${ISSUER}/keys/enrol`, {
          method: "POST",
          headers: { cookie, origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ...fields, decision: "allow", signed }),
        }),
      ))!,
    serviceKeys: () =>
      stack.db
        .prepare(
          "select actor, paths, origin, label from keys where actor is not null and revoked_at is null",
        )
        .all(),
  };
}

async function pageOf(stack: { env: Parameters<typeof keysPagesResponse>[0]; cookie: string }) {
  const page = await keysPagesResponse(
    stack.env,
    new Request(`${ISSUER}/keys`, { headers: { cookie: stack.cookie } }),
  );
  return page!.text();
}

/** A P-256 key of an iterate Cloud's: its public half as SPKI, base64url, and its id. */
async function cloudKeyOf() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = base64url(
    new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer),
  );
  return { publicKey, key: await keyIdOf(publicKey) };
}

/** The Cloud's link to `/keys/enrol`, as internal-packages/installer access.js makes it. */
const cloudLink = (publicKey: string, cloud = CLOUD) => ({
  actor: "iterate-cloud",
  label: "iterate Cloud",
  publicKey,
  paths: "/integrations/",
  cloud,
});

/** The Cloud's documents, by origin: each read is counted, and an origin with none answers 404. */
function cloudsPublish(published: Record<string, Response | (() => Response)>) {
  const read: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    read.push(`${url} ${init?.redirect}`);
    const answer = published[new URL(url).origin];
    if (!answer) return new Response("not found", { status: 404 });
    return typeof answer === "function" ? answer() : answer.clone();
  });
  return read;
}

const cloudDocument = (publicKey: string) =>
  Response.json({ actor: "iterate-cloud", label: "iterate Cloud", publicKey, clients: {} });
