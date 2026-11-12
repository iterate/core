// The mind runs elsewhere (core/home-lab) and dials `/provide`: each call goes through the root
// context of this Worker's own kernel, to the stub the mind provided as `itx.mind`. This module
// defines that kernel's host, so only the provided build imports it.
import { RpcTarget } from "capnweb";
import {
  type ClientRpcStub,
  contextAt,
  defineItxHost,
  type IterateContextRpcTarget,
  serveHostRequest,
  serveSession,
} from "core-itx";
import type { ItxExpressionStep } from "iterate/expression";
import { stampedCallerOf } from "iterate/principal";
import { mindProvideUrlOf } from "iterate/mind-api";
import type { MindTarget } from "iterate/workers";
import type { MindTransport } from "../http.ts";
import { ProvidedDoor } from "../provided-door.ts";

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

/** The mind through its session. With none connected, a request is answered 503 here, and any
 *  other call fails: the root finds no stub. */
export const providedMind = (ctx: ExecutionContext): MindTransport => ({
  fetch: (forwarded) =>
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
    }),
  append: (path, events, fromAuth) =>
    throughTheMind(["append"], [path, events, fromAuth]) as ReturnType<MindTarget["append"]>,
  runAct: (held) => throughTheMind(["runAct"], [held]) as ReturnType<MindTarget["runAct"]>,
  receiveEmail: (mail) =>
    throughTheMind(["receiveEmail"], [mail]) as ReturnType<MindTarget["receiveEmail"]>,
});

const throughTheMind = (steps: ItxExpressionStep[], args: unknown[] = []) =>
  contextAt("/").invoke(["itx", "mind", ...steps], args, {
    principal: null,
    platform: true,
  });

// The bearer is checked before any socket is accepted. The socket lives in this invocation, never in
// the Durable Object, which hibernates between pages.
export async function serveProvide(
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
  // answer (../provided-door.ts).
  get door() {
    return this.#door;
  }
}
