// provided-door.ts — THE DOOR THAT A MIND WHICH RUNS ELSEWHERE IS GIVEN, as the argument of its
// connect function (./provided-mind.ts).
import { RpcTarget } from "capnweb";
import { codedError, releasedAnswer } from "iterate/lib";

/** A door's methods, called by name. */
type Methods = Record<string, (...args: unknown[]) => unknown>;

/** Every method of the boundary's Door, each answer copied and released.
 *
 *  A mind on Cloudflare calls the Door across Workers, and lets its answer go when it has read it:
 *  the Door's call ends, and with it the vault's session behind it. A mind at home calls over
 *  its link's socket, so each call is made HERE, by the Durable Object that holds the socket,
 *  and its answer is this object's to release. capnweb does not: when the home lab lets an
 *  answer go, it disposes the stubs inside the value and never the value's own disposer. Left
 *  alone, every answer kept its session, and the vault's behind it, open for the socket's whole
 *  life: an hour, or until the mind restarts.
 *
 *  THE DOOR ENDS WITH ITS SESSION. `sessionIsOpen` is asked before every call, and a call after
 *  the session's end is refused here: the token that the session came with has ended, or another
 *  session took the mind over. A mind holds the door from the moment its connect function is
 *  called, so this does not wait for the mind to be handed in, or for the socket to close. */
export class ProvidedDoor extends RpcTarget {
  readonly #door: Methods;
  readonly #sessionIsOpen: () => boolean;

  constructor(door: object, sessionIsOpen: () => boolean) {
    super();
    // a Workers stub answers any name with a method: its type names the Door's, by name
    this.#door = door as Methods;
    this.#sessionIsOpen = sessionIsOpen;
  }

  static {
    // Above the base's prototype, never in its place: capnweb tells an RpcTarget by `instanceof`,
    // and calls only what an instance does not hold itself.
    const base: object = Object.getPrototypeOf(ProvidedDoor.prototype);
    Object.setPrototypeOf(
      ProvidedDoor.prototype,
      new Proxy(Object.create(base), {
        get(target, name, receiver) {
          // an instance is no thenable, and capnweb's own `dup` is not the Door's to answer
          if (typeof name === "symbol" || name === "then" || name === "dup" || name in target)
            return Reflect.get(target, name, receiver);
          return function (this: ProvidedDoor, ...args: unknown[]) {
            if (!this.#sessionIsOpen())
              throw codedError("FORBIDDEN", "the session that was given this door has ended");
            // the call itself, not a promise made from it: a refused call is released by its own
            // promise's disposer (iterate/lib `releasedAnswer`)
            return releasedAnswer(this.#door[name]!(...args) as PromiseLike<unknown>);
          };
        },
      }),
    );
  }
}
