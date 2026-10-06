// sdk/call-with-cause.ts — `walkUnderCause`, the walk behind every `callWithCause`: the SDK hosts'
// (index.ts), and the one every loaded `WorkerEntrypoint` gets (loaded-worker.ts). Its own module,
// so a loaded isolate that never imports the SDK's hosts never evaluates them.

// Typed against the Cloudflare types, never Node's, as ../cause.ts is, which says why.
// @ts-ignore -- without Node's types the import has none; it is typed where it is constructed
import { AsyncLocalStorage as NodeAsyncLocalStorage } from "node:async_hooks";
import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { runCausedBy } from "../cause.ts";
import { codedError } from "../lib.ts";

/** A step of `callWithCause`'s walk, which reaches no further than Workers RPC would: on this facet
 *  or an RpcTarget, a member its class declares (never a field of its own); anything on a stub; on
 *  plain data, its own members (never a method of data the facet holds live). */
/** An expression's steps past a host: a property, or a method and its arguments. */
export type RpcSteps = (string | [string, ...unknown[]])[];

/** The caller's path of the walk running now (`walkUnderCause`). The import is untyped (above), so
 *  its constructor is typed here. */
const walkCallerPath = new (NodeAsyncLocalStorage as new <T>() => {
  run<R>(store: T, code: () => R): R;
  getStore(): T | undefined;
})<{ callerPath: string | undefined }>();

/** `callWithCause` (../cause.ts): the platform's way to walk `steps` on `host` under the cause of
 *  the call that made it — only as far as Workers RPC would reach, and never into `callWithCause`
 *  itself or `getItx`, which Workers RPC reaches on every loaded entrypoint (loaded-worker.ts).
 *  `callerPath` is the context the call came from, as the platform stamps it (core/os caller.ts
 *  `Caller.path`); `currentCallerPath` reads it while the walk runs. */
export function walkUnderCause(
  host: object,
  cause: unknown,
  steps: RpcSteps,
  callerPath?: string,
): Promise<unknown> {
  return runCausedBy(cause, () =>
    walkCallerPath.run({ callerPath }, async () => {
      let value: unknown = host;
      for (const step of steps) {
        const [name, ...args] = typeof step === "string" ? [step] : step;
        if (name === "callWithCause")
          throw codedError("NOT_A_METHOD", "callWithCause is the platform's alone");
        if (name === "getItx") throw codedError("NOT_A_METHOD", "getItx is the code's own");
        const member = memberRpcReaches(value, name);
        value =
          typeof step === "string"
            ? await member
            : // a step with arguments calls its member; Reflect.apply throws on anything else
              await Reflect.apply(member as (...a: unknown[]) => unknown, value, args);
      }
      return value;
    }),
  );
}

/** The context the method running now was called from (`walkUnderCause`), or undefined outside a
 *  walk the platform handed one: a `fetch`, a facet's call, module scope. */
export const currentCallerPath = (): string | undefined => walkCallerPath.getStore()?.callerPath;

function memberRpcReaches(value: unknown, name: string): unknown {
  // (RpcStub's own type is generic past what TypeScript will narrow)
  if (value instanceof (RpcStub as unknown as new () => object))
    return (value as Record<string, unknown>)[name];
  const prototype = typeof value === "object" && value ? Object.getPrototypeOf(value) : undefined;
  const reaches =
    value instanceof RpcTarget ||
    value instanceof DurableObject ||
    value instanceof WorkerEntrypoint
      ? name in value && !Object.hasOwn(value, name) && !(name in Object.prototype)
      : // one of these prototypes means `value` is an object
        (prototype === Object.prototype || prototype === Array.prototype || prototype === null) &&
        Object.hasOwn(value as object, name);
  if (!reaches) throw codedError("NOT_A_METHOD", `${name} is no method Workers RPC would reach`);
  // `reaches` holds only for an object: its member, read by name
  return (value as Record<string, unknown>)[name];
}
