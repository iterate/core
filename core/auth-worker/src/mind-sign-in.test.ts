// SIGN IN WITH YOUR MIND (./mind-sign-in.ts and ./vouch.ts say the rules), between two minds that
// are each this Worker on SQLite in memory, made by its own migrations, with an identity log that
// lists each stack's key: A, whose app at cloud.mind-a.net names "mind", and B, the person's own
// mind. The global `fetch` is each mind's own Worker at its hostname, so A reads B's log, probes
// B's vouch route and checks B's signature as it does live. The guard is tested in
// core/lib/src/sdk/auth.test.ts.
import { decodeFacts, FACTS_HEADER } from "iterate/facts";
import type { SignInMethod } from "iterate/principal";
import { type Envelope, signedMlDsa65, statementText } from "iterate/signed";
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { newIdentityLog } from "../../lib/src/test-support/identity-log.ts";
import { emailSessionCookie, sessionCookie } from "./cookies.ts";
import type { Env } from "./env.ts";
import { authResponse } from "./http.ts";
import { identityIntakeResponse, identityLogResponse } from "./identity.ts";
import { isMember } from "./members.ts";
import { NO_MIND, OLDER_RELEASE, SIGN_IN_VOUCHED_TYPE } from "./mind-sign-in.ts";
import { grantLifetimeOf, hostCallbackOf, hostClientOf, tokenIdentity } from "./oauth.ts";
import { signedByStack, stackKeyResponse } from "./stack-key.ts";
import { sqliteStack, stackKeyPair } from "./test-support.ts";
import { userOf } from "./users.ts";

// Each test has minds of its own hostnames: the log reader keeps a hostname's answer a minute.
let minds = 0;
let ZONE = "";
let A = "";
let B = "";
let APP = "";
/** A second hostname that A's log lists, after its issuer's: as a mind lists a hostname it moves
 *  from. Its log answers there, and nothing else of A does. */
let LISTED = "";
const OWNER = "owner@example.net";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

