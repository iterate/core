import { waitUntil } from "cloudflare:workers";
import { cookieValueOf } from "iterate/lib";
import type { SignInMethod } from "iterate/principal";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { AccountFacts } from "./account-facts.ts";
import { isBlocked } from "./blocked.ts";
import { configOf, type Env, issuerOf } from "./env.ts";

// A browser's session at the issuer is a row of `browser_sessions` (../migrations/0011), and its
// cookie holds the row's id. It ends at expiry, at sign-out, on /sessions (./sessions-page.ts),
// or for everyone when the config's signing key changes. The row's `method` says which of three
// kinds it is. The first two are a person's session, and their word is the person's sign-in
// method (iterate/principal `SignInMethod`), which the session, its grants, their tokens and the
// person that the boundary stamps all carry:
//
//   a passkey's            ("passkey") a member's session, which ends with the passkey that opened
//                          it. Membership is checked again on every use. `sessionOf` answers it.
//   a mailed code's        ("email") a mailed code proved the address of a person who was no
//                          member (./email-sign-in.ts). An app of the mind with users of its own
//                          takes it, when the app names "email". It is never a member's, whatever
//                          its address becomes: only `personSessionOf` answers it, for the few
//                          pages that take anyone.
//   to add a first passkey (./enrolment.ts; its `method` is the proof's, never a sign-in method)
//                          neither reader here answers it, so no page and no RPC that asks who is
//                          signed in takes it for a person.
const SESSION_COOKIE = "__Host-iterate-auth-session";
const SESSION_SECONDS = 30 * 24 * 3600;
/** The cookie's token is for this use alone: a token this key signed for another (a key's token,
 *  ./key-tokens.ts) is no session. */
const AUDIENCE = "session";
/** `last_seen_at` is written at most this often: a D1 write on every request would cost. */
const SEEN_EVERY_MS = 10 * 60_000;
/** A passkey's ended or expired row stays this long, then the user's next sign-in deletes it. */
const KEPT_MS = 30 * 24 * 3600_000;

/** WHICH OF A PERSON'S SESSIONS AND SIGN-INS ARE MEANT: all of them, or those alone that a mailed
 *  code opened (the `method` of a session and of a grant). A session that a mailed code opened
 *  lists and ends its own kind alone on /sessions (`reachOf`): its address may be a member's by
 *  now, and mail must not reach what a passkey opened. */
export type Reach = "all" | Exclude<SignInMethod, "passkey">;

/** What `session` manages of its person: a passkey's, everything. */
export const reachOf = (session: PersonSession): Reach =>
  session.method === "passkey" ? "all" : session.method;

const within = (reach: Reach, column: string) =>
  reach === "all" ? "" : `and ${column} = '${reach}'`;

/** A member's session at the issuer, which a passkey opened. `id` is its row's. */
export type Session = { id: string; userId: string; email: string };

/** A session of anyone signed in, and how they signed in. A passkey's acts as a member while its
 *  address is a member's (./members.ts `isMemberSession`). A mailed code's is no member's. */
export type PersonSession = Session & {
  method: SignInMethod;
  /** When the session's row expires, in epoch milliseconds. */
  expiresAt: number;
};

/** A NEW SESSION OF A PASSKEY: its row, and the cookie that holds the row's id. `key` is the id
 *  of the passkey that opened it: the session ends with the key. `request` is the sign-in's, for
 *  its User-Agent. */
export async function sessionCookie(
  env: Env,
  request: Request,
  user: { id: string; email: string },
  key: string,
): Promise<{ setCookie: string; session: string }> {
  const session = newSessionId();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `delete from browser_sessions
       where user_id = ?1 and coalesce(ended_at, expires_at) < ?2`,
    ).bind(user.id, now - KEPT_MS),
    env.DB.prepare(
      `insert into browser_sessions
         (id, user_id, method, key_id, user_agent, created_at, last_seen_at, expires_at)
       values (?1, ?2, 'passkey', ?3, ?4, ?5, ?5, ?6)`,
    ).bind(session, user.id, key, userAgentOf(request), now, now + SESSION_SECONDS * 1000),
  ]);
  return { setCookie: await cookieOf(env, user, session, SESSION_SECONDS), session };
}

/** A NEW SESSION OF A PERSON WHO IS NO MEMBER, whose address a mailed code proved: its row, whose
 *  method is "email", and the cookie that holds the row's id. */
