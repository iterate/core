// /sessions and the browser's session it lists (./cookies.ts): a session is its row, and a
// person ends their own alone.
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { SignJWT } from "jose";
import { expect, test } from "vitest";
import { AccountFacts } from "./account-facts.ts";
import { browserSessionsFake } from "./browser-sessions-fake.ts";
import { endSessions, sessionCookie, sessionOf } from "./cookies.ts";
import type { Env } from "./env.ts";
import { browserNameOf, sessionsResponse } from "./sessions-page.ts";
import { signOutResponse } from "./sign-in.ts";

const DOMAIN = "example.com";
const ISSUER = `https://iterate.${DOMAIN}`;
const SIGNING_KEY = "a-signing-key-for-tests-only";
const OWNER = { id: "user_owner", email: "owner@example.net" };
const ADA = { id: "user_ada", email: "ada@example.org" };
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

test("a browser is named by its browser and its system, and a string it does not know is a browser", () => {
  expect(
    [
      MAC_CHROME,
      IPHONE_SAFARI,
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
      // Playwright's headless Chromium
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
      "curl/8.7.1",
      "",
    ].map(browserNameOf),
  ).toEqual([
    "Chrome on macOS",
    "Safari on iPhone",
    "Edge on Windows",
    "Firefox on Linux",
    "Chrome on Android",
    "Safari on macOS",
    "Chrome on Linux",
    "A browser",
    "A browser",
  ]);
});

test("a cookie is a session only while its row is there, not ended, not expired, and its passkey not removed", async () => {
  const { env, sessions, revoked } = stackOf();
  const made = await signedIn(env, OWNER, "passkey");
  expect(await sessionOf(env, at(made.cookie))).toMatchObject({
    id: made.session,
    userId: OWNER.id,
    method: "passkey",
  });
  // no session id, and an id with no row: each is no session, though the key signed it
  expect(await sessionOf(env, at(await forged({ email: OWNER.email })))).toBeNull();
  const unknown = await forged({ email: OWNER.email, session: "session_gone" });
  expect(await sessionOf(env, at(unknown))).toBeNull();

  const expired = await signedIn(env, ADA, "email");
  sessions.rows.get(expired.session)!.expires_at = Date.now() - 1;
  expect(await sessionOf(env, at(expired.cookie))).toBeNull();

  const ended = await signedIn(env, ADA, "email");
  await endSessions(env, ADA.id, { session: ended.session }, new AccountFacts());
  expect(await sessionOf(env, at(ended.cookie))).toBeNull();

  revoked.add("key-1");
  expect(await sessionOf(env, at(made.cookie))).toBeNull();
});

test("a person ends their own browser's session here, and another person's ends nothing", async () => {
  const { env, sessions } = stackOf();
  const here = await signedIn(env, ADA, "email");
  const phone = await signedIn(env, ADA, "email", IPHONE_SAFARI);
  const owners = await signedIn(env, OWNER, "passkey");
  const end = (fields: Record<string, string>) =>
    sessionsResponse(env, post(here.cookie, fields)) as Promise<Response>;

  const refused = await end({ session: owners.session });
  expect(refused).toMatchObject({ status: 303 });
  expect(sessions.rows.get(owners.session)!.ended_at).toBeNull();

  const answer = await end({ session: phone.session });
  expect(answer.headers.get("location")).toBe("/sessions");
  expect(sessions.rows.get(phone.session)!.ended_at).not.toBeNull();
  expect(decodeFacts(answer.headers.get(FACTS_HEADER)!)).toMatchObject([
    {
      path: `/users/${ADA.id}`,
      events: [
        { type: "events.iterate.com/account/session-ended", payload: { session: phone.session } },
      ],
    },
  ]);
  // this browser's own is ended by the sign-out, never by this form
  await end({ session: here.session });
  expect(await sessionOf(env, at(here.cookie))).not.toBeNull();

  const laptop = await signedIn(env, ADA, "email");
  await end({ others: "1" });
  expect(sessions.rows.get(laptop.session)!.ended_at).not.toBeNull();
  expect(sessions.rows.get(here.session)!.ended_at).toBeNull();
  expect(sessions.rows.get(owners.session)!.ended_at).toBeNull();

  // only from this origin's own page
  const elsewhere = post(here.cookie, { others: "1" }, "https://evil.test");
  expect(await sessionsResponse(env, elsewhere)).toMatchObject({ status: 403 });

  // the sign-out on this browser's row ends its row with its cookie
  const out = new Request(`${ISSUER}/sign-out`, {
    method: "POST",
    headers: { cookie: here.cookie, origin: ISSUER },
    body: new FormData(),
  });
  expect(await signOutResponse(env, out)).toMatchObject({ status: 303 });
  expect(sessions.rows.get(here.session)!.ended_at).not.toBeNull();
});

