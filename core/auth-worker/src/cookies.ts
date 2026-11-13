import { waitUntil } from "cloudflare:workers";
import { cookieValueOf } from "iterate/lib";
import { SignInMethod } from "iterate/principal";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { AccountFacts } from "./account-facts.ts";
import { FIRST_OWNER_TICKET_MS } from "./config.ts";
import { type Env, issuerOf } from "./env.ts";

// A browser's session at the issuer is a row of `browser_sessions` (../migrations/0011), and its
// cookie holds the row's id. It ends at expiry, at sign-out, on /sessions (./sessions-page.ts),
// with the passkey that opened it, or for everyone when AUTH_SIGNING_KEY changes. Membership is
// checked again on every use.
const SESSION_COOKIE = "__Host-iterate-auth-session";
const SESSION_SECONDS = 30 * 24 * 3600;
// Cloudflare's session is kept apart from the mind's: ./cloudflare-sign-in.ts says why.
const CLOUDFLARE_SESSION_COOKIE = "__Host-iterate-auth-cloudflare-session";
const CLOUDFLARE_SESSION_SECONDS = 7 * 24 * 3600;
/** `last_seen_at` is written at most this often: a D1 write on every request would cost. */
const SEEN_EVERY_MS = 10 * 60_000;
/** An ended or expired row stays this long, then the user's next sign-in deletes it. */
const KEPT_MS = 30 * 24 * 3600_000;
const FLOW_COOKIE = "__Host-iterate-auth-sign-in";
const FLOW_SECONDS = 10 * 60;

/** How a session was opened (iterate/principal `SignInMethod`) is kept in its row as `method`.
 *  "cloudflare" is never in a row: `cloudflareSessionOf` alone answers it. */
const BrowserSignInMethod = SignInMethod.exclude(["cloudflare"]);

export type Session = { userId: string; email: string; method: SignInMethod };

/** A session at the issuer that has its row: every session but Cloudflare's. `id` is the row's. */
export type BrowserSession = Session & { id: string; method: BrowserSignInMethod };
export type BrowserSignInMethod = z.infer<typeof BrowserSignInMethod>;

/** A sign-in at Google that this browser began (./google-sign-in.ts): where it goes after, and
 *  what Google's answer must carry. */
const Flow = z.object({
  next: z.string(),
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
});
type Flow = z.infer<typeof Flow>;

/** A NEW SESSION: its row, and the cookie that holds the row's id. `key`: the id of the passkey
 *  that opened it, for the method "passkey". `request` is the sign-in's, for its User-Agent. */
