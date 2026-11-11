import { RpcTarget } from "capnweb";
import {
  InvokeHandle,
  normalizedItxExpression,
  print,
  type ItxExpression,
  type ItxExpressionInput,
} from "iterate/expression";
import { codedError, releaseRpcSessions } from "iterate/lib";

// Promise brands the walk threads unawaited, so a chain pipelines into one round trip. Registered
// at boot (iterate-context.ts), not imported here: Node unit tests run this module.
const PIPELINED_RPC_BRANDS: (abstract new (...args: never[]) => unknown)[] = [];
export function registerPipelinedRpcBrand(brand: abstract new (...args: never[]) => unknown): void {
  PIPELINED_RPC_BRANDS.push(brand);
}
const pipelined = (v: unknown): boolean => PIPELINED_RPC_BRANDS.some((b) => v instanceof b);

// Workers-RPC brands whose values hold a session, and the actor at its far end, until disposed.
const RPC_SESSION_BRANDS: (abstract new (...args: never[]) => unknown)[] = [];
export function registerRpcSessionBrand(brand: abstract new (...args: never[]) => unknown): void {
  RPC_SESSION_BRANDS.push(brand);
}
const holdsRpcSession = (v: unknown): boolean => RPC_SESSION_BRANDS.some((b) => v instanceof b);

export const isMissingRpcMethod = (error: unknown, method: string): boolean =>
  String(error).includes(`does not implement the method "${method}"`);

// workerd keeps a rejected call's session, and the far actor, open until its promise is disposed,
// and an idle isolate may not collect it for many minutes.
export async function awaitAnswerReleasedIfRejected(answer: unknown): Promise<unknown> {
  try {
    return await answer;
  } catch (error) {
    if (holdsRpcSession(answer)) releaseRpcSessions([answer]);
    throw error;
  }
}

// `constructor` would hand out the class itself.
function stepGet(value: object, key: string): unknown {
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  return Reflect.get(value, key);
}

// Call with `Reflect.apply`, never `stub[m].apply(…)`: `.apply` on an RPC stub is a pipelined remote
// path that serializes the stub, and a facet stub then throws DataCloneError. Do not simplify.
export async function walkSteps(
  start: { value: unknown; receiver: unknown },
  steps: ItxExpression,
  // collects the session-holding values walked past (never the start or the answer), for the owner
  // to release once the answer is in
  rpcSessionsSteppedPast?: unknown[],
): Promise<{ value: unknown; receiver: unknown }> {
  let { value, receiver } = start;
  for (const [stepIndex, step] of steps.entries()) {
    if (!pipelined(value)) value = await value;
    // a facet, or a handle that says so, takes the rest of the walk in one call (under the cause)
    const name = typeof step === "string" ? step : step[0];
    if (
      (value instanceof FacetHandle || (value instanceof InvokeHandle && value.takesTheRest)) &&
      name !== "invoke" &&
      name !== "applyRoot"
    )
      return { value: await value.invoke(steps.slice(stepIndex)), receiver: undefined };
    if (stepIndex > 0 && holdsRpcSession(value)) rpcSessionsSteppedPast?.push(value);
    if (value == null)
      throw new Error(
        `hit ${String(value)} at step ${stepIndex + 1} of ${print(steps)} (${JSON.stringify(step)})`,
      );
    if (typeof step === "string") {
      receiver = value;
      value = stepGet(value as object, step);
    } else {
      const [method, ...args] = step;
      if (method === "") {
        // the anonymous call step: call the value itself
        value = callOn(value, receiver, args);
        receiver = undefined;
        if (!pipelined(value)) value = await value;
        continue;
      }
      const fn = stepGet(value as object, method);
      if (typeof fn !== "function")
        throw codedError(
          "NOT_A_METHOD",
          `${JSON.stringify(method)} is not a method at step ${stepIndex + 1} of ${print(steps)}`,
        );
      receiver = undefined;
      value = Reflect.apply(fn, value, args);
      if (!pipelined(value)) value = await value;
    }
  }
  return { value: pipelined(value) ? value : await value, receiver };
}

export async function callOn(value: unknown, receiver: unknown, args: unknown[]): Promise<unknown> {
  if (typeof value === "function") return Reflect.apply(value, receiver, args);
  if (value instanceof InvokeHandle) return value.applyRoot(args);
  throw codedError("NOT_A_METHOD", `target is not callable but ${args.length} arg(s) were passed`);
}

export class FacetHandle extends InvokeHandle {}

export class RpcStubHandle extends InvokeHandle {}

// A handle answered as a live stub would hold the context's actor resident while the caller keeps
// it, so the context answers the caller's expression instead and the caller mints its own handle.
const ITX_HANDLE_REFERENCE_KEY = "$itxHandleExpression";
type ItxHandleReference = { [ITX_HANDLE_REFERENCE_KEY]: ItxExpression };

const isItxHandleReference = (value: unknown): value is ItxHandleReference =>
  Boolean(value) &&
  typeof value === "object" &&
  Array.isArray((value as Record<string, unknown>)[ITX_HANDLE_REFERENCE_KEY]);

// workerd gives every object an RPC call answered with, but a stub, a disposer for that call.
const isRpcResultWithDisposer = (value: unknown): value is Disposable =>
  typeof (value as Partial<Disposable> | null | undefined)?.[Symbol.dispose] === "function";

// A careless caller disposes nothing, so nothing of the call's session may outlive the call: a live
// result becomes its expression; data from a hop below is copied and released, as it holds the actor.
export function itxAnswerDetachedFromSession(
  result: unknown,
  call: ItxExpressionInput,
  args: unknown[] = [],
): unknown {
  const reference = (): ItxHandleReference => {
    const expression = normalizedItxExpression(call);
    const last = expression.at(-1);
    return {
      [ITX_HANDLE_REFERENCE_KEY]:
        args.length === 0
          ? expression
          : typeof last === "string" && expression.length > 1
            ? [...expression.slice(0, -1), [last, ...args]]
            : [...expression, ["", ...args]],
    };
  };
  if (holdsRpcSession(result)) {
    releaseRpcSessions([result]);
    return reference();
  }
  if (result instanceof RpcTarget || typeof result === "function" || isItxHandleReference(result))
    return reference();
  if (!isRpcResultWithDisposer(result)) return result;
  let copy: unknown;
  try {
    copy = structuredClone(result);
  } catch {
    return result; // a stream, a Response, data holding a stub: not data a copy can carry
  }
  releaseRpcSessions([result]);
  return copy;
}

export function materializeItxHandleReference(
  result: unknown,
  invoke: (expression: ItxExpression) => unknown,
): unknown {
  if (!isItxHandleReference(result)) return result;
  const expression = result[ITX_HANDLE_REFERENCE_KEY];
  return new InvokeHandle((steps) =>
    invoke(
      typeof steps === "string" || steps[0] === "itx"
        ? normalizedItxExpression(steps as ItxExpressionInput)
        : [...expression, ...steps],
    ),
  );
}
