import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { base64url } from "iterate/signed";
import { expect, test } from "vitest";
import { newGrantProps } from "./authorize.ts";
import { FIRST_OWNER_PATH } from "./config.ts";
import { sessionCookie, sessionOf } from "./cookies.ts";
import { sha256Hex } from "./device/protocol.ts";
import type { Env } from "./env.ts";
import { firstOwnerResponse } from "./first-owner.ts";
import { statementInParts } from "./key-rules.ts";
import { addressProven } from "./keys.ts";
import { keysPagesResponse, statementHtml } from "./keys-pages.ts";
import { memberHoldsPasskey } from "./members.ts";
import { passkeySignInResponse } from "./passkey-sign-in.ts";

const facts = { domain: "example.com", key: "key-a-of-a-service", person: "ada@example.com" };

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

const DOMAIN = "example.com";
const ISSUER = `https://iterate.${DOMAIN}`;
const MEMBER = "member@example.org";
const OWNERS_TICKET = "the-owners-ticket";
// a default name: the word and the day it was added, whichever day the test runs
const DEFAULT_NAME = expect.stringMatching(/^Passkey, \d{4}-\d{2}-\d{2}$/);

// A member's link (./members.ts `memberLink`) adds the member's first passkey alone
// (./keys-pages.ts): a session that another link opened before that passkey adds no second one.
test.for(["one after the other", "at once"])(
  "of two member's-link sessions that opened /keys before any passkey, one adds a passkey: %s",
  async (when) => {
    const { env, passkeys } = await stack();
    const sessions = [await linkSession(env, "link-one"), await linkSession(env, "link-two")];
    const pages = await Promise.all(sessions.map((cookie) => challengeOf(env, cookie)));
    const add = (n: number) => added(env, sessions[n]!, pages[n]!);
    const statuses =
      when === "at once" ? await Promise.all([add(0), add(1)]) : [await add(0), await add(1)];
    expect({ added: statuses.filter((status) => status === 200), passkeys: passkeys() }).toEqual({
      added: [200],
      passkeys: 1,
    });
  },
);

// The page sends a session that came only to add a passkey on, once it has one: to the `next` its
// request named when that is the mind's own (./key-rules.ts `honouredNext`), else to the Dash.
const DASH = `https://dash.${DOMAIN}`;
test.for([
  { ticket: OWNERS_TICKET, next: `${DASH}/?agent=/agents/a`, onward: `${DASH}/?agent=/agents/a` },
  { ticket: OWNERS_TICKET, next: "/authorize?client_id=a", onward: "/authorize?client_id=a" },
  {
    ticket: OWNERS_TICKET,
    next: "https://evil.example/",
    onward: `${DASH}/?agent=/agents/onboarding`,
  },
  { ticket: OWNERS_TICKET, next: null, onward: `${DASH}/?agent=/agents/onboarding` },
  { ticket: "link-one", next: null, onward: `${DASH}/` },
])(
  "after the passkey of $ticket, next $next goes on to $onward",
  async ({ ticket, next, onward }) => {
    const { env } = await stack();
    const cookie = await linkSession(env, ticket);
    const query = next ? `?${new URLSearchParams({ next })}` : "";
    const page = await keysPagesResponse(
      env,
      new Request(`${ISSUER}/keys${query}`, { headers: { cookie } }),
    );
    const html = await page!.text();
    const said = html.match(/data-next="([^"]+)"/)?.[1];
    expect(said?.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))).toBe(onward);
  },
);

