// session-mind.ts — THE MIND AS ONE SESSION OF THE CONTROL PLANE'S API REACHES IT
// (./control-plane-api.ts `session.mind`): the stub that the mind answered to `api(who)`
// (iterate/workers `MindTarget.api`), with one thing added, which only the invocation that holds
// the client's socket can do.
//
// A CLIENT LENDS A STUB WHOSE `fetch` MAY ANSWER A WEBSOCKET (`iterate tunnel`). The mind holds
// that stub as a Workers RPC stub of this Worker, and a `Response` that holds a WebSocket cannot
// be returned over Workers RPC ("Could not serialize object of type "WebSocket"", workerd
// 1.20261116.1). A SOCKET CROSSES A WORKER'S BOUNDARY THROUGH A METHOD NAMED `fetch`, and through
// no other. So for each lend this hands the mind a holder beside the stub (core-itx
// `LentFetchHolder`): the mind asks the holder for the lend's fetch, the holder makes it here, and
// for a socket in the answer it dials a leg into the mind through the mind's own `fetch` and
// joins the two sockets (core-itx `dialRpcStubFetch`, the splice that the mind's Worker runs for
// a session that ends there).
//
//   visitor ─► boundary ─fetch─► mind ─► context ─► mind's `api` invocation ─holder.fetch─► HERE
//   HERE ─capnweb─► client: 101 and a socket          HERE ─`mind.fetch` (the leg)─► context
import { RpcStub, RpcTarget } from "capnweb";
import {
  dialRpcStubFetch,
  fetchUpgradeLegRequest,
  type LentFetchHolder,
} from "core-itx/fetch-upgrade";
import { RESERVED_SEGMENT_NAMES, walkStepsOnRpcStub } from "iterate/expression";
import { codedError } from "iterate/lib";

/** What the mind answered to `api(who)`, as this file calls it: a Workers RPC stub, which answers
 *  every other name too. */
export type MindApiStub = Partial<Disposable> & {
  provide(match: unknown, target: unknown, options: unknown, lentFetch?: object): unknown;
  cd(path: unknown): MindApiStub;
  /** Whether the mind's part of the session lives (core-itx `sessionLives`): the boundary's own
   *  question, whose failure says that the stub broke. */
  sessionLives(): unknown;
};

/** The names that the fallback of `SessionMind` never hands to the mind's stub: the ones that a
 *  framework or capnweb probes on any object (iterate/expression says which, and why: `then` and
 *  `dup` are among them), and the boundary's own watch of the stub. */
const neverForwarded = (name: string) =>
  RESERVED_SEGMENT_NAMES.has(name) || name === "sessionLives";

/** A request into the mind, through its `fetch` (./http.ts `MindTransport.fetch`). */
type FetchInMind = (request: Request) => Promise<Response>;

/** Every name of the mind's own API, as the mind answers it, but `provide` and `cd`: a lend gets
 *  its holder, and a context reached by `cd` is wrapped as this one is, so that a lend there gets
 *  one too. Any other call goes to the mind's stub untouched, pipelined as the client sent it.
 *
 *  A KEY'S SESSION IS NARROW HERE TOO. The mind answers a key its one lend, `whoami` and `provide`
 *  (core/mind-worker `LenderRoot`), and this wrapper adds nothing to that: a key gets no `cd`,
 *  and no other name is asked of the mind for it. */
export class SessionMind extends RpcTarget {
  readonly #mind: MindApiStub;
  readonly #fetchInMind: FetchInMind;
  readonly #ofKey: boolean;
  readonly #ownsStub: boolean;

  /** `ofKey`: the session is a key's. `ownsStub`: the stub is this wrapper's alone (a `cd`'s
   *  answer), and is let go with it. The session's own is the session's to let go of
   *  (./control-plane-api.ts). */
  constructor(mind: MindApiStub, fetchInMind: FetchInMind, ofKey: boolean, ownsStub = false) {
    super();
    this.#mind = mind;
    this.#fetchInMind = fetchInMind;
    this.#ofKey = ofKey;
    this.#ownsStub = ownsStub;
  }

  provide(match: unknown, target: unknown, options?: unknown) {
    // a row (an expression, or null) lends nothing that could answer a socket
    if (!(target instanceof RpcStub)) return this.#mind.provide(match, target, options || {});
    // The stub is this call's alone: the holder keeps a `dup()`, and lets go of it when the mind
    // lets go of the holder.
    return this.#mind.provide(
      match,
      target,
      options || {},
      new LentFetch(target.dup(), this.#fetchInMind),
    );
  }

  cd(path: unknown) {
    if (this.#ofKey) throw keysNames("cd");
    return new SessionMind(this.#mind.cd(path), this.#fetchInMind, false, true);
  }

  [Symbol.dispose]() {
    if (this.#ownsStub) this.#mind[Symbol.dispose]?.();
  }

  static {
    // Above the base's prototype, never in its place: capnweb tells an RpcTarget by `instanceof`,
    // and reads only what an instance does not hold itself. A name is answered with the mind's
    // own stub of it, never a function made here: capnweb walks a path (`mind.files.read`)
    // through that stub, where it stays one pipelined call.
    const base: object = Object.getPrototypeOf(SessionMind.prototype);
    Object.setPrototypeOf(
      SessionMind.prototype,
      new Proxy(Object.create(base), {
        get(target, name, receiver) {
          if (typeof name === "symbol" || name in target || neverForwarded(name))
            return Reflect.get(target, name, receiver);
          // a lookup on the prototype itself names no session's mind
          if (!(#mind in receiver)) return undefined;
          if (receiver.#ofKey && name !== "whoami")
            return () => {
              throw keysNames(name);
            };
          // the cast: a Workers RPC stub answers any name, and its type names three
          return (receiver.#mind as unknown as Record<string, unknown>)[name];
        },
      }),
    );
  }
}

const keysNames = (name: string) =>
  codedError(
    "FORBIDDEN",
    `a key's session has whoami and provide, and nothing else of the mind: no ${name}`,
  );

/** ONE LEND'S `fetch`, made in the invocation that holds the lender's socket. The steps stop short
 *  of the terminal `fetch`: what they reach on the lent stub is what answers it. */
class LentFetch extends RpcTarget implements Omit<LentFetchHolder, "dup"> {
  readonly #lent: Disposable;
  readonly #fetchInMind: FetchInMind;

  constructor(lent: Disposable, fetchInMind: FetchInMind) {
    super();
    this.#lent = lent;
    this.#fetchInMind = fetchInMind;
  }

  async fetch(
    ...[upgradeId, itxExpressionSteps, request, context]: Parameters<LentFetchHolder["fetch"]>
  ) {
    // The cast: the steps walk the client's own stub, which answers any name, and the kernel
    // asks for a fetch only where a lend's rule ends in one.
    const receiver = (await walkStepsOnRpcStub(this.#lent, itxExpressionSteps)) as {
      fetch(request: Request): Promise<unknown>;
    };
    return dialRpcStubFetch(
      (lentRequest) => receiver.fetch(lentRequest),
      request,
      upgradeId,
      () => ({
        fetch: (url, leg) => this.#fetchInMind(fetchUpgradeLegRequest(context, url, leg)),
      }),
    );
  }

  [Symbol.dispose]() {
    this.#lent[Symbol.dispose]();
  }
}
