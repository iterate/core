import { RpcTarget } from "capnweb";
import {
  type ClientRpcStub,
  contextAt,
  defineItxHost,
  IterateContextDurableObject,
  type IterateContextRpcTarget,
  serveHostRequest,
  serveSession,
} from "core-itx";
import type { ItxExpressionStep } from "iterate/expression";
import { recordFacts as recorded } from "iterate/facts";
import { stampedCallerOf } from "iterate/principal";
import { platformRouteOf, projectProvideUrlOf } from "iterate/project-api";
import { projectHostResponse } from "./host-session.ts";
import { parseEmail } from "./mail.ts";
import { confinedAnswer, httpsRedirect, stampedRequest } from "./stamp.ts";

// A birth event is written as given, so the target is stored as steps.
const PROJECT_TARGET = ["itx", "project"];

defineItxHost({
  firstPartyFacets: {},
  // A birth event never passes the platform-write check, so no caller writes this row.
  birthEvents: (path) =>
    path === "/"
      ? [
          {
            type: "events.iterate.com/itx/ingress-configured",
            idempotencyKey: "itx/ingress-configured",
            payload: { target: PROJECT_TARGET },
          },
        ]
      : [],
  // No `egress`: no code runs in these contexts (no loader, no roots), so nothing is sent out.
});

// A Durable Object binding names a class the Worker's main module exports.
export { IterateContextDurableObject };
export { Door } from "./door.ts";

export default {
  async fetch(request, workerEnv, ctx) {
    const secure = httpsRedirect(request);
    if (secure) return secure;
    const domain = workerEnv.DOMAIN;
    const route = platformRouteOf(new URL(request.url), domain);
    if (route === "provide") return serveProvide(request, workerEnv, ctx, domain);
    const recordFacts = (response: Response) => {
      const { answer, recorded: appended } = recorded(response, (path, events) =>
        throughTheProject(["append"], [path, events]),
      );
      ctx.waitUntil(appended);
      return answer;
    };
    const toProject = (forwarded: Request) =>
      serveHostRequest({
        ctx,
        request: forwarded,
        caller: stampedCallerOf(forwarded),
        unserved: (reason) => {
          console.info({ event: "boundary.project-not-connected", reason });
          return new Response("This project runs elsewhere and is not connected right now.\n", {
            status: 503,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "retry-after": "10",
              "x-iterate-not-connected": reason,
            },
          });
        },
      });
    if (!route)
      return projectHostResponse(request, { auth: workerEnv.AUTH, domain, recordFacts }, toProject);
    const { forwarded, answer } = await stampedRequest(request, {
      auth: workerEnv.AUTH,
      route,
      domain,
    });
    if (answer) return answer;
    if (route === "auth") return recordFacts(await workerEnv.AUTH.fetch(forwarded));
    if (route === "secrets") return recordFacts(await workerEnv.SECRETS.fetch(forwarded));
    return confinedAnswer(await toProject(forwarded));
  },

  // A failure throws, so Cloudflare delivers the mail again: with no project provided, the root finds
  // no stub. The fact's idempotency key keeps a retry from landing twice.
  async email(message, workerEnv) {
    const mail = await parseEmail({
      from: message.from,
      to: message.to,
      raw: message.raw,
      isMember: (address) => workerEnv.AUTH.isMember(address),
    });
    await throughTheProject(["receiveEmail"], [mail]);
  },
} satisfies ExportedHandler<Cloudflare.Env>;

const throughTheProject = (steps: ItxExpressionStep[], args: unknown[] = []) =>
  contextAt("/").invoke(["itx", "project", ...steps], args, {
    principal: null,
    platform: true,
  });

// The bearer is checked before any socket is accepted. The socket lives in this invocation, never in
// the Durable Object, which hibernates between pages.
async function serveProvide(
  request: Request,
  workerEnv: Cloudflare.Env,
  ctx: ExecutionContext,
  domain: string,
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response("A home lab dials this URL with a capnweb WebSocket.\n", {
      status: 426,
      headers: { upgrade: "websocket" },
    });
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const identity = bearer ? await workerEnv.AUTH.whoIs(bearer, projectProvideUrlOf(domain)) : null;
  if (!identity)
    return new Response("Send a live token for this URL as the upgrade's bearer.\n", {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer${bearer ? ' error="invalid_token"' : ""}` },
    });
  // The socket closes when its token ends, so a revoked grant or a removed member loses the link
  // within the token's hour.
  return serveSession(request, ctx, {
    caller: { principal: identity.principal, grant: identity.grant },
    endsAt: identity.expiresAt * 1000,
    endReason: "the token for this link ended: dial again",
    root: (rootContext) =>
      new ProvideSessionTarget(rootContext, (ctx.exports as unknown as { Door: Fetcher }).Door),
  });
}

// Not `implements ProvideSession`: `provide` takes the kernel's `ClientRpcStub`, which a
// `ProjectTarget` is on the wire but not in its type.
class ProvideSessionTarget extends RpcTarget {
  readonly #root: IterateContextRpcTarget;
  readonly #door: Fetcher;

  constructor(root: IterateContextRpcTarget, door: Fetcher) {
    super();
    this.#root = root;
    this.#door = door;
  }

  provide(project: ClientRpcStub) {
    return this.#root.provide("itx.project", project, { description: "the provided project" });
  }

  // capnweb serves a Workers stub as an RpcTarget, so each call of the home lab's is a call on the door.
  get door() {
    return this.#door;
  }
}
