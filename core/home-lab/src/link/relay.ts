import { RpcTarget } from "cloudflare:workers";
import type { MindTarget } from "iterate/workers";

/** Forwards every method `Class`'s base lacks. Never `then` (an instance is no thenable) nor `dup`:
 *  capnweb calls `dup` on a target passed as a parameter, and workerd refuses to send it. */
export function forwardEveryMethod<Instance extends object>(
  Class: abstract new (...args: never[]) => Instance,
  forward: (self: Instance, method: string, args: unknown[]) => unknown,
) {
  // Above the base's prototype, never in its place: capnweb tells an RpcTarget by `instanceof`.
  const base = Object.getPrototypeOf(Class.prototype) as object;
  Object.setPrototypeOf(
    Class.prototype,
    new Proxy(Object.create(base) as object, {
      get(target, name, receiver) {
        if (typeof name === "symbol" || name === "then" || name === "dup" || name in target)
          return Reflect.get(target, name, receiver);
        return function (this: Instance, ...args: unknown[]) {
          return forward(this, name, args);
        };
      },
    }),
  );
}

/** The mind, for the boundary: every method of `MindTarget` goes on to the local Mind Worker as it
 *  came. */
export function relayTo(target: () => MindTarget) {
  class Relay extends RpcTarget {
    /** The config's `email` hook (iterate/workers `MindTarget.email`). capnweb hands `save` and
     *  `forward` in as stubs of its own, which last while this call does and call back over the
     *  link to the boundary. Neither goes into Workers RPC as it is: a function of this isolate's
     *  calls each, and Workers RPC hands the local Mind Worker a stub of that function. A boundary
     *  of an older build hands no `save`. It answers what the local Mind Worker answered
     *  (how the hook ended, or nothing from an older build). */
    email({ mail, save, forward }: Parameters<MindTarget["email"]>[0]) {
      return target().email({
        mail,
        ...(save && { save: () => save() }),
        forward: (to) => forward(to),
      });
    }
  }
  // the cast: a Workers RPC stub answers each of the mind's methods by name
  forwardEveryMethod(Relay, (_relay, method, args) =>
    (target() as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args),
  );
  return new Relay();
}
