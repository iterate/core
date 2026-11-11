import { sameOriginPath } from "iterate/lib";
import { challengeOf, statementText } from "iterate/signed";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import { sessionCookie } from "./cookies.ts";
import { TOO_MANY } from "./device/limits.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { verifiedStatement } from "./keys.ts";

const PASSKEY_SIGN_IN_PATH = "/sign-in/passkey";
const CHALLENGE_PATH = `${PASSKEY_SIGN_IN_PATH}/challenge`;
const SIGNED_IN = "events.iterate.com/account/signed-in";
const LIFETIME_MS = 5 * 60_000;
const WINDOW_MS = 10 * 60_000;

// The limits of ./device/limits.ts, counted the same way: 20 a client and 120 the stack in ten
// minutes. ?1 challenge, ?2 client, ?3 now, ?4 expires at.
const INSERT_CHALLENGE = `insert into passkey_challenges (challenge, client, created_at, expires_at)
select ?1, ?2, ?3, ?4
where (?2 is null or (select count(*) from passkey_challenges
                      where client = ?2 and created_at > ?3 - ${WINDOW_MS})
                     < 20)
  and (select count(*) from passkey_challenges where created_at > ?3 - ${WINDOW_MS}) < 120
returning challenge`;

const Answer = z.object({
  statement: z.string(),
  credentialId: z.string(),
  sig: z.string(),
  authenticatorData: z.string(),
  clientDataJSON: z.string(),
  next: z.string().optional(),
});

export async function passkeySignInResponse(env: Env, request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== PASSKEY_SIGN_IN_PATH && pathname !== CHALLENGE_PATH) return null;
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (request.headers.get("origin") !== issuerOf(env))
    return json({ error: "Sign in from this site's own page." }, 403);
  return pathname === CHALLENGE_PATH ? challenge(env, request) : finish(env, request);
}

async function challenge(env: Env, request: Request) {
  const now = Date.now();
  const statement = statementText({
    project: iterateConfigOf(env).domain,
    path: "/",
    type: SIGNED_IN,
    at: now,
    expires: now + LIFETIME_MS,
  });
  const made = await challengeOf(statement);
  const [, added] = await env.DB.batch([
    env.DB.prepare("delete from passkey_challenges where created_at <= ?1").bind(now - WINDOW_MS),
    env.DB.prepare(INSERT_CHALLENGE).bind(
      made,
      request.headers.get("cf-connecting-ip") || null,
      now,
      now + LIFETIME_MS,
    ),
  ]);
  if (!added?.results[0]) {
    console.warn({ event: "auth.admission-refused", kind: "passkey" });
    return json({ error: TOO_MANY }, 429);
  }
  return json({ statement, challenge: made });
}

async function finish(env: Env, request: Request) {
  const answer = Answer.safeParse(await request.json().catch(() => null));
  if (!answer.success) return json({ error: "Send the passkey's answer as JSON." }, 400);
  const { statement, credentialId, sig, authenticatorData, clientDataJSON, next } = answer.data;
  // Spent before the check, in one statement: no other request sees it unspent. Only a statement
  // this Worker made has a row, so its type and its end need no second look.
  const spent = await env.DB.prepare(
    "update passkey_challenges set expires_at = 0 where challenge = ?1 and expires_at > ?2 returning challenge",
  )
    .bind(await challengeOf(statement), Date.now())
    .first();
  if (!spent) return json({ error: "This sign-in expired. Try again." }, 403);
  const key = await env.DB.prepare(
    "select id from keys where credential_id = ?1 and format = 'webauthn' and revoked_at is null",
  )
    .bind(credentialId)
    .first<{ id: string }>();
  const verified = key
    ? await verifiedStatement(env, {
        statement,
        signature: { format: "webauthn", key: key.id, sig, authenticatorData, clientDataJSON },
      })
    : { refused: "the passkey is not one this project knows" };
  if ("refused" in verified) return refused(verified.refused);
  const { principal, member, userVerified } = verified.signer;
  if (!principal.email || !member) return refused("its address is not a member here");
  if (!userVerified)
    return refused("it did not check that it is you, by a PIN, a fingerprint or a face");
  const user = { id: principal.actor, email: principal.email };
  console.info({ event: "auth.signed-in", method: "passkey", userId: user.id });
  const facts = new AccountFacts();
  facts.add(user.id, {
    type: SIGNED_IN,
    payload: { method: "passkey", key: verified.signer.key, at: Date.now() },
  });
  const headers = new Headers({
    "set-cookie": await sessionCookie(env, user, "passkey", verified.signer.key),
  });
  return facts.on(json({ next: sameOriginPath(next || "/", issuerOf(env)) }, 200, headers));
}

function refused(reason: string) {
  console.info({ event: "auth.passkey-sign-in-refused", reason });
  return json({ error: `The passkey did not sign you in: ${reason}.` }, 403);
}

function json(body: unknown, status = 200, headers = new Headers()) {
  headers.set("cache-control", "no-store");
  return Response.json(body, { status, headers });
}
