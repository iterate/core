import { RpcTarget } from "cloudflare:workers";

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

export function relayTo(target: () => object) {
  class Relay extends RpcTarget {}
  forwardEveryMethod(Relay, (_relay, method, args) =>
    (target() as Record<string, (...args: unknown[]) => unknown>)[method]!(...args),
  );
  return new Relay();
}
