import { errorCode } from "iterate/lib";
import { stampedExpiryOf } from "iterate/principal";
import {
  ITERATE_SERVE_ADMITS_HEADER,
  ITERATE_SERVE_CONTEXT_HEADER,
  ITERATE_SERVE_HEADER,
} from "iterate/mind-ingress";
import type { Caller } from "./caller.ts";
import {
  FETCH_UPGRADE_CONTEXT_HEADER,
  FETCH_UPGRADE_RESUMABLE_HEADER,
  FETCH_UPGRADE_SOCKET_HEADER,
  spliceEyeballAnswer,
} from "./context/fetch-upgrade.ts";
import { implicitRootsAt, resolveItxExpression } from "./context/itx-expression-rewriting.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import { ITX_EXPRESSION_FETCH_HEADER, itxExpressionEndingInFetch } from "./context/rpc-stubs.ts";
import { contextReach, statelessResolverFor } from "./context/stateless-context.ts";
import { matchFetchRoute } from "./fetch-routes.ts";
import { contexts } from "./host.ts";
import { statelessExpressionFetch } from "./iterate-context.ts";
import { personItxSession } from "./person-context.ts";
import { serveSession } from "./session.ts";
import { expressionFetchErrorAnswer, failedPageAnswer } from "./unavailable.ts";

/** A SOCKET DIALLED INTO A CONTEXT FROM OUTSIDE THE MIND'S WORKER, or null when `request` is none:
 *  it goes to the context that the dial names, and its answer holds the socket. Two dials:
 *    - the leg of a lent stub's upgrade (./context/fetch-upgrade.ts `LentFetchHolder`). The
 *      upgrade's id, which the context made and gave to the holder alone, admits a leg there;
 *    - the upgrade of a session's `itx.fetch` (./iterate-context.ts `fetchUpgradeDial`), which
 *      the context answers as that `fetch`, for the caller that the dial names.
 *  Only the boundary sends either: it removes every `x-itx-*` header from a request that comes
 *  from outside. Ask before any routing by hostname or path: a dial has neither. */
export function fetchUpgradeLegResponse(request: Request): Promise<Response> | null {
  const context = request.headers.get(FETCH_UPGRADE_CONTEXT_HEADER);
  if (!context) return null;
  const leg = request.headers.has(FETCH_UPGRADE_SOCKET_HEADER);
  const fetchUpgrade =
    request.headers.has(ITX_EXPRESSION_FETCH_HEADER) &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (!leg && !fetchUpgrade) return null;
  return contexts().getByName(context).fetch(request);
}

// Served where it arrived, never through the root's Durable Object: the root's snapshot says where
// it goes. `unserved` answers whenever nothing serves the ingress.
export async function serveHostRequest(args: {
  ctx: ExecutionContext;
  request: Request;
  caller: Caller;
  unserved?: (reason: "no-ingress" | "no-rule" | "stub-offline") => Response;
  // The host whose own loaded config worker answers: only its answer may ask for a session, a
  // member's itx (`itxSession`) or a person's view of one context (./person-context.ts).
  itxSessions?: true;
  // Answers one MCP `tools/call` of `run` as `caller` (the mind Worker's own handler). Only with
  // it may the config worker's answer ask for such a run (`mcpRunAnswer`).
  mcpRun?: (message: Request, caller: Caller) => Promise<Response>;
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
          // The route's target runs as loaded code that names no member. The visitor's person, and
          // another mind that asks, are the boundary's word, so they go with the call.
          resolverUnder({
            principal: null,
            app: true,
            cause: caller.cause,
            person: caller.person,
            mind: caller.mind,
          }),
          () => route.target,
          request,
          JSON.stringify(route.target),
        ),
      );
    // A snapshot read does not bear the root, so one log read does: its birth events start the mind.
    if (!routing.ingressTarget) {
      ctx.waitUntil(reach.contextOf("/").read(0, 1));
      if (unserved) return unserved("no-ingress");
      return new Response(
        "This mind has no site yet: its config worker's fetch serves this page once the mind defines one\n",
        { status: 404 },
      );
    }
    label = JSON.stringify(routing.ingressTarget);
    const ingress = itxExpressionEndingInFetch(routing.ingressTarget);
    // Refused here, so an unpublished mind costs the root no call per request.
    resolveItxExpression(() => rules, ingress, implicitRootsAt("/"));
    // The ingress row's target is run as the person who asks, and as a row's run
    // (`Caller.runsRow`): a member's request writes no row that loaded code could not write.
    const answer = await resolverUnder({ ...caller, runsRow: true }).invoke(ingress, request);
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
    if (args.mcpRun && answer.headers.get(ITERATE_SERVE_HEADER) === "mcp-run")
      return await mcpRunAnswer({ ...args, mcpRun: args.mcpRun }, answer);
    const serve = args.itxSessions && answer.headers.get(ITERATE_SERVE_HEADER);
    if (serve === "itx") {
      await answer.body?.cancel();
      return await itxSession(args);
    }
    if (serve === "person-itx") {
      const path = answer.headers.get(ITERATE_SERVE_CONTEXT_HEADER);
      const admits = answer.headers.get(ITERATE_SERVE_ADMITS_HEADER);
      await answer.body?.cancel();
      return await personItxSession({ ctx, request: args.request, path, admits });
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
    // a person's own page load gets words; every other caller the answer as it is
    return await failedPageAnswer(args.request, expressionFetchErrorAnswer(error, label), error);
  }
}