test("a member of B signs in at A's app: one press at B, a person of the way mind at A, no address sent", async () => {
  const { a, b, app } = await twoMinds();
  const started = await a.get(`/sign-in/mind?next=${app.next}&mind=${B}`);
  expect(started).toMatchObject({ status: 303 });
  const to = new URL(started.headers.get("location")!);
  expect([to.origin, to.pathname]).toEqual([`https://${B}`, "/sign-in/vouch"]);
  expect(Object.fromEntries(to.searchParams)).toMatchObject({ for: A, app: `cloud.${ZONE}` });
  const form = cookieOf(started);
  expect(started.headers.get("set-cookie")).toMatch(
    /^__Secure-iterate-auth-mind-form=[^;]+; HttpOnly; Secure; SameSite=None; Path=\/sign-in\/mind; Max-Age=600$/,
  );

  // B: one line and one button, saying what goes
  const owner = await b.ownerCookie();
  const asked = await b.get(to.pathname + to.search, owner);
  const page = await asked.text();
  expect(asked).toMatchObject({ status: 200 });
  expect(page).toContain(`as a member of <strong>${B}</strong>`);
  expect(page).toContain("It does not learn your email address.");
  // the page names A's issuer, which A's log proves, and no app: an app's name is A's word
  expect(page).toContain(`<h1>Sign in to ${A}</h1>`);
  expect(page).not.toContain(`cloud.${ZONE}`);
  const vouched = await b.press(page, owner);
  expect(vouched).toMatchObject({ status: 200 });
  expect(decodeFacts(vouched.headers.get(FACTS_HEADER)!)).toMatchObject([
    {
      events: [
        {
          type: "events.iterate.com/account/sign-in-vouched",
          payload: { mind: a.log.mind, hostname: A },
        },
      ],
    },
  ]);
  const { action, envelope } = postedBy(await vouched.text());
  expect(action).toBe(`https://${A}/sign-in/mind/return`);
  const statement = JSON.parse(envelope.statement);
  expect(statement).toMatchObject({
    mind: a.log.mind,
    from: b.log.mind,
    fromHost: B,
    path: "/",
    type: SIGN_IN_VOUCHED_TYPE,
  });
  // the member's user id and nothing made from their address
  expect(Object.keys(statement.payload).sort()).toEqual(["member", "nonce", "state", "to", "user"]);
  expect(envelope.statement).not.toContain("@");
  expect(statement.expires - statement.at).toBe(60_000);

  const back = await a.back(envelope, form);
  expect(back).toMatchObject({ status: 303 });
  expect(back.headers.get("location")).toBe(`https://${A}${app.path}`);
  const cookies = back.headers.getSetCookie();
  expect(cookies[0]).toMatch(
    /^__Host-iterate-auth-mind-session=[^;]+;.*SameSite=Lax; Path=\/; Max-Age=86400$/,
  );
  expect(cookies[1]).toMatch(/^__Secure-iterate-auth-mind-form=; .*Max-Age=0$/);
  // one way at a time: a guest's cookie, which authorize reads first, ends here
  expect(cookies[2]).toMatch(/^__Host-iterate-auth-guest-session=; .*Max-Age=0$/);
  const bOwner = await userOf(b.env.DB, OWNER);
  const person = a.db.prepare("select id, email from users where email like 'mind:%'").all() as {
    id: string;
    email: string;
  }[];
  expect(person).toEqual([{ id: expect.any(String), email: `mind:${b.log.mind}:${bOwner.id}` }]);
  expect(await isMember(a.env, person[0]!.email)).toBe(false);

  // the app's own sign-in: no question, a token of the way mind, no member, 24 hours at most
  const authorized = await app.ask(cookieOf(back));
  expect(authorized).toMatchObject({ status: 302 });
  const token = await app.tokenFor(authorized);
  const identity = await tokenIdentity(a.env, token, APP);
  expect(identity).toEqual({
    principal: { actor: person[0]!.id },
    grant: expect.any(String),
    expiresAt: expect.any(Number),
    member: false,
    method: "mind",
    name: B,
    mind: { id: b.log.mind, hostname: B, userId: bOwner.id },
  });
  expect(identity!.expiresAt * 1000 - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
  // the mind's API takes no such person
  expect(await tokenIdentity(a.env, token, `https://${A}/api`)).toBeNull();
});

test.for([
  { name: "no statement", change: { envelope: "" } },
  { name: "no browser that started", change: { cookie: "" } },
  { name: "another browser's state", fields: { state: "x".repeat(32) } },
  { name: "another browser's nonce", fields: { nonce: "x".repeat(32) } },
  { name: "another type", fields: { type: "events.iterate.com/account/something-else" } },
  { name: "a statement for another mind", fields: { mind: "f".repeat(64) } },
  { name: "a statement that lives too long", fields: { expiresInSeconds: 120 } },
  { name: "a key that B's log does not list", unlisted: true },
])("the return opens no session: $name", async ({ change, fields, unlisted }) => {
  const { a, b, app } = await twoMinds();
  const { form, ask } = await a.started(app.next);
  const payload = {
    state: ask.state,
    nonce: ask.nonce,
    user: "user_b",
    member: true,
    to: `https://${A}`,
  };
  const {
    mind = a.log.mind,
    type = SIGN_IN_VOUCHED_TYPE,
    expiresInSeconds = 60,
    ...over
  } = (fields || {}) as Record<string, string | number>;
  const envelope = unlisted
    ? await signedByUnlistedKey(a.log.mind, b.log.mind, payload)
    : await signedByStack(b.env, {
        mind: String(mind),
        path: "/",
        type: String(type),
        payload: { ...payload, ...over },
        expiresInSeconds: Number(expiresInSeconds),
      });
  const back = await a.back(envelope, form, change);
  expect(back).toMatchObject({ status: 403 });
  expect(back.headers.get("set-cookie") || "").not.toMatch(/mind-session=[^;]/);
  expect(a.db.prepare("select count(*) as n from users where email like 'mind:%'").get()).toEqual({
    n: 0,
  });
});

test("a statement is taken once, and not past its 60 seconds", async () => {
  const { a, b, app } = await twoMinds();
  const { form, ask } = await a.started(app.next);
  const vouch = () =>
    signedByStack(b.env, {
      mind: a.log.mind,
      path: "/",
      type: SIGN_IN_VOUCHED_TYPE,
      payload: {
        state: ask.state,
        nonce: ask.nonce,
        user: "user_b",
        member: true,
        to: `https://${A}`,
      },
      expiresInSeconds: 60,
    });
  const once = await vouch();
  expect(await a.back(once, form)).toMatchObject({ status: 303 });
  expect(await a.back(once, form)).toMatchObject({ status: 403 });
  const late = await vouch();
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
  expect(await a.back(late, form)).toMatchObject({ status: 403 });
  vi.useRealTimers();
});

test("A answers a hostname that someone typed with one of three fixed sentences", async () => {
  const { a, app, serveB } = await twoMinds();
  const typed = async (mind: string) => {
    const answer = await a.get(`/sign-in/mind?next=${app.next}&mind=${mind}`);
    return { status: answer.status, page: await answer.text() };
  };
  // no mind at that address: what the host answered is not shown
  const nothing = `iterate.nothing-${ZONE}`;
  expect(await typed(nothing)).toMatchObject({
    status: 400,
    page: expect.stringContaining(NO_MIND),
  });
  expect((await typed(nothing)).page).not.toContain("the host");
  // a mind on a release before the vouch route
  serveB((request, mind) =>
    new URL(request.url).pathname === "/sign-in/vouch"
      ? new Response(null, { status: 404 })
      : mind(request),
  );
  expect(await typed(B)).toMatchObject({
    status: 400,
    page: expect.stringContaining(OLDER_RELEASE),
  });
  expect(await typed("not a hostname")).toMatchObject({ status: 400 });
  expect(await typed(A)).toMatchObject({ status: 400, page: expect.stringContaining("this mind") });
});

test("the way is for an app that names it: another app has no field, and its sign-in no button", async () => {
  const { a } = await twoMinds();
  const other = await hostSignInOf(a.env, `https://notes.${ZONE}`, "email passkey");
  expect(await a.get(`/sign-in/mind?next=${other.next}`)).toMatchObject({ status: 404 });
  expect(await a.get(`/sign-in/mind?next=/members`)).toMatchObject({ status: 404 });
  const signIn = await a.get(`/sign-in?next=${other.next}`);
  expect(await signIn.text()).not.toContain("Sign in with your mind");
  const mixed = await hostSignInOf(a.env, APP, "passkey mind");
  expect(await (await a.get(`/sign-in?next=${mixed.next}`)).text()).toContain(
    "Sign in with your mind",
  );
  const first = await hostSignInOf(a.env, APP, "mind");
  const opened = await a.get(`/sign-in?next=${first.next}`);
  expect(opened.headers.get("location")).toMatch(new RegExp(`^https://${A}/sign-in/mind\\?next=`));
  expect(await (await a.get(`/sign-in/mind?next=${first.next}`)).text()).toContain(
    "Your mind's address",
  );
});

test("B vouches for a signed-in member alone, toward a hostname that serves another mind's log", async () => {
  const { a, b, app } = await twoMinds();
  const { ask } = await a.started(app.next);
  const at = `/sign-in/vouch?${new URLSearchParams({ for: A, app: `cloud.${ZONE}`, state: ask.state, nonce: ask.nonce })}`;
  expect(await b.head("/sign-in/vouch")).toMatchObject({ status: 204 });
  // signed out: to B's own sign-in, and back
  const signedOut = await b.get(at);
  expect([signedOut.status, signedOut.headers.get("location")]).toEqual([
    302,
    `/sign-in?${new URLSearchParams({ next: at })}`,
  ]);
  // a person who is no member of B
  const stranger = await userOf(b.env.DB, "someone@other.test");
  const { setCookie } = await emailSessionCookie(b.env, new Request(`https://${B}`), stranger);
  expect(await b.get(at, setCookie.split(";")[0]!)).toMatchObject({ status: 403 });
  // a hostname that serves no mind, and B itself
  const owner = await b.ownerCookie();
  for (const host of ["nothing.mind-c.net", B])
    expect(await b.get(at.replace(`for=${A}`, `for=${host}`), owner), host).toMatchObject({
      status: 400,
    });
  // the press comes from B's own page alone
  const foreign = new Request(`https://${B}/sign-in/vouch`, {
    method: "POST",
    headers: { origin: APP, cookie: owner },
    body: new URLSearchParams({ for: A, app: `x.${ZONE}`, state: ask.state, nonce: ask.nonce }),
  });
  expect(await authResponse(foreign, b.env, ctx)).toMatchObject({ status: 403 });
});

test("B posts the proof to A's issuer alone, whatever hostname of A's log it is asked for, and names that issuer in it", async () => {
  const { a, b, app } = await twoMinds();
  const { form, location } = await a.started(app.next);
  const owner = await b.ownerCookie();
  // asked for another hostname that A's log lists: the page and the proof name A's issuer
  const elsewhere = location.replace(`for=${A}`, `for=${LISTED}`);
  const page = await (await b.get(elsewhere, owner)).text();
  expect(page).toContain(`<h1>Sign in to ${A}</h1>`);
  expect(page).not.toContain(LISTED);
  expect(page).not.toContain(`cloud.${ZONE}`);
  const { action, envelope } = postedBy(await (await b.press(page, owner)).text());
  expect(action).toBe(`https://${A}/sign-in/mind/return`);
  expect(JSON.parse(envelope.statement).payload).toMatchObject({ to: `https://${A}` });
  expect(await a.back(envelope, form)).toMatchObject({ status: 303 });
});

test("A takes a proof only when it names A's own issuer as where it goes", async () => {
  const { a, b, app } = await twoMinds();
  const { form, ask } = await a.started(app.next);
  const vouch = (to: string) =>
    signedByStack(b.env, {
      mind: a.log.mind,
      path: "/",
      type: SIGN_IN_VOUCHED_TYPE,
      payload: { state: ask.state, nonce: ask.nonce, user: "user_b", member: true, to },
      expiresInSeconds: 60,
    });
  for (const to of [`https://${LISTED}`, APP, `https://${A}/`])
    expect(await a.back(await vouch(to), form), to).toMatchObject({ status: 403 });
  expect(await a.back(await vouch(`https://${A}`), form)).toMatchObject({ status: 303 });
});

test("with a meld rule for A, B signs with no press only after its own member opened A from B", async () => {
  const { a, b, app } = await twoMinds();
  b.db
    .prepare(
      `insert into mind_melds (domain, mind, append, key, configured_at, configured_by)
       values (?1, ?2, '["/minds/x/"]', null, 1, 'user-owner')`,
    )
    .run(A, a.log.mind);
  const owner = await b.ownerCookie();
  // any other site's navigation to B's vouch gets the one Continue page
  const unasked = await a.started(app.next);
  const page = await (await b.get(unasked.location, owner)).text();
  expect(page).toContain('<button type="submit">Continue</button>');
  expect(page).not.toContain('name="envelope"');
  // B's own open, from B's own site: it says which app, for one use
  const open = (fetchSite: string) =>
    authResponse(
      new Request(`https://${B}/sign-in/open?${new URLSearchParams({ to: `${APP}/mind` })}`, {
        headers: { cookie: owner, "sec-fetch-site": fetchSite },
      }),
      b.env,
      ctx,
    );
  for (const site of ["cross-site", ""])
    expect((await open(site)).headers.get("set-cookie") || "", site).not.toMatch(/intent=[^;]/);
  const opened = await open("same-site");
  expect([opened.status, opened.headers.get("location")]).toEqual([303, `${APP}/mind`]);
  const intent = cookieOf(opened);
  expect(intent).toMatch(/^__Host-iterate-auth-vouch-intent=./);
  const { form, location } = await a.started(app.next);
  const vouched = await b.get(location, `${owner}; ${intent}`);
  expect(vouched.headers.get("set-cookie")).toMatch(
    /^__Host-iterate-auth-vouch-intent=; .*Max-Age=0/,
  );
  const { envelope } = postedBy(await vouched.text());
  expect(await a.back(envelope, form)).toMatchObject({ status: 303 });
  // an intent for another app opens nothing at once
  const other = await authResponse(
    new Request(
      `https://${B}/sign-in/open?to=${encodeURIComponent("https://notes.example.org/")}`,
      {
        headers: { cookie: owner, "sec-fetch-site": "same-site" },
      },
    ),
    b.env,
    ctx,
  );
  const again = await a.started(app.next);
  expect(await (await b.get(again.location, `${owner}; ${cookieOf(other)}`)).text()).not.toContain(
    'name="envelope"',
  );
});

test("a failed return keeps the sign-in that waits: the right answer still signs in", async () => {
  const { a, b, app } = await twoMinds();
  const { form, ask } = await a.started(app.next);
  const failed = await a.back(
    await signedByStack(b.env, {
      mind: a.log.mind,
      path: "/",
      type: SIGN_IN_VOUCHED_TYPE,
      payload: {
        state: "y".repeat(32),
        nonce: ask.nonce,
        user: "user_b",
        member: true,
        to: `https://${A}`,
      },
      expiresInSeconds: 60,
    }),
    form,
  );
  expect(failed).toMatchObject({ status: 403 });
  expect(failed.headers.get("set-cookie") || "").not.toMatch(/mind-form=;/);
  const right = await signedByStack(b.env, {
    mind: a.log.mind,
    path: "/",
    type: SIGN_IN_VOUCHED_TYPE,
    payload: {
      state: ask.state,
      nonce: ask.nonce,
      user: "user_b",
      member: true,
      to: `https://${A}`,
    },
    expiresInSeconds: 60,
  });
  expect(await a.back(right, form)).toMatchObject({ status: 303 });
});

test("a token of the way mind is not refreshed, and ends with the vouch's 24 hours", () => {
  const grant = {
    userId: "user_x",
    email: "mind:x:y",
    method: "mind" as const,
    mind: { id: "x", hostname: B, userId: "y" },
    standingByMethod: true as const,
    deadline: 1_000_000,
  };
  expect(grantLifetimeOf(grant, { refresh: false, host: true, now: 1_000_000 - 3600_000 })).toEqual(
    {
      accessTokenTTL: 3600,
      refreshTokenTTL: 0,
    },
  );
  expect(grantLifetimeOf(grant, { refresh: true, host: true, now: 0 })).toBe("mind_no_refresh");
  expect(grantLifetimeOf(grant, { refresh: false, host: false, now: 0 })).toBe("deadline_passed");
  expect(grantLifetimeOf(grant, { refresh: false, host: true, now: 999_000 })).toBe(
    "deadline_passed",
  );
});

/** A, B, the app of A that names "mind", and the global fetch as both minds' Workers. */
async function twoMinds() {
  minds += 1;
  ZONE = `mind-a${minds}.net`;
  A = `iterate.${ZONE}`;
  B = `iterate.mind-b${minds}.net`;
  APP = `https://cloud.${ZONE}`;
  LISTED = `old.${ZONE}`;
  const [a, b] = [await mindAt(A, ZONE, [LISTED]), await mindAt(B, `mind-b${minds}.net`)];
  type Handler = (
    request: Request,
    mind: (request: Request) => Promise<Response>,
  ) => Response | Promise<Response>;
  let bAnswers: Handler = (request, mind) => mind(request);
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    const { hostname } = new URL(request.url);
    if (hostname === A) return a.serve(request);
    if (hostname === LISTED && new URL(request.url).pathname === "/.well-known/iterate")
      return identityLogResponse(a.env, {
        hostname,
        after: new URL(request.url).searchParams.get("after"),
      });
    if (hostname === B) return bAnswers(request, b.serve);
    return new Response("<script>the host's own words</script>", { status: 500 });
  });
  const app = await hostSignInOf(a.env, APP, "mind");
  return {
    a: {
      ...a,
      /** Started for `next`: the form cookie, B's address with its query, and its ask. */
      started: async (next: string) => {
        const started = await a.get(`/sign-in/mind?next=${next}&mind=${B}`);
        const location = started.headers.get("location")!;
        const url = new URL(location);
        return {
          form: cookieOf(started),
          location: url.pathname + url.search,
          ask: { state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")! },
        };
      },
      /** B's page posts `envelope` back, in the browser with `form`. */
      back: (
        envelope: Envelope,
        form: string,
        change: { envelope?: string; cookie?: string } = {},
      ) => {
        // "" in `change` sends none
        const sent = { envelope: JSON.stringify(envelope), cookie: form, ...change };
        return authResponse(
          new Request(`https://${A}/sign-in/mind/return`, {
            method: "POST",
            headers: { origin: `https://${B}`, cookie: sent.cookie },
            body: new URLSearchParams({ envelope: sent.envelope }),
          }),
          a.env,
          ctx,
        );
      },
    },
    b: {
      ...b,
      /** The Continue press on B's page `page`. */
      press: (page: string, cookie: string) => {
        return authResponse(
          new Request(`https://${B}/sign-in/vouch`, {
            method: "POST",
            headers: { origin: `https://${B}`, cookie },
            body: new URLSearchParams(
              Object.fromEntries(
                ["for", "app", "state", "nonce"].map((name) => [
                  name,
                  unescaped(new RegExp(`name="${name}" value="([^"]*)"`).exec(page)?.[1] || ""),
                ]),
              ),
            ),
          }),
          b.env,
          ctx,
        );
      },
    },
    app,
    serveB: (handler: Handler) => {
      bAnswers = handler;
    },
  };
}

