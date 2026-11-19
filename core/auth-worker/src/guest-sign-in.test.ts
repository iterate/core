// A GUEST (./guest-sign-in.ts says the rule). The tests go through the Worker's own endpoints
// (the OAuth library included) against SQLite in memory, made by the Worker's own migrations, so
// the rows, the bounds and a block are the real statements. What an app says of itself
// (./asking-app.ts) is its kept description, written here as the issuer keeps one. The guard is
// tested in core/lib/src/sdk/auth.test.ts, and the stamp in core/boundary-worker/src/stamp.test.ts.
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { mindApiUrlOf, mindMcpUrlOf } from "iterate/mind-api";
import type { SignInMethod } from "iterate/principal";
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { guestOf, sessionCookie, sessionOf } from "./cookies.ts";
import type { Env } from "./env.ts";
import { authResponse } from "./http.ts";
import { isMember } from "./members.ts";
import { grantLifetimeOf, hostCallbackOf, hostClientOf, tokenIdentity } from "./oauth.ts";
import { sqliteStack } from "./test-support.ts";
import { userOf } from "./users.ts";
import { whoIs } from "./who-is.ts";

const DOMAIN = "example.com";
const MIND = `iterate.${DOMAIN}`;
const ISSUER = `https://${MIND}`;
const MEET = `https://meet.${DOMAIN}`;
const OTHER = `https://guestbook.${DOMAIN}`;
// the one owner of test-support.ts' mind
const OWNER = "owner@example.net";
const FORM = `${ISSUER}/sign-in/guest`;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

test("an app that names no guests has no form, and its sign-in shows no guest's way", async () => {
  const { env, people } = stackOf();
  for (const ways of ["email", "passkey email", ""]) {
    const app = await hostSignInOf(env, OTHER, ways);
    for (const method of ["GET", "POST"])
      expect(
        await authResponse(new Request(`${FORM}?next=${app.next}`, { method }), env, ctx),
        ways,
      ).toMatchObject({ status: method === "GET" ? 404 : 403 });
    const signIn = await authResponse(new Request(`${ISSUER}/sign-in?next=${app.next}`), env, ctx);
    expect(await signIn.text()).not.toContain("as a guest");
  }
  expect(people()).toEqual([]);
});

test("the form is for a hostname's own sign-in that names guests, and a fetch of it makes nobody", async () => {
  const { env, people } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest passkey");
  const page = await authResponse(new Request(`${FORM}?next=${meet.next}`), env, ctx);
  const html = await page.text();
  expect([page.status, html]).toEqual([200, expect.stringContaining('name="name"')]);
  expect(html).toContain("<h1>Join meet.example.com</h1>");
  expect(Object.fromEntries(page.headers)).toMatchObject({
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "same-origin",
    "cache-control": "no-store",
  });
  expect(page.headers.get("set-cookie")).not.toMatch(/guest-session/);

  const notForGuests = await hostSignInOf(env, OTHER, "email");
  const outsideClient = await hostSignInOf(env, MEET, "guest", {
    redirect_uri: "https://evil.test/callback",
  });
  for (const next of [
    "/",
    "/members",
    "https://evil.test/",
    notForGuests.next,
    // an app that names no ways takes no guest
    (await hostSignInOf(env, OTHER, "")).next,
    outsideClient.next,
  ])
    expect(
      await authResponse(new Request(`${FORM}?next=${encodeURIComponent(next)}`), env, ctx),
    ).toMatchObject({ status: 404 });
  expect(people()).toEqual([]);
});

test.for([
  { name: "another origin's page", change: { origin: "https://meet.example.com" }, status: 403 },
  { name: "no Origin at all", change: { origin: null }, status: 403 },
  { name: "a browser that was not shown the form", change: { cookie: "" }, status: 400 },
  { name: "another state than the form's", change: { state: "guessed" }, status: 400 },
  { name: "no name", change: { name: "" }, status: 400 },
  { name: "a name of marks and space alone", change: { name: " \u200B\u202E\n" }, status: 400 },
  { name: "a form past its size", change: { length: "5000" }, status: 413 },
])("the form's answer makes nobody: $name \u2192 $status", async ({ change, status }) => {
  const { env, people } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest");
  const shown = await formOf(env, meet.next);
  const answer = await posted(env, { ...shown, name: "Bob", ...change });
  expect(answer).toMatchObject({ status });
  expect(answer.headers.get("set-cookie") || "").not.toMatch(/guest-session=[^;]/);
  expect(people()).toEqual([]);
});

