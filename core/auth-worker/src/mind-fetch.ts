// A MIND'S SIGNED REQUEST, CHECKED (`AuthService.mindOfSignedRequest`). The statement covers the
// method and the URL, no body: TLS protects the body and a WebSocket's frames alike.
import {
  envelopeOfStatementHeader,
  ITERATE_STATEMENT_HEADER,
  MIND_FETCH_STATEMENT_TYPE,
  statementOf,
  verifySignature,
} from "iterate/signed";
import type { AuthService } from "iterate/workers";
import { z } from "zod";
import { configOf, type Env, issuerOf } from "./env.ts";
import { mindSignerOf } from "./minds.ts";
import { stackKeyOf } from "./stack-key.ts";

/** A mind's signed request lives five minutes (the sender's `signedByStack`, 300 seconds). */
const LIFETIME_MS = 300_000;
/** What the two clocks may differ by. */
const CLOCK_SKEW_MS = 30_000;

const FetchPayload = z.strictObject({ method: z.string(), url: z.string() });

/** WHO SENT A MIND'S SIGNED REQUEST, or why it is refused, with one log line that names the
 *  method and the URL's origin and path alone. The statement's text is checked first, unproven,
 *  only to spare a log read; then the signer's identity log, the key's format and the signature,
 *  so every field is the signer's word; then the clock again.
 *
 *  ONE STATEMENT SERVES EVERY REQUEST with its method and URL while it lives: a sender signs once
 *  for each signer, mind, method and URL, and uses it again while it has more than a minute to
 *  live (iterate/signed `mindFetchStatements`). For five minutes whoever holds it can repeat that
 *  method to that URL of this mind. The holders: the two minds' platforms, and a server that is
 *  no mind but gets one, which can echo it in a body to the sender's code. Workers Logs redact
 *  it by its name.
 *
 *  IT PROVES a working key that `from`'s log lists, read from the genesis, not the mind's current
 *  key. Key an app by `actor`, the id the genesis proves, never by `hostname`, a label. */
export async function mindOfSignedRequest(
  env: Env,
  input: Parameters<AuthService["mindOfSignedRequest"]>[0],
): ReturnType<AuthService["mindOfSignedRequest"]> {
  const { answer, hostname } = await checked(env, input);
  const asked = URL.parse(input.url);
  const request = { method: input.method, origin: asked?.origin, pathname: asked?.pathname };
  if ("refused" in answer)
    console.info({
      event: "auth.mind-request-refused",
      reason: answer.refused,
      hostname,
      ...request,
    });
  else
    console.info({
      event: "auth.mind-request-stamped",
      mind: answer.principal.actor,
      hostname: answer.principal.hostname,
      ...request,
    });
  return answer;
}

async function checked(
  env: Env,
  { statement: header, method, url }: Parameters<AuthService["mindOfSignedRequest"]>[0],
): Promise<{ answer: Awaited<ReturnType<AuthService["mindOfSignedRequest"]>>; hostname?: string }> {
  const envelope = envelopeOfStatementHeader(header);
  if (!envelope)
    return { answer: { refused: `${ITERATE_STATEMENT_HEADER} holds no signed statement` } };
  const fields = statementOf(envelope.statement);
  if ("refused" in fields) return { answer: fields };
  // unverified text: what a log line names of it is bounded
  const hostname = fields.from?.slice(0, 80);
  const refused = (reason: string) => ({ answer: { refused: reason }, hostname });
  const asked = URL.parse(url);
  if (!asked) return refused("the request's URL is no absolute URL");
  if (fields.type !== MIND_FETCH_STATEMENT_TYPE)
    return refused(`the statement is no ${MIND_FETCH_STATEMENT_TYPE}`);
  if (envelope.signature.format !== "ML-DSA-65")
    return refused("a mind's signed request is signed with its working key, ML-DSA-65");
  if (fields.from === configOf(env).controlPlaneHostname)
    return refused("a mind is no caller of itself: the statement is from this mind");
  if (fields.mind !== configOf(env).controlPlaneHostname)
    return refused("the statement is for another mind");
  if (fields.path !== "/") return refused('a signed request\'s statement has the path "/"');
  const payload = FetchPayload.safeParse(fields.payload);
  if (!payload.success) return refused("the statement's payload is { method, url }");
  if (payload.data.method !== method.toUpperCase())
    return refused(`the statement is for ${payload.data.method}, not ${method.toUpperCase()}`);
  if (payload.data.url !== asked.href) return refused("the statement is for another URL");
  const now = Date.now();
  if (fields.expires <= now) return refused("the statement has expired");
  if (
    fields.at >= fields.expires ||
    fields.at > now + CLOCK_SKEW_MS ||
    fields.expires - fields.at > LIFETIME_MS
  )
    return refused(
      "a signed request's statement starts before it ends, now, and lives five minutes at most",
    );
  if (envelope.signature.key === (await stackKeyOf(env)).key)
    return refused("the stack's own key signs for others, not for this stack");
  const signer = await mindSignerOf(env, envelope);
  if (!signer) return refused("the statement names no mind as `from`");
  if ("refused" in signer) return { answer: signer, hostname };
  if (signer.mind === configOf(env).mindId)
    return refused("a mind is no caller of itself: the statement is this mind's own");
  if (signer.key.format !== envelope.signature.format)
    return refused(`this key signs as ${signer.key.format}`);
  const issuer = issuerOf(env);
  const verified = await verifySignature(envelope, signer.key.publicKey, {
    origin: issuer,
    rpId: new URL(issuer).hostname,
  });
  if ("refused" in verified) return { answer: verified, hostname };
  // the clock again, after the log read: a statement that ended on the way stamps nobody
  if (Date.now() >= fields.expires) return refused("the statement has expired");
  return {
    answer: {
      principal: { actor: signer.mind, kind: "mind", hostname: signer.hostname },
      expiresAt: Math.floor(fields.expires / 1000),
    },
    hostname,
  };
}