/** A mind at `hostname`, on SQLite, whose log lists its stack's key. */
async function mindAt(hostname: string, zone: string, also: string[] = []) {
  const log = await newIdentityLog([hostname, ...also]);
  const { env, db } = sqliteStack({
    mindId: log.mind,
    controlPlaneHostname: hostname,
    zones: [zone],
  });
  const intake = (signed: unknown) =>
    identityIntakeResponse(
      env,
      new Request(`https://${hostname}/.well-known/iterate`, {
        method: "POST",
        body: JSON.stringify(signed),
      }),
    );
  await intake(log.genesis);
  const { publicKey } = (await (await stackKeyResponse(env)).json()) as { publicKey: string };
  await intake(
    await log.next(log.genesis, {
      workingKeys: [
        { signs: "raw", algorithm: "ML-DSA-65", publicKey, label: "stack", purpose: "statements" },
      ],
    }),
  );
  const serve = (request: Request) => authResponse(request, env, ctx);
  return {
    log,
    env,
    db,
    serve,
    get: (path: string, cookie = "") =>
      serve(new Request(`https://${hostname}${path}`, { headers: { cookie } })),
    head: (path: string) => serve(new Request(`https://${hostname}${path}`, { method: "HEAD" })),
    /** The owner, signed in with a live passkey: a member's session. */
    ownerCookie: async () => {
      const owner = await userOf(env.DB, OWNER);
      await env.DB.prepare(
        `insert into keys (id, user_id, public_key, format, label, added_via, added_by, added_at)
         values ('key-1', ?1, 'a-public-key', 'webauthn', 'a passkey', 'keys-page', ?1, 1)
         on conflict do nothing`,
      )
        .bind(owner.id)
        .run();
      const { setCookie } = await sessionCookie(
        env,
        new Request(`https://${hostname}`),
        owner,
        "key-1",
      );
      return setCookie.split(";")[0]!;
    },
  };
}

