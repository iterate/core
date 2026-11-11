import { InvokeHandle, type ItxExpression } from "iterate/expression";
import { crossingOneMore, type Cause } from "../cause.ts";
import type { Caller } from "../caller.ts";
import type { IterateContextNamespace } from "../iterate-context.ts";
import { reachableContext } from "../context-stub.ts";
import { itxEntrypointFor, type LibraryItx } from "../host.ts";
import {
  buildIdentityRoots,
  buildPortableBuiltIns,
  callContext,
  workersRoot,
} from "./built-ins.ts";
import { egress } from "./egress.ts";
import { ItxExpressionResolver } from "./itx-expression-rewriting.ts";
import { DurableObjectNameCodec, type DurableObjectAddress } from "./paths.ts";
import { ruleSnapshots, type RulesSnapshotAnswer } from "./rule-snapshots.ts";

export function contextReach(args: {
  namespace: IterateContextNamespace;
  ctx: DurableObjectState | ExecutionContext;
  ambient?: () => Pick<Caller, "delivery" | "cause">;
  readsRunSettlements?: boolean;
}) {
  const { namespace, readsRunSettlements } = args;
  const ambient: () => Pick<Caller, "delivery" | "cause"> = args.ambient || (() => ({}));
  const nameOf = (path: string) => DurableObjectNameCodec.stringify(path);
  const stubOf = (path: string) => namespace.getByName(nameOf(path));
  const addressOf = (path: string) => DurableObjectNameCodec.address(path);
  const contextOf = (path: string) =>
    reachableContext(namespace, addressOf(path), "itx", { readsRunSettlements });
  const resolverAt = (path: string, cause: Cause | undefined, app?: true) =>
    statelessResolverFor({
      namespace,
      address: addressOf(path),
      caller: { principal: null, app, cause },
      ctx: args.ctx,
    });
  const loadedCodeAt = (path: string, cause: Cause | undefined) => (call: ItxExpression) =>
    resolverAt(path, cause, true).invoke(call);
  return {
    contextOf,
    loadedCodeAt,
    recordLoopLimit: (path: string, cause: Cause, message: string) =>
      args.ctx.waitUntil(stubOf(path).recordLoopLimit(cause, message)),
    snapshotOf: (path: string) =>
      ruleSnapshots.get(
        nameOf(path),
        // workerd's RPC types wrap the `RulesSnapshotAnswer` in a type that no longer matches.
        (ifVersion) =>
          stubOf(path).rulesSnapshot(ifVersion) as unknown as Promise<RulesSnapshotAnswer>,
        (reading) => args.ctx.waitUntil(reading),
      ),
    located: (path: string, expression: ItxExpression, callArgs: unknown[], caller: Caller) => {
      return callContext(
        () => contextOf(path),
        expression,
        callArgs,
        caller,
        path,
        () => ambient().delivery,
      );
    },
    workersOf: (path: string, caller: Caller, hops: number, vouched: boolean) => {
      // Read per call: a row's target is resolved once and called for each delivery.
      const cause = () => {
        const now = ambient().cause;
        return now && hops ? crossingOneMore(now, path, hops) : now;
      };
      return workersRoot({
        path,
        iterateContextName: nameOf(path),
        itxEntrypoint: () => itxEntrypointFor(args.ctx, nameOf(path)),
        invoke: (call) => loadedCodeAt(path, cause())(call),
        // The producer runs as the loaded code of the context whose rule names it, not of `path`.
        namedWorker: async (source) => {
          const { at, spec, vouched } = await resolverAt(path, cause()).namedWorker(source);
          return { spec, vouched, invoke: (call) => loadedCodeAt(at, cause())(call) };
        },
        caller: () => caller,
        delivery: () => ambient().delivery,
        cause,
        vouched,
      });
    },
  };
}

export function statelessResolverFor(args: {
  namespace: IterateContextNamespace;
  address: DurableObjectAddress;
  caller: Caller;
  ctx: DurableObjectState | ExecutionContext;
}): ItxExpressionResolver {
  const { address, caller } = args;
  const { path } = address;
  const reach = contextReach({
    namespace: args.namespace,
    ambient: () => ({ cause: caller.cause }),
    ctx: args.ctx,
  });
  const context = reach.contextOf;
  // No `connections`: a resolver lives one round trip, so a connector root is sent to the
  // context, whose residency holds and releases them.
  const resolverUnder = (callerNow: Caller) => {
    const build = (): Record<string, unknown> => ({
      ...buildPortableBuiltIns({
        path,
        context,
        egress: (request) => egress(request, { cause: callerNow.cause, path }),
        caller: () => callerNow,
        invokeAs: (callerThere, call) => resolverUnder(callerThere).invoke(call),
        itx: libraryItx,
      }),
      ...buildIdentityRoots({ path, caller: () => callerNow }),
    });
    return new ItxExpressionResolver({
      reach,
      builtIns: build,
      path,
      caller: () => callerNow,
    });
  };
  // The library's hops go as the platform's (no `app`). Cast: InvokeHandle's declared type lacks
  // the dotted members its prototype fallback serves.
  const { app: _loadedCode, ...libraryCaller } = caller;
  const libraryItx = new InvokeHandle((steps) =>
    resolverUnder(libraryCaller).invoke(["itx", ...steps]),
  ) as unknown as LibraryItx;
  return resolverUnder(caller);
}
