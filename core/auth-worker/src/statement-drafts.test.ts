import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { base64url, challengeOf, keyIdOf, statementText } from "iterate/signed";
import { expect, test } from "vitest";
import type { Env } from "./env.ts";
import { proposeStatement, statementDraftsResponse } from "./statement-drafts.ts";
import { OUTSIDER_STATEMENTS_AN_HOUR, statementsResponse } from "./statements.ts";

const DOMAIN = "example.com";
const ISSUER = `https://iterate.${DOMAIN}`;
const MEMBER = "owner@example.net";
const STRANGER = "stranger@example.net";
const TYPE = "demo/statement-asked";
const PAYLOAD = { append: ["/minds/example.org/"], note: "<b>bold</b>" };

test("a proposed draft is shown on its page, every value as text", async () => {
  const { env } = await stack();
  const { draft, signAt } = await proposed(env, { from: "/agents/<onboarding>" });
  expect(signAt).toBe(`${ISSUER}/statements/sign?draft=${draft}`);
  const page = await statementDraftsResponse(env, new Request(signAt));
  const html = await page!.text();
  expect(page!).toMatchObject({ status: 200 });
  expect(html).toContain("/minds/example.com");
  expect(html).toContain(TYPE);
  expect(html).toContain("Asked by <code>/agents/&#60;onboarding&#62;</code>");
  expect(html).toContain("&#60;b&#62;bold&#60;/b&#62;");
  expect(html).not.toContain("<b>bold");
});

test("a member's press lands the event with the member as its signer, and the draft is gone", async () => {
  const { env, passkeys } = await stack();
  const { draft } = await proposed(env, { next: `https://dash.${DOMAIN}/` });
  const answer = await pressed(env, draft, passkeys[MEMBER]);
  expect(answer).toMatchObject({ status: 200 });
  expect(await answer.json()).toMatchObject({
    path: "/minds/example.com",
    type: TYPE,
    next: `https://dash.${DOMAIN}/`,
  });
  expect(decodeFacts(answer.headers.get(FACTS_HEADER) || "")).toMatchObject([
    {
      path: "/minds/example.com",
      storeFirst: true,
      events: [
        {
          type: TYPE,
          payload: PAYLOAD,
          source: {
            signer: { principal: { email: MEMBER }, key: passkeys[MEMBER].id, member: true },
          },
        },
      ],
    },
  ]);
  // a second press finds no draft, and adds nothing
  const again = await pressed(env, draft, passkeys[MEMBER]);
  expect({ status: again.status, facts: again.headers.get(FACTS_HEADER) }).toEqual({
    status: 404,
    facts: null,
  });
  const page = await statementDraftsResponse(
    env,
    new Request(`${ISSUER}/statements/sign?draft=${draft}`),
  );
  expect(page!).toMatchObject({ status: 404 });
});

test("a statement that differs from the draft is refused", async () => {
  const { env, passkeys } = await stack();
  const { draft } = await proposed(env);
  const answer = await pressed(env, draft, passkeys[MEMBER], { payload: { append: ["/"] } });
  expect({ status: answer.status, body: await answer.json() }).toEqual({
    status: 403,
    body: { refused: "the statement is not the one this link shows" },
  });
});

test("a non-member's passkey adds nothing, and the draft waits on", async () => {
  const { env, passkeys } = await stack();
  const { draft } = await proposed(env);
  const answer = await pressed(env, draft, passkeys[STRANGER]);
  expect({ status: answer.status, body: await answer.json() }).toEqual({
    status: 403,
    body: {
      refused: `${STRANGER} is not a member here, so its key signs only at its own context, /people/${STRANGER}`,
    },
  });
  expect(await pressed(env, draft, passkeys[MEMBER])).toMatchObject({ status: 200 });
});