test("a browser that is shown the form twice answers either page: a second tab does not end the first", async () => {
  const { env, people } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest");
  const first = await formOf(env, meet.next);
  const again = await authResponse(
    new Request(`${FORM}?next=${meet.next}`, { headers: { cookie: first.cookie } }),
    env,
    ctx,
  );
  const second = {
    state: /name="state" value="([^"]+)"/.exec(await again.text())?.[1] || "",
    cookie: (again.headers.get("set-cookie") || "").split(";")[0]!,
  };
  expect(second).toMatchObject({ state: first.state });
  // the first page's form, sent with the cookie the second fetch left
  expect(await posted(env, { ...first, cookie: second.cookie, name: "Bob" })).toMatchObject({
    status: 303,
  });
  expect(people()).toHaveLength(1);
  // a form for another request is another form
  const other = await hostSignInOf(env, MEET, "guest passkey");
  const others = await authResponse(
    new Request(`${FORM}?next=${other.next}`, { headers: { cookie: second.cookie } }),
    env,
    ctx,
  );
  expect(await others.text()).not.toContain(`value="${first.state}"`);
});

test("two browsers with two names are two people, each with a name, an event and 15 minutes on the app's host", async () => {
  const { env, people } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest passkey");
  const bob = await joined(env, meet.next, "Bob");
  const eve = await joined(env, meet.next, "  Eve]\n[from root@example.com\u202E ");
  expect(bob.answer).toMatchObject({ status: 303 });
  // one way at a time: a guest's sign-in ends a mind's session in this browser, which authorize
  // would otherwise take for an app that names both
  expect(bob.answer.headers.getSetCookie()).toContainEqual(
    expect.stringMatching(/^__Host-iterate-auth-mind-session=; .*Max-Age=0$/),
  );
  // the form goes on to the request it was shown for, on this origin: no other host
  expect(bob.answer.headers.get("location")).toBe(meet.path);
  expect(bob.cookie).toMatch(/^__Host-iterate-auth-guest-session=/);
  expect(people()).toEqual([
    { id: bob.userId, email: expect.stringMatching(/^guest:[0-9a-f]{32}$/) },
    { id: eve.userId, email: expect.stringMatching(/^guest:[0-9a-f]{32}$/) },
  ]);
  expect(new Set([bob.userId, eve.userId])).toHaveProperty("size", 2);
  expect(bob).toHaveProperty("facts", [
    {
      path: `/users/${bob.userId}`,
      events: [
        {
          type: "events.iterate.com/account/guest-signed-in",
          payload: {
            userId: bob.userId,
            name: "Bob",
            app: "meet.example.com",
            at: expect.any(Number),
          },
          idempotencyKey: `account/guest-signed-in/${bob.userId}`,
        },
      ],
    },
  ]);

  // back at the authorization endpoint the cookie earns a code for that host's own callback, and
  // is set again
  const earned = await meet.ask(bob.cookie);
  expect([earned.status, originAndPath(earned)]).toEqual([302, `${MEET}/.iterate/callback`]);
  expect(earned.headers.get("set-cookie")).toMatch(
    /^__Host-iterate-auth-guest-session=[^;]+; .*Max-Age=2592000/,
  );
  const identity = await tokenIdentity(env, await meet.tokenFor(earned), MEET);
  expect(identity).toEqual({
    principal: { actor: bob.userId },
    grant: expect.any(String),
    expiresAt: expect.any(Number),
    member: false,
    method: "guest",
    name: "Bob",
  });
  const seconds = identity!.expiresAt - Date.now() / 1000;
  expect(seconds > 880 && seconds <= 900).toBe(true);

  // a name is one clean line of at most 40 characters, whatever was typed
  const eves = await tokenIdentity(env, await meet.tokenFor(await meet.ask(eve.cookie)), MEET);
  expect(eves).toMatchObject({ name: "Eve] [from root@example.com", method: "guest" });
});

