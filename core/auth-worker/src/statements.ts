import { envelopeOf, statementHashOf } from "iterate/signed";
import { withFacts } from "iterate/facts";
import type { Env } from "./env.ts";
import { canonicalPath, underPaths } from "./key-rules.ts";
import { verifiedStatement } from "./keys.ts";

export const STATEMENTS_PATH = "/statements";

// Ingress appends these events as the platform, so the kernel's guard on platform facts
// (core/itx caller.ts `refuseNonPlatformWrites`) cannot catch them: this list must.
const PLATFORM_NAMESPACES = ["itx", "mind", "email", "webhook", "mcp", "account", "secret"];

export async function statementsResponse(env: Env, request: Request): Promise<Response> {
  const envelope = envelopeOf(await request.json().catch(() => null));
  if (!envelope)
    return Response.json(
      { refused: "send an envelope, { statement, signature }, as JSON" },
      { status: 400 },
    );
  const verified = await verifiedStatement(env, envelope);
  if ("refused" in verified) return Response.json(verified, { status: 403 });
  const { signer, statement, paths } = verified;
  if (!canonicalPath(statement.path))
    return Response.json(
      { refused: "name the context by its own path: no empty, . or .. segment" },
      { status: 403 },
    );
  if (!underPaths(statement.path, paths))
    return Response.json(
      { refused: `this key adds events under ${paths!.join(", ")} alone` },
      { status: 403 },
    );
  if (
    PLATFORM_NAMESPACES.some((namespace) =>
      statement.type.startsWith(`events.iterate.com/${namespace}/`),
    )
  )
    return Response.json({ refused: `${statement.type} is the platform's own` }, { status: 403 });
  const idempotencyKey = `statement:${await statementHashOf(envelope.statement)}`;
  return withFacts(Response.json({ path: statement.path, type: statement.type, idempotencyKey }), [
    {
      path: statement.path,
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
  ]);
}
