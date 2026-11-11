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
              // workerd puts the session's disposer on the wrapper; whoever gets an answer
              // releases the answer itself, so it moves onto the answer.
              const { data, [Symbol.dispose]: dispose } = result;
              if (dispose && data instanceof Object && !data[Symbol.dispose])
                Object.defineProperty(data, Symbol.dispose, { value: dispose, configurable: true });
              return data;
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
    append: (...events) => stub().append(...events),
    read: (...page) => stub().read(...page),
    reserveSend: (key) => stub().reserveSend(key),
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
