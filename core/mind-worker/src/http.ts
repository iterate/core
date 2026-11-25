// http.ts — THE MIND'S ANSWER TO A REQUEST. Every request comes from the boundary, which has
// stamped who asks. A request on the control-plane hostname is for the platform's own paths (a signed
// file URL, a webhook, MCP). A request on any other hostname goes to the mind's own
// host, which is the config's worker.
import {
  type Caller,
  causeOfOwnRequest,
  contextAt,
  fetchUpgradeLegResponse,
  serveHostRequest,
} from "core-itx";
import { ITERATE_CAUSE_HEADER, releasedAnswer } from "iterate/lib";
import { controlPlaneRouteOf } from "iterate/mind-api";
import { isControlPlaneHostname, controlPlaneOriginOf } from "iterate/mind-config";
import { stampedCallerOf } from "iterate/principal";
import { mindWorkerConfigOf } from "./config.ts";
import { FILES_PATH, serveMindFileRequest } from "./context/file-urls.ts";
import type { Env } from "./env.ts";
import { MCP_WEBHOOK_PATH, serveMcpWebhook } from "./integrations/mcp.ts";
import { serveWebhook, WEBHOOKS_PATH } from "./integrations/webhooks.ts";
import { serveAppMcp, serveMcp, serveMcpRun } from "./mcp.ts";
import { appendAsPlatform } from "./platform-append.ts";

export async function mindResponse(request: Request, env: Env, ctx: ExecutionContext) {
  // the leg of a lent stub's upgrade, which the boundary dials for a session that ends there
  const leg = fetchUpgradeLegResponse(request);
  if (leg) return leg;
  const config = mindWorkerConfigOf(env);
  const url = new URL(request.url);
  /** A signed file URL of this mind, read here: what a `run` shows its caller as images. */
  const readSignedFile = (signedUrl: string) =>
    serveMindFileRequest({
      bucket: env.FILES,
      secret: config.signingKey.exposeSecret(),
      // a read: nothing is uploaded
      recordUpload: () => Promise.resolve(),
      request: new Request(signedUrl),
    });
  if (!isControlPlaneHostname(config, url.hostname)) {
    const host = hostRequestOf(request);
    return serveHostRequest({
      ctx,
      request: host.request,
      caller: { ...stampedCallerOf(request), cause: host.cause },
      itxSessions: true,
      mcpRun: (message, caller) => serveMcpRun(message, caller, readSignedFile),
      mcpServer: (asked, caller, server, call) =>
        serveAppMcp(asked, caller, {
          ...server,
          controlPlaneOrigin: controlPlaneOriginOf(config),
          config: call,
        }),
    });
  }
  // Of the control plane, the boundary sends the mind the API and MCP alone.
  const route = controlPlaneRouteOf(url);
  // The signature is the permission, so a signed file URL is answered before any bearer check.
  if (route === "api" && url.pathname.startsWith(FILES_PATH))
    return serveMindFileRequest({
      bucket: env.FILES,
      secret: config.signingKey.exposeSecret(),
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
    return serveMcpWebhook(request, config.signingKey.exposeSecret());
  if (route === "api") {
    if (request.method === "GET" && url.pathname === "/api/_skeleton") {
      // a member alone: each run writes a fact and sends requests out
      if (!stampedCallerOf(request).principal)
        return new Response("Sign in\n", {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer realm="iterate"' },
        });
      return Response.json(await skeletonChecks(request, env, controlPlaneOriginOf(config)));
    }
    // the API itself is a session that the boundary ends: `Mind.api` (./rpc.ts) is the mind's part
    return new Response("Not found\n", { status: 404 });
  }
  if (route === "mcp") {
    // THE MIND'S PART OF ITS OWN SERVER: the method of the config's class that the deploy's config
    // names (`mcpTarget`), called as the member who asks. Absent: the defaults.
    const { mcpTarget } = config;
    const caller = stampedCallerOf(request);
    return serveMcp(
      request,
      readSignedFile,
      mcpTarget
        ? (client, method, args) =>
            contextAt("/").invoke(
              ["itx", "config", ["mcpCall", mcpTarget, [client], method, args]],
              [],
              // the platform's MCP server asks: the one caller that reaches `mcpCall`
              { ...caller, mcpServer: true },
            )
        : undefined,
    );
  }
  return new Response("Not found\n", { status: 404 });
}

/** A request to one of the mind's hosts, and its cause. The mind's own request resumes its chain;
 *  any other begins one, and its mark goes no further (core/itx/src/cause.ts). */
export function hostRequestOf(request: Request): { request: Request; cause: Caller["cause"] } {
  const cause = causeOfOwnRequest(request.headers, new URL(request.url).hostname);
  if (cause || !request.headers.has(ITERATE_CAUSE_HEADER)) return { request, cause };
  const headers = new Headers(request.headers);
  headers.delete(ITERATE_CAUSE_HEADER);
  return { request: new Request(request, { headers }), cause: undefined };
}

/** No secret material: core/alchemy/scripts/smoke.ts reads these. */
async function skeletonChecks(request: Request, env: Env, controlPlaneOrigin: string) {
  const door = env.DOOR;
  return {
    principal: stampedCallerOf(request).principal,
    /** The boundary removes a cookie on the control-plane hostname. */
    cookieReached: request.headers.has("cookie"),
    egressFetchStatus: (await door.fetch(new Request("https://example.com/"))).status,
    // the issuer's own document: its `/` is a redirect to the Dash
    authThroughEgressStatus: (
      await door.fetch(new Request(`${controlPlaneOrigin}/.well-known/oauth-authorization-server`))
    ).status,
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
