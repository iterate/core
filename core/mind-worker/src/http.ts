// http.ts — THE MIND'S ANSWER TO A REQUEST. Every request comes from the boundary, which has
// stamped who asks. Platform paths are answered first (a signed file URL, a webhook, the API, MCP);
// every other request goes to the mind's own host, which is the config's worker.
import { contextAt, serveHostRequest } from "core-itx";
import { releasedAnswer } from "iterate/lib";
import { platformOriginOf, platformRouteOf } from "iterate/mind-api";
import { ITERATE_ROUTING_SLUG_HEADER } from "iterate/mind-ingress";
import { stampedCallerOf } from "iterate/principal";
import { serveApi } from "./api.ts";
import { FILES_PATH, serveMindFileRequest } from "./context/file-urls.ts";
import type { Env } from "./env.ts";
import { MCP_WEBHOOK_PATH, serveMcpWebhook } from "./integrations/mcp.ts";
import { serveWebhook, WEBHOOKS_PATH } from "./integrations/webhooks.ts";
import { serveMcp } from "./mcp.ts";
import { appendAsPlatform } from "./platform-append.ts";

export async function mindResponse(request: Request, env: Env, ctx: ExecutionContext) {
  const domain = env.DOMAIN;
  const url = new URL(request.url);
  // The API and MCP first: platform code, before anything of the mind's own.
  const route = platformRouteOf(url, domain);
  // The signature is the permission, so a signed file URL is answered before any bearer check.
  if (route === "api" && url.pathname.startsWith(FILES_PATH))
    return serveMindFileRequest({
      bucket: env.FILES,
      secret: env.MIND_SIGNING_KEY,
      recordUpload: (payload) =>
        contextAt("/").invoke(
          ["itx", "builtins", ["append", { type: "events.iterate.com/itx/file-set", payload }]],
          [],
          { principal: null, platform: true },
        ),
      request,
    });
  // a webhook's signature is the permission
  if (route === "api" && url.pathname.startsWith(WEBHOOKS_PATH)) return serveWebhook(request);
  if (route === "api" && url.pathname === MCP_WEBHOOK_PATH)
    return serveMcpWebhook(request, env.MIND_SIGNING_KEY);
  if (route === "api") {
    if (request.method === "GET" && url.pathname === "/api/_skeleton") {
      // a member alone: each run writes a fact and sends requests out
      if (!stampedCallerOf(request).principal)
        return new Response("Sign in\n", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer realm="iterate"' },
        });
      return Response.json(await skeletonChecks(request, env));
    }
    return serveApi(request, ctx);
  }
  if (route === "mcp") return serveMcp(request);
  return serveMindHost(request, ctx, domain);
}

/** No secret material: core/alchemy/scripts/smoke.ts reads these. */
async function skeletonChecks(request: Request, env: Env) {
  const door = env.DOOR;
  return {
    principal: stampedCallerOf(request).principal,
    /** The boundary removes a cookie on the platform's hostname. */
    cookieReached: request.headers.has("cookie"),
    egressFetchStatus: (await door.fetch(new Request("https://example.com/"))).status,
    authThroughEgressStatus: (await door.fetch(new Request(`${platformOriginOf(env.DOMAIN)}/`)))
      .status,
    secretsEventCount:
      (await releasedAnswer(door.secret("/secrets/skeleton", "describe", undefined))).path ===
      "/secrets/skeleton"
        ? 1
        : 0,
    emailEventCount: (await contextAt("/integrations/email").read()).events.length,
    /** Of a type only the platform may append, which the default config's cases pass over. */
    platformFactOffset: (
      await appendAsPlatform("/skeleton/platform-fact", [
        { type: "events.iterate.com/mcp/webhook-received", payload: { skeleton: true } },
      ])
    )[0]?.offset,
  };
}

/** The routing slug header is unset on the apex, so a visitor's copy never survives. */
function serveMindHost(request: Request, ctx: ExecutionContext, domain: string) {
  const { hostname } = new URL(request.url);
  const routingSlug = hostname.endsWith(`.${domain}`)
    ? hostname.slice(0, -`.${domain}`.length)
    : null;
  const headers = new Headers(request.headers);
  if (routingSlug) headers.set(ITERATE_ROUTING_SLUG_HEADER, routingSlug);
  else headers.delete(ITERATE_ROUTING_SLUG_HEADER);
  return serveHostRequest({
    ctx,
    request: new Request(request, { headers }),
    caller: stampedCallerOf(request),
    itxSessions: true,
  });
}
