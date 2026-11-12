import { z } from "zod";
import {
  itxExpressionStepName,
  normalizedItxExpression,
  type ItxExpression,
} from "iterate/expression";
import { codedError, releaseRpcSessions } from "iterate/lib";
import type { StreamProcessorDurableObject } from "iterate/sdk";
import type { StreamEvent } from "iterate/stream/processor";
import { failureKind, ONCE_NOW, retryPlatformFailures } from "iterate/platform-retry";
import type { Caller } from "./caller.ts";
import { DurableObjectNameCodec, type DurableObjectAddress } from "./context/paths.ts";
import type { IterateContextNamespace } from "./iterate-context.ts";
import type { IterateContextDurableObject } from "./iterate-context-durable-object.ts";
import { settlementOfRun, type WaitForEventAt } from "./context/run.ts";
import type { ReachableContext } from "./stream/stream.ts";
import { unavailable } from "./unavailable.ts";

// A fresh stub per call: Cloudflare's error-handling guide says an exception can leave a stub
// broken for every later request. A run's settlement is read in slices of fresh calls, so no call
// holds one instance for a run's length.
export function contextStub(
  namespace: Pick<IterateContextNamespace, "getByName">,
  address: DurableObjectAddress,
  area: string,
  { readsRunSettlements = true }: { readsRunSettlements?: boolean } = {},
) {
  return {
    // Never repeated: a request's body is read once, and its answer may hold a socket.
    fetch(request: Request): Promise<Response> {
      return namespace.getByName(address.name).fetch(request);
    },
    async invoke(
      itxExpression: ItxExpression,
      args: unknown[],
      caller: Caller,
      givenUp?: AbortSignal,
    ): Promise<unknown> {
      let answer: unknown;
      try {
        answer = await retryPlatformFailures(
          async () => {
            const call = namespace.getByName(address.name).invokeSafe(itxExpression, args, caller);
            // A call that threw or was given up on holds the context until its promise is released.
            const release = () => releaseRpcSessions([call]);
            givenUp?.addEventListener("abort", release, { once: true });
            try {
              // workerd's RPC types turn the answer's union into `never`.
              const result = (await call) as Awaited<
                ReturnType<IterateContextDurableObject["invokeSafe"]>
              >;
              if (!result.ok) {
                const { code, message, data } = result.error;
                throw codedError(code, message, data);
              }
              // workerd puts the session's disposer on the wrapper. Plain data is copied and the
              // session let go; an answer that holds a stub gets the disposer, for its holder.
              const { data, [Symbol.dispose]: dispose } = result;
              return releasedWhenPlain(data, dispose && (() => dispose.call(result)));
            } catch (error) {
              release();
              throw error;
            } finally {
              givenUp?.removeEventListener("abort", release);
            }
          },
          {
            area,
            schedule: ONCE_NOW,
            idempotent: isIdempotentItxCall(itxExpression, args),
            kind: failureKind,
            describe: () => ({
              name: itxExpression.map(itxExpressionStepName).join("."),
              path: address.path,
            }),
            signal: givenUp,
          },
        );
      } catch (error) {
        throw unavailable(error);
      }
      if (!readsRunSettlements) return answer;
      return settlementOfRun(answer, waitForEventOnContext(namespace)) ?? answer;
    },
  };
}

/** A JSON object as an answer holds one: Object's own prototype and string keys alone. Its call's
 *  disposer, which workerd puts on an answer under `Symbol.dispose`, is not a key of the data. */
function isJsonObject(value: object): value is Record<string, unknown> {
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" || key === Symbol.dispose)
  );
}

/** `value` copied when it is plain data all the way down (JSON's kinds, and `undefined`), else
 *  `NOT_PLAIN`: a stub, a function, a Date, bytes or any object with a class of its own is not
 *  copied, because a copy of a stub is not the stub. */
