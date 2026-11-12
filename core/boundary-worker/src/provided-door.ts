// provided-door.ts — THE DOOR THAT A PROVIDE SESSION HANDS A MIND AT HOME (provided.ts).
import { RpcTarget } from "capnweb";
import { releasedAnswer } from "iterate/lib";

/** A door's methods, called by name. */
type Methods = Record<string, (...args: unknown[]) => unknown>;

/** Every method of the boundary's Door, each answer copied and released.
 *
 *  A mind on Cloudflare calls the Door across Workers, and lets its answer go when it has read it:
 *  the Door's call ends, and with it the vault's session behind it. A mind at home calls over the
 *  provide session's socket, so each call is made HERE, by the invocation that holds the socket,
 *  and its answer is this invocation's to release. capnweb does not: when the home lab lets an
 *  answer go, it disposes the stubs inside the value and never the value's own disposer. Left
 *  alone, every answer kept its session, and the vault's behind it, open for the socket's whole
 *  life: an hour, or until the mind restarts. */
export class ProvidedDoor extends RpcTarget {
  readonly #door: Methods;

  constructor(door: object) {
    super();
    // a Workers stub answers any name with a method: its type names the Door's, by name
    this.#door = door as Methods;
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
            return releasedAnswer(Promise.resolve(this.#door[name]!(...args)));
          };
        },
      }),
    );
  }
}