export async function emailSessionCookie(
  env: Env,
  request: Request,
  user: { id: string; email: string },
): Promise<{ setCookie: string; session: string }> {
  const session = newSessionId();
  const now = Date.now();
  await env.DB.prepare(
    `insert into browser_sessions
       (id, user_id, method, key_id, user_agent, created_at, last_seen_at, expires_at)
     values (?1, ?2, 'email', null, ?3, ?4, ?4, ?5)`,
  )
    .bind(session, user.id, userAgentOf(request), now, now + SESSION_SECONDS * 1000)
    .run();
  return { setCookie: await cookieOf(env, user, session, SESSION_SECONDS), session };
}

/** REMOVES THE SESSIONS THAT ARE NO PASSKEY'S AND ARE OVER: ended, or expired. One statement for
 *  the batch that sweeps the mailed codes (./email-sign-in.ts), which runs before any such session
 *  is made, so their rows never outgrow the codes that were asked for. A passkey's rows are kept
 *  for `KEPT_MS` and go at that person's next sign-in (`sessionCookie`). */
export const sessionsOverRemoved = (env: Env, now: number) =>
  env.DB.prepare(
    "delete from browser_sessions where method != 'passkey' and coalesce(ended_at, expires_at) <= ?1",
  ).bind(now);

export const newSessionId = () => `session_${crypto.randomUUID().replaceAll("-", "")}`;

/** The browser's User-Agent as a session's row keeps it. */
export const userAgentOf = (request: Request) =>
  (request.headers.get("user-agent") || "").slice(0, 300);

/** The `Set-Cookie` of the session `session` of `user`, which lasts `seconds`. */
export async function cookieOf(
  env: Env,
  user: { id: string; email: string },
  session: string,
  seconds: number,
) {
  const token = await new SignJWT({ email: user.email, session })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(issuerOf(env))
    .setAudience(AUDIENCE)
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(keyOf(env));
  return cookie(SESSION_COOKIE, token, seconds);
}

/** What the request's session cookie says, when this Worker signed it: the row's id and whose it
 *  is. It is no session yet: its row says whether it is live, and of which kind. */
