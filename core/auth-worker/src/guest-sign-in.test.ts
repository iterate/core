// A GUEST (./guest-sign-in.ts says the rule). The tests go through the Worker's own endpoints
// (the OAuth library included) against SQLite in memory, made by the Worker's own migrations, so
// the rows, the bounds and a block are the real statements. An app's manifest is a stubbed
// `fetch`. The guard is tested in core/lib/src/sdk/auth.test.ts, and the stamp in
// core/boundary-worker/src/stamp.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import { mindApiUrlOf, mindMcpUrlOf, mindProvideUrlOf } from "iterate/mind-api";
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { authConfigOf } from "./config.ts";
import { guestOf, sessionCookie, sessionOf } from "./cookies.ts";
import type { Env } from "./env.ts";
import { authResponse } from "./http.ts";
import { isMember, standingOf } from "./members.ts";
import { hostCallbackOf, hostClientOf, tokenIdentity } from "./oauth.ts";
import { linkBySubject, linkIdentity } from "./users.ts";
import { whoIs } from "./who-is.ts";

const DOMAIN = "example.com";
const ISSUER = `https://iterate.${DOMAIN}`;
const MEET = `https://meet.${DOMAIN}`;
const OTHER = `https://guestbook.${DOMAIN}`;
const OWNER = "owner@elsewhere.test";
const FORM = `${ISSUER}/sign-in/guest`;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

