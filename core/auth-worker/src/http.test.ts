import { expect, test } from "vitest";
import type { Env } from "./env.ts";
import { authResponse } from "./http.ts";
import { sqliteStack } from "./test-support.ts";

const ISSUER = "https://iterate.example.com";

test("the control-plane hostname has no start page: `/` leads a visitor to the mind's Dash", async () => {
  for (const method of ["GET", "HEAD"]) {
    const answer = await asked("/", { method });
    expect(answer).toMatchObject({ status: 302 });
    expect(Object.fromEntries(answer.headers)).toMatchObject({
      location: "https://dash.example.com/",
      "cache-control": "no-store",
    });
  }
});

test("a control plane at the Dash's own address never redirects `/` back to itself: it leads to `/sessions`", async () => {
  const { env } = sqliteStack({ controlPlaneHostname: "dash.example.com" });
  const answer = await authResponse(new Request("https://dash.example.com/"), env, {
    waitUntil: () => {},
  } as unknown as ExecutionContext);
  expect({ status: answer.status, location: answer.headers.get("location") }).toEqual({
    status: 302,
    location: "/sessions",
  });
});

test("a control plane at its zone's apex still leads `/` to the mind's Dash", async () => {
  const { env } = sqliteStack({ controlPlaneHostname: "example.com" });
  const answer = await authResponse(new Request("https://example.com/"), env, {
    waitUntil: () => {},
  } as unknown as ExecutionContext);
  expect({ status: answer.status, location: answer.headers.get("location") }).toEqual({
    status: 302,
    location: "https://dash.example.com/",
  });
});

test("a request for any other hostname is not this Worker's", async () => {
  const answer = await authResponse(
    new Request("https://example.com/sign-in"),
    sqliteStack().env,
    {} as ExecutionContext,
  );
  expect(answer).toMatchObject({ status: 404 });
});

// A mailed code signs in no member, so the control plane's own sign-in offers none.
test("/sign-in on a mind whose owner has a passkey is the passkey's page, which asks as it opens, with the owner's link to Cloudflare Access below and no email address", async () => {
  const { env, db } = sqliteStack();
  db.exec("insert into users (id, email) values ('user_owner', 'owner@example.net')");
  db.exec(
    `insert into keys (id, user_id, public_key, format, label, added_via, added_by, added_at)
     values ('a-passkey', 'user_owner', 'a-public-key', 'webauthn', 'A phone', 'keys-page', 'user_owner', 0)`,
  );
  const html = await signInHtml(env, "/sign-in?next=%2Fkeys");
  expect(html).toContain(`<h1>Sign in to iterate.example.com</h1>`);
  expect(html).toContain("\nsignIn(false);");
  expect(html).toMatch(
    /<button type="submit">Sign in with a passkey<\/button>[^]*<p class="muted">An owner with no passkey yet: <a href="\/sign-in\/access\?next=%2Fkeys">prove your email address with Cloudflare<\/a>, and then add one.<\/p>/,
  );
  // nothing to type, and no way to a mailed code
  expect(html).not.toMatch(
    /type="email"|sign-in\/email|Sign in with your email address|class="or"|Set up your first passkey/,
  );
  expect(html.match(/<form/g)).toHaveLength(1);
  // a passkey that was removed is still one that a browser may hold: the page stays the same
  db.exec("update keys set revoked_at = 1");
  expect(await signInHtml(env, "/sign-in?next=%2Fkeys")).toBe(html);
});

test("/sign-in on a mind where nobody ever had a passkey asks the browser for none as it opens: the owner's way to the first passkey is the main button, and the passkey's button is below", async () => {
  const { env, db } = sqliteStack();
  // a passkey that was added while its owner was no member is none
  db.exec("insert into users (id, email) values ('user_guest', 'guest@example.net')");
  db.exec(
    `insert into keys (id, user_id, public_key, format, label, added_via, added_by, added_at, outsider)
     values ('a-passkey', 'user_guest', 'a-public-key', 'webauthn', 'A phone', 'keys-page', 'user_guest', 0, 1)`,
  );
  const html = await signInHtml(env, "/sign-in?next=%2Fkeys");
  expect(html).toContain(`<h1>Sign in to iterate.example.com</h1>`);
  expect(html).not.toContain("signIn(false)");
  expect(html).toMatch(
    /<form method="get" action="\/sign-in\/access" class="stack">\s*<input type="hidden" name="next" value="\/keys">\s*<button type="submit">Set up your first passkey<\/button>\s*<\/form><p class="or">or<\/p>\s*<form id="passkey" class="stack" data-next="\/keys">\s*<button type="submit" class="secondary">Sign in with a passkey<\/button>/,
  );
  expect(html).not.toMatch(/type="email"|sign-in\/email|An owner with no passkey yet/);
  // a person who signed out reads the same page
  expect(await signInHtml(env, "/sign-in?next=%2Fkeys&signed-out=1")).toBe(html);
});

test("a person who signed out is not asked for a passkey as the page opens: the sign-out's link says so, with a way back and with none", async () => {
  const signedOut = async (form: Record<string, string>) => {
    const out = await asked("/sign-out", {
      method: "POST",
      headers: { origin: ISSUER },
      body: new URLSearchParams(form),
    });
    return out.headers.get("location");
  };
  // the way back is the whole address that was checked
  expect(await signedOut({ next: "/sessions" })).toBe(
    `/sign-in?next=${encodeURIComponent(`${ISSUER}/sessions`)}&signed-out=1`,
  );
  expect(await signedOut({ next: "//evil.example/" })).toBe("/sign-in?next=%2F&signed-out=1");
  // the button on /sessions names no way back: the sign-in for the start page, which waits too
  expect(await signedOut({})).toBe("/sign-in?next=%2F&signed-out=1");
  const html = await (await asked("/sign-in?next=%2Fsessions&signed-out=1")).text();
  expect(html).toContain(`>Sign in with a passkey</button>`);
  expect(html).not.toContain("signIn(false)");
});

test.for([
  { name: "an authorization request", next: "/oauth2/auth?client_id=app&state=a+b%26c" },
  { name: "an outside URL", next: "https://elsewhere.test/return?state=a&next=/keys" },
  { name: "a protocol-relative URL", next: "//elsewhere.test/return" },
  { name: "header delimiters", next: "/keys\r\nLocation: https://elsewhere.test/" },
])(
  "the sign-in page keeps next as data, in its form and in its form for Cloudflare Access: $name",
  async ({ next }) => {
    const answer = await asked(`/sign-in?${new URLSearchParams({ next })}`);
    expect(answer).toMatchObject({ status: 200 });
    expect(answer.headers.get("location")).toBeNull();
    const html = await answer.text();
    const written = next.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
    expect(html).toContain(`data-next="${written}"`);
    expect(html).toContain(
      `<form method="get" action="/sign-in/access" class="stack">\n        <input type="hidden" name="next" value="${written}">`,
    );
  },
);

/** The page that a signed-out browser reads at `path`, without the nonce of its one load. */
async function signInHtml(env: Env, path: string) {
  const answer = await asked(path, {}, env);
  expect(answer).toMatchObject({ status: 200 });
  return (await answer.text()).replace(/ nonce="[^"]*"/g, "");
}

/** A signed-out request to the issuer, on a new stack or on `env`. */
function asked(path: string, init: RequestInit = {}, env: Env = sqliteStack().env) {
  return authResponse(new Request(`${ISSUER}${path}`, init), env, {} as ExecutionContext);
}