export async function cookieClaimsOf(
  env: Env,
  request: Request,
): Promise<{ session: string; userId: string; email: string } | null> {
  const token = cookieValueOf(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return null;
  // every bad cookie is no cookie: why it failed is never said
  const claims = await jwtVerify(token, keyOf(env), {
    issuer: issuerOf(env),
    audience: AUDIENCE,
    algorithms: ["HS256"],
  }).then(
    ({ payload }) => payload,
    () => null,
  );
  const email = z.string().safeParse(claims?.email);
  const session = z.string().min(1).safeParse(claims?.session);
  if (!claims?.sub || !email.success || !session.success) return null;
  return { session: session.data, userId: claims.sub, email: email.data };
}

/** THE BROWSER'S SESSION, OF ANYONE SIGNED IN: its cookie, and a row that is not ended and not
 *  expired, of a passkey whose key is not removed (a lost device holds a passkey and its session:
 *  to remove the one must end the other), or of a person who was no member. One read. For a page
 *  that takes a person who is no member: every other page asks `sessionOf`. */
export async function personSessionOf(env: Env, request: Request): Promise<PersonSession | null> {
  const claims = await cookieClaimsOf(env, request);
  if (!claims) return null;
  const now = Date.now();
  const row = await env.DB.prepare(
    `select s.method, s.last_seen_at, s.expires_at from browser_sessions s
     where s.id = ?1 and s.user_id = ?2 and s.ended_at is null and s.expires_at > ?3
       and ${LIVE_PERSON_SESSION}`,
  )
    .bind(claims.session, claims.userId, now)
    .first<{ method: SignInMethod; last_seen_at: number; expires_at: number }>();
  if (!row) return null;
  if (row.last_seen_at < now - SEEN_EVERY_MS) waitUntil(seen(env, claims.session, now));
  return {
    id: claims.session,
    userId: claims.userId,
    email: claims.email,
    method: row.method,
    expiresAt: row.expires_at,
  };
}

/** As SQL over a row `s` of `browser_sessions`: the row is a person's session, a mailed code's
 *  or a passkey's whose key is not removed. So a row that answers it has a `SignInMethod` for
 *  its `method`, and a session that may add a first passkey (./enrolment.ts) never answers. A
 *  passkey that was added while its owner was no member opens no session (../migrations/0016,
 *  ./passkey-sign-in.ts): a row of one is nobody's. */
const LIVE_PERSON_SESSION = `(s.method = 'email' or (s.method = 'passkey' and exists
         (select 1 from keys k
           where k.id = s.key_id and k.user_id = s.user_id and k.revoked_at is null
             and k.outsider = 0)))`;

/** THE BROWSER'S SESSION OF A PASSKEY, the one kind that can be a member's: what every page of
 *  the control plane asks, but the few that take anyone (`personSessionOf`). */
export async function sessionOf(env: Env, request: Request): Promise<Session | null> {
  const session = await personSessionOf(env, request);
  return session?.method === "passkey" ? session : null;
}

/** The conditional write: of two requests at once, one writes. */
async function seen(env: Env, session: string, now: number) {
  await env.DB.prepare(
    "update browser_sessions set last_seen_at = ?2 where id = ?1 and last_seen_at < ?3",
  )
    .bind(session, now, now - SEEN_EVERY_MS)
    .run()
    .catch((error: unknown) =>
      console.warn({ event: "auth.session-seen-failed", message: String(error) }),
    );
}

/** Which of a person's sessions to end: one, every one but this browser's, or every one. */
export type SessionsEnded = { session: string } | { allBut: string } | "all";

/** ENDS THIS BROWSER'S ROW AS ITS COOKIE IS CLEARED: the session the request's cookie holds, of
 *  either kind. Clearing the cookie must not wait on D1: a failure to end the row is logged, and
 *  the caller still answers with the cleared cookie. The row then ends at its own expiry, or on
 *  /sessions. */
export async function endThisSession(env: Env, request: Request, facts: AccountFacts) {
  try {
    const claims = await cookieClaimsOf(env, request);
    if (claims) await endSessions(env, claims.userId, "all", { session: claims.session }, facts);
  } catch (error) {
    console.warn({ event: "auth.session-end-failed", message: String(error) });
  }
}

/** ENDS SESSIONS OF ONE PERSON, each with a fact. A session that is not that person's, that is
 *  not within `reach`, or that ended already, ends nothing. Answers the ids it ended. */
export async function endSessions(
  env: Env,
  userId: string,
  reach: Reach,
  which: SessionsEnded,
  facts: AccountFacts,
): Promise<string[]> {
  const now = Date.now();
  const [condition, bound] =
    which === "all"
      ? ["", []]
      : "session" in which
        ? ["and id = ?3", [which.session]]
        : ["and id != ?3", [which.allBut]];
  const { results } = await env.DB.prepare(
    `update browser_sessions set ended_at = ?2
     where user_id = ?1 and ended_at is null and expires_at > ?2 ${condition}
       ${within(reach, "method")}
     returning id`,
  )
    .bind(userId, now, ...bound)
    .all<{ id: string }>();
  for (const { id } of results)
    facts.add(userId, {
      type: "events.iterate.com/account/session-ended",
      payload: { session: id, at: now },
      idempotencyKey: `account/session-ended/${id}`,
    });
  return results.map(({ id }) => id);
}

/** A person's live sessions, newest first, as /sessions lists them. `method`: as on
 *  `PersonSession`. */
export type SessionRow = {
  id: string;
  method: SignInMethod;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
};

export async function liveSessionsOf(
  env: Env,
  userId: string,
  reach: Reach,
): Promise<SessionRow[]> {
  const { results } = await env.DB.prepare(
    `select s.id, s.method, s.user_agent as userAgent, s.created_at as createdAt,
            s.last_seen_at as lastSeenAt
     from browser_sessions s
     where s.user_id = ?1 and s.ended_at is null and s.expires_at > ?2
       and ${LIVE_PERSON_SESSION}
       ${within(reach, "s.method")}
     order by s.created_at desc`,
  )
    .bind(userId, Date.now())
    .all<SessionRow>();
  return results;
}

export const clearSessionCookie = cookie(SESSION_COOKIE, "", 0);

// A GUEST'S COOKIE (./guest-sign-in.ts) is kept apart from the session's, and proves nothing: the
// authorization endpoint alone reads it (./authorize.ts), for a host's own sign-in whose app names
// guests. It holds no row: the user id, the key of the guest's row and the name they typed, signed.
// It outlives a guest's 15 minutes on an app's host (./oauth.ts), so that a browser that comes back
// is the same guest and is asked for no name again: 30 days from the browser's last visit.
const GUEST_COOKIE = "__Host-iterate-auth-guest-session";
const GUEST_SECONDS = 30 * 24 * 3600;
/** The name form's own cookie: the `next` it goes on to and the form's state, for ten minutes. */
const GUEST_FORM_COOKIE = "__Host-iterate-auth-guest-form";
const GUEST_FORM_SECONDS = 10 * 60;

/** The key of a guest's row in `users.email`: no address, so no proof of an address reaches it. */
export const GUEST_KEY_PREFIX = "guest:";

/** A guest's cookie, set again at each session it earns on an app's host. */
export async function guestCookie(env: Env, guest: { id: string; key: string; name: string }) {
  const token = await signed(env, "guest-session", { key: guest.key, name: guest.name })
    .setSubject(guest.id)
    .setExpirationTime(`${GUEST_SECONDS}s`)
    .sign(keyOf(env));
  return cookie(GUEST_COOKIE, token, GUEST_SECONDS);
}

/** THE GUEST THIS BROWSER IS, or null; `blocked` when an owner blocked them (./members.ts). The
 *  token's audience is this cookie's own: a session's token under this name is no guest. */
export async function guestOf(
  env: Env,
  request: Request,
): Promise<{ userId: string; email: string; name: string; blocked: boolean } | null> {
  const claims = await claimsOf(env, request, GUEST_COOKIE, "guest-session");
  const key = z.string().startsWith(GUEST_KEY_PREFIX).safeParse(claims?.key);
  const name = z.string().min(1).safeParse(claims?.name);
  if (!claims?.sub || !key.success || !name.success) return null;
  return {
    userId: claims.sub,
    email: key.data,
    name: name.data,
    blocked: await isBlocked(env, key.data),
  };
}

/** The name form's cookie: the browser that was shown the form, and where it goes on. */
export async function guestFormCookie(env: Env, form: { next: string; state: string }) {
  const token = await signed(env, "guest-form", form)
    .setExpirationTime(`${GUEST_FORM_SECONDS}s`)
    .sign(keyOf(env));
  return cookie(GUEST_FORM_COOKIE, token, GUEST_FORM_SECONDS);
}

export async function guestFormOf(env: Env, request: Request) {
  const form = z
    .object({ next: z.string(), state: z.string().min(1) })
    .safeParse(await claimsOf(env, request, GUEST_FORM_COOKIE, "guest-form"));
  if (!form.success) return null;
  return form.data;
}

export const clearGuestFormCookie = cookie(GUEST_FORM_COOKIE, "", 0);
export const clearGuestCookie = cookie(GUEST_COOKIE, "", 0);

// A MEMBER OF ANOTHER MIND (./mind-sign-in.ts) has a cookie like a guest's: no row, and read by the
// authorization endpoint alone, for a host's own sign-in whose app names "mind". It holds the user
// id, the key of the row, and the mind that vouched: its id, its hostname and the person's user
// id there. It lasts 24 hours from the vouch and is never set again, so a member whom that mind
// removes keeps this mind's session for 24 hours at most; then their mind is asked again.
const MIND_COOKIE = "__Host-iterate-auth-mind-session";
const MIND_SESSION_SECONDS = 24 * 3600;
/** The sign-in's own cookie, between `POST /sign-in/mind` and the return from the person's mind:
 *  the browser that started it, and what it waits for. The return is a POST from the other mind's
 *  page, a cross-site request, so the cookie is `SameSite=None`: a Lax one is not sent with it.
 *  Its path is the sign-in's alone, so no other request carries it, and with a path it cannot have
 *  the `__Host-` prefix: `__Secure-`, with no Domain, is host-only too. */
const MIND_FORM_COOKIE = "__Secure-iterate-auth-mind-form";
const MIND_FORM_SECONDS = 10 * 60;
export const MIND_FORM_PATH = "/sign-in/mind";

/** The key of a member of another mind's row in `users.email`: `mind:<that mind's id>:<their user
 *  id there>`. No address, so no proof of an address reaches it, and it is nobody's member. */
export const MIND_KEY_PREFIX = "mind:";

/** Whom another mind vouched for: that mind and the person's user id there. */
export type Vouched = { id: string; hostname: string; userId: string };

/** The cookie of a member of another mind, set once at the vouch. */
export async function mindSessionCookie(
  env: Env,
  person: { id: string; key: string; mind: Vouched },
) {
  const { mind } = person;
  const token = await signed(env, "mind-session", {
    key: person.key,
    mind: mind.id,
    hostname: mind.hostname,
    user: mind.userId,
  })
    .setSubject(person.id)
    .setExpirationTime(`${MIND_SESSION_SECONDS}s`)
    .sign(keyOf(env));
  return cookie(MIND_COOKIE, token, MIND_SESSION_SECONDS);
}

/** THE MEMBER OF ANOTHER MIND THIS BROWSER IS, or null; `expiresAt` in epoch milliseconds, the
 *  end that no visit moves. */
export async function mindSessionOf(
  env: Env,
  request: Request,
): Promise<{ userId: string; email: string; mind: Vouched; expiresAt: number } | null> {
  const claims = await claimsOf(env, request, MIND_COOKIE, "mind-session");
  const parsed = z
    .object({
      sub: z.string().startsWith("user_"),
      key: z.string().startsWith(MIND_KEY_PREFIX),
      mind: z.string().min(1),
      hostname: z.string().min(1),
      user: z.string().min(1),
      exp: z.number(),
    })
    .safeParse(claims);
  if (!parsed.success) return null;
  const { sub, key, mind, hostname, user, exp } = parsed.data;
  return {
    userId: sub,
    email: key,
    mind: { id: mind, hostname, userId: user },
    expiresAt: exp * 1000,
  };
}

/** What a sign-in by another mind waits for (./mind-sign-in.ts). */
export type MindForm = {
  next: string;
  /** The host of the app the sign-in is for; a form from before it was kept has none. */
  app?: string;
  hostname: string;
  mind: string;
  state: string;
  nonce: string;
};

export async function mindFormCookie(env: Env, form: MindForm) {
  const token = await signed(env, "mind-form", form)
    .setExpirationTime(`${MIND_FORM_SECONDS}s`)
    .sign(keyOf(env));
  return mindFormCookieOf(token, MIND_FORM_SECONDS);
}

export async function mindFormOf(env: Env, request: Request): Promise<MindForm | null> {
  const form = z
    .object({
      next: z.string().min(1),
      app: z.string().min(1).optional(),
      hostname: z.string().min(1),
      mind: z.string().min(1),
      state: z.string().min(1),
      nonce: z.string().min(1),
    })
    .safeParse(await claimsOf(env, request, MIND_FORM_COOKIE, "mind-form"));
  if (!form.success) return null;
  return form.data;
}

const mindFormCookieOf = (value: string, maxAgeSeconds: number) =>
  `${MIND_FORM_COOKIE}=${value}; HttpOnly; Secure; SameSite=None; Path=${MIND_FORM_PATH}; Max-Age=${maxAgeSeconds}`;

export const clearMindFormCookie = mindFormCookieOf("", 0);

// A MEMBER'S INTENT TO OPEN AN APP OF ANOTHER MIND (./vouch.ts `/sign-in/open`): set by this mind's
// own page, for one use and two minutes, so that a vouch to a mind that this mind lets in goes on
// with no press only when the member began it here. Any other site's link to the vouch gets the
// Continue page.
const VOUCH_INTENT_COOKIE = "__Host-iterate-auth-vouch-intent";
const VOUCH_INTENT_SECONDS = 120;

export async function vouchIntentCookie(env: Env, intent: { app: string; user: string }) {
  const token = await signed(env, "vouch-intent", intent)
    .setExpirationTime(`${VOUCH_INTENT_SECONDS}s`)
    .sign(keyOf(env));
  return cookie(VOUCH_INTENT_COOKIE, token, VOUCH_INTENT_SECONDS);
}

export async function vouchIntentOf(env: Env, request: Request) {
  const intent = z
    .object({ app: z.string().min(1), user: z.string().min(1) })
    .safeParse(await claimsOf(env, request, VOUCH_INTENT_COOKIE, "vouch-intent"));
  if (!intent.success) return null;
  return intent.data;
}

export const clearVouchIntentCookie = cookie(VOUCH_INTENT_COOKIE, "", 0);
export const clearMindCookie = cookie(MIND_COOKIE, "", 0);

// A MIND SIGN-IN THAT JUST COMPLETED (./mind-sign-in.ts): set at the return, for the person it
// made and the app it was for, for 30 seconds: the return goes on to the app, whose guard asks
// the authorization endpoint at once. There it answers that host's `prompt=select_account` once
// (./authorize.ts): a host that the person signed out of asks who they are, and they just said.
// Any authorization clears it, and its `jti` is taken once (`statements`), so it answers one
// prompt at most. `request`: when the sign-in was begun for one authorization request (the
// sign-in page's `next`), a hash of that request (`requestHashOf`), and the mark answers no
// other. A sign-in that an app's page began (iterate/sdk `auth.mindSignIn`) has none: its
// request does not exist yet.
export const MIND_FRESH_COOKIE = "__Host-iterate-auth-mind-fresh";
const MIND_FRESH_SECONDS = 30;

export async function mindFreshCookie(
  env: Env,
  fresh: { user: string; app: string; request: string | null },
) {
  const claims: Record<string, string> = { user: fresh.user, app: fresh.app };
  if (fresh.request) claims.request = fresh.request;
  const token = await signed(env, "mind-fresh", claims)
    .setJti(crypto.randomUUID())
    .setExpirationTime(`${MIND_FRESH_SECONDS}s`)
    .sign(keyOf(env));
  return cookie(MIND_FRESH_COOKIE, token, MIND_FRESH_SECONDS);
}

export async function mindFreshOf(env: Env, request: Request) {
  const fresh = z
    .object({
      user: z.string().min(1),
      app: z.string().min(1),
      request: z.string().min(1).optional(),
      jti: z.string().min(1),
      exp: z.number(),
    })
    .safeParse(await claimsOf(env, request, MIND_FRESH_COOKIE, "mind-fresh"));
  return fresh.success ? fresh.data : null;
}

export const clearMindFreshCookie = cookie(MIND_FRESH_COOKIE, "", 0);

/** A hash of an authorization request, as its path and query without `prompt` (./authorize.ts
 *  `promptOf`, `here`): what a fresh mark and a chooser's choice are bound to. */
export async function requestHashOf(here: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(here));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// THE CHOICE THAT THE CHOOSER OFFERS between a person's session here and a mind sign-in that just
// completed (./authorize.ts `chosen`): set with the chooser's page, for the two people that the
// page names (`person`, `user`), the app's host and that one authorization request (`request`, a
// hash of it), for two minutes. The chooser's POST takes it once (`jti`, `statements`), so one
// page makes one code. `SameSite=Strict` and the authorization endpoint's path: only that page's
// own form sends it. The cookie's name ends with the start of the request's hash, so a chooser
// for another request, in another tab, has a choice of its own.
const MIND_CHOICE_SECONDS = 120;

const mindChoiceNameOf = (requestHash: string) =>
  `__Secure-iterate-auth-mind-choice-${requestHash.slice(0, 16)}`;

export async function mindChoiceCookie(
  env: Env,
  choice: { person: string; user: string; app: string; request: string },
  path: string,
) {
  const token = await signed(env, "mind-choice", choice)
    .setJti(crypto.randomUUID())
    .setExpirationTime(`${MIND_CHOICE_SECONDS}s`)
    .sign(keyOf(env));
  return mindChoiceCookieOf(choice.request, token, MIND_CHOICE_SECONDS, path);
}

/** The choice that this browser holds for the request with the hash `requestHash`. */
export async function mindChoiceOf(env: Env, request: Request, requestHash: string) {
  const choice = z
    .object({
      person: z.string().min(1),
      user: z.string().min(1),
      app: z.string().min(1),
      request: z.literal(requestHash),
      jti: z.string().min(1),
      exp: z.number(),
    })
    .safeParse(await claimsOf(env, request, mindChoiceNameOf(requestHash), "mind-choice"));
  return choice.success ? choice.data : null;
}

const mindChoiceCookieOf = (
  requestHash: string,
  value: string,
  maxAgeSeconds: number,
  path: string,
) =>
  `${mindChoiceNameOf(requestHash)}=${value}; HttpOnly; Secure; SameSite=Strict; Path=${path}; Max-Age=${maxAgeSeconds}`;

export const clearMindChoiceCookie = (requestHash: string, path: string) =>
  mindChoiceCookieOf(requestHash, "", 0, path);

const signed = (env: Env, audience: string, claims: Record<string, string>) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(issuerOf(env))
    .setAudience(audience)
    .setIssuedAt();

/** What the cookie `name` holds, when this Worker signed it for `audience`; every bad cookie is
 *  no cookie. */
async function claimsOf(env: Env, request: Request, name: string, audience: string) {
  const token = cookieValueOf(request.headers.get("cookie"), name);
  if (!token) return null;
  return jwtVerify(token, keyOf(env), {
    issuer: issuerOf(env),
    audience,
    algorithms: ["HS256"],
  }).then(
    ({ payload }) => payload,
    () => null,
  );
}

// `__Host-` binds each cookie to this origin over https. `SameSite=Lax` because a client's link to
// the authorization endpoint is a cross-site navigation.
function cookie(name: string, value: string, maxAgeSeconds: number) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

const keyOf = (env: Env) => new TextEncoder().encode(configOf(env).signingKey.exposeSecret());