// ./keys-pages.ts `keysPage` says why a first sign-in has a page of its own.
test.for([
  { name: "the owner's ticket", ticket: OWNERS_TICKET },
  { name: "a member's link", ticket: "link-one" },
])("the first sign-in by $name is a page with one thing to do", async ({ ticket }) => {
  const { env } = await stack();
  const cookie = await linkSession(env, ticket);
  const page = await keysPagesResponse(env, new Request(`${ISSUER}/keys`, { headers: { cookie } }));
  const html = await page!.text();
  expect({
    heading: html.match(/<h1>([^<]*)<\/h1>/)?.[1],
    lines: [...html.matchAll(/<p>([^<]*)<\/p>/g)].map((line) => line[1]),
    buttons: [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((button) => button[1]),
    nameField: html.match(/<input name="label"[^>]*>/)?.[0],
    saysOfOtherKeys: /Your keys for|no keys here yet|second passkey|Sessions/.test(html),
  }).toEqual({
    heading: "Add your passkey to example.com",
    lines: [
      "example.com needs a passkey at your first sign-in. From then on it is how you sign in here, and how you sign what you approve.",
      "Press the button, and your browser asks for your fingerprint, your face or a security key.",
    ],
    buttons: ["Add a passkey"],
    nameField:
      '<input name="label" maxlength="100" size="28" aria-label="Name" placeholder="such as YubiKey">',
    saysOfOtherKeys: false,
  });
});

test("a later visit to /keys is the whole page: the keys, and a name that is optional", async () => {
  const { env } = await stack();
  const first = await linkSession(env, "link-one");
  const made = await posted(env, first, await challengeOf(env, first), { label: "A phone" });
  // the passkey's own session, which the answer sets
  const cookie = made.headers.get("set-cookie")!.split(";")[0]!;
  const page = await keysPagesResponse(env, new Request(`${ISSUER}/keys`, { headers: { cookie } }));
  const html = await page!.text();
  expect({
    heading: html.match(/<h1>([^<]*)<\/h1>/)?.[1],
    listed: html.includes("<li>A phone "),
    nameField: html.match(/<label>[^<]*<input name="label"[^>]*>/)?.[0],
    asksForASecond: html.includes("<strong>Add a second passkey</strong>"),
  }).toEqual({
    heading: "Your keys for example.com",
    listed: true,
    nameField:
      '<label>Name, optional <input name="label" maxlength="100" size="28" placeholder="such as YubiKey">',
    asksForASecond: true,
  });
});

test.for([
  { name: "no name", sent: {}, status: 200, kept: [DEFAULT_NAME] },
  { name: "a name of spaces", sent: { label: "   " }, status: 200, kept: [DEFAULT_NAME] },
  { name: "a name", sent: { label: " A phone " }, status: 200, kept: ["A phone"] },
  { name: "a name of 101 characters", sent: { label: "n".repeat(101) }, status: 400, kept: [] },
  { name: "a name that is no text", sent: { label: 7 }, status: 400, kept: [] },
])("a passkey sent with $name: status $status", async ({ sent, status, kept }) => {
  const { env, labels } = await stack();
  const cookie = await linkSession(env, "link-one");
  const answer = await posted(env, cookie, await challengeOf(env, cookie), sent);
  const said = (await answer.json()) as { label?: string };
  expect({
    status: answer.status,
    kept: labels(),
    // the answer names the key as it was kept, a default included
    answered: said.label ? [said.label] : [],
  }).toEqual({ status, kept, answered: kept });
});

// ./keys-pages.ts: someone who is no member adds a first passkey, to sign about themselves alone
test("someone who is no member, signed in by a code, adds one passkey and sees no key", async () => {
  const { env } = await stack();
  const visit = async (cookie: string) => {
    const page = await keysPagesResponse(
      env,
      new Request(`${ISSUER}/keys`, { headers: { cookie } }),
    );
    return { status: page!.status, heading: (await page!.text()).match(/<h1>([^<]*)<\/h1>/)?.[1] };
  };
  const cookie = await codeSession(env, "stranger@example.net");
  expect(await visit(cookie)).toEqual({ status: 200, heading: "Add your passkey to example.com" });
  const made = await posted(env, cookie, await challengeOf(env, cookie));
  expect(made).toMatchObject({ status: 200 });
  // with a passkey, neither its own session nor a new code's sees /keys
  const refused = { status: 403, heading: "You can't continue" };
  expect(await visit(made.headers.get("set-cookie")!.split(";")[0]!)).toEqual(refused);
  expect(await visit(await codeSession(env, "stranger@example.net"))).toEqual(refused);
});

// ../migrations/0016, the rule: a credential made while its owner was no member never becomes a
// member's. Mallory reads carol's mail for a day on a mind where anyone signs in, and adds a
// passkey. Weeks later an owner adds carol as a member.
test("a passkey that someone added as no member, its session and its grant are no member's once the address is a member, and the passkey signs nobody in", async () => {
  const { env, db } = await stack();
  const CAROL = "carol@example.net";
  const mailed = await codeSession(env, CAROL);
  const pair = await newPair();
  const made = await posted(env, mailed, await challengeOf(env, mailed), {}, pair);
  const sleeper = made.headers.get("set-cookie")!.split(";")[0]!;
  const at = (cookie: string) => new Request(`${ISSUER}/keys`, { headers: { cookie } });
  const held = await sessionOf(env, at(sleeper));
  // the mark is on the key, on the session it opened, and on a grant of that session
  expect({
    key: db.prepare("select outsider from keys where user_id = ?").all(`user-${CAROL}`),
    session: held,
    grant: newGrantProps(held!),
  }).toMatchObject({
    key: [{ outsider: 1 }],
    session: { method: "passkey", outsider: true },
    grant: { outsider: true },
  });
  db.prepare("insert into members (email, added_by, added_at) values (?, ?, ?)").run(
    CAROL,
    "owner@example.net",
    Date.now(),
  );
  // the session is nobody's now: /keys sends its browser to the sign-in
  const page = await keysPagesResponse(env, at(sleeper));
  expect({
    session: await sessionOf(env, at(sleeper)),
    keys: [page!.status, new URL(page!.headers.get("location")!).pathname],
  }).toEqual({ session: null, keys: [302, "/sign-in"] });
  expect(await signedIn(env, pair)).toEqual({
    status: 403,
    body: {
      error:
        "The passkey did not sign you in: it was added before its address was a member here. Sign in with a code by email or a member's link, and add a new passkey.",
    },
  });
});

// The other half of the rule: the outsider's passkey must not lock the real person out.
test("the member whose address held an outsider's passkey adds their own by a code, and that ends the outsider's", async () => {
  const { env, db } = await stack();
  const CAROL = "carol@example.net";
  const mallory = await codeSession(env, CAROL);
  await posted(env, mallory, await challengeOf(env, mallory));
  db.prepare("insert into members (email, added_by, added_at) values (?, ?, ?)").run(
    CAROL,
    "owner@example.net",
    Date.now(),
  );
  // carol's mailed code is taken, and an owner's link for her would be made
  expect({
    code: await addressProven(env, { id: `user-${CAROL}`, email: CAROL }, "/"),
    holdsPasskey: await memberHoldsPasskey(env, CAROL),
  }).toEqual({ code: { location: "/keys?next=%2F" }, holdsPasskey: false });
  const carol = await codeSession(env, CAROL);
  const page = await keysPagesResponse(
    env,
    new Request(`${ISSUER}/keys`, { headers: { cookie: carol } }),
  );
  expect((await page!.text()).match(/<h1>([^<]*)<\/h1>/)?.[1]).toBe(
    "Add your passkey to example.com",
  );
  expect(await added(env, carol, await challengeOf(env, carol))).toBe(200);
  expect(
    db
      .prepare(
        "select outsider, revoked_at is null as live from keys where user_id = ? order by added_at",
      )
      .all(`user-${CAROL}`),
  ).toEqual([
    { outsider: 1, live: 0 },
    { outsider: 0, live: 1 },
  ]);
  expect(await memberHoldsPasskey(env, CAROL)).toBe(true);
});

/** The session cookie a mailed code gives `email`'s browser (./email-sign-in.ts). */
async function codeSession(env: Env, email: string): Promise<string> {
  const user = { id: `user-${email}`, email };
  await env.DB.prepare("insert or ignore into users (id, email) values (?1, ?2)")
    .bind(user.id, email)
    .run();
  const { setCookie } = await sessionCookie(env, new Request(ISSUER), user, "email");
  return setCookie.split(";")[0]!;
}

/** The session cookie that spending a member's link, or the owner's ticket, gives a browser
 *  (./first-owner.ts). */
async function linkSession(env: Env, ticket: string): Promise<string> {
  const answer = await firstOwnerResponse(
    env,
    new Request(`${ISSUER}${FIRST_OWNER_PATH}`, {
      method: "POST",
      headers: { origin: ISSUER, "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    }),
  );
  expect(answer).toMatchObject({ status: 200 });
  return answer.headers.get("set-cookie")!.split(";")[0]!;
}

/** The challenge that /keys gives this session to make a passkey with. */
async function challengeOf(env: Env, cookie: string): Promise<string> {
  const page = await keysPagesResponse(env, new Request(`${ISSUER}/keys`, { headers: { cookie } }));
  return (await page!.text()).match(/data-challenge="([^"]+)"/)![1]!;
}

/** The status of a POST to /keys with a new P-256 key, as the page's script sends it. */
async function added(
  env: Env,
  cookie: string,
  challenge: string,
  named?: { label?: unknown },
): Promise<number> {
  return (await posted(env, cookie, challenge, named)).status;
}

type Pair = { keys: CryptoKeyPair; spki: Uint8Array; credentialId: string };

/** A passkey as an authenticator holds it: a P-256 pair and the credential's id. */
async function newPair(): Promise<Pair> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    keys,
    spki: new Uint8Array((await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer),
    credentialId: base64url(crypto.getRandomValues(new Uint8Array(16))),
  };
}

/** The answer of the passkey's sign-in (./passkey-sign-in.ts) to `pair`, an authenticator that
 *  checked the person: the challenge, then its signature. */
async function signedIn(env: Env, pair: Pair) {
  const post = (path: string, body: unknown) =>
    passkeySignInResponse(
      env,
      new Request(`${ISSUER}${path}`, {
        method: "POST",
        headers: { origin: ISSUER, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const asked = (await (await post("/sign-in/passkey/challenge", {}))!.json()) as {
    statement: string;
    challenge: string;
  };
  const encoder = new TextEncoder();
  const clientDataJSON = encoder.encode(
    JSON.stringify({ type: "webauthn.get", challenge: asked.challenge, origin: ISSUER }),
  );
  const digest = async (bytes: Uint8Array) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  // user present and user verified
  const authenticatorData = new Uint8Array([
    ...(await digest(encoder.encode(new URL(ISSUER).hostname))),
    0x05,
    0,
    0,
    0,
    1,
  ]);
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.keys.privateKey,
      new Uint8Array([...authenticatorData, ...(await digest(clientDataJSON))]),
    ),
  );
  const integer = (half: Uint8Array) => {
    let at = 0;
    while (at < half.length - 1 && half[at] === 0) at++;
    const bytes = half.subarray(at);
    const positive = bytes[0]! & 0x80 ? [0, ...bytes] : [...bytes];
    return [0x02, positive.length, ...positive];
  };
  const der = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  const answer = await post("/sign-in/passkey", {
    statement: asked.statement,
    credentialId: pair.credentialId,
    sig: base64url(new Uint8Array([0x30, der.length, ...der])),
    authenticatorData: base64url(authenticatorData),
    clientDataJSON: base64url(clientDataJSON),
  });
  return { status: answer!.status, body: await answer!.json() };
}

/** The answer to a POST to /keys with a new P-256 key, as the page's script sends it. `named`: the
 *  name it sends, which a test may leave out or make anything. `pair`: the passkey, when the test
 *  signs with it afterwards. */
async function posted(
  env: Env,
  cookie: string,
  challenge: string,
  named: { label?: unknown } = { label: "laptop" },
  pair?: Pair,
): Promise<Response> {
  const { spki, credentialId } = pair || (await newPair());
  const clientData = { type: "webauthn.create", origin: ISSUER, challenge };
  const answer = await keysPagesResponse(
    env,
    new Request(`${ISSUER}/keys`, {
      method: "POST",
      headers: { cookie, origin: ISSUER, "content-type": "application/json" },
      body: JSON.stringify({
        ...named,
        publicKey: base64url(spki),
        credentialId,
        clientDataJSON: base64url(new TextEncoder().encode(JSON.stringify(clientData))),
      }),
    }),
  );
  return answer!;
}

/** A stack in SQLite in memory, made by the Worker's own migrations, whose one member holds two
 *  unspent links. `passkeys` counts the member's live passkeys, and `labels` says their names. */
async function stack() {
  const db = new DatabaseSync(":memory:");
  const folder = new URL("../migrations/", import.meta.url).pathname;
  for (const name of readdirSync(folder).sort()) db.exec(readFileSync(`${folder}${name}`, "utf8"));
  const tickets = db.prepare(
    "insert into member_tickets (hash, email, made_by, expires_at) values (?, ?, 'owner@example.net', ?)",
  );
  for (const ticket of ["link-one", "link-two"])
    tickets.run(await sha256Hex(ticket), MEMBER, Date.now() + 3_600_000);
  const statementOf = (sql: string, bound: SQLInputValue[] = []) => {
    const execute = () => {
      const prepared = db.prepare(sql);
      if (prepared.columns().length) return { results: prepared.all(...bound), meta: {} };
      return { results: [], meta: { changes: Number(prepared.run(...bound).changes) } };
    };
    return {
      bind: (...values: SQLInputValue[]) => statementOf(sql, values),
      first: async () => execute().results[0] ?? null,
      all: async () => execute(),
      run: async () => execute(),
      execute,
    };
  };
  const kv = new Map<string, string>();
  const env = {
    DOMAIN,
    AUTH_SIGNING_KEY: "a-signing-key-for-tests-only",
    FIRST_OWNER_TICKET: JSON.stringify({
      email: "owner@example.net",
      hash: await sha256Hex(OWNERS_TICKET),
      expires: Date.now() + 3_600_000,
    }),
    AUTH_SETTINGS: JSON.stringify({
      login: { allow: [{ email: "owner@example.net" }, { email: MEMBER }] },
    }),
    DB: {
      prepare: (sql: string) => statementOf(sql),
      batch: async (statements: ReturnType<typeof statementOf>[]) =>
        statements.map((statement) => statement.execute()),
    },
    OAUTH_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    },
    // the cast: of D1 and KV, the pages call only these members
  } as unknown as Env;
  const passkeys = () =>
    db
      .prepare(
        `select count(*) as n from keys k join users u on u.id = k.user_id
         where u.email = ? and k.format = 'webauthn' and k.revoked_at is null`,
      )
      .get(MEMBER)!.n;
  const labels = () =>
    db
      .prepare(
        `select k.label from keys k join users u on u.id = k.user_id
         where u.email = ? and k.format = 'webauthn' and k.revoked_at is null`,
      )
      .all(MEMBER)
      .map((row) => row.label);
  return { env, db, passkeys, labels };
}
