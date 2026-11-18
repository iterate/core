// What a token of Cloudflare Access opens (./access-sign-in.ts), through the Worker's own router
// and SQL: for an owner with no passkey yet the one session that adds the first passkey, and for
// anything else nothing, with words that say what to do. The team's keys are read where the team
// publishes them: `fetch` answers that one address with this file's own key.
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { expect, test, vi } from "vitest";
import type { Env } from "./env.ts";
import { authResponse } from "./http.ts";
import { sqliteStack } from "./test-support.ts";

const ISSUER = "https://iterate.example.com";
const TEAM = "https://team.cloudflareaccess.com";
const KEY_ID = "the-teams-key";

const team = await generateKeyPair("RS256");
// a key that is not the team's, which names the team's key
const stranger = await generateKeyPair("RS256");
const teamKeySet = { keys: [{ ...(await exportJWK(team.publicKey)), kid: KEY_ID, alg: "RS256" }] };

test("a token for an owner with no passkey yet opens the session that adds the first passkey, and nothing else", async () => {
  const { env, db } = sqliteStack();
  const answer = await ask(env, "/sign-in/access", await tokenOf());
  expect({ status: answer.status, location: answer.headers.get("location") }).toEqual({
    status: 303,
    location: `/keys/first?next=${encodeURIComponent("https://example.com/")}`,
  });
  // the row's kind is this proof's own (./enrolment.ts `Proof`)
  expect(db.prepare("select method, key_id from browser_sessions").all()).toEqual([
    { method: "cloudflare-access", key_id: null },
  ]);
  const cookie = sessionCookieOf(answer);
  const form = await ask(env, "/keys/first", null, cookie);
  expect(await form.text()).toContain(`<button type="submit">Add a passkey</button>`);
  // to every other page the browser is signed out
  const keys = await ask(env, "/keys", null, cookie);
  expect(keys.headers.get("location")).toBe(`${ISSUER}/sign-in?next=%2Fkeys`);
});

test("the sign-in goes on to the `next` it was given, when that is an address of the mind's own", async () => {
  const { env } = sqliteStack();
  const locationFor = async (next: string) =>
    (
      await ask(env, `/sign-in/access?${new URLSearchParams({ next })}`, await tokenOf())
    ).headers.get("location");
  expect([
    await locationFor("https://dash.example.com/agents"),
    await locationFor("https://elsewhere.example.net/"),
  ]).toEqual([
    `/keys/first?next=${encodeURIComponent("https://dash.example.com/agents")}`,
    `/keys/first?next=${encodeURIComponent("https://example.com/")}`,
  ]);
});

test.for([
  {
    passkey: "has a passkey",
    removedAt: null,
    words:
      "owner@example.net has a passkey for iterate.example.com, so nothing else signs it in. Sign in with the passkey.",
  },
  {
    passkey: "had a passkey, which was removed",
    removedAt: 1,
    words:
      "owner@example.net had a passkey for iterate.example.com, so Cloudflare's proof of the address signs it in no more. An owner with no passkey left gets back in by the recovery command, which whoever holds this mind's Cloudflare account runs.",
  },
])(
  "an owner who $passkey is refused, with words that say what to do",
  async ({ removedAt, words }) => {
    const { env, db } = sqliteStack();
    db.exec("insert into users (id, email) values ('user_owner', 'owner@example.net')");
    db.prepare(
      `insert into keys (id, user_id, public_key, format, label, added_via, added_by, added_at, revoked_at)
       values ('a-passkey', 'user_owner', 'a-public-key', 'webauthn', 'A phone', 'keys-page', 'user_owner', 0, ?)`,
    ).run(removedAt);
    expect(await refusalOf(env, await tokenOf())).toEqual({ status: 403, words, session: "" });
  },
);

test.for<{ name: string; token: () => Promise<string> }>([
  {
    name: "a token for another application of the team",
    token: () => tokenOf({ aud: ["another-applications-audience-tag"] }),
  },
  {
    name: "a token of another team",
    token: () => tokenOf({ iss: "https://another-team.cloudflareaccess.com" }),
  },
  {
    name: "a token of the team's own session, not of an application",
    token: () => tokenOf({ type: "org" }),
  },
  {
    name: "a token that is not valid yet",
    token: () => tokenOf({ nbf: Math.floor(Date.now() / 1000) + 600 }),
  },
  { name: "a token with no end", token: () => tokenOf({ exp: undefined }) },
  {
    name: "a token with no email: a service token's",
    token: () => tokenOf({ email: undefined, common_name: "a-service-token" }),
  },
  {
    name: "a token that another key signed under the team's key id",
    token: () => tokenOf({}, stranger.privateKey),
  },
  {
    name: "a token with a changed byte",
    token: async () => {
      const [header, payload, signature] = (await tokenOf()).split(".");
      const changed = payload!.replace(/.$/, (last) => (last === "A" ? "B" : "A"));
      return [header, changed, signature].join(".");
    },
  },
  {
    name: "a token signed with a shared secret, not with the team's key",
    token: () =>
      new SignJWT(claimsOf({}))
        .setProtectedHeader({ alg: "HS256", kid: KEY_ID })
        .sign(new TextEncoder().encode("a secret that anyone may know, of 32 bytes")),
  },
  { name: "text that is no token", token: async () => "not.a.token" },
])("$name is no proof that Cloudflare Access made for this mind", async ({ token }) => {
  const { env, db } = sqliteStack();
  expect(await refusalOf(env, await token())).toEqual({
    status: 403,
    words:
      "This is no proof of an email address that Cloudflare Access made for iterate.example.com. Sign in again.",
    session: "",
  });
  expect(db.prepare("select count(*) as sessions from browser_sessions").get()).toEqual({
    sessions: 0,
  });
});

