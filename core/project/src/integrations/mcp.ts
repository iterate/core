// The webhook mode of the draft MCP Events extension (github.com/modelcontextprotocol/experimental-ext-triggers-events).
// A URL's secret is derived from its path and server under the signing key: nothing is stored.
import { env } from "cloudflare:workers";
import { contextAt, type LibraryItx } from "core-itx";
import type { McpConnectOptions } from "iterate/api";
import { errorCode } from "iterate/lib";
import { projectApiUrlOf } from "iterate/project-api";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import { connectToMcp } from "../library/mcp.ts";
import { bodyWithin } from "./webhooks.ts";

export const MCP_WEBHOOK_PATH = "/api/mcp-webhook";

export const connectToMcpAt =
  (itx: LibraryItx, path: string) =>
  (url: string, options: McpConnectOptions = {}) =>
    connectToMcp(itx, url, options, () =>
      mcpWebhookOf({ domain: env.DOMAIN, signingKey: env.PROJECT_SIGNING_KEY }, path, url),
    );

const MCPWebhookTarget = z.object({ path: z.string().min(1), server: z.string().min(1) });

async function mcpWebhookOf(
  { domain, signingKey }: { domain: string; signingKey: string },
  path: string,
  server: string,
) {
  const target = { path, server };
  const url = `${projectApiUrlOf(domain)}/mcp-webhook?${new URLSearchParams(target)}`;
  return { url, secret: await webhookSecretOf(signingKey, target) };
}

/** Standard Webhooks takes the base64 of the 64 hex digits as the secret's 64 bytes. */
const webhookSecretOf = async (signingKey: string, target: z.output<typeof MCPWebhookTarget>) =>
  `whsec_${btoa(
    await hmacSha256Hex(
      signingKey,
      `mcp-webhook-secret:${JSON.stringify([target.path, target.server])}`,
    ),
  )}`;

const MCP_WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;

export async function serveMcpWebhook(request: Request, signingKey: string): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const target = MCPWebhookTarget.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!target.success) return Response.json({ error: "Unknown MCP webhook." }, { status: 404 });
  const raw = await bodyWithin(request, MCP_WEBHOOK_BODY_MAX_BYTES);
  if (!raw) return Response.json({ error: "Payload too large." }, { status: 413 });
  let body: unknown;
  try {
    body = new Webhook(await webhookSecretOf(signingKey, target.data)).verify(
      new TextDecoder().decode(raw),
      Object.fromEntries(request.headers),
    );
  } catch {
    return Response.json({ error: "Invalid MCP webhook signature." }, { status: 401 });
  }
  const verification = z
    .object({ type: z.literal("verification"), challenge: z.string() })
    .safeParse(body);
  if (verification.success) return Response.json({ challenge: verification.data.challenge });
  const { path, server } = target.data;
  try {
    await contextAt(path).invoke(
      [
        "itx",
        "builtins",
        [
          "append",
          {
            type: "events.iterate.com/mcp/webhook-received",
            // `webhook-id` is signed, so a retry is stored once
            idempotencyKey: `mcp-webhook:${JSON.stringify([server, request.headers.get("webhook-id")])}`,
            // the subscription id is only in an unsigned header, and the one name a `terminated`
            // or `gap` body has for its subscription
            payload: { server, subscriptionId: request.headers.get("x-mcp-subscription-id"), body },
          },
        ],
      ],
      [],
      { principal: null, platform: true },
    );
  } catch (error) {
    // A retry may carry a newer `cursor`, so it differs from the event already stored.
    if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
  }
  return Response.json({ ok: true });
}

async function hmacSha256Hex(key: string, payload: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
