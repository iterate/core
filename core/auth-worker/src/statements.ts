import { type Envelope, envelopeOf, statementHashOf } from "iterate/signed";
import { type Facts, withFacts } from "iterate/facts";
import type { Env } from "./env.ts";
import { canonicalPath, underPaths } from "./key-rules.ts";
import { personKeyRefusal, verifiedStatement } from "./keys.ts";

// Ingress appends these events as the platform, so the kernel's guard on platform facts
// (core/itx caller.ts `refuseNonPlatformWrites`) cannot catch them: this list must.
export const PLATFORM_NAMESPACES = [
  "itx",
  "mind",
  "email",
  "webhook",
  "mcp",
  "account",
  "secret",
  "approval",
];

export async function statementsResponse(env: Env, request: Request): Promise<Response> {
  const envelope = envelopeOf(await request.json().catch(() => null));
  if (!envelope)
    return Response.json(
      { refused: "send an envelope, { statement, signature }, as JSON" },
      { status: 400 },
    );
  const admitted = await admittedStatement(env, envelope);
  if ("refused" in admitted) return Response.json(admitted, { status: 403 });
  // The event is the act, so the boundary answers this 200 only once the log has it
  // (iterate/facts `storeFirst`), and 503 when it has not.
  return withFacts(Response.json(admitted.answer), admitted.facts);
}

/** THE INTAKE OF AN ENVELOPE: the event it adds, or why not. `POST /statements` and the press on a
 *  draft's page (./statement-drafts.ts) both take a statement through it. */
export async function admittedStatement(
  env: Env,
  envelope: Envelope,
): Promise<
  | { answer: { path: string; type: string; idempotencyKey: string }; facts: Facts }
  | { refused: string }
> {
  // Taken again when it comes again: this Worker cannot know that the first try's event was
  // stored, and a sender that got no 200 sends the same statement. The event's key is the
  // statement's hash, so the log stores it once, however often it comes.
  const verified = await verifiedStatement(env, envelope, { once: false });
  if ("refused" in verified) return verified;
  const { signer, statement, paths } = verified;
  // a person's key has no paths, so it adds at any path: only a member's does
  const notThisPerson = personKeyRefusal(signer);
  if (notThisPerson) return { refused: notThisPerson };
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
  const idempotencyKey = `statement:${await statementHashOf(envelope.statement)}`;
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
            source: { signer: { principal: signer.principal, key: signer.key } },
          },
        ],
      },
    ],
  };
}