/** A statement in B's name, signed with a key that B's log does not list. */
async function signedByUnlistedKey(mind: string, from: string, payload: Record<string, unknown>) {
  const key = await stackKeyPair();
  const at = Date.now();
  return signedMlDsa65(
    statementText({
      mind,
      from,
      fromHost: B,
      path: "/",
      type: SIGN_IN_VOUCHED_TYPE,
      payload,
      at,
      expires: at + 60_000,
    }),
    key.privateKey,
    key.key,
  );
}

/** The form that B's page posts: where to, and the envelope. */
function postedBy(page: string) {
  const action = unescaped(/<form id="vouch" method="post" action="([^"]+)"/.exec(page)?.[1] || "");
  const value = unescaped(/name="envelope" value="([^"]*)"/.exec(page)?.[1] || "");
  return { action, envelope: JSON.parse(value) as Envelope };
}

const unescaped = (html: string) =>
  html.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

const cookieOf = (answer: Response) => (answer.headers.get("set-cookie") || "").split(";")[0]!;

/** An authorization of `resource`'s own sign-in at A, for an app that names `ways`. */
async function hostSignInOf(env: Env, resource: string, ways: string) {
  const verifier = generateRandomCodeVerifier();
  const { host } = new URL(resource);
  const clientId = await hostClientOf(env, host);
  await env.OAUTH_KV.put(
    `iterate-app-description:${host}`,
    JSON.stringify({
      name: null,
      icon: null,
      members: false,
      signIn: ways.split(" ") as SignInMethod[],
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
  });
  const path = `/oauth2/auth?${query}`;
  return {
    path,
    next: encodeURIComponent(path),
    ask: (cookie = "") =>
      authResponse(new Request(`https://${A}${path}`, { headers: { cookie } }), env, ctx),
    tokenFor: async (answer: Response) => {
      const exchanged = await authResponse(
        new Request(`https://${A}/oauth2/token`, {
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