test.for<{ name: string; token: () => Promise<string | null>; words: string }>([
  {
    name: "no token",
    token: async () => null,
    words:
      "Cloudflare Access sent no proof of an email address with this request, so it signs nobody in. Sign in with your passkey.",
  },
  {
    name: "a token that is over",
    token: () => tokenOf({ exp: Math.floor(Date.now() / 1000) - 60 }),
    words: "Cloudflare's proof of your email address is over. Sign in again.",
  },
  {
    name: "a token for an address that is no owner's",
    token: () => tokenOf({ email: "member@example.net" }),
    words:
      "member@example.net is not an owner of iterate.example.com, and Cloudflare Access signs in an owner alone. Sign in with your passkey.",
  },
  {
    // an added member is no owner: an owner's sign-in link is that member's way in
    name: "a token for an added member's address",
    token: () => tokenOf({ email: "added@example.net" }),
    words:
      "added@example.net is not an owner of iterate.example.com, and Cloudflare Access signs in an owner alone. Sign in with your passkey.",
  },
  {
    name: "a token for an owner's address with a tag",
    token: () => tokenOf({ email: "owner+tag@example.net" }),
    words:
      "owner+tag@example.net is not an owner of iterate.example.com, and Cloudflare Access signs in an owner alone. Sign in with your passkey.",
  },
])("$name is refused, and the page says what to do", async ({ token, words }) => {
  const { env, db } = sqliteStack();
  db.exec(
    "insert into members (email, added_by, added_at) values ('added@example.net', 'owner@example.net', 0)",
  );
  expect(await refusalOf(env, await token())).toEqual({ status: 403, words, session: "" });
  expect(db.prepare("select count(*) as sessions from browser_sessions").get()).toEqual({
    sessions: 0,
  });
});

test.for([
  { name: "the sign-in page", path: "/sign-in", method: "GET" },
  { name: "the first passkey's page", path: "/keys/first", method: "GET" },
  { name: "a path under the application's", path: "/sign-in/access/", method: "GET" },
  { name: "a POST to the application's path", path: "/sign-in/access", method: "POST" },
])("a good token on $name opens nothing: it counts on one path alone", async ({ path, method }) => {
  const { env, db } = sqliteStack();
  const answer = await ask(env, path, await tokenOf(), "", method);
  expect(answer).not.toMatchObject({ status: 303 });
  expect(sessionCookieOf(answer)).toBe("");
  expect(db.prepare("select count(*) as sessions from browser_sessions").get()).toEqual({
    sessions: 0,
  });
});

test("the sign-in page has an owner's link to Cloudflare Access, with where the sign-in goes on", async () => {
  const page = await ask(sqliteStack().env, "/sign-in?next=%2Fkeys", null);
  expect(await page.text()).toContain(
    `An owner with no passkey yet: <a href="/sign-in/access?next=%2Fkeys">prove your email address with Cloudflare</a>, and then add one.`,
  );
});

/** What Cloudflare Access puts in an application's token for a person's sign-in, with `over` in
 *  place of its claims: an `undefined` leaves a claim out. */
function claimsOf(over: JWTPayload): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: ["the-audience-tag-of-the-owners-application"],
    email: "owner@example.net",
    exp: now + 900,
    iat: now,
    nbf: now,
    iss: TEAM,
    type: "app",
    sub: "a-person-of-the-team",
    ...over,
  };
}

const tokenOf = (over: JWTPayload = {}, key = team.privateKey) =>
  new SignJWT(claimsOf(over)).setProtectedHeader({ alg: "RS256", kid: KEY_ID }).sign(key);

/** One request to the Worker, with `token` as Cloudflare Access sends it on. The team's keys are
 *  at the one address that the team publishes them at. */
function ask(env: Env, path: string, token: string | null, cookie = "", method = "GET") {
  vi.stubGlobal("fetch", async (address: string | URL) => {
    expect(String(address)).toBe(`${TEAM}/cdn-cgi/access/certs`);
    return Response.json(teamKeySet);
  });
  const headers = new Headers({ cookie });
  if (token) headers.set("cf-access-jwt-assertion", token);
  return authResponse(
    new Request(`${ISSUER}${path}`, { method, headers }),
    env,
    // the cast: these pages hand the runtime nothing to keep alive
    {} as ExecutionContext,
  );
}

const sessionCookieOf = (answer: Response) =>
  answer.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]!)
    .find((cookie) => cookie.startsWith("__Host-iterate-auth-session=")) || "";

/** The refusal's page for `token` on the application's path: its words, and no session. */
async function refusalOf(env: Env, token: string | null) {
  const answer = await ask(env, "/sign-in/access", token);
  const html = (await answer.text()).replaceAll(/&#(\d+);/g, (_all, code) =>
    String.fromCharCode(Number(code)),
  );
  return {
    status: answer.status,
    words: html.match(/<h1>You can't continue<\/h1><p>([^<]*)<\/p>/)?.[1],
    session: sessionCookieOf(answer),
  };
}
