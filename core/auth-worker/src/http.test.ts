import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import type { Env } from "./env.ts";
import { authResponse } from "./http.ts";

const env = withKeys([{ format: "webauthn", revokedAt: null }]);

test("the platform's host has no start page: `/` leads a signed-out visitor to the Dash", async () => {
  for (const method of ["GET", "HEAD"]) {
    const answer = await authResponse(
      new Request("https://iterate.example.com/", { method }),
      env,
      {} as ExecutionContext,
    );
    expect(answer).toMatchObject({ status: 302 });
    expect(Object.fromEntries(answer.headers)).toMatchObject({
      location: "https://dash.example.com/",
      "cache-control": "no-store",
    });
  }
});

test("with an active passkey, the mind's own sign-in is the passkey's page: one button, an ask as the page opens, and the mailed code behind one link", async () => {
  const answer = await asked("/sign-in?next=%2Fkeys");
  expect(answer).toMatchObject({ status: 200 });
  const html = await answer.text();
  expect(html).toContain(`<h1>Sign in to example.com</h1>`);
  expect(html).toContain(`<button type="submit">Sign in with a passkey</button>`);
  expect(html).toContain("\nsignIn(false);");
  expect(html).toContain(
    `<a href="/sign-in/email?next=%2Fkeys">No passkey on this device? Get a code by email</a>`,
  );
  // nothing to type and no rule on sign-ups: those are on the code's page
  expect(html).not.toMatch(/type="email"|sign-ups|class="or"/);
});

test("a mind that mails no code and offers Google has no link to a code, and Google's button under the passkey's", async () => {
  const login = { methods: { google: {} }, allow: [{ email: "owner@example.net" }] };
  const html = await (
    await asked("/sign-in?next=%2Fkeys", login, { CLOUD_ORIGIN: "https://cloud.example.org" })
  ).text();
  expect(html).toContain("\nsignIn(false);");
  expect(html).toMatch(
    /<button type="submit">Sign in with a passkey<\/button>[^]*<p class="or">or<\/p>[^]*<form method="get" action="\/sign-in\/google"[^]*Sign in with Google<\/button>/,
  );
  expect(html).not.toContain("code by email");
});

test("a person who signed out is not asked for a passkey as the page opens: the sign-out's link says so, with a way back and with none", async () => {
  const signedOut = async (form: Record<string, string>) => {
    const out = await authResponse(
      new Request("https://iterate.example.com/sign-out", {
        method: "POST",
        headers: { origin: "https://iterate.example.com" },
        body: new URLSearchParams(form),
      }),
      env,
      {} as ExecutionContext,
    );
    return out.headers.get("location");
  };
  expect(await signedOut({ next: "/sessions" })).toBe("/sign-in?next=%2Fsessions&signed-out=1");
  // the button on /sessions names no way back: the sign-in for the start page, which waits too
  expect(await signedOut({})).toBe("/sign-in?next=%2F&signed-out=1");
  const html = await (await asked("/sign-in?next=%2Fsessions&signed-out=1")).text();
  expect(html).toContain(`<button type="submit">Sign in with a passkey</button>`);
  expect(html).not.toContain("signIn(false)");
});

test.for([
  {
    open: "its mailed code goes to anyone",
    login: { methods: { email: { anyone: true } }, allow: [{ email: "owner@example.net" }] },
  },
  {
    open: "its rule admits everyone",
    login: { methods: { email: {} }, allow: [{ everyone: {} }] },
  },
])(
  "a stack where anyone may sign in ($open) asks for the passkey too at the mind's own sign-in: a member comes there",
  async ({ login }) => {
    const answer = await asked("/sign-in?next=%2Fkeys", login);
    expect(answer).toMatchObject({ status: 200 });
    const html = await answer.text();
    expect(html).toContain("\nsignIn(false);");
    expect(html).toContain(`<a href="/sign-in/email?next=%2Fkeys">`);
  },
);

