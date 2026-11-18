import { type Envelope, envelopeOf, PLATFORM_NAMESPACES, statementHashOf } from "iterate/signed";
import { type Facts, withFacts } from "iterate/facts";
import { isBlocked } from "./blocked.ts";
import { type Env, iterateConfigOf } from "./env.ts";
import { canonicalPath, underPaths } from "./key-rules.ts";
import { personKeyRefusal, verifiedStatement } from "./keys.ts";
import { configuredMeld } from "./minds.ts";

// Ingress appends a statement's event as the platform, so the kernel's guard on platform facts
// (core/itx caller.ts `refuseNonPlatformWrites`) cannot catch every one: `PLATFORM_NAMESPACES`
// must.

/** The most JSON a statement's payload holds where a size is checked: a draft's
 *  (./statement-drafts.ts), and what someone who is no member signs. */
export const MOST_PAYLOAD_BYTES = 64 * 1024;
/** The most a non-member's whole envelope holds, the statement's text and its signature: a payload
 *  of `MOST_PAYLOAD_BYTES` and 8 KiB for the rest. The signer writes every field of it. */
const MOST_OUTSIDER_ENVELOPE_BYTES = MOST_PAYLOAD_BYTES + 8 * 1024;
/** THE MOST STATEMENTS THAT ONE KEY OF SOMEONE WHO IS NO MEMBER SIGNS IN AN HOUR. Each new one is
 *  an event that wakes the person's context and runs the mind's `processEvent`, and a passkey in
 *  software signs in a loop. The same statement sent again counts once. */
export const OUTSIDER_STATEMENTS_AN_HOUR = 20;
const HOUR_MS = 3600 * 1000;

const bytesOf = (value: string) => new TextEncoder().encode(value).length;

export async function statementsResponse(env: Env, request: Request): Promise<Response> {
  const envelope = envelopeOf(await request.json().catch(() => null));
  if (!envelope)
    return Response.json(
      { refused: "send an envelope, { statement, signature }, as JSON" },
      { status: 400 },
    );
  const admitted = await admittedStatement(env, envelope);
  if ("refused" in admitted)
    return Response.json({ refused: admitted.refused }, { status: admitted.status || 403 });
  // The event is the act, so the boundary answers this 200 only once the log has it
  // (iterate/facts `storeFirst`), and 503 when it has not.
  return withFacts(Response.json(admitted.answer), admitted.facts);
}

/** THE INTAKE OF AN ENVELOPE: the event it adds, or why not. `POST /statements` and the press on a
 *  draft's page (./statement-drafts.ts) both take a statement through it. `status`: the HTTP status
 *  of a refusal that is not 403. */
export async function admittedStatement(
  env: Env,
  envelope: Envelope,
): Promise<
  | { answer: { path: string; type: string; idempotencyKey: string }; facts: Facts }
  | { refused: string; status?: number }
