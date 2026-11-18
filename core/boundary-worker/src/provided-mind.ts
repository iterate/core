// provided-mind.ts — THE MIND THAT RUNS ELSEWHERE, AS THE BOUNDARY HOLDS IT
// (`topology: "external-mind-connects-into-cloudflare-boundary"`, core/home-lab).
//
// Such a mind dials the API's own address, `https://<controlPlaneHostname>/api`, and says on the
// dial that it hands in a mind (iterate/mind-api `MIND_PROVIDE_EXTERNAL_MIND_HEADER`). The
// boundary sends that socket here, to the one instance of `ProvidedMind`, and this object ends
// the session with the API's own root (./control-plane-api.ts): the mind authenticates as every
// client does, with a token of its own audience (iterate/mind-api
// `mindProvideConnectResourceOf`), and its session offers `provideExternalMind(connect)`. This
// object calls `connect(door)` once and keeps the `MindTarget` that it answers, the LINK, for as
// long as the socket is open. Every request, mail, act and session of the mind then goes through
// this object to that target (./mind-transport.ts).
//
// WHY THE SESSION ENDS HERE AND NOT IN THE BOUNDARY'S OWN INVOCATION: a link lasts for days, and
// every invocation of the boundary uses it. An invocation has one CPU budget for all of its
// life, and a stub that it holds is no other invocation's to call.
//
// The link is in memory alone: it is a live socket. A deploy of the boundary, or Cloudflare
// moving this object, ends the socket, and the mind dials again.
//
// A SESSION'S END IS ONE MOMENT, whatever ends it: the token's end, a newer session's hand-in, a
// broken socket (./control-plane-api.ts `controlPlaneApiResponse` is the one implementation, for
// this object and for the boundary's own invocation). From that moment the session's mind is no
// link, its door refuses every call (./provided-door.ts), and its capnweb session reads no
// further message.
import { DurableObject } from "cloudflare:workers";
import { RpcStub } from "capnweb";
import { codedError } from "iterate/lib";
import type { Door, MindTarget } from "iterate/workers";
import { boundaryConfigOf } from "./config.ts";
import {
  type ApiSession,
  type ConnectStub,
  controlPlaneApiResponse,
  SESSION_ENDS,
} from "./control-plane-api.ts";
import type { DoorEnv } from "./env.ts";
import { ProvidedDoor } from "./provided-door.ts";

/** THE BOUNDARY'S MARK ON THE DIAL. ./mind-transport.ts alone sets it, and removes it from every
 *  other request that it sends to this object. A request with the mark is a session of the API
 *  that ends here; a request without it is for the mind. */
export const PROVIDED_MIND_DIAL_HEADER = "x-itx-provided-mind-dial";

/** A mind that was handed in, and how a newer one ends its session. */
type Link = { mind: RpcStub<MindTarget>; takeOver(): void };

export class ProvidedMind extends DurableObject<DoorEnv> {
  #link: Link | null = null;
  /** Each call of `provideExternalMind` gets the next number, and `#linkOrder` is the number of the
   *  call whose mind is the link. A connect function can take any time to answer: an answer to
   *  an earlier call than the link's is late, and never replaces the link. */
  #handIns = 0;
  #linkOrder = 0;

