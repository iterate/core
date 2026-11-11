// key-tokens.ts — A TOKEN FOR A KEY, WITH NO PERSON. A service that lends a capability to the mind
// (`iterate provide --key`, core/lib/src/cli/bridge-key.ts) should not hold a person's
// grant, which may do all that person may. A member allows its key once, on /keys/enrol, with the one capability
// it may lend (`provide`). From then on the key signs a statement and gets a token for the mind's
// API that lives an hour. There is no refresh token: the key signs again. The key has no end date,
// and a member ends it on /keys.
//
//   POST /keys/token   { statement, signature } → { access_token, token_type, expires_in, provide }
//
// The statement is of KEY_TOKEN_STATEMENT_TYPE at `/`, ends within five minutes and counts once
// (./keys.ts): what RFC 7523 asks of a client's assertion, in the form the rest of the stack signs.
// Its payload may ask for less than the hour: `{ seconds }`, 60 at least.
import { mindApiUrlOf } from "iterate/mind-api";
import { KEY_TOKEN_STATEMENT_TYPE } from "iterate/signed";
import type { TokenIdentity } from "iterate/workers";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { UNKNOWN_KEY, verifiedStatement } from "./keys.ts";

const TOKEN_SECONDS = 3600;
const FRESH_MS = 5 * 60_000;

// The Worker's one signing key (./cookies.ts). A cookie's audience is a word and a key token's is
// the API's URL, so neither is ever taken for the other.
const signingKey = (env: Env) => new TextEncoder().encode(env.AUTH_SIGNING_KEY);

const Claims = z.object({
  kind: z.literal("key-token"),
  sub: z.string().min(1),
  key: z.string().min(1),
  provide: z.string().min(1),
  exp: z.number(),
});

export async function keyTokenResponse(env: Env, request: Request): Promise<Response> {
  const verified = await verifiedStatement(env, await request.json().catch(() => null));
  if ("refused" in verified)
    return refused(
      verified.refused === UNKNOWN_KEY ? "invalid_client" : "invalid_grant",
      verified.refused,
    );
  const { statement, signer, provide } = verified;
  if (statement.type !== KEY_TOKEN_STATEMENT_TYPE || statement.path !== "/")
    return refused("invalid_grant", `the statement is not ${KEY_TOKEN_STATEMENT_TYPE} at /`);
  if (statement.expires > Date.now() + FRESH_MS)
    return refused("invalid_grant", "the statement must end within five minutes");
  if (!provide)
    return refused(
      "invalid_scope",
      "this key lends nothing: a token is for a key that a member allowed to lend a capability",
    );
  const asked = statement.payload?.seconds;
  const seconds =
    typeof asked === "number" && Number.isFinite(asked)
      ? Math.min(TOKEN_SECONDS, Math.max(60, Math.floor(asked)))
      : TOKEN_SECONDS;
  await env.DB.prepare("update keys set last_used_at = ?1 where id = ?2")
    .bind(Date.now(), signer.key)
    .run();
  const token = await new SignJWT({ kind: "key-token", key: signer.key, provide })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(issuerOf(env))
    .setAudience(mindApiUrlOf(iterateConfigOf(env).domain))
    .setSubject(signer.principal.actor)
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(signingKey(env));
  console.info({
    event: "auth.key-token-issued",
    key: signer.key,
    actor: signer.principal.actor,
    provide,
    seconds,
  });
  return json({ access_token: token, token_type: "Bearer", expires_in: seconds, provide });
}

/** Who a key's token is, for the mind's API and for no other resource. The key's row is read on
 *  every use: a key a member removed, or allowed again for something else, ends its tokens. */
export async function keyTokenIdentity(
  env: Env,
  token: string,
  resource: string,
): Promise<TokenIdentity | null> {
  if (token.split(".").length !== 3 || resource !== mindApiUrlOf(iterateConfigOf(env).domain))
    return null;
  const claims = await jwtVerify(token, signingKey(env), {
    issuer: issuerOf(env),
    audience: resource,
    algorithms: ["HS256"],
  }).then(
    ({ payload }) => Claims.safeParse(payload).data,
    () => undefined,
  );
  if (!claims) return null;
  const live = await env.DB.prepare(
    "select 1 from keys where id = ?1 and actor = ?2 and provide = ?3 and revoked_at is null",
  )
    .bind(claims.key, claims.sub, claims.provide)
    .first();
  if (!live) return null;
  return {
    principal: { actor: claims.sub },
    grant: `key:${claims.key}`,
    expiresAt: claims.exp,
    member: false,
    provide: claims.provide,
  };
}

// The shape of an OAuth token endpoint's refusal (RFC 6749 5.2), so a client reads one field.
function refused(error: "invalid_client" | "invalid_grant" | "invalid_scope", description: string) {
  console.info({ event: "auth.key-token-refused", error, description });
  return json({ error, error_description: description }, error === "invalid_client" ? 401 : 400);
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