// The headers are the platform's to act on: no answer that goes on to a browser keeps them.
const withoutServeHeader =
  (next: (answer: Response) => Response) =>
  (answer: Response): Response => {
    if (
      !answer.headers.has(ITERATE_SERVE_HEADER) &&
      !answer.headers.has(ITERATE_SERVE_CONTEXT_HEADER) &&
      !answer.headers.has(ITERATE_SERVE_ADMITS_HEADER)
    )
      return next(answer);
    const headers = new Headers(answer.headers);
    headers.delete(ITERATE_SERVE_HEADER);
    headers.delete(ITERATE_SERVE_CONTEXT_HEADER);
    headers.delete(ITERATE_SERVE_ADMITS_HEADER);
    return next(
      new Response(answer.body, {
        status: answer.status,
        statusText: answer.statusText,
        headers,
        webSocket: answer.webSocket,
      }),
    );
  };

// The script of a run, and the message around it: past this the app's answer is no run.
const MAX_MCP_RUN_MESSAGE_BYTES = 1024 * 1024;

// ONE `run` OF THE CONFIG'S OWN MCP SERVER, AS THE MEMBER WHO ASKS (iterate/sdk `auth.mcpRun`). The
// config worker's answer asked for it and holds the message; it named no caller. As for a
// member's itx below, the caller is the one the boundary stamped on the Request this invocation
// was given: a member, on a POST. Another mind and a person who is no member are no principal,
// and get the answer nobody gets. The message must be one `tools/call` of `run`, so the answer can
// ask for nothing but what the mind's own /mcp does for that member. The run's record is marked
// with the host it came through (`via.appPage`), and what the script appends names the member
// and the host as who it was for (`onBehalfOf`).
async function mcpRunAnswer(
  args: {
    request: Request;
    caller: Caller;
    mcpRun: (message: Request, caller: Caller) => Promise<Response>;
  },
  answer: Response,
): Promise<Response> {
  const { request, caller } = args;
  const refuse = async (body: string, status: number, headers?: Record<string, string>) => {
    await answer.body?.cancel();
    return new Response(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
  };
  if (!caller.principal)
    return refuse("Sign in\n", 401, { "WWW-Authenticate": 'Bearer realm="iterate"' });
  if (request.method !== "POST") return refuse("Method not allowed\n", 405, { allow: "POST" });
  // The length is counted in bytes as they arrive, whatever the answer says of its length: the
  // read stops at the first chunk that crosses the limit.
  const message = await textUpTo(answer, MAX_MCP_RUN_MESSAGE_BYTES);
  if (!message)
    return new Response("This app's MCP run is too long\n", {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  const body = message.text;
  if (!isMcpRunMessage(body))
    return new Response("This app asked for an MCP run with no call of the tool `run`\n", {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  const url = new URL(request.url);
  return args.mcpRun(mcpRunRequest(url, body, request.headers.get("mcp-protocol-version")), {
    ...caller,
    via: { appPage: url.hostname },
  });
}

/** THE REQUEST OF ONE `run`, of the platform's own making: the URL, how the client reads an
 *  answer, the protocol version the client spoke, and the two headers that MCP from 2026-07-28 on
 *  asks beside a `tools/call` (`Mcp-Method`, `Mcp-Name`), which `body` was checked to match
 *  (`isMcpRunMessage`). Nothing else of the member's request goes on. */
export function mcpRunRequest(url: URL, body: string, protocolVersion: string | null): Request {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-method": "tools/call",
    "mcp-name": "run",
  });
  if (protocolVersion) headers.set("mcp-protocol-version", protocolVersion);
  return new Request(url, { method: "POST", headers, body });
}

/** Whether `body` is one JSON-RPC `tools/call` of the tool `run`, with an id and a script. */
function isMcpRunMessage(body: string): boolean {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return false;
  }
  const call = message as {
    id?: unknown;
    method?: unknown;
    params?: { name?: unknown; arguments?: { script?: unknown } };
  } | null;
  return Boolean(
    call &&
    !Array.isArray(call) &&
    (typeof call.id === "string" || typeof call.id === "number") &&
    call.method === "tools/call" &&
    call.params?.name === "run" &&
    typeof call.params.arguments?.script === "string",
  );
}

/** An answer's body as text, or nothing when it is past `limit` bytes: the read is cancelled at
 *  the chunk that crosses it. */
async function textUpTo(answer: Response, limit: number): Promise<{ text: string } | undefined> {
  if (!answer.body) return { text: "" };
  const reader = answer.body.getReader();
  const decoder = new TextDecoder();
  let read = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode() };
    read += value.byteLength;
    if (read > limit) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
}

// A MEMBER'S OWN ITX, FOR THE PAGE THEY ARE ON (iterate/sdk `auth.itx`). The config worker's answer
// asked for it; it named no caller and handed over no Request. The caller is the one the boundary
// stamped on the Request this invocation was given, so nothing user code built or altered is read.
// A principal on a mind host is a member: another mind is `caller.mind`, never a principal
// (iterate/principal `principalStampOf`), so it gets the refusal below. The session is the
// host's own: a WebSocket upgrade from that origin, ended when the stamp ends, and marked, so what
// the page appends says it came through a page of the mind's code.
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
  return serveSession(args.ctx, {
    caller: { ...caller, via: { appPage: url.hostname } },
    endsAt,
    endReason: "the sign-in for this session ended: sign in again",
  });
}
