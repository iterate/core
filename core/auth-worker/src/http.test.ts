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

// The page is the same on a mind where nobody has a passkey yet: its first owner follows the
// link below the passkey's button, to Cloudflare Access. A mailed code signs in no member, so
// the control plane's own sign-in offers none.
test.for([
  { name: "a mind where nobody has a passkey yet", passkey: false },
  { name: "a mind whose owner has a passkey", passkey: true },
])(
  "/sign-in on $name is the passkey's page, which asks as it opens, with the owner's link to Cloudflare Access below and no email address",
  async ({ passkey }) => {
    const { env, db } = sqliteStack();
    if (passkey) {
      db.exec("insert into users (id, email) values ('user_owner', 'owner@example.net')");
      db.exec(
        `insert into keys (id, user_id, public_key, format, label, added_via, added_by, added_at)
         values ('a-passkey', 'user_owner', 'a-public-key', 'webauthn', 'A phone', 'keys-page', 'user_owner', 0)`,
      );
    }
    const answer = await asked("/sign-in?next=%2Fkeys", {}, env);
    expect(answer).toMatchObject({ status: 200 });
    const html = await answer.text();
    expect(html).toContain(`<h1>Sign in to iterate.example.com</h1>`);
    expect(html).toContain("\nsignIn(false);");
    expect(html).toMatch(
      /<button type="submit">Sign in with a passkey<\/button>[^]*<p class="muted">An owner with no passkey yet: <a href="\/sign-in\/access\?next=%2Fkeys">prove your email address with Cloudflare<\/a>, and then add one.<\/p>/,
    );
    // nothing to type, and no way to a mailed code
    expect(html).not.toMatch(
      /type="email"|sign-in\/email|Sign in with your email address|class="or"/,
    );
    expect(html.match(/<form/g)).toHaveLength(1);
  },
);

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
  expect(html).toContain(`<button type="submit">Sign in with a passkey</button>`);
  expect(html).not.toContain("signIn(false)");
});

test.for([
  { name: "an authorization request", next: "/oauth2/auth?client_id=app&state=a+b%26c" },
  { name: "an outside URL", next: "https://elsewhere.test/return?state=a&next=/keys" },
  { name: "a protocol-relative URL", next: "//elsewhere.test/return" },
  { name: "header delimiters", next: "/keys\r\nLocation: https://elsewhere.test/" },
])(
  "the sign-in page keeps next as data, in its form and in its link to Cloudflare Access: $name",
  async ({ next }) => {
    const answer = await asked(`/sign-in?${new URLSearchParams({ next })}`);
    expect(answer).toMatchObject({ status: 200 });
    expect(answer.headers.get("location")).toBeNull();
    const html = await answer.text();
    const written = next.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
    expect(html).toContain(`data-next="${written}"`);
    expect(html).toContain(`<a href="/sign-in/access?${new URLSearchParams({ next })}">`);
  },
);

/** A signed-out request to the issuer, on a new stack or on `env`. */
function asked(path: string, init: RequestInit = {}, env: Env = sqliteStack().env) {
  return authResponse(new Request(`${ISSUER}${path}`, init), env, {} as ExecutionContext);
}