test.for([
  { name: "no keys and mailed codes", keys: [], mailsCodes: true, status: 302 },
  {
    name: "the last passkey was revoked",
    keys: [{ format: "webauthn", revokedAt: 1 }],
    mailsCodes: true,
    status: 302,
  },
  {
    name: "an active service key is no passkey",
    keys: [{ format: "p256", revokedAt: null }],
    mailsCodes: true,
    status: 302,
  },
  {
    name: "a revoked passkey and an active service key",
    keys: [
      { format: "webauthn", revokedAt: 1 },
      { format: "p256", revokedAt: null },
    ],
    mailsCodes: true,
    status: 302,
  },
  {
    name: "an active passkey keeps the passkey page",
    keys: [{ format: "webauthn", revokedAt: null }],
    mailsCodes: true,
    status: 200,
  },
  { name: "no keys but no mailed codes", keys: [], mailsCodes: false, status: 200 },
])("the mind's first sign-in: $name", async ({ keys, mailsCodes, status }) => {
  const stack = withKeys(keys);
  const answer = await asked(
    "/sign-in?next=%2Fkeys",
    { methods: mailsCodes ? { email: {} } : {}, allow: [{ email: "owner@example.net" }] },
    { DB: stack.DB },
  );
  expect(answer).toMatchObject({ status });
  expect(answer.headers.get("location")).toBe(
    status === 302 ? "https://iterate.example.com/sign-in/email?next=%2Fkeys" : null,
  );
});

test.for([
  { name: "an authorization request", next: "/oauth2/auth?client_id=app&state=a+b%26c" },
  { name: "an outside URL", next: "https://elsewhere.test/return?state=a&next=/keys" },
  { name: "a protocol-relative URL", next: "//elsewhere.test/return" },
  { name: "header delimiters", next: "/keys\r\nLocation: https://elsewhere.test/" },
])("the first-code redirect keeps next as data on its own code page: $name", async ({ next }) => {
  const answer = await asked(`/sign-in?${new URLSearchParams({ next })}`, undefined, {
    DB: withKeys([]).DB,
  });
  expect(answer).toMatchObject({ status: 302 });
  // Exact encoding keeps the return address in a query value, even when it names another origin.
  expect(answer.headers.get("location")).toBe(
    `https://iterate.example.com/sign-in/email?${new URLSearchParams({ next })}`,
  );
});

/** A signed-out GET of the issuer, on a stack with these sign-in rules (by default `env`'s) and
 *  these bindings beside them. */
function asked(path: string, login?: object, bound: Partial<Env> = {}) {
  const settings = login ? { AUTH_SETTINGS: JSON.stringify({ login, keys: [] }) } : {};
  return authResponse(
    new Request(`https://iterate.example.com${path}`),
    // the bindings a sign-in page reads, not a whole stack's
    { ...env, ...settings, ...bound } as Env,
    {} as ExecutionContext,
  );
}

/** The sign-in query runs on SQLite with the Worker's schema and these stored keys. */
function withKeys(keys: { format: string; revokedAt: number | null }[]): Env {
  const db = new DatabaseSync(":memory:");
  const folder = new URL("../migrations/", import.meta.url).pathname;
  for (const name of readdirSync(folder).sort()) db.exec(readFileSync(`${folder}${name}`, "utf8"));
  db.exec("insert into users (id, email) values ('test-user', 'owner@example.net')");
  const insert = db.prepare(`
    insert into keys (id, user_id, actor, paths, public_key, format, label, added_via, added_by, added_at, revoked_at)
    values (?, ?, ?, '[]', 'test-public-key', ?, 'test key', 'test', 'test-user', 0, ?)
  `);
  for (const [index, key] of keys.entries())
    insert.run(
      `test-key-${index}`,
      key.format === "webauthn" ? "test-user" : null,
      key.format === "webauthn" ? null : "test-service",
      key.format,
      key.revokedAt,
    );
  // These requests read only prepare().first() of D1; no other bindings are used.
  return {
    DOMAIN: "example.com",
    AUTH_SETTINGS: JSON.stringify({
      login: { methods: { email: {} }, allow: [{ email: "owner@example.net" }] },
      keys: [],
    }),
    DB: { prepare: (sql: string) => ({ first: async () => db.prepare(sql).get() ?? null }) },
  } as unknown as Env;
}
