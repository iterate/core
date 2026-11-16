import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { base64url } from "iterate/signed";
import { expect, test } from "vitest";
import { FIRST_OWNER_PATH } from "./config.ts";
import { sha256Hex } from "./device/protocol.ts";
import type { Env } from "./env.ts";
import { firstOwnerResponse } from "./first-owner.ts";
import { statementInParts } from "./key-rules.ts";
import { keysPagesResponse, statementHtml } from "./keys-pages.ts";

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
      "example.com needs a passkey at your first sign-in. From then on it is how you sign in here, and how you approve what your agents ask for.",
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

/** The answer to a POST to /keys with a new P-256 key, as the page's script sends it. `named`: the
 *  name it sends, which a test may leave out or make anything. */
async function posted(
  env: Env,
  cookie: string,
  challenge: string,
  named: { label?: unknown } = { label: "laptop" },
): Promise<Response> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
  );
  const clientData = { type: "webauthn.create", origin: ISSUER, challenge };
  const answer = await keysPagesResponse(
    env,
    new Request(`${ISSUER}/keys`, {
      method: "POST",
      headers: { cookie, origin: ISSUER, "content-type": "application/json" },
      body: JSON.stringify({
        ...named,
        publicKey: base64url(spki),
        credentialId: base64url(crypto.getRandomValues(new Uint8Array(16))),
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
  return { env, passkeys, labels };
}