> {
  // Taken again when it comes again: this Worker cannot know that the first try's event was
  // stored, and a sender that got no 200 sends the same statement. The event's key is the
  // statement's hash, so the log stores it once, however often it comes.
  const verified = await verifiedStatement(env, envelope, { once: false });
  if ("refused" in verified) return refused(verified.refused);
  const { signer, statement, paths } = verified;
  // a person's key has no paths, so it adds at any path: only a member's does, and anyone else's
  // at their own context alone
  const notThisPerson = personKeyRefusal(signer, statement.path);
  if (notThisPerson) return { refused: notThisPerson };
  // SOMEONE WHO IS NO MEMBER: an app's end user, a removed member, the holder of a passkey from
  // before its address was a member. An owner's block ends what they sign too (./blocked.ts), and
  // what they sign is small.
  const outsider = signer.principal.email && !signer.member ? signer.principal.email : null;
  if (outsider && (await isBlocked(env, outsider)))
    return refused(`${outsider} is blocked here, so its key signs nothing`);
  if (
    outsider &&
    (bytesOf(JSON.stringify(statement.payload || {})) > MOST_PAYLOAD_BYTES ||
      bytesOf(envelope.statement) + bytesOf(JSON.stringify(envelope.signature)) >
        MOST_OUTSIDER_ENVELOPE_BYTES)
  )
    return refused(
      "a statement of someone who is no member here holds a payload of at most 64 KiB of JSON",
      413,
    );
  // A rule that lets a mind in is a member's alone: a melded mind must never widen its own rule.
  if (statement.type.startsWith("events.iterate.com/mind-meld/") && !signer.member)
    return refused("only a member's passkey sets a mind meld");
  if (statement.type === "events.iterate.com/mind-meld/configured") {
    // the row first: the event is the record, the row its copy for the check of a mind's statement
    const meld = await configuredMeld(env, {
      path: statement.path,
      payload: statement.payload,
      at: statement.at,
      by: signer.principal.actor,
      own: iterateConfigOf(env).domain,
    });
    if ("refused" in meld) return refused(meld.refused);
  }
  if (!canonicalPath(statement.path))
    return { refused: "name the context by its own path: no empty, . or .. segment" };
  if (!underPaths(statement.path, paths))
    return {
      refused: paths?.length
        ? `this key adds events under ${paths.join(", ")} alone`
        : "this key adds no events: it only lends a capability",
    };
  if (
    PLATFORM_NAMESPACES.some((namespace) =>
      statement.type.startsWith(`events.iterate.com/${namespace}/`),
    )
  )
    return { refused: `${statement.type} is the platform's own` };
  const hash = await statementHashOf(envelope.statement);
  // last, so that a statement which is refused counts for nothing
  if (outsider && !(await countedForOutsider(env, signer.key, hash)))
    return refused(
      `this key signed ${OUTSIDER_STATEMENTS_AN_HOUR} statements in the last hour, the most for someone who is no member here. Try again later`,
      429,
    );
  // A mind signs each try of one event anew, so its key is the event it names (`about`), not the
  // statement's hash: the log keeps that event once, however often the mind sends it.
  const idempotencyKey =
    signer.principal.kind === "mind" && statement.about?.length
      ? `mind:${signer.principal.actor}:${statement.about.join(" ")}`
      : `statement:${hash}`;
  return {
    answer: { path: statement.path, type: statement.type, idempotencyKey },
    facts: [
      {
        path: statement.path,
        storeFirst: true,
        events: [
          {
            type: statement.type,
            payload: statement.payload,
            idempotencyKey,
            signed: envelope,
            // `member`: as it was at this signing. A reader that wants a member's word checks it:
            // the same stamp names someone who is none.
            source: {
              signer: { principal: signer.principal, key: signer.key, member: signer.member },
            },
          },
        ],
      },
    ],
  };
}

/** Whether `key`, a non-member's, may sign the statement `hash` now: it is one of the hour's
 *  `OUTSIDER_STATEMENTS_AN_HOUR`, or it came before. One statement counts and writes, so of many
 *  requests at once no more than the bound get through. */
async function countedForOutsider(env: Env, key: string, hash: string): Promise<boolean> {
  const now = Date.now();
  const [, counted] = await env.DB.batch<{ hash: string }>([
    env.DB.prepare("delete from outsider_statements where at <= ?1").bind(now - HOUR_MS),
    env.DB.prepare(
      `insert into outsider_statements (hash, key, at)
       select ?1, ?2, ?3
       where exists (select 1 from outsider_statements where hash = ?1)
          or (select count(*) from outsider_statements where key = ?2 and at > ?3 - ${HOUR_MS})
             < ${OUTSIDER_STATEMENTS_AN_HOUR}
       on conflict (hash) do update set at = outsider_statements.at
       returning hash`,
    ).bind(hash, key, now),
  ]);
  return Boolean(counted?.results.length);
}

function refused(reason: string, status?: number) {
  console.info({ event: "auth.statement-refused", reason });
  return status ? { refused: reason, status } : { refused: reason };
}
