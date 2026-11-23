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
//
// THE FACTS THAT A MIND AWAY COULD NOT TAKE. A fact of a mail (./mail.ts: `email/forwarded`,
// `email/forward-failed`, `email/hook-failed`) that the mind does not take, for any reason but its
// own typed refusal (not connected, a link that breaks under the call, a platform failure), is
// kept in this object's storage (`appendOrKeep`), and appended in its order by ONE DRAIN at a time
// (`#drain`), after a hand-in and after a live append that landed. A ROW GOES ONLY WHEN ITS APPEND
// LANDED OR THE MIND REFUSED IT BY A TYPED CODE: any other answer stops the drain, and every row
// stays. At most KEPT_FACTS_MAX are kept: a fact past the bound
// drops the oldest, and the next fact appended says how many were dropped. Each is appended with
// its own idempotency key, so a fact that reached the mind before the link broke is refused as
// IDEMPOTENCY_CONFLICT (the late payload differs) and not written twice. Its payload's
// `recordedLate` says when it happened (iterate/email).
import { DurableObject } from "cloudflare:workers";
import { RpcStub } from "capnweb";
import { codedError, errorCode } from "iterate/lib";
import { failureKind } from "iterate/platform-retry";
import type { Door, MindTarget } from "iterate/workers";
import { boundaryConfigOf } from "./config.ts";
import {
  type ApiSession,
  type ConnectStub,
  controlPlaneApiResponse,
  SESSION_ENDS,
} from "./control-plane-api.ts";
import type { DoorEnv } from "./env.ts";
import type { PlatformFact } from "./http.ts";
import { ProvidedDoor } from "./provided-door.ts";
import type { DoorProps } from "./rpc.ts";

/** How many facts this object keeps for a mind that is away. A mail makes at most a few, so 100
 *  is a long absence, and 100 small rows. */