export async function sessionCookie(
  env: Env,
  request: Request,
  user: { id: string; email: string },
  method: BrowserSignInMethod,
  key?: string,
): Promise<{ setCookie: string; session: string }> {
  // a ticket's or a link's session lasts as long as a ticket: it is there to add a passkey, and no
  // key ends it
  const seconds =
    method === "first-owner-ticket" || method === "member-link"
      ? FIRST_OWNER_TICKET_MS / 1000
      : SESSION_SECONDS;
  const session = `session_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `delete from browser_sessions
       where user_id = ?1 and coalesce(ended_at, expires_at) < ?2`,
    ).bind(user.id, now - KEPT_MS),
    env.DB.prepare(
      `insert into browser_sessions
         (id, user_id, method, key_id, user_agent, created_at, last_seen_at, expires_at)
       values (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)`,
    ).bind(
      session,
      user.id,
      method,
      method === "passkey" ? key || null : null,
      (request.headers.get("user-agent") || "").slice(0, 300),
      now,
      now + seconds * 1000,
    ),
  ]);
  const claims = { email: user.email, session };
  const setCookie = cookie(
    SESSION_COOKIE,
    await sign(env, "session", claims, user.id, seconds),
    seconds,
  );
  return { setCookie, session };
}

/** THE BROWSER'S SESSION: its cookie, and a row that is not ended, not expired and, for a passkey's
 *  session, whose passkey is not removed (a lost device holds a passkey and its session: to remove
 *  the one must end the other). One read. */
export async function sessionOf(env: Env, request: Request): Promise<BrowserSession | null> {
  const claims = await verified(env, request, SESSION_COOKIE, "session");
  const email = z.string().safeParse(claims?.email);
  const id = z.string().min(1).safeParse(claims?.session);
  if (!claims?.sub || !email.success || !id.success) return null;
  const now = Date.now();
  const row = await env.DB.prepare(
    `select s.method, s.last_seen_at from browser_sessions s
     where s.id = ?1 and s.user_id = ?2 and s.ended_at is null and s.expires_at > ?3
       and (s.key_id is null or exists (select 1 from keys k
         where k.id = s.key_id and k.user_id = s.user_id and k.revoked_at is null))`,
  )
    .bind(id.data, claims.sub, now)
    .first<{ method: string; last_seen_at: number }>();
  const method = BrowserSignInMethod.safeParse(row?.method);
  if (!row || !method.success) return null;
  if (row.last_seen_at < now - SEEN_EVERY_MS) waitUntil(seen(env, id.data, now));
  return { id: id.data, userId: claims.sub, email: email.data, method: method.data };
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

/** ENDS THIS BROWSER'S ROW AS ITS COOKIE IS CLEARED: the session `from` names, or the one the
 *  request's cookie holds. Cloudflare's session has no row. Clearing the cookie must not wait on
 *  D1: a failure to end the row is logged, and the caller still answers with the cleared cookie.
 *  The row then ends at its own expiry, or on /sessions. */
export async function endThisSession(env: Env, from: Request | Session, facts: AccountFacts) {
  try {
    const session = from instanceof Request ? await sessionOf(env, from) : from;
    if (session && "id" in session && typeof session.id === "string")
      await endSessions(env, session.userId, { session: session.id }, facts);
  } catch (error) {
    console.warn({ event: "auth.session-end-failed", message: String(error) });
  }
}

/** ENDS SESSIONS OF ONE PERSON, each with a fact. A session that is not that person's, or that
 *  ended already, ends nothing. Answers the ids it ended. */
export async function endSessions(
  env: Env,
  userId: string,
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

/** A person's live sessions, newest first, as /sessions lists them. */
export type SessionRow = {
  id: string;
  method: BrowserSignInMethod;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
};

export async function liveSessionsOf(env: Env, userId: string): Promise<SessionRow[]> {
  const { results } = await env.DB.prepare(
    `select s.id, s.method, s.user_agent, s.created_at, s.last_seen_at from browser_sessions s
     where s.user_id = ?1 and s.ended_at is null and s.expires_at > ?2
       and (s.key_id is null or exists (select 1 from keys k
         where k.id = s.key_id and k.user_id = s.user_id and k.revoked_at is null))
     order by s.created_at desc`,
  )
    .bind(userId, Date.now())
    .all<{
      id: string;
      method: string;
      user_agent: string;
      created_at: number;
      last_seen_at: number;
    }>();
  return results.flatMap((row) => {
    const method = BrowserSignInMethod.safeParse(row.method);
    return method.success
      ? [
          {
            id: row.id,
            method: method.data,
            userAgent: row.user_agent,
            createdAt: row.created_at,
            lastSeenAt: row.last_seen_at,
          },
        ]
      : [];
  });
}

export const clearSessionCookie = cookie(SESSION_COOKIE, "", 0);

export async function cloudflareSessionCookie(env: Env, user: { id: string; email: string }) {
  return cookie(
    CLOUDFLARE_SESSION_COOKIE,
    await sign(
      env,
      "cloudflare-session",
      { email: user.email },
      user.id,
      CLOUDFLARE_SESSION_SECONDS,
    ),
    CLOUDFLARE_SESSION_SECONDS,
  );
}

/** The sign-in at Cloudflare this browser holds. The token's audience is this cookie's own, so the
 *  mind's session cookie under this name is no session, and this one under that name is none. */
export async function cloudflareSessionOf(env: Env, request: Request): Promise<Session | null> {
  const claims = await verified(env, request, CLOUDFLARE_SESSION_COOKIE, "cloudflare-session");
  const email = z.string().safeParse(claims?.email);
  if (!claims?.sub || !email.success) return null;
  return { userId: claims.sub, email: email.data, method: "cloudflare" };
}

export const clearCloudflareSessionCookie = cookie(CLOUDFLARE_SESSION_COOKIE, "", 0);

export async function flowCookie(env: Env, flow: Flow) {
  return cookie(
    FLOW_COOKIE,
    await sign(env, "sign-in", flow, undefined, FLOW_SECONDS),
    FLOW_SECONDS,
  );
}

export async function flowOf(env: Env, request: Request): Promise<Flow | null> {
  const parsed = Flow.safeParse(await verified(env, request, FLOW_COOKIE, "sign-in"));
  return parsed.success ? parsed.data : null;
}

export const clearFlowCookie = cookie(FLOW_COOKIE, "", 0);

// `__Host-` binds each cookie to this origin over https. `SameSite=Lax` because a client's link
// to the authorization endpoint and Google's redirect back are cross-site navigations.
function cookie(name: string, value: string, maxAgeSeconds: number) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

const keyOf = (env: Env) => new TextEncoder().encode(env.AUTH_SIGNING_KEY);

function sign(
  env: Env,
  audience: string,
  claims: Record<string, unknown>,
  subject: string | undefined,
  seconds: number,
) {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(issuerOf(env))
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`);
  if (subject) jwt.setSubject(subject);
  return jwt.sign(keyOf(env));
}

// Every bad cookie is no cookie: why it failed is never said.
async function verified(env: Env, request: Request, name: string, audience: string) {
  const token = cookieValueOf(request.headers.get("cookie"), name);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keyOf(env), {
      issuer: issuerOf(env),
      audience,
      algorithms: ["HS256"],
    });
    return payload;
  } catch {
    return null;
  }
}
