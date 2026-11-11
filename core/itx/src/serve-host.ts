import { errorCode } from "iterate/lib";
import { stampedExpiryOf } from "iterate/principal";
import { ITERATE_SERVE_HEADER } from "iterate/project-ingress";
import type { Caller } from "./caller.ts";
import { FETCH_UPGRADE_RESUMABLE_HEADER, spliceEyeballAnswer } from "./context/fetch-upgrade.ts";
import { implicitRootsAt, resolveItxExpression } from "./context/itx-expression-rewriting.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import { itxExpressionEndingInFetch } from "./context/rpc-stubs.ts";
import { contextReach, statelessResolverFor } from "./context/stateless-context.ts";
import { matchFetchRoute } from "./fetch-routes.ts";
import { contexts } from "./host.ts";
import { statelessExpressionFetch } from "./iterate-context.ts";
import { serveSession } from "./session.ts";
import { expressionFetchErrorAnswer } from "./unavailable.ts";

// Served where it arrived, never through the root's Durable Object: the root's snapshot says where
// it goes. `unserved` answers whenever nothing serves the ingress.
export async function serveHostRequest(args: {
  ctx: ExecutionContext;
  request: Request;
  caller: Caller;
  unserved?: (reason: "no-ingress" | "no-rule" | "stub-offline") => Response;
  // The host whose own loaded config worker answers: only its answer may ask for an itx session.
  itxSessions?: true;
}): Promise<Response> {
  const { ctx, caller, unserved } = args;
  const namespace = contexts();
  let { request } = args;
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const headers = new Headers(request.headers);
    headers.set(FETCH_UPGRADE_RESUMABLE_HEADER, "1");
    request = new Request(request, { headers });
  }
  // A lent stub's WebSocket is held here, not by the context: the visitor gets this invocation's
  // own socket and never sees a frame of the splice's wire.
  const held = (answer: Response) =>
    spliceEyeballAnswer(answer, (path) =>
      namespace.getByName(DurableObjectNameCodec.address(path).name),
    );
  const resolverUnder = (callerThere: Caller) =>
    statelessResolverFor({
      namespace,
      address: DurableObjectNameCodec.address("/"),
      caller: callerThere,
      ctx,
    });
  let label = "";
  try {
    const reach = contextReach({ namespace, ctx });
    const { routing, rules } = await reach.snapshotOf("/");
    const route = matchFetchRoute(routing.fetchRoutes, request);
    if (route?.authRequirement && !caller.principal)
      return new Response("Sign in\n", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="iterate"' },
      });
    if (route)
      return withoutServeHeader(held)(
        await statelessExpressionFetch(
          resolverUnder({
            principal: null,
            app: true,
            cause: caller.cause,
          }),
          () => route.target,
          request,
          JSON.stringify(route.target),
        ),
      );
    // A snapshot read does not bear the root, so one log read does: its birth events start the project.
    if (!routing.ingressTarget) {
      ctx.waitUntil(reach.contextOf("/").read(0, 1));
      if (unserved) return unserved("no-ingress");
      return new Response(
        "This project has no site yet: its config worker's fetch serves this page once the project defines one\n",
        { status: 404 },
      );
    }
    label = JSON.stringify(routing.ingressTarget);
    const ingress = itxExpressionEndingInFetch(routing.ingressTarget);
    // Refused here, so an unpublished project costs the root no call per request.
    resolveItxExpression(() => rules, ingress, implicitRootsAt("/"));
    const answer = await resolverUnder(caller).invoke(ingress, request);
    if (
      unserved &&
      answer instanceof Response &&
      answer.headers.has("x-iterate-rpc-stub-offline")
    ) {
      await answer.body?.cancel();
      return unserved("stub-offline");
    }
    if (!(answer instanceof Response))
      return new Response(`expression fetch: ${JSON.stringify(answer)}\n`);
    if (args.itxSessions && answer.headers.get(ITERATE_SERVE_HEADER) === "itx") {
      await answer.body?.cancel();
      return await itxSession(args);
    }
    return withoutServeHeader(held)(answer);
  } catch (error) {
    const code = errorCode(error);
    if (unserved && code === "NO_ITX_EXPRESSION_MATCH") {
      console.info({
        event: "itx.host-ingress-unresolved",
        ingress: label,
        message: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
      return unserved("no-rule");
    }
    if (unserved && code === "RPC_STUB_OFFLINE") return unserved("stub-offline");
    return expressionFetchErrorAnswer(error, label);
  }
}

// The header is the platform's to act on: no answer that goes on to a browser keeps it.
const withoutServeHeader =
  (next: (answer: Response) => Response) =>
  (answer: Response): Response => {
    if (!answer.headers.has(ITERATE_SERVE_HEADER)) return next(answer);
    const headers = new Headers(answer.headers);
    headers.delete(ITERATE_SERVE_HEADER);
    return next(
      new Response(answer.body, {
        status: answer.status,
        statusText: answer.statusText,
        headers,
        webSocket: answer.webSocket,
      }),
    );
  };

// A MEMBER'S OWN ITX, FOR THE PAGE THEY ARE ON (iterate/sdk `auth.itx`). The config worker's answer
// asked for it; it named no caller and handed over no Request. The caller is the one the boundary
// stamped on the Request this invocation was given, so nothing user code built or altered is read.
// A principal on a project host is a member (the boundary stamps no other). The session is the
// host's own: a WebSocket upgrade from that origin, ended when the stamp ends, and marked, so what
// the page appends says it came through a page of the project's code.
async function itxSession(args: {
  ctx: ExecutionContext;
  request: Request;
  caller: Caller;
}): Promise<Response> {
  const { request, caller } = args;
  const url = new URL(request.url);
  const endsAt = stampedExpiryOf(request);
  if (!caller.principal || !endsAt)
    return new Response("Sign in\n", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="iterate"', "Cache-Control": "no-store" },
    });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response("Open this path as a WebSocket: it is the page's itx.\n", {
      status: 426,
      headers: { upgrade: "websocket" },
    });
  if (request.headers.get("origin") !== url.origin)
    return new Response("This socket opens from a page of this host alone\n", { status: 403 });
  return serveSession(request, args.ctx, {
    caller: { ...caller, via: { appPage: url.hostname } },
    endsAt,
    endReason: "the sign-in for this session ended: sign in again",
  });
}