// ./keys.ts `personKeyRefusal`: someone who is no member signs a statement about themselves alone.
test("someone who is no member signs at their own context, and at another person's is refused", async () => {
  const { env, passkeys } = await stack();
  const at = async (path: string) => {
    const { draft } = await proposed(env, { path });
    const answer = await pressed(env, draft, passkeys[STRANGER], { path });
    return { status: answer.status, facts: decodeFacts(answer.headers.get(FACTS_HEADER) || "") };
  };
  expect(await at(`/people/${STRANGER}`)).toMatchObject({
    status: 200,
    facts: [
      {
        path: `/people/${STRANGER}`,
        events: [
          // the stamp says that no member signed: a reader cannot take this for a member's word
          { type: TYPE, source: { signer: { principal: { email: STRANGER }, member: false } } },
        ],
      },
    ],
  });
  expect(await at(`/people/${MEMBER}`)).toEqual({ status: 403, facts: [] });
  expect(await at(`/people/${STRANGER}/inbox`)).toEqual({ status: 403, facts: [] });
});

// The stranger here holds a passkey from when the address was a member's, as a removed member
// does: on every mind, such a key signs at its own context alone, like any non-member's.
const OWN = `/people/${STRANGER}`;

test.for([
  ["another context", "/agents/one", TYPE],
  ["their address in capitals", `/people/${STRANGER.toUpperCase()}`, TYPE],
  ["their context with a slash after it", `${OWN}/`, TYPE],
  ["their address with %40", `/people/${STRANGER.replace("@", "%40")}`, TYPE],
  [
    "a type of the platform's, at their own context",
    OWN,
    "events.iterate.com/account/member-added",
  ],
] as const)(
  "someone who is no member, with no draft, adds nothing at %s",
  async ([, path, type]) => {
    const { env, passkeys } = await stack();
    expect(await sent(env, passkeys[STRANGER], { path, type })).toMatchObject({
      status: 403,
      facts: [],
    });
    expect(await sent(env, passkeys[STRANGER], { path: OWN })).toMatchObject({ status: 200 });
  },
);

test("a blocked person's passkey signs nothing, with a draft or without, until an owner unblocks them", async () => {
  const { env, db, passkeys } = await stack();
  db.prepare("insert into blocked (email, blocked_by, blocked_at) values (?, ?, ?)").run(
    STRANGER,
    MEMBER,
    Date.now(),
  );
  const refusal = { refused: `${STRANGER} is blocked here, so its key signs nothing` };
  const { draft } = await proposed(env, { path: OWN });
  const press = await pressed(env, draft, passkeys[STRANGER], { path: OWN });
  expect({
    pressed: [press.status, await press.json()],
    sent: await sent(env, passkeys[STRANGER], { path: OWN }),
  }).toEqual({ pressed: [403, refusal], sent: { status: 403, body: refusal, facts: [] } });
  db.prepare("delete from blocked").run();
  expect(await sent(env, passkeys[STRANGER], { path: OWN })).toMatchObject({ status: 200 });
});

test("what someone who is no member signs is at most 64 KiB, and a member's is not bounded here", async () => {
  const { env, passkeys } = await stack();
  const big = { path: OWN, payload: { text: "x".repeat(64 * 1024) } };
  expect(await sent(env, passkeys[STRANGER], big)).toEqual({
    status: 413,
    body: {
      refused:
        "a statement of someone who is no member here holds a payload of at most 64 KiB of JSON",
    },
    facts: [],
  });
  expect(await sent(env, passkeys[MEMBER], big)).toMatchObject({ status: 200 });
});

test("one key of someone who is no member signs a bounded number of statements an hour; the same one again is taken", async () => {
  const { env, passkeys } = await stack();
  const numbered = (n: number) => sent(env, passkeys[STRANGER], { path: OWN, payload: { n } });
  const first = await signedBy(passkeys[STRANGER], { path: OWN });
  const envelope = {
    statement: first.statement,
    signature: { format: "webauthn", key: passkeys[STRANGER].id, ...first.signature },
  };
  const statuses = [(await posted(env, envelope)).status];
  for (let n = 1; n < OUTSIDER_STATEMENTS_AN_HOUR; n++) statuses.push((await numbered(n)).status);
  expect(new Set(statuses)).toEqual(new Set([200]));
  // at the bound, a statement that came before is taken again: a sender that got no 200 sends it
  // again, and the log keeps its event once
  expect(await posted(env, envelope)).toMatchObject({ status: 200 });
  expect(await numbered(OUTSIDER_STATEMENTS_AN_HOUR)).toEqual({
    status: 429,
    body: {
      refused: `this key signed ${OUTSIDER_STATEMENTS_AN_HOUR} statements in the last hour, the most for someone who is no member here. Try again later`,
    },
    facts: [],
  });
  // a member's key is not counted
  for (let n = 0; n <= OUTSIDER_STATEMENTS_AN_HOUR; n++)
    await sent(env, passkeys[MEMBER], { path: OWN, payload: { n } });
  expect(await sent(env, passkeys[MEMBER], { path: OWN })).toMatchObject({ status: 200 });
});

