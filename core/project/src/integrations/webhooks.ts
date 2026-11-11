// A provider signs the body with a shared secret, as GitHub does: `x-hub-signature-256: sha256=<hex>`.
import { contextAt } from "core-itx";
import { SECRET_PATH } from "iterate/secret-placeholder";
import type { StreamEvent } from "iterate/stream/processor";

export const WEBHOOKS_PATH = "/api/webhooks/";

/** Far under the stream's append ceiling. */
const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;

/** A credential a provider may send beside its signature. */
const DROPPED_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/** Anyone can post here, so nothing larger than `limit` is ever held. */
export async function bodyWithin(request: Request, limit: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length") || 0) > limit) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body || []) {
    size += chunk.byteLength;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const decodedOrEmpty = (encoded: string) => {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
};

/** 401 for a missing or wrong signature, 413 for a body over the limit, 200 once stored; a failed
 *  append throws (5xx) so the provider retries. */
export async function serveWebhook(request: Request): Promise<Response> {
  const name = decodedOrEmpty(new URL(request.url).pathname.slice(WEBHOOKS_PATH.length));
  const secretPath = `/secrets/${name}`;
  if (!SECRET_PATH.test(secretPath))
    return new Response("Not found: a webhook is /api/webhooks/<secret name>\n", { status: 404 });
  if (request.method !== "POST")
    return new Response("A webhook is a POST\n", { status: 405, headers: { allow: "POST" } });
  const signature = /^sha256=([0-9a-f]{64})$/i.exec(
    request.headers.get("x-hub-signature-256")?.trim() || "",
  )?.[1];
  if (!signature) return new Response("Unauthorized: no x-hub-signature-256\n", { status: 401 });
  const body = await bodyWithin(request, WEBHOOK_BODY_MAX_BYTES);
  if (!body) return new Response("Payload too large\n", { status: 413 });
  const asPlatform = { principal: null, platform: true as const };
  // The key never leaves the secrets Worker. A secret never set answers false or refuses.
  const valid = await contextAt("/")
    .invoke(
      // at the fixed point: no rule of the project's stands between the platform and the vault
      ["itx", "builtins", "secrets", ["verifyHmac", secretPath, { payload: body, signature }]],
      [],
      asPlatform,
    )
    .catch((error: unknown) => {
      console.info({ event: "webhook.verify-refused", name, error: String(error).slice(0, 300) });
      return false;
    });
  if (valid !== true)
    return new Response("Unauthorized: the signature is wrong\n", { status: 401 });
  const deliveryId =
    request.headers.get("x-github-delivery") || request.headers.get("webhook-id") || undefined;
  const [recorded] = (await contextAt(`/integrations/webhooks/${name}`).invoke(
    [
      "itx",
      "builtins",
      [
        "append",
        {
          type: "events.iterate.com/webhook/received",
          ...(deliveryId && { idempotencyKey: `webhook/received:${deliveryId}` }),
          payload: {
            name,
            headers: Object.fromEntries(
              [...request.headers].filter(([header]) => !DROPPED_HEADERS.has(header)),
            ),
            body: new TextDecoder().decode(body),
          },
        },
      ],
    ],
    [],
    asPlatform,
  )) as StreamEvent[];
  return Response.json({ path: recorded!.path, offset: recorded!.offset });
}
