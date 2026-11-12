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
import { runApprovedActs } from "iterate/acts";
import { recordFacts as recorded } from "iterate/facts";
import { stampedCallerOf } from "iterate/principal";
import { platformRouteOf, mindProvideUrlOf } from "iterate/mind-api";
import { mindHostResponse } from "./host-session.ts";
import { parseEmail } from "./mail.ts";
import { ProvidedDoor } from "./provided-door.ts";
import { confinedAnswer, httpsRedirect, stampedRequest } from "./stamp.ts";

// A birth event is written as given, so the target is stored as steps.
const MIND_TARGET = ["itx", "mind"];

defineItxHost({
  firstPartyFacets: {},
  // A birth event never passes the platform-write check, so no caller writes this row.
  birthEvents: (path) =>
    path === "/"
      ? [
          {
            type: "events.iterate.com/itx/ingress-configured",
            idempotencyKey: "itx/ingress-configured",
            payload: { target: MIND_TARGET },
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
    // `fromAuth`: only the auth Worker's answer names the signer of an event (the key it verified)
    const recordFacts = (response: Response, fromAuth = false) => {
      const { answer, recorded: appended } = recorded(response, (path, events) =>
        throughTheMind(["append"], [path, events, fromAuth]),
      );
      ctx.waitUntil(appended);
      return answer;
    };
    const toMind = (forwarded: Request) =>
      serveHostRequest({
        ctx,
        request: forwarded,
        caller: stampedCallerOf(forwarded),
        unserved: (reason) => {
          console.info({ event: "boundary.mind-not-connected", reason });
          return new Response("This mind runs elsewhere and is not connected right now.\n", {
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
      return mindHostResponse(request, { auth: workerEnv.AUTH, domain, recordFacts }, toMind);
    const { forwarded, answer } = await stampedRequest(request, {
      auth: workerEnv.AUTH,
      route,
      domain,
    });
    if (answer) return answer;
    if (route === "auth") return recordFacts(await workerEnv.AUTH.fetch(forwarded), true);
    if (route === "secrets") {
      // an approval of an act whose caller stopped waiting: the mind does the act now
      const { answer: answered, ran } = runApprovedActs(
        await workerEnv.SECRETS.fetch(forwarded),
        async (digest) => {
          const held = await workerEnv.SECRETS.approvedAct(digest);
          if (held) await throughTheMind(["runAct"], [held]);
        },
      );
      ctx.waitUntil(ran);
      return recordFacts(answered);
    }
    return confinedAnswer(await toMind(forwarded));
  },

  // A failure throws, so Cloudflare delivers the mail again: with no mind provided, the root finds
  // no stub. The fact's idempotency key keeps a retry from landing twice.
  async email(message, workerEnv) {
    const mail = await parseEmail({
      from: message.from,
      to: message.to,
      raw: message.raw,
      isMember: (address) => workerEnv.AUTH.isMember(address),
    });
    await throughTheMind(["receiveEmail"], [mail]);
  },
} satisfies ExportedHandler<Cloudflare.Env>;

const throughTheMind = (steps: ItxExpressionStep[], args: unknown[] = []) =>
  contextAt("/").invoke(["itx", "mind", ...steps], args, {
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
  const identity = bearer ? await workerEnv.AUTH.whoIs(bearer, mindProvideUrlOf(domain)) : null;
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
// `MindTarget` is on the wire but not in its type.
class ProvideSessionTarget extends RpcTarget {
  readonly #root: IterateContextRpcTarget;
  readonly #door: ProvidedDoor;

  constructor(root: IterateContextRpcTarget, door: Fetcher) {
    super();
    this.#root = root;
    this.#door = new ProvidedDoor(door);
  }

  provide(mind: ClientRpcStub) {
    return this.#root.provide("itx.mind", mind, { description: "the provided mind" });
  }

  // Each call of the home lab's is a call on the door, made by this invocation, which releases the
  // answer (provided-door.ts).
  get door() {
    return this.#door;
  }
}