test("a member signs at someone else's own context too", async () => {
  const { env, passkeys } = await stack();
  const path = `/people/${STRANGER}`;
  const { draft } = await proposed(env, { path });
  expect(await pressed(env, draft, passkeys[MEMBER], { path })).toMatchObject({ status: 200 });
});

test("a mind meld is a member's alone, at a non-member's own context too", async () => {
  const { env, passkeys } = await stack();
  const changed = { path: `/people/${STRANGER}`, type: "events.iterate.com/mind-meld/configured" };
  const { draft } = await proposed(env, changed);
  const answer = await pressed(env, draft, passkeys[STRANGER], changed);
  expect({ status: answer.status, body: await answer.json() }).toEqual({
    status: 403,
    body: { refused: "only a member's passkey sets a mind meld" },
  });
});

test("a draft that names its signer shows them, and takes their passkey alone", async () => {
  const { env, passkeys } = await stack();
  const path = `/people/${STRANGER}`;
  // the agent may write the address as the mail did: the draft keeps the one path that signs
  const { draft, signAt } = await proposed(env, {
    path: `/people/${STRANGER.toUpperCase()}`,
    signerEmail: ` ${STRANGER.toUpperCase()}`,
  });
  const html = await (await statementDraftsResponse(env, new Request(signAt)))!.text();
  expect(html).toContain(`Only <code>${STRANGER}</code> can sign it.`);
  // a person with no passkey yet goes to /keys, and through the sign-in page if signed out
  expect(html).toContain(
    `<a href="/keys?next=%2Fstatements%2Fsign%3Fdraft%3D${draft}">Sign in and add one</a>`,
  );
  const byMember = await pressed(env, draft, passkeys[MEMBER], { path });
  expect({ status: byMember.status, body: await byMember.json() }).toEqual({
    status: 403,
    body: { refused: `only ${STRANGER} signs this statement` },
  });
  expect(await pressed(env, draft, passkeys[STRANGER], { path })).toMatchObject({ status: 200 });
});

test("an expired draft has ended", async () => {
  const { env, db, passkeys } = await stack();
  const { draft } = await proposed(env);
  db.prepare("update statement_drafts set expires = ?").run(Date.now() - 1);
  const page = await statementDraftsResponse(
    env,
    new Request(`${ISSUER}/statements/sign?draft=${draft}`),
  );
  expect(page!).toMatchObject({ status: 404 });
  expect(await page!.text()).toContain("This link has ended");
  expect(await pressed(env, draft, passkeys[MEMBER])).toMatchObject({ status: 404 });
});

