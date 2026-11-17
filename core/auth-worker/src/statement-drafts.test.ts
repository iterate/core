import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { base64url, challengeOf, keyIdOf, statementText } from "iterate/signed";
import { expect, test } from "vitest";
import type { Env } from "./env.ts";
import { proposeStatement, statementDraftsResponse } from "./statement-drafts.ts";

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
          source: { signer: { principal: { email: MEMBER }, key: passkeys[MEMBER].id } },
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
    body: { refused: `${STRANGER} is not a member here, so its key signs nothing` },
  });
  expect(await pressed(env, draft, passkeys[MEMBER])).toMatchObject({ status: 200 });
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
 *  may spoil, signed by `passkey` as an authenticator that checked the person. */
async function pressed(
  env: Env,
  draft: string,
  passkey: Passkey,
  changed: { payload?: Record<string, unknown> } = {},
): Promise<Response> {
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
  const answer = await statementDraftsResponse(
    env,
    new Request(`${ISSUER}/statements/sign`, {
      method: "POST",
      headers: { origin: ISSUER, "content-type": "application/json" },
      body: JSON.stringify({
        draft,
        statement,
        credentialId: passkey.credentialId,
        sig: base64url(derOf(raw)),
        authenticatorData: base64url(authenticatorData),
        clientDataJSON: base64url(clientDataJSON),
      }),
    }),
  );
  return answer!;
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