test("sign-out clears the cookie when D1 fails: the row is not ended, and the cookie is cleared all the same", async () => {
  const { env } = stackOf();
  const here = await signedIn(env, ADA, "email");
  const fails = () => {
    throw new Error("D1_ERROR: the database is unavailable");
  };
  const broken = { ...env, DB: { prepare: fails, batch: fails } } as unknown as Env;
  const answer = await signOutResponse(
    broken,
    new Request(`${ISSUER}/sign-out`, {
      method: "POST",
      headers: { cookie: here.cookie, origin: ISSUER },
      body: new FormData(),
    }),
  );
  expect(answer).toMatchObject({ status: 303 });
  expect(answer.headers.get("location")).toBe("/");
  expect(answer.headers.getSetCookie()).toContainEqual(
    expect.stringMatching(/^__Host-iterate-auth-session=; .*Max-Age=0/),
  );
});

test("the page lists a member's and a non-member's own browsers, this one marked, and nobody else's", async () => {
  const { env } = stackOf();
  const owner = await signedIn(env, OWNER, "passkey");
  await signedIn(env, OWNER, "passkey", IPHONE_SAFARI);
  const ada = await signedIn(env, ADA, "email");

  const ownersPage = await pageOf(env, owner.cookie);
  expect(ownersPage).toContain("Chrome on macOS");
  expect(ownersPage).toContain("Safari on iPhone");
  expect(ownersPage).toContain(`data-session="${owner.session}" data-current`);
  expect(ownersPage).toContain("End all other browsers");
  expect(ownersPage).toContain("Apps and tools signed in as you");
  expect(ownersPage).not.toContain(ada.session);

  // a person who is no member sees their own one browser, and no key and no member
  const adasPage = await pageOf(env, ada.cookie);
  expect(adasPage).toContain("signed in with a mailed code");
  expect(adasPage).toContain("(this browser)");
  expect(adasPage).not.toContain("End all other browsers");
  expect(adasPage).not.toMatch(/Safari on iPhone|passkey|Members/);

  // signed out: the sign-in, which comes back here
  const signedOut = (await sessionsResponse(env, new Request(`${ISSUER}/sessions`)))!;
  expect(signedOut.headers.get("location")).toBe("/sign-in?next=%2Fsessions");
});

const at = (cookie: string) => new Request(ISSUER, { headers: { cookie } });

const post = (cookie: string, fields: Record<string, string>, origin = ISSUER) =>
  new Request(`${ISSUER}/sessions`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

async function pageOf(env: Env, cookie: string) {
  const answer = await sessionsResponse(
    env,
    new Request(`${ISSUER}/sessions`, { headers: { cookie } }),
  );
  return answer!.text();
}

async function signedIn(
  env: Env,
  user: { id: string; email: string },
  method: "passkey" | "email",
  userAgent = MAC_CHROME,
) {
  const request = new Request(ISSUER, { headers: { "user-agent": userAgent } });
  const { setCookie, session } = await sessionCookie(
    env,
    request,
    user,
    method,
    method === "passkey" ? "key-1" : undefined,
  );
  return { cookie: setCookie.split(";")[0]!, session };
}

/** A cookie that the signing key signed, with the claims given: what a script that holds the key
 *  could make. */
async function forged(claims: Record<string, unknown>) {
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience("session")
    .setSubject(OWNER.id)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SIGNING_KEY));
  return `__Host-iterate-auth-session=${token}`;
}

/** The owner is the config's member and holds the passkey "key-1"; Ada is no member. No app holds
 *  a sign-in as anyone. */
function stackOf() {
  const revoked = new Set<string>();
  const sessions = browserSessionsFake((key) => !revoked.has(key));
  const prepare = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async () => {
      const session = sessions.statementOf(sql, bound);
      if (session) return session.first();
      // nobody was added as a member, and nobody is blocked
      if (sql.includes("from members") || sql.includes("from blocked")) return null;
      throw new Error(`not expected: ${sql}`);
    },
    all: async () => {
      const session = sessions.statementOf(sql, bound);
      if (session) return session.all();
      throw new Error(`not expected: ${sql}`);
    },
    results: () => sessions.statementOf(sql, bound)!.results(),
  });
  const env = {
    DOMAIN,
    AUTH_SIGNING_KEY: SIGNING_KEY,
    AUTH_SETTINGS: JSON.stringify({ login: { allow: [{ email: OWNER.email }] } }),
    DB: {
      prepare,
      batch: async (statements: ReturnType<typeof prepare>[]) =>
        statements.map((statement) => statement.results()),
    },
    OAUTH_KV: {
      list: async () => ({ keys: [], list_complete: true }),
      get: async () => null,
    },
    // the cast: the page reads these bindings and no other
  } as unknown as Env;
  return { env, sessions, revoked };
}