test.for([
  ["a platform type", { type: "events.iterate.com/account/member-added" }],
  ["a path with a dot segment", { path: "/integrations/../secrets" }],
  ["a payload that is a list", { payload: [] as unknown as Record<string, unknown> }],
  ["a next on another host", { next: "https://evil.example/" }],
  ["a next that is no https URL", { next: `http://dash.${DOMAIN}/` }],
] as const)("a draft with %s is refused", async ([, input]) => {
  const { env } = await stack();
  await expect(proposed(env, input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

function proposed(env: Env, input: Partial<Parameters<typeof proposeStatement>[1]> = {}) {
  return proposeStatement(env, {
    path: "/minds/example.com",
    type: TYPE,
    payload: PAYLOAD,
    ...input,
  });
}

/** The page's press, as its script sends it: a statement of the draft's values, which `changed`
 *  may spoil or must match when the draft has its own, signed by `passkey` as an authenticator
 *  that checked the person. */
async function pressed(
  env: Env,
  draft: string,
  passkey: Passkey,
  changed: Changed = {},
): Promise<Response> {
  const { statement, signature } = await signedBy(passkey, changed);
  const answer = await statementDraftsResponse(
    env,
    new Request(`${ISSUER}/statements/sign`, {
      method: "POST",
      headers: { origin: ISSUER, "content-type": "application/json" },
      body: JSON.stringify({ draft, statement, credentialId: passkey.credentialId, ...signature }),
    }),
  );
  return answer!;
}

/** What `POST /statements` answers to a statement that `passkey` signed, with no draft: the status,
 *  the body and the facts. */
async function sent(env: Env, passkey: Passkey, changed: Changed = {}) {
  const { statement, signature } = await signedBy(passkey, changed);
  return posted(env, {
    statement,
    signature: { format: "webauthn", key: passkey.id, ...signature },
  });
}

/** What `POST /statements` answers to `envelope`, which a test may send twice. */
async function posted(env: Env, envelope: unknown) {
  const answer = await statementsResponse(
    env,
    new Request(`${ISSUER}/statements`, { method: "POST", body: JSON.stringify(envelope) }),
  );
  return {
    status: answer.status,
    body: await answer.json(),
    facts: decodeFacts(answer.headers.get(FACTS_HEADER) || ""),
  };
}

type Changed = { payload?: Record<string, unknown>; path?: string; type?: string };

/** A statement of the draft's values, which `changed` replaces, and `passkey`'s signature of it. */
async function signedBy(passkey: Passkey, changed: Changed) {
  const now = Date.now();
  const statement = statementText({
    mind: DOMAIN,
    path: "/minds/example.com",
    type: TYPE,
    payload: PAYLOAD,
    ...changed,
    at: now,
    expires: now + 5 * 60_000,
  });
  const encoder = new TextEncoder();
  const clientDataJSON = encoder.encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: await challengeOf(statement),
      origin: ISSUER,
    }),
  );
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(new URL(ISSUER).hostname)),
  );
  // user present and user verified
  const authenticatorData = new Uint8Array([...rpIdHash, 0x05, 0, 0, 0, 1]);
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      passkey.privateKey,
      new Uint8Array([...authenticatorData, ...clientDataHash]),
    ),
  );
  return {
    statement,
    signature: {
      sig: base64url(derOf(raw)),
      authenticatorData: base64url(authenticatorData),
      clientDataJSON: base64url(clientDataJSON),
    },
  };
}

function derOf(raw: Uint8Array): Uint8Array {
  const integer = (half: Uint8Array) => {
    let at = 0;
    while (at < half.length - 1 && half[at] === 0) at++;
    const bytes = half.subarray(at);
    const positive = bytes[0]! & 0x80 ? [0, ...bytes] : [...bytes];
    return [0x02, positive.length, ...positive];
  };
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

type Passkey = { id: string; credentialId: string; privateKey: CryptoKey };

/** A stack in SQLite in memory, made by the Worker's own migrations. The config makes one address
 *  a member; each address holds a passkey. */
async function stack() {
  const db = new DatabaseSync(":memory:");
  const folder = new URL("../migrations/", import.meta.url).pathname;
  for (const name of readdirSync(folder).sort()) db.exec(readFileSync(`${folder}${name}`, "utf8"));
  const passkeys = {} as Record<typeof MEMBER | typeof STRANGER, Passkey>;
  for (const email of [MEMBER, STRANGER] as const) {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = base64url(
      new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer),
    );
    const passkey = {
      id: await keyIdOf(publicKey),
      credentialId: `credential-of-${email}`,
      privateKey: pair.privateKey,
    };
    db.prepare("insert into users (id, email) values (?, ?)").run(`user-${email}`, email);
    db.prepare(
      `insert into keys (id, user_id, public_key, format, credential_id, label, added_via, added_by, added_at)
       values (?, ?, ?, 'webauthn', ?, 'a passkey', 'test', ?, ?)`,
    ).run(
      passkey.id,
      `user-${email}`,
      publicKey,
      passkey.credentialId,
      `user-${email}`,
      Date.now(),
    );
    passkeys[email] = passkey;
  }
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
  const env = {
    DOMAIN,
    AUTH_SETTINGS: JSON.stringify({ login: { allow: [{ email: MEMBER }] } }),
    DB: {
      prepare: (sql: string) => statementOf(sql),
      batch: async (statements: ReturnType<typeof statementOf>[]) =>
        statements.map((statement) => statement.execute()),
    },
    // the cast: of D1, the drafts call only these members
  } as unknown as Env;
  return { env, db, passkeys };
}
