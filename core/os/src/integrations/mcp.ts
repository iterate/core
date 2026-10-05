// integrations/mcp.ts — THE MCP WEBHOOK: where an MCP server delivers the events a context subscribed
// to (library/mcp.ts `subscribe`), in the webhook mode of the draft MCP Events extension
// (github.com/modelcontextprotocol/experimental-ext-triggers-events). One URL per context and
// server: `/api/integrations/mcp/webhook?project=…&path=…&server=…`. Its Standard Webhooks secret is
// an HMAC of those three under the platform's signing key, so nothing is stored and a server holds
// the secret for its own URL only: it cannot sign for another server or another context. The route
// derives the secret again from the URL and verifies the signature; a `verification` challenge is
// echoed, and every other body lands on the context as `events.iterate.com/mcp/webhook-received`.
// Unsubscribing asks the server to stop; the secret itself keeps working while `secretsEncryption.key` does.

import { Webhook } from "standardwebhooks";
import { z } from "zod";
import { errorCode, ITERATE_CAUSE_HEADER } from "iterate/lib";
import { iterateConfigOf, sessionSigningSecretOf, type IterateConfig } from "../iterate-config.ts";
import { LOOP_DEPTH_LIMIT, parseCause, storedCause } from "../cause.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import type { Env } from "../env.ts";
import { hmacSha256Hex } from "../secrets.ts";
import { appendPlatformFact } from "./connections.ts";

const MCP_WEBHOOK_PATH = "/api/integrations/mcp/webhook";

/** What a webhook URL names: the context it delivers to and the server it is for. */
const MCPWebhookTarget = z.object({
  project: z.string().min(1),
  path: z.string().min(1),
  server: z.string().min(1),
});

/** The webhook the MCP server at `server` delivers the context `{ projectId, path }`'s events to,
 *  and the secret it signs them with. */
export async function mcpWebhookOf(
  iterateConfig: IterateConfig,
  platformOrigin: string | null,
  { projectId, path }: { projectId: string; path: string },
  server: string,
) {
  if (!platformOrigin)
    throw new Error("MCP events: this context knows no platform origin to receive them on");
  const target = { project: projectId, path, server };
  const url = new URL(`${MCP_WEBHOOK_PATH}?${new URLSearchParams(target)}`, platformOrigin);
  return { url: url.href, secret: await webhookSecretOf(iterateConfig, target) };
}

/** A webhook's Standard Webhooks secret: `whsec_` and the base64 of the 64 hex digits of an HMAC of
 *  its target, which Standard Webhooks takes as the secret's 64 bytes. */
const webhookSecretOf = async (
  iterateConfig: IterateConfig,
  target: z.output<typeof MCPWebhookTarget>,
) =>
  `whsec_${btoa(
    await hmacSha256Hex(
      await sessionSigningSecretOf(iterateConfig),
      `mcp-webhook-secret:${JSON.stringify([target.project, target.path, target.server])}`,
    ),
  )}`;

/** A delivery's response, or null when the path is not the MCP webhook's. */
export async function mcpWebhookRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== MCP_WEBHOOK_PATH) return null;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const target = MCPWebhookTarget.safeParse(Object.fromEntries(url.searchParams));
  if (!target.success) return Response.json({ error: "Unknown MCP webhook." }, { status: 404 });
  let body: unknown;
  try {
    body = new Webhook(await webhookSecretOf(iterateConfigOf(env), target.data)).verify(
      await request.text(),
      Object.fromEntries(request.headers),
    );
  } catch {
    return Response.json({ error: "Invalid MCP webhook signature." }, { status: 401 });
  }
  const { project, path, server } = target.data;
  // 410: the server drops the delivery; a deleted project's context must not be born again
  if (await new ControlPlane(env).deletedProject(project))
    return Response.json({ error: "The project was deleted." }, { status: 410 });
  const verification = z
    .object({ type: z.literal("verification"), challenge: z.string() })
    .safeParse(body);
  if (verification.success) return Response.json({ challenge: verification.data.challenge });
  // A delivery our own server sent (mcp-events.ts) resumes the chain its mark carries, so a context
  // that watches itself stops at the loop limit; any other begins one. Always recorded, as mail is.
  const mark = parseCause(request.headers.get(ITERATE_CAUSE_HEADER));
  try {
    await appendPlatformFact(
      env,
      project,
      path,
      {
        type: "events.iterate.com/mcp/webhook-received",
        // `webhook-id` is signed and is the event's `eventId`, so a retry is stored once
        idempotencyKey: `mcp-webhook:${JSON.stringify([server, request.headers.get("webhook-id")])}`,
        // the subscription id is only in a header, unsigned, and the one name a `terminated` or
        // `gap` body has for its subscription
        payload: { server, subscriptionId: request.headers.get("x-mcp-subscription-id"), body },
      },
      mark && { ...storedCause(mark), depth: Math.min(mark.depth, LOOP_DEPTH_LIMIT) },
    );
  } catch (error) {
    // A retry may carry a newer `cursor` or another subscription header, so it differs from the
    // event stored under the key: already stored.
    if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
  }
  return Response.json({ ok: true });
}