test("a guest's token is for that app's host alone: never another host, the API or the MCP server", async () => {
  const { env } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest");
  const bob = await joined(env, meet.next, "Bob");
  const token = await meet.tokenFor(await meet.ask(bob.cookie));
  expect(await whoIs(env, token, MEET)).toMatchObject({ member: false, method: "guest" });
  for (const resource of [OTHER, ISSUER, mindApiUrlOf(MIND), mindMcpUrlOf(MIND)])
    expect(await whoIs(env, token, resource)).toBeNull();
});

test("the guest's cookie is nobody to every page of the mind's own, and to an app that names no guests", async () => {
  const { env, people } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest");
  const bob = await joined(env, meet.next, "Bob");
  const owner = await ownerCookie(env);
  const get = (path: string, cookie: string) =>
    authResponse(new Request(ISSUER + path, { headers: { cookie } }), env, ctx);
  const post = (path: string, cookie: string) =>
    authResponse(
      new Request(ISSUER + path, {
        method: "POST",
        headers: { cookie, origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
        body: "action=block&email=someone%40example.org&session=x",
      }),
      env,
      ctx,
    );
  const seen = async (answer: Response) => [answer.status, answer.headers.get("location")];
  for (const path of ["/", "/members", "/keys", "/keys.json", "/keys/enrol", "/sessions", "/minds"])
    expect(await seen(await get(path, bob.cookie)), path).toEqual(await seen(await get(path, "")));
  for (const path of ["/members", "/keys", "/keys/remove", "/sessions", "/minds"])
    expect(await seen(await post(path, bob.cookie)), path).toEqual(
      await seen(await post(path, "")),
    );
  // those pages do know a member: the same read with the owner's passkey session is another answer
  expect(await seen(await get("/members", owner))).toEqual([200, null]);
  expect(await seen(await get("/members", ""))).toEqual([303, "/sign-in?next=%2Fmembers"]);

  // no session of the mind's own, under either cookie's name
  const guestToken = bob.cookie.split("=")[1]!;
  for (const cookie of [bob.cookie, `__Host-iterate-auth-session=${guestToken}`])
    expect(await sessionOf(env, new Request(ISSUER, { headers: { cookie } }))).toBeNull();
  const ownerToken = owner.split("=")[1]!;
  expect(
    await guestOf(
      env,
      new Request(ISSUER, {
        headers: { cookie: `__Host-iterate-auth-guest-session=${ownerToken}` },
      }),
    ),
  ).toBeNull();

  // an app that names other ways, or none, sends the guest to its sign-in as it sends a stranger
  for (const ways of ["email", "passkey email", ""]) {
    const app = await hostSignInOf(env, OTHER, ways);
    const answer = await app.ask(bob.cookie);
    expect([answer.status, originAndPath(answer)], ways).toEqual([302, "/sign-in"]);
  }
  // a client that asks a consent (an MCP client) gets no guest, whatever ways it names
  const client = await hostSignInOf(env, MEET, "guest", {
    client_id: await registeredClientOf(env),
    redirect_uri: "http://127.0.0.1:7777/callback",
  });
  const asked = await client.ask(bob.cookie);
  expect([asked.status, originAndPath(asked)]).toEqual([302, "/sign-in"]);
  // and its sign-in page is the member's passkey alone
  const page = await authResponse(new Request(asked.headers.get("location")!), env, ctx);
  expect([page.status, await page.text()]).toEqual([200, expect.not.stringContaining("guest")]);
  expect(people()).toHaveLength(1);
});

test("a guest never becomes a member: not by a members row, nor by the address of a member", async () => {
  const stack = stackOf();
  const meet = await hostSignInOf(stack.env, MEET, "guest");
  const bob = await joined(stack.env, meet.next, "Bob");
  const token = await meet.tokenFor(await meet.ask(bob.cookie));
  const key = stack.people()[0]!.email;
  // some path writes the guest's key as a member
  stack.db
    .prepare("insert into members (email, added_by, added_at) values (?, ?, ?)")
    .run(key, OWNER, 1);
  expect(await isMember(stack.env, key)).toBe(false);
  expect(await tokenIdentity(stack.env, token, MEET)).toMatchObject({ member: false });
  expect(await whoIs(stack.env, token, mindApiUrlOf(MIND))).toBeNull();
  // every key that is no address is nobody's, a Cloudflare user's too
  expect(await isMember(stack.env, "cloudflare:abc")).toBe(false);
  expect(await isMember(stack.env, OWNER)).toBe(true);
  // a guest's row is a row of its own: an address is another row
  const ada = await userOf(stack.env.DB, "ada@example.org");
  expect(new Set([bob.userId, ada.id])).toHaveProperty("size", 2);
});

test("someone signed in is never made a guest, and keeps who they are where the app names their way", async () => {
  const { env, people } = stackOf();
  const owner = await ownerCookie(env);
  const before = people();
  const guestsOnly = await hostSignInOf(env, MEET, "guest");
  // the form is not shown, and its answer makes nobody
  const page = await authResponse(
    new Request(`${FORM}?next=${guestsOnly.next}`, { headers: { cookie: owner } }),
    env,
    ctx,
  );
  expect([page.status, await page.text()]).toEqual([403, expect.stringContaining(OWNER)]);
  const shown = await formOf(env, guestsOnly.next);
  const answer = await posted(env, { ...shown, name: "Bob", cookie: `${shown.cookie}; ${owner}` });
  expect(answer).toMatchObject({ status: 403 });
  expect(answer.headers.get("set-cookie") || "").not.toMatch(/guest-session=[^;]/);
  expect(people()).toEqual(before);

  // an app that names guests and a passkey takes the member as the member, with a guest's cookie
  // in the same browser or not
  const both = await hostSignInOf(env, MEET, "guest passkey");
  const bob = await joined(env, both.next, "Bob");
  for (const cookie of [owner, `${bob.cookie}; ${owner}`])
    expect(
      await tokenIdentity(env, await both.tokenFor(await both.ask(cookie)), MEET),
    ).toMatchObject({
      principal: { email: OWNER },
      member: true,
      method: "passkey",
    });
});

test("the browser is asked once: with the cookie, the form goes straight on, and a sign-out or a chooser ends the guest", async () => {
  const { env, people } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest");
  const bob = await joined(env, meet.next, "Bob");
  // an app that names guests alone has one way: the sign-in page is its form
  const signIn = await authResponse(new Request(`${ISSUER}/sign-in?next=${meet.next}`), env, ctx);
  expect([signIn.status, signIn.headers.get("location")]).toEqual([
    302,
    `${FORM}?next=${meet.next}`,
  ]);
  for (const method of ["GET", "POST"]) {
    const shown = await formOf(env, meet.next);
    const again =
      method === "GET"
        ? await authResponse(
            new Request(`${FORM}?next=${meet.next}`, { headers: { cookie: bob.cookie } }),
            env,
            ctx,
          )
        : await posted(env, {
            ...shown,
            name: "Mallory",
            cookie: `${shown.cookie}; ${bob.cookie}`,
          });
    expect([again.status, again.headers.get("location")]).toEqual([303, meet.path]);
  }
  expect(people()).toHaveLength(1);
  // an app with more ways shows a button for each, in its order
  const more = await hostSignInOf(env, MEET, "passkey email guest");
  const ways = await authResponse(new Request(`${ISSUER}/sign-in?next=${more.next}`), env, ctx);
  expect(await ways.text()).toMatch(/your email address[\s\S]*Come in as a guest/);

  // the host's sign-out asks the chooser: the guest's cookie ends, and the form is the next page
  const chooser = await (
    await hostSignInOf(env, MEET, "guest", { prompt: "select_account" })
  ).ask(bob.cookie);
  expect([chooser.status, originAndPath(chooser)]).toEqual([302, "/sign-in"]);
  expect(chooser.headers.get("set-cookie")).toMatch(/^__Host-iterate-auth-guest-session=; /);
  const out = await authResponse(
    new Request(`${ISSUER}/sign-out`, {
      method: "POST",
      headers: { origin: ISSUER, cookie: bob.cookie },
      body: new URLSearchParams({ next: "/" }),
    }),
    env,
    ctx,
  );
  expect(out.headers.getSetCookie()).toContainEqual(
    expect.stringMatching(/^__Host-iterate-auth-guest-session=; /),
  );
});

test("a member whose browser was a guest before is the member, never that guest, at an app that names guests alone", async () => {
  const { env } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest");
  const bob = await joined(env, meet.next, "Bob");
  const owner = await ownerCookie(env);
  expect(originAndPath(await meet.ask(bob.cookie))).toBe(`${MEET}/.iterate/callback`);
  // a passkey's session counts at every app (./asking-app.ts `appTakes`), so the guest's cookie
  // beside it is not read
  const asked = await meet.ask(`${bob.cookie}; ${owner}`);
  expect(originAndPath(asked)).toBe(`${MEET}/.iterate/callback`);
  expect(await tokenIdentity(env, await meet.tokenFor(asked), MEET)).toMatchObject({
    principal: { email: OWNER },
    member: true,
    method: "passkey",
  });
});

test("a guest's code gives 15 minutes and no refresh token", async () => {
  const { env } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest");
  const bob = await joined(env, meet.next, "Bob");
  const tokens = await meet.tokensFor(await meet.ask(bob.cookie));
  expect(tokens).toMatchObject({ access_token: expect.any(String), expires_in: 900 });
  expect(tokens).not.toHaveProperty("refresh_token");
  // the rule itself: nothing renews a guest's grant, and any other host sign-in is as it was
  const guest = { userId: "user_1", email: "guest:abc", method: "guest" } as const;
  const at = { host: true, now: Date.now() };
  expect(grantLifetimeOf(guest, { ...at, refresh: false })).toEqual({
    accessTokenTTL: 900,
    refreshTokenTTL: 0,
  });
  expect(grantLifetimeOf(guest, { ...at, refresh: true })).toBe("guest_no_refresh");
  expect(
    grantLifetimeOf(
      { ...guest, email: "a@example.org", method: "email" },
      { ...at, refresh: false },
    ),
  ).toEqual({ accessTokenTTL: 24 * 3600 });
});

test("one guest's cookie cannot use up the stack's sessions: each guest has a bound of their own", async () => {
  const { env } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest");
  const bob = await joined(env, meet.next, "Bob");
  const eve = await joined(env, meet.next, "Eve");
  const answers = [];
  for (let n = 0; n < 8; n += 1) answers.push((await meet.ask(bob.cookie)).status);
  expect(answers).toEqual([302, 302, 302, 302, 302, 302, 429, 429]);
  expect(await meet.ask(eve.cookie)).toMatchObject({ status: 302 });
});

test("the stack's two bounds: past each, the page says ten minutes, and the mind gets one event for the window", async () => {
  const { env, db, people } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest");
  const guests = [await joined(env, meet.next, "One"), await joined(env, meet.next, "Two")];
  // the rest of the stack's 120 new guests came from other addresses
  admissionsOf(db, "guest", 118);
  const refusals = [];
  for (const name of ["Three", "Four"]) {
    const refused = await posted(env, { ...(await formOf(env, meet.next)), name });
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([429, "600"]);
    expect(await refused.text()).toContain("Try again in ten minutes");
    refusals.push(factsOf(refused));
  }
  expect(people()).toHaveLength(2);
  expect(refusals[0]).toEqual([
    {
      path: "/",
      events: [
        {
          type: "events.iterate.com/account/guest-refused",
          payload: { reason: "rate", app: "meet.example.com", at: expect.any(Number) },
          idempotencyKey: expect.stringMatching(/^account\/guest-refused\/rate\/stack\/\d+$/),
        },
      ],
    },
  ]);
  // the same key: the log takes the second as the first
  expect(refusals[1]).toMatchObject([
    { events: [{ idempotencyKey: refusals[0]![0]!.events[0]!.idempotencyKey }] },
  ]);

  // the stack's 600 sessions for its guests, then none: a renewal is counted like a first one
  admissionsOf(db, "guest-session", 597);
  for (const guest of [guests[0]!, guests[1]!, guests[0]!])
    expect(await meet.ask(guest.cookie)).toMatchObject({ status: 302 });
  const refused = await meet.ask(guests[1]!.cookie);
  expect(refused).toMatchObject({ status: 429 });
  expect(factsOf(refused)).toMatchObject([
    { path: "/", events: [{ payload: { reason: "session-rate", app: "meet.example.com" } }] },
  ]);
});

test("an owner blocks a guest by id: the token and the cookie end at once", async () => {
  const { env } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest");
  const bob = await joined(env, meet.next, "Bob");
  const eve = await joined(env, meet.next, "Eve");
  const token = await meet.tokenFor(await meet.ask(bob.cookie));
  const evesToken = await meet.tokenFor(await meet.ask(eve.cookie));
  const owner = await ownerCookie(env);
  const members = (action: string, email: string) =>
    authResponse(
      new Request(`${ISSUER}/members`, {
        method: "POST",
        headers: { origin: ISSUER, cookie: owner },
        body: new URLSearchParams({ action, email }),
      }),
      env,
      ctx,
    );
  // an id that is no guest's names nobody
  const ownerId = z
    .object({ id: z.string() })
    .parse(await env.DB.prepare("select id from users where email = ?1").bind(OWNER).first()).id;
  expect(await (await members("block", ownerId)).text()).toContain("Type the address to block");

  const blocked = await members("block", bob.userId);
  expect(await blocked.text()).toContain(`The guest ${bob.userId} is blocked`);
  expect(factsOf(blocked).flatMap((fact) => fact.events.map((event) => event.type))).toEqual([
    "events.iterate.com/account/grant-ended",
    "events.iterate.com/account/person-blocked",
  ]);
  expect(await tokenIdentity(env, token, MEET)).toBeNull();
  expect(await tokenIdentity(env, evesToken, MEET)).toMatchObject({ name: "Eve" });
  // the cookie earns nothing more, and the form says so with one event on the guest's context
  const asked = await meet.ask(bob.cookie);
  expect([asked.status, originAndPath(asked)]).toEqual([302, "/sign-in"]);
  const signIn = await authResponse(new Request(asked.headers.get("location")!), env, ctx);
  expect(originAndPath(signIn)).toBe("/sign-in/guest");
  const refused = await authResponse(
    new Request(signIn.headers.get("location")!, { headers: { cookie: bob.cookie } }),
    env,
    ctx,
  );
  expect(refused).toMatchObject({ status: 403 });
  expect(factsOf(refused)).toMatchObject([
    { path: `/users/${bob.userId}`, events: [{ payload: { reason: "blocked" } }] },
  ]);

  expect(await (await members("unblock", bob.userId)).text()).toContain("is no longer blocked");
  expect(originAndPath(await meet.ask(bob.cookie))).toBe(`${MEET}/.iterate/callback`);
});

test("an app that stops naming guests ends every guest at once: the token and the cookie", async () => {
  const { env } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest passkey");
  const bob = await joined(env, meet.next, "Bob");
  const token = await meet.tokenFor(await meet.ask(bob.cookie));
  expect(await tokenIdentity(env, token, MEET)).toMatchObject({ method: "guest" });
  const changed = await hostSignInOf(env, MEET, "passkey");
  // the token that the guest holds is nobody's from the next request
  expect(await tokenIdentity(env, token, MEET)).toBeNull();
  const asked = await changed.ask(bob.cookie);
  expect([asked.status, originAndPath(asked)]).toEqual([302, "/sign-in"]);
  expect(await authResponse(new Request(`${FORM}?next=${changed.next}`), env, ctx)).toMatchObject({
    status: 404,
  });
});

/** The mind of ./test-support.ts on SQLite in memory, with its guests' rows. No app is asked for
 *  its description over the network: `hostSignInOf` writes the one the issuer keeps. */
function stackOf() {
  const stack = sqliteStack();
  vi.stubGlobal("fetch", async () => new Response("Not found", { status: 404 }));
  return {
    ...stack,
    /** The guests' rows alone, oldest first. */
    people: () =>
      stack.db
        .prepare("select id, email from users where email like 'guest:%' order by rowid")
        .all() as { id: string; email: string }[],
  };
}

/** `count` admissions of `kind` that others made in this window (./device/limits.ts). */
function admissionsOf(db: ReturnType<typeof sqliteStack>["db"], kind: string, count: number) {
  const insert = db.prepare("insert into admissions (kind, client, created_at) values (?, ?, ?)");
  for (let n = 0; n < count; n += 1) insert.run(kind, `other-${n}`, Date.now());
}

/** The authorization request of `resource`'s own host client, as the boundary sends a visitor,
 *  for an app whose description names the sign-in methods `ways` (none: the default). `next` is
 *  that request as the sign-in pages carry it, a path of the issuer. `change`: a parameter that
 *  another client would send. */
async function hostSignInOf(
  env: Env,
  resource: string,
  ways: string,
  change: Record<string, string> = {},
) {
  const verifier = generateRandomCodeVerifier();
  const { host } = new URL(resource);
  const clientId = await hostClientOf(env, host);
  const signIn = (ways ? ways.split(" ") : ["email", "passkey"]) as SignInMethod[];
  await env.OAUTH_KV.put(
    `iterate-app-description:${host}`,
    JSON.stringify({
      name: null,
      icon: null,
      members: false,
      signIn,
      askAfter: Date.now() + 60_000,
    }),
  );
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: hostCallbackOf(resource),
    resource,
    scope: "identity",
    state: "s",
    code_challenge: await calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    ...change,
  });
  const path = `/oauth2/auth?${query}`;
  const request = {
    path,
    next: encodeURIComponent(path),
    ask: (cookie = "") =>
      authResponse(new Request(ISSUER + path, { headers: { cookie } }), env, ctx),
    /** The token endpoint's answer for the code in `answer`'s redirect, as the boundary's
     *  callback gets it. */
    tokensFor: async (answer: Response) => {
      const exchanged = await authResponse(
        new Request(`${ISSUER}/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: new URL(answer.headers.get("location")!).searchParams.get("code")!,
            redirect_uri: hostCallbackOf(resource),
            client_id: clientId,
            code_verifier: verifier,
            resource,
          }),
        }),
        env,
        ctx,
      );
      return exchanged.json() as Promise<Record<string, unknown>>;
    },
  };
  return {
    ...request,
    /** The access token alone. */
    tokenFor: async (answer: Response) =>
      z.object({ access_token: z.string() }).parse(await request.tokensFor(answer)).access_token,
  };
}

/** The form as a browser is shown it for `next` (URI-encoded): its state, and its flow cookie. */
async function formOf(env: Env, next: string) {
  const page = await authResponse(new Request(`${FORM}?next=${next}`), env, ctx);
  const state = /name="state" value="([^"]+)"/.exec(await page.text())?.[1] || "";
  return { state, cookie: (page.headers.get("set-cookie") || "").split(";")[0]! };
}

/** The form's answer. `origin: null` sends none; `length` claims a Content-Length. */
function posted(
  env: Env,
  sent: { state: string; cookie: string; name: string; origin?: string | null; length?: string },
) {
  const headers = new Headers({ cookie: sent.cookie });
  // null is "send none", which is not the same as "the form's own"
  // oxlint-disable-next-line iterate/simple-truthiness-check -- null and undefined mean two things here: no Origin header at all, and the issuer's own
  if (sent.origin !== null) headers.set("origin", sent.origin || ISSUER);
  if (sent.length) headers.set("content-length", sent.length);
  return authResponse(
    new Request(FORM, {
      method: "POST",
      headers,
      body: new URLSearchParams({ state: sent.state, name: sent.name }),
    }),
    env,
    ctx,
  );
}

/** One browser that is shown the form and answers it with `name`. */
async function joined(env: Env, next: string, name: string) {
  const answer = await posted(env, { ...(await formOf(env, next)), name });
  const facts = factsOf(answer);
  const cookie = answer.headers
    .getSetCookie()
    .find((each) => each.includes("guest-session="))!
    .split(";")[0]!;
  return { answer, facts, cookie, userId: facts[0]!.path.replace("/users/", "") };
}

function factsOf(answer: Response) {
  return decodeFacts(answer.headers.get(FACTS_HEADER) || "");
}

function originAndPath(answer: Response) {
  const url = new URL(answer.headers.get("location")!);
  return url.origin === ISSUER ? url.pathname : url.origin + url.pathname;
}

/** The owner, signed in with a live passkey: a member's session. */
async function ownerCookie(env: Env) {
  const owner = await userOf(env.DB, OWNER);
  await env.DB.prepare(
    `insert into keys (id, user_id, public_key, format, label, added_via, added_by, added_at)
     values ('key-1', ?1, 'a-public-key', 'webauthn', 'a passkey', 'keys-page', ?1, 1)
     on conflict do nothing`,
  )
    .bind(owner.id)
    .run();
  const { setCookie } = await sessionCookie(env, new Request(ISSUER), owner, "key-1");
  return setCookie.split(";")[0]!;
}

/** An MCP client that registers itself, as any MCP client does. Answers its id. */
async function registeredClientOf(env: Env) {
  const registered = await authResponse(
    new Request(`${ISSUER}/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "An MCP client",
        redirect_uris: ["http://127.0.0.1:7777/callback"],
        token_endpoint_auth_method: "none",
      }),
    }),
    env,
    ctx,
  );
  return z.object({ client_id: z.string() }).parse(await registered.json()).client_id;
}