const NOT_PLAIN = Symbol("not plain");
function plainCopy(value: unknown): unknown {
  if (typeof value === "function" || typeof value === "symbol") return NOT_PLAIN;
  // a number, a string, a boolean, nothing
  // oxlint-disable-next-line iterate/simple-truthiness-check -- an answer off the wire is of any kind: an object alone is walked
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const copy = value.map(plainCopy);
    return copy.includes(NOT_PLAIN) ? NOT_PLAIN : copy;
  }
  if (!isJsonObject(value)) return NOT_PLAIN;
  const copy = {};
  for (const [key, held] of Object.entries(value)) {
    const copied = plainCopy(held);
    if (copied === NOT_PLAIN) return NOT_PLAIN;
    // Defined, never assigned: an event's payload is anyone's JSON, and a key named `__proto__`
    // is data there. An assignment would set the copy's prototype in place of the key.
    Object.defineProperty(copy, key, {
      value: copied,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/** A context's answer with its call's session let go, when the answer is plain data: the caller
 *  gets a copy. An answer that crosses Workers RPC keeps its session open until its disposer
 *  runs, and for plain data nobody ran it: the runtime then logs "An RPC result was not disposed
 *  properly". An answer that holds a stub is handed on as it is, with `dispose` on it, for
 *  whoever holds it. As core/mind-worker's `releasedAnswer` does for the vault's answers. */
function releasedWhenPlain<T>(held: T, dispose: (() => void) | undefined): T {
  if (!dispose) return held;
  const copy = plainCopy(held);
  if (copy !== NOT_PLAIN) {
    dispose();
    // `plainCopy` answers `unknown`; a copy of plain data has the shape of what it copies
    return copy as T;
  }
  if (held instanceof Object && !(Symbol.dispose in held))
    Object.defineProperty(held, Symbol.dispose, { value: dispose, configurable: true });
  return held;
}

/** `releasedWhenPlain` for a verb that answers the value itself, with its disposer on it. */
async function released<T>(answer: Promise<T> | T): Promise<T> {
  const held = await answer;
  // An answer of any type may carry its call's disposer: `Partial<Disposable>` says "perhaps",
  // which no type of the answer itself does.
  const dispose =
    held instanceof Object ? (held as Partial<Disposable>)[Symbol.dispose] : undefined;
  return releasedWhenPlain(held, dispose && (() => dispose.call(held)));
}

export function reachableContext(
  namespace: Pick<IterateContextNamespace, "getByName">,
  address: DurableObjectAddress,
  area: string,
  options?: { readsRunSettlements?: boolean },
): ReachableContext {
  const hop = contextStub(namespace, address, area, options);
  const stub = () => namespace.getByName(address.name);
  return {
    fetch: hop.fetch,
    append: (...events) => released(stub().append(...events)),
    read: (...page) => released(stub().read(...page)),
    reserveSend: (key) => released(stub().reserveSend(key)),
    releaseSend: (key) => stub().releaseSend(key),
    invoke: (call, args = [], caller = { principal: null }) =>
      hop.invoke(normalizedItxExpression(call), args, caller),
  };
}

export function waitForEventOnContext(
  namespace: Pick<IterateContextNamespace, "getByName">,
): WaitForEventAt {
  return async (path, filter, givenUp) => {
    const found = await contextStub(
      namespace,
      DurableObjectNameCodec.address(path),
      "itx-run",
    ).invoke(["itx", "builtins", ["waitForEvent", filter]], [], { principal: null }, givenUp);
    try {
      return structuredClone(found) as StreamEvent;
    } finally {
      releaseRpcSessions([found]);
    }
  };
}

// Judged as the caller spelled it: an owner's rule or facet that makes one of these a write is the
// owner's to keep safe to repeat.
const IDEMPOTENT_CALLS: ReadonlySet<string> = new Set([
  "whoami",
  "readEvents",
  "waitForEvent",
  "kv.get",
  "kv.list",
  "rewriteRules.list",
  "subscriptions.list",
  "processors.list",
  "processors.enable",
  ...(
    [
      "snapshot",
      "liveSnapshot",
      "waitUntilProcessed",
    ] satisfies (keyof StreamProcessorDurableObject)[]
  ).map((read) => `facets.get.${read}`),
  "repos.list",
  ...["tip", "readFile", "modules", "listFiles", "log", "origin"].map(
    (verb) => `repos.get.${verb}`,
  ),
  "workspaces.list",
  ...["mounts", "readFile", "readBase", "listAllFiles", "gitStatus", "gitLog"].map(
    (verb) => `workspaces.get.${verb}`,
  ),
  "sandboxes.list",
]);

const KeyedDurableEvent = z.object({
  idempotencyKey: z.string().min(1),
  ephemeral: z.literal(false).optional(),
});

// A call with live args (a Request, a callback) is never idempotent.
function isIdempotentItxCall(itxExpression: ItxExpression, args: unknown[]): boolean {
  if (args.length > 0) return false;
  let steps = itxExpression.slice(itxExpression[1] === "builtins" ? 2 : 1);
  while (Array.isArray(steps[0]) && steps[0][0] === "cd") steps = steps.slice(1);
  const [call] = steps;
  if (
    steps.length === 1 &&
    Array.isArray(call) &&
    (call[0] === "append" || call[0] === "appendOffsets")
  )
    return (
      call.length > 1 &&
      call
        .slice(1)
        // An ephemeral is never stored, so its key matches nothing on a second call.
        .every(
          (event) =>
            (event as { ephemeral?: unknown } | null)?.ephemeral !== true &&
            KeyedDurableEvent.safeParse(event).success,
        )
    );
  return IDEMPOTENT_CALLS.has(steps.map(itxExpressionStepName).join("."));
}