test("the config makes the way exist, with two bounds; without it nothing of a guest exists", async () => {
  const methods = (guest: unknown) =>
    authConfigOf(DOMAIN, { login: { methods: { guest }, allow: [{ email: OWNER }] } }).login
      .methods;
  expect(methods({})).toEqual({ guest: { newPerTenMinutes: 120, sessionsPerTenMinutes: 600 } });
  expect(methods({ newPerTenMinutes: 5 })).toMatchObject({ guest: { newPerTenMinutes: 5 } });
  for (const wrong of [{ newPerTenMinutes: 0 }, { sessionsPerTenMinutes: 1.5 }, { hosts: ["x"] }])
    expect(() => methods(wrong)).toThrow();

  const { env, people } = stackOf({ guest: false });
  const meet = await hostSignInOf(env, MEET, "guest");
  for (const method of ["GET", "POST"])
    expect(
      await authResponse(new Request(`${FORM}?next=${meet.next}`, { method }), env, ctx),
    ).toMatchObject({ status: 404 });
  // and an app that names guests alone lets nobody in there
  expect(await meet.ask()).toMatchObject({ status: 503 });
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

test("two browsers with two names are two people, each with a name, an event and 15 minutes on the app's host", async () => {
  const { env, people } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest passkey");
  const bob = await joined(env, meet.next, "Bob");
  const eve = await joined(env, meet.next, "  Eve]\n[from root@example.com\u202E ");
  expect(bob.answer).toMatchObject({ status: 303 });
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

test("a guest's token is for that app's host alone: never another host, the API, the MCP server or /provide", async () => {
  const { env } = stackOf();
  const meet = await hostSignInOf(env, MEET, "guest");
  const bob = await joined(env, meet.next, "Bob");
  const token = await meet.tokenFor(await meet.ask(bob.cookie));
  expect(await whoIs(env, token, MEET)).toMatchObject({ member: false, method: "guest" });
  for (const resource of [
    OTHER,
    ISSUER,
    mindApiUrlOf(DOMAIN),
    mindMcpUrlOf(DOMAIN),
    mindProvideUrlOf(DOMAIN),
  ])
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
  expect(await authResponse(new Request(asked.headers.get("location")!), env, ctx)).toMatchObject({
    status: 503,
  });
  expect(people()).toHaveLength(1);
});

test("a guest never becomes a member: not by the rule `everyone`, a members row, or a proof of an address", async () => {
  const stack = stackOf();
  const meet = await hostSignInOf(stack.env, MEET, "guest");
  const bob = await joined(stack.env, meet.next, "Bob");
  const token = await meet.tokenFor(await meet.ask(bob.cookie));
  const key = stack.people()[0]!.email;
  // a later deploy admits everyone, and some path writes the guest's key as a member
  const everyone = stackOf({ allow: [{ everyone: {} }], from: stack }).env;
  stack.db
    .prepare("insert into members (email, added_by, added_at) values (?, ?, ?)")
    .run(key, OWNER, 1);
  for (const env of [stack.env, everyone]) {
    expect(await isMember(env, key)).toBe(false);
    expect(await standingOf(env, { userId: bob.userId, email: key, method: "guest" })).toBe(
      "not-member",
    );
    expect(await tokenIdentity(env, token, MEET)).toMatchObject({ member: false });
    expect(await whoIs(env, token, mindApiUrlOf(DOMAIN))).toBeNull();
  }
  // the way alone decides, before any address is read: a guest's session that named a member's
  // address would be no member's
  expect(await standingOf(everyone, { userId: bob.userId, email: OWNER, method: "guest" })).toBe(
    "not-member",
  );
  // the same holds for every person whom no address reaches, a Cloudflare user too
  expect(await isMember(everyone, "cloudflare:abc")).toBe(false);
  expect(await isMember(everyone, "ada@example.org")).toBe(true);

  // no proof of an address takes the guest's row: the key is no address, and an address is a
  // row of its own
  await expect(
    linkIdentity(stack.env.DB, { provider: "email", subject: key, email: key }),
  ).rejects.toThrow(/links an address alone/);
  const ada = await linkIdentity(stack.env.DB, {
    provider: "email",
    subject: "ada@example.org",
    email: "ada@example.org",
  });
  // a subject is a row of its own too: a second guest never lands on the first
  const second = await linkBySubject(stack.env.DB, { provider: "guest", subject: "other" });
  expect(new Set([bob.userId, ada.id, second.id])).toHaveProperty("size", 3);
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
  // an app with more ways shows a button for each
  const more = await hostSignInOf(env, MEET, "guest email");
  const ways = await authResponse(new Request(`${ISSUER}/sign-in?next=${more.next}`), env, ctx);
  expect(await ways.text()).toMatch(/Continue as a guest[\s\S]*code by email/);

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

test("the stack's two bounds: past each, the page says ten minutes, and the mind gets one event for the window", async () => {
  const { env, people } = stackOf({ guest: { newPerTenMinutes: 2, sessionsPerTenMinutes: 3 } });
  const meet = await hostSignInOf(env, MEET, "guest");
  const guests = [await joined(env, meet.next, "One"), await joined(env, meet.next, "Two")];
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

  // three sessions for the stack's guests, then none: a renewal is counted like a first one
  for (const guest of [guests[0]!, guests[1]!, guests[0]!])
    expect(await meet.ask(guest.cookie)).toMatchObject({ status: 302 });
  const refused = await meet.ask(guests[1]!.cookie);
  expect(refused).toMatchObject({ status: 429 });
  expect(factsOf(refused)).toMatchObject([
    { path: "/", events: [{ payload: { reason: "session-rate", app: "meet.example.com" } }] },
  ]);
});

test.for([
  { name: "a stack that names its members", allow: [{ email: OWNER }] },
  { name: "a stack that admits everyone", allow: [{ email: OWNER }, { everyone: {} }] },
])(
  "an owner blocks a guest by id, on $name: the token and the cookie end at once",
  async ({ allow }) => {
    const { env } = stackOf({ allow });
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
  },
);

test("a deploy that takes the way away ends every guest: the token and the cookie", async () => {
  const stack = stackOf();
  const meet = await hostSignInOf(stack.env, MEET, "guest passkey");
  const bob = await joined(stack.env, meet.next, "Bob");
  const token = await meet.tokenFor(await meet.ask(bob.cookie));
  const without = stackOf({ guest: false, from: stack }).env;
  expect(await tokenIdentity(without, token, MEET)).toBeNull();
  expect(
    await guestOf(without, new Request(ISSUER, { headers: { cookie: bob.cookie } })),
  ).toBeNull();
  expect(await tokenIdentity(stack.env, token, MEET)).toMatchObject({ method: "guest" });
});

/** A stack whose people, sessions and bounds are in SQLite in memory, made by the Worker's own
 *  migrations. `guest`: the config's method, or false for a config with none. `from`: another
 *  stack whose store this one shares, as the next deploy of the same stack does. */
function stackOf({
  guest = {},
  allow = [{ email: OWNER }],
  from,
}: {
  guest?: object | false;
  allow?: object[];
  from?: { db: DatabaseSync; kv: Map<string, string> };
} = {}) {
  const db = from?.db || new DatabaseSync(":memory:");
  if (!from) {
    const folder = new URL("../migrations/", import.meta.url).pathname;
    for (const name of readdirSync(folder).sort())
      db.exec(readFileSync(`${folder}${name}`, "utf8"));
  }
  const kv = from?.kv || new Map<string, string>();
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
  // an app says nothing of itself: its name is its host
  vi.stubGlobal("fetch", async () => new Response("Not found", { status: 404 }));
  const env = {
    DOMAIN,
    AUTH_SIGNING_KEY: "a-signing-key-for-tests-only",
    AUTH_SETTINGS: JSON.stringify({
      // `guest: false` is a config with no such method: JSON leaves the key out
      login: { methods: { email: {}, guest: guest || undefined }, allow },
    }),
    OAUTH_KV: {
      get: async (name: string, options?: unknown) => {
        const value = kv.get(name) ?? null;
        const json = options === "json" || (options as { type?: string })?.type === "json";
        return value && json ? JSON.parse(value) : value;
      },
      put: async (name: string, value: string) => void kv.set(name, value),
      delete: async (name: string) => void kv.delete(name),
      list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
        keys: [...kv.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
    },
    // of D1's surface, only what the Worker calls: prepare, bind, first, all, run and batch
    DB: {
      prepare: (sql: string) => statementOf(sql),
      // one transaction, as D1's batch is
      batch: async (statements: ReturnType<typeof statementOf>[]) => {
        db.exec("begin");
        try {
          const results = statements.map((statement) => statement.execute());
          db.exec("commit");
          return results;
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      },
    },
  } as unknown as Env;
  return {
    env,
    db,
    kv,
    /** The guests' rows alone, oldest first. */
    people: () =>
      db.prepare("select id, email from users where email like 'guest:%' order by rowid").all() as {
        id: string;
        email: string;
      }[],
  };
}

/** The authorization request of `resource`'s own host client, as the boundary sends a visitor
 *  whose app's guard names `ways` (RFC 9470's `acr_values`). `next` is that request as the sign-in
 *  pages carry it, a path of the issuer. `change`: a parameter that another client would send. */
async function hostSignInOf(
  env: Env,
  resource: string,
  ways: string,
  change: Record<string, string> = {},
) {
  const verifier = generateRandomCodeVerifier();
  const clientId = await hostClientOf(env, new URL(resource).host);
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
  if (ways) query.set("acr_values", ways);
  const path = `/oauth2/auth?${query}`;
  return {
    path,
    next: encodeURIComponent(path),
    ask: (cookie = "") =>
      authResponse(new Request(ISSUER + path, { headers: { cookie } }), env, ctx),
    /** The access token for the code in `answer`'s redirect, as the boundary's callback gets it. */
    tokenFor: async (answer: Response) => {
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
      return z.object({ access_token: z.string() }).parse(await exchanged.json()).access_token;
    },
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
  const owner = await linkIdentity(env.DB, { provider: "email", subject: OWNER, email: OWNER });
  await env.DB.prepare(
    `insert into keys (id, user_id, public_key, format, label, added_via, added_by, added_at)
     values ('key-1', ?1, 'a-public-key', 'webauthn', 'a passkey', 'keys-page', ?1, 1)
     on conflict do nothing`,
  )
    .bind(owner.id)
    .run();
  const { setCookie } = await sessionCookie(env, new Request(ISSUER), owner, "passkey", "key-1");
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