  override async fetch(request: Request): Promise<Response> {
    // ONE SESSION OF THE API THAT ENDS IN THIS OBJECT: the dial of a mind that runs elsewhere. It
    // is the API's own session (./control-plane-api.ts): the mind authenticates as every client
    // does, and the session ends when its credential does, so a revoked grant or a removed
    // member loses the link within the token's hour. A credential that hands in no mind opens
    // no session here.
    if (request.headers.has(PROVIDED_MIND_DIAL_HEADER))
      return controlPlaneApiResponse(request, {
        auth: this.env.AUTH,
        config: boundaryConfigOf(this.env),
        handIn: (session) => this.#handInOf(session),
      });
    const link = this.#link;
    if (!link) return notConnected();
    try {
      // The answer may be a WebSocket: capnweb carries one, and a Durable Object's `fetch`
      // carries it on to the boundary's handler, which Workers RPC does not.
      return await link.mind.fetch(request);
    } catch (error) {
      // a link that ended under the request is no link
      if (this.#link === link) throw error;
      return notConnected();
    }
  }

  /** The mind's own API for one session of the boundary's (iterate/workers `MindTarget.api`). What
   *  the mind answers is a capnweb stub, and it crosses to the boundary's invocation as it is:
   *  the Workers RPC hop between the two capnweb sessions is what lets a stream pass from the
   *  one to the other. */
  async api(who: Parameters<MindTarget["api"]>[0]) {
    return await this.#mind().api(who);
  }

  async append(...[path, events, fromAuth]: Parameters<MindTarget["append"]>) {
    await this.#mind().append(path, events, fromAuth);
  }

  async receiveEmail(mail: Parameters<MindTarget["receiveEmail"]>[0]) {
    await this.#mind().receiveEmail(mail);
  }

  async runAct(held: Parameters<MindTarget["runAct"]>[0]) {
    await this.#mind().runAct(held);
  }

  #mind() {
    if (!this.#link)
      throw codedError("UNAVAILABLE", "This mind runs elsewhere and is not connected right now.", {
        kind: "disconnected",
        retryAfterMs: 10_000,
      });
    return this.#link.mind;
  }

  /** ONE SESSION'S PART OF `provideExternalMind`: it takes one mind. At the session's end, whatever
   *  ends it, its mind is no link from that moment, and its door refuses every call
   *  (./provided-door.ts). */
  #handInOf(session: ApiSession) {
    let linked: Link | null = null;
    session.onEnd((why, detail) => {
      if (linked && this.#link === linked) this.#link = null;
      console.info({
        event: "boundary.mind-link-ended",
        why: why || "the socket closed",
        hadHandedIn: Boolean(linked),
        ...(detail !== undefined && { detail: String(detail) }),
      });
      // while the session can still say so
      linked?.mind[Symbol.dispose]();
    });
    // The first cast: the boundary declares no `GlobalProps`, so `ctx.exports` has no typed
    // member. `Door` is an export of ./worker.ts, the Worker's main module. The second: a
    // `ProvidedDoor` answers every method of that Door by name, and its class declares none.
    const door = new ProvidedDoor((this.ctx.exports as unknown as { Door: object }).Door, () =>
      session.isOpen(),
    ) as unknown as Door;
    let handedIn = false;
    return async (connect: ConnectStub) => {
      if (handedIn) throw codedError("INVALID_INPUT", "this session handed in its mind already");
      handedIn = true;
      const order = (this.#handIns += 1);
      // What a call answers is its caller's to keep until it lets go of it, so the mind's stub
      // outlives this call. The door is this side's: the function keeps it with `dup()`.
      const answer: unknown = await connect(door);
      // A HAND-IN IS CHECKED BEFORE IT REPLACES ANYTHING. The answer is a capnweb stub, which
      // can be called and can say when it breaks: a plain value in its place would take a
      // healthy mind's link and then answer nothing.
      if (!(answer instanceof RpcStub)) {
        // capnweb gives an object that it answers a disposer, for the stubs inside it; the
        // answer's own type, unknown, does not name it
        (answer as Partial<Disposable> | null | undefined)?.[Symbol.dispose]?.();
        throw codedError(
          "INVALID_INPUT",
          "connect(door) answers the mind, an RpcTarget with fetch, api, append, runAct and receiveEmail",
        );
      }
      // The cast: capnweb's class types no target, and the mind's process answers its `MindTarget`.
      const mind = answer as RpcStub<MindTarget>;
      // registered before the mind is the link: a stub that is broken already says so at once
      mind.onRpcBroken((error) => session.end("broken", error));
      // the session ended while its function ran: the socket is closed, and nothing hears a refusal
      if (!session.isOpen()) return mind[Symbol.dispose]();
      if (order < this.#linkOrder) {
        mind[Symbol.dispose]();
        session.end("takenOver");
        throw codedError("UNAVAILABLE", SESSION_ENDS.takenOver.reason);
      }
      linked = { mind, takeOver: () => session.end("takenOver") };
      const older = this.#link;
      this.#link = linked;
      this.#linkOrder = order;
      console.info({ event: "boundary.mind-link-opened", replaced: Boolean(older) });
      older?.takeOver();
    };
  }
}

function notConnected() {
  console.info({ event: "boundary.mind-not-connected" });
  return new Response("This mind runs elsewhere and is not connected right now.\n", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "10" },
  });
}