export const KEPT_FACTS_MAX = 100;
/** Each kept fact's key: the prefix and its number, padded so that the keys list in order. */
const KEPT_FACT_PREFIX = "kept-fact:";
/** The next fact's number, and how many were dropped at the bound and not said yet. */
const KEPT_FACTS_STATE = "kept-facts";
type KeptFactsState = { next: number; dropped: number };
type KeptFact = { path: string; fact: PlatformFact; happenedAt: string };

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
  /** A drain runs, and one was asked for while it ran. */
  #draining = false;
  #drainAgain = false;

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

  /** ONE PLATFORM FACT that must reach the mind's log: appended now, or kept. ONLY THE MIND'S OWN
   *  TYPED REFUSAL THROWS, from a link that is still the link (`failureKind` "refused": a coded
   *  error other than UNAVAILABLE), which no later append mends. Every other failure keeps the fact.
   *  No drain straight after a keep on the link that just failed; one at once when a newer link is
   *  there (its hand-in's drain can have run before this call to the older link failed). */
  async appendOrKeep(path: string, fact: PlatformFact) {
    const link = this.#link;
    if (link)
      try {
        await link.mind.append(path, [fact]);
        return void this.#drain();
      } catch (error) {
        if (this.#link === link && failureKind(error) === "refused") throw error;
      }
    this.#keep({ path, fact, happenedAt: new Date().toISOString() });
    if (this.#link && this.#link !== link) void this.#drain();
  }

  async receiveEmail(mail: Parameters<MindTarget["receiveEmail"]>[0]) {
    await this.#mind().receiveEmail(mail);
  }

  /** THE CONFIG'S `email` HOOK, over the link (iterate/workers `MindTarget.email`). `save` and
   *  `forward` are Workers RPC stubs of the boundary's invocation here. capnweb sends its own
   *  stubs, its targets and plain functions, so a function of this object's calls each stub, and
   *  capnweb hands that function to the far end as a stub of its own: the home lab calls back
   *  through it, and it lasts while this call does. It answers what the mind answered:
   *  how the hook ended, or nothing from a mind of an older build. */
  async email({ mail, save, forward }: Parameters<MindTarget["email"]>[0]) {
    return await this.#mind().email({
      mail,
      ...(save && { save: () => save() }),
      forward: (to) => forward(to),
    });
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

  /** Keeps one fact; past the bound, the oldest goes, and is counted. The synchronous KV: no other
   *  call runs between the reads and the writes. */
  #keep(kept: KeptFact) {
    const kv = this.ctx.storage.kv;
    const state = kv.get<KeptFactsState>(KEPT_FACTS_STATE) ?? { next: 0, dropped: 0 };
    kv.put(`${KEPT_FACT_PREFIX}${String(state.next).padStart(12, "0")}`, kept);
    state.next += 1;
    const keys = [...kv.list({ prefix: KEPT_FACT_PREFIX })].map(([key]) => key);
    for (const key of keys.slice(0, Math.max(0, keys.length - KEPT_FACTS_MAX))) {
      const oldest = kv.get<KeptFact>(key);
      kv.delete(key);
      state.dropped += 1;
      console.error({
        event: "boundary.kept-fact-dropped",
        message: `more than ${KEPT_FACTS_MAX} facts wait for the mind: the oldest is dropped`,
        path: oldest?.path,
        type: oldest?.fact.type,
        idempotencyKey: oldest?.fact.idempotencyKey,
      });
    }
    kv.put(KEPT_FACTS_STATE, state);
    console.info({
      event: "boundary.mind-fact-kept",
      path: kept.path,
      type: kept.fact.type,
      idempotencyKey: kept.fact.idempotencyKey,
      kept: Math.min(keys.length, KEPT_FACTS_MAX),
    });
  }

  /** THE DRAIN, one at a time: asked for while one runs, it runs once more, and nothing queues.
   *  The kept facts, the oldest first, until none is left or one neither landed nor was refused. */
  async #drain() {
    if (this.#draining) return void (this.#drainAgain = true);
    this.#draining = true;
    // A pass that stops on a failure still honours a drain asked for while it ran: a newer link's
    // hand-in during an older link's pending replay drains once more, to the newer link.
    do {
      this.#drainAgain = false;
      await this.#appendEachKept().catch((error: unknown) =>
        console.error({ event: "boundary.kept-facts-not-appended", error: String(error) }),
      );
    } while (this.#drainAgain);
    this.#draining = false;
  }

  async #appendEachKept() {
    const kv = this.ctx.storage.kv;
    for (;;) {
      const link = this.#link;
      const [key, kept] = [...kv.list<KeptFact>({ prefix: KEPT_FACT_PREFIX, limit: 1 })][0] ?? [];
      if (!link || !key || !kept) return;
      const { dropped } = kv.get<KeptFactsState>(KEPT_FACTS_STATE)!;
      const recordedLate = {
        happenedAt: kept.happenedAt,
        ...(dropped > 0 && { droppedBefore: dropped }),
      };
      try {
        await link.mind.append(kept.path, [
          { ...kept.fact, payload: { ...kept.fact.payload, recordedLate } },
        ]);
        if (dropped > 0) {
          const state = kv.get<KeptFactsState>(KEPT_FACTS_STATE)!;
          kv.put(KEPT_FACTS_STATE, { ...state, dropped: state.dropped - dropped });
        }
      } catch (error) {
        // Not landed, not refused (a broken link, a platform or unclassified failure): it stays.
        if (this.#link !== link || failureKind(error) !== "refused")
          throw new Error(`${kept.fact.idempotencyKey}: ${String(error)}`);
        const reachedBefore = errorCode(error) === "IDEMPOTENCY_CONFLICT";
        // The mind's typed refusal, which no retry mends, or the fact that reached it before.
        console[reachedBefore ? "info" : "error"]({
          event: reachedBefore ? "boundary.kept-fact-reached-before" : "boundary.kept-fact-refused",
          path: kept.path,
          type: kept.fact.type,
          idempotencyKey: kept.fact.idempotencyKey,
          ...(!reachedBefore && { appendError: String(error) }),
        });
      }
      kv.delete(key);
    }
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
    // `provided`: this Door's own request is no mind's own (./rpc.ts `Door.fetch`).
    const exports = this.ctx.exports as unknown as {
      Door: (options: { props: DoorProps }) => object;
    };
    const door = new ProvidedDoor(exports.Door({ props: { provided: true } }), () =>
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
          "connect answers the mind, an RpcTarget with fetch, api, append, runAct, receiveEmail and email",
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
      void this.#drain();
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
