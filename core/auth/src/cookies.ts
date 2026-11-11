import { cookieValueOf } from "iterate/lib";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { FIRST_OWNER_TICKET_MS } from "./config.ts";
import { type Env, issuerOf } from "./env.ts";

// A session has no server-side record: it ends at expiry, at sign-out, with the passkey that opened
// it, or for everyone when AUTH_SIGNING_KEY changes. Membership is checked again on every use.
const SESSION_COOKIE = "__Host-iterate-auth-session";
const SESSION_SECONDS = 30 * 24 * 3600;
const FLOW_COOKIE = "__Host-iterate-auth-sign-in";
const FLOW_SECONDS = 10 * 60;

/** How a session was opened, kept in its cookie as `method`: what the person proved to get it. */
const SignInMethod = z.enum(["iterate", "email", "passkey", "first-owner-ticket"]);
export type SignInMethod = z.infer<typeof SignInMethod>;

/** `method` is absent in a cookie made before the claim was. */
export type Session = { userId: string; email: string; method?: SignInMethod };

const Flow = z.object({ next: z.string(), state: z.string(), verifier: z.string() });
type Flow = z.infer<typeof Flow>;

/** `key`: the id of the passkey that opened the session, for the method "passkey". */
export async function sessionCookie(
  env: Env,
  user: { id: string; email: string },
  method: SignInMethod,
  key?: string,
) {
  const claims = { email: user.email, method, key };
  // the ticket's session lasts as long as a ticket: it is there to add a passkey, and no key ends it
  const seconds = method === "first-owner-ticket" ? FIRST_OWNER_TICKET_MS / 1000 : SESSION_SECONDS;
  return cookie(SESSION_COOKIE, await sign(env, "session", claims, user.id, seconds), seconds);
}

export async function sessionOf(env: Env, request: Request): Promise<Session | null> {
  const claims = await verified(env, request, SESSION_COOKIE, "session");
  const email = z.string().safeParse(claims?.email);
  if (!claims?.sub || !email.success) return null;
  const method = SignInMethod.safeParse(claims.method).data;
  // A lost device holds a passkey and its session: to remove the one must end the other.
  if (method === "passkey") {
    const live = await env.DB.prepare(
      "select 1 from keys where id = ?1 and user_id = ?2 and revoked_at is null",
    )
      .bind(String(claims.key), claims.sub)
      .first();
    if (!live) return null;
  }
  return { userId: claims.sub, email: email.data, method };
}

export const clearSessionCookie = cookie(SESSION_COOKIE, "", 0);

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

// `__Host-` binds each cookie to this origin over https. `SameSite=Lax` because the upstream's
// redirect back and a client's link to the authorization endpoint are cross-site navigations.
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
