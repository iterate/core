// The client is just capnweb: there is no client SDK, so anything that needs client-side smarts
// belongs here, behind an RpcTarget method. capnweb terminates here; the DO is reached over Workers
// RPC only. A client's rpc stub must live in this stateless worker, never in the DO.

import { RpcPromise as CapnwebRpcPromise, RpcStub as CapnwebRpcStub, RpcTarget } from "capnweb";
import { z } from "zod";
import { codedError, ITERATE_CAUSE_HEADER, loopLimitOf, resolveContextPath } from "iterate/lib";
import * as cloudflareWorkers from "cloudflare:workers";
import {
  InvokeHandle,
  canonicalItxExpressionPrefix,
  itxExpressionStepName,
  normalizedItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
  installPrototypeInvokeFallback,
} from "iterate/expression";
import type { EventCopyTarget, FetchRouteInput, IterateContextApi } from "iterate/api";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import { newChain, parseCause, type Cause } from "./cause.ts";
import {
  itxAnswerDetachedFromSession,
  materializeItxHandleReference,
  registerPipelinedRpcBrand,
  registerRpcSessionBrand,
} from "./context/dispatch.ts";
import type { Caller } from "./caller.ts";
import type { IterateContextDurableObject, Env } from "./iterate-context-durable-object.ts";
import { contexts } from "./host.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  encodeFetchExpression,
  parseFetchExpression,
  itxExpressionEndingInFetch,
  stampCallerHeaders,
  terminalFetchOf,
} from "./context/rpc-stubs.ts";
import {
  lendRpcStubOverPager,
  type ClientRpcStub,
  type IterateContextDurableObjectStub,
} from "./context/rpc-stub-relay.ts";
import {
  entersOwnRoot,
  implicitRootsAt,
  normalizeRewriteRuleConfigured,
  type ItxExpressionResolver,
} from "./context/itx-expression-rewriting.ts";
import { lendRefusal } from "./context/lent-names.ts";
import { FetchRouteConfiguredPayload } from "./fetch-routes.ts";
import type { BuiltInScope } from "./context/built-ins.ts";
import { statelessResolverFor } from "./context/stateless-context.ts";
import { DurableObjectNameCodec, type DurableObjectAddress } from "./context/paths.ts";
import { SessionTeardown } from "./session.ts";
import { contextStub } from "./context-stub.ts";
import { expressionFetchErrorAnswer } from "./unavailable.ts";

export type IterateContextNamespace = DurableObjectNamespace<IterateContextDurableObject>;
type WaitUntil = (p: Promise<unknown>) => void;

class RewriteRuleHandleRpcTarget extends RpcTarget {
  readonly #undo: () => void;
  readonly #lendEnded: Promise<string> | null;
  constructor(undo: () => void, lendEnded: Promise<string> | null = null) {
    super();
    this.#undo = undo;
    this.#lendEnded = lendEnded;
  }
  lendEnded(): Promise<string> {
    if (!this.#lendEnded)
      throw codedError("INVALID_INPUT", "provide lent no stub here: a rule has no lend to end");
    return this.#lendEnded;
  }
  [Symbol.dispose](): void {
    this.#undo();
  }
}

// `name` is a getter: capnweb exposes prototype members only.
class SubscriptionHandleRpcTarget extends RpcTarget {
  readonly #name: string;
  readonly #undo: () => void;
  constructor(name: string, undo: () => void) {
    super();
    this.#name = name;
    this.#undo = undo;
  }
  get name(): string {
    return this.#name;
  }
  [Symbol.dispose](): void {
    this.#undo();
  }
}

// Declaration merging types the built-in roots; the prototype fallback below is the runtime.
export interface IterateContextRpcTarget extends Omit<BuiltInScope, "cd" | "facets"> {
  facets: IterateContextApi["facets"];
}

type StatelessReach = (
  address: DurableObjectAddress,
  caller: Caller,
  expression: ItxExpression,
) => ItxExpressionResolver | undefined;

export class IterateContextRpcTarget extends RpcTarget {
  readonly #contextNamespace: IterateContextNamespace;
  readonly #durableObjectAddress: DurableObjectAddress;
  readonly #sessionTeardown: SessionTeardown;
  readonly #waitUntil: WaitUntil;
  readonly #caller: Caller;
  readonly #statelessResolverOf: StatelessReach | undefined;
  // Loaded code that keeps an answer keeps nothing open.
  readonly #detachAnswers: boolean;

  constructor(
    contextNamespace: IterateContextNamespace,
    durableObjectAddress: DurableObjectAddress,
    sessionTeardown: SessionTeardown,
    waitUntil: WaitUntil,
    caller: Caller,
    statelessResolverOf?: StatelessReach,
    detachAnswers = false,
  ) {
    super();
    this.#detachAnswers = detachAnswers;
    this.#contextNamespace = contextNamespace;
    this.#durableObjectAddress = durableObjectAddress;
    this.#sessionTeardown = sessionTeardown;
    this.#waitUntil = waitUntil;
    this.#caller = caller;
    this.#statelessResolverOf = statelessResolverOf;
  }

  // Per call: an exception can leave a stub broken (Cloudflare's error-handling guide).
  get #durableObject(): IterateContextDurableObjectStub {
    return this.#contextNamespace.getByName(this.#durableObjectAddress.name);
  }

  // A handle the DO names becomes a handle of this edge object, so no session onto the actor
  // outlives a call.
  async #invokeOnDurableObject(
    itxExpression: ItxExpression,
    args: unknown[] = [],
  ): Promise<unknown> {
    const result = await contextStub(
      this.#contextNamespace,
      this.#durableObjectAddress,
      "itx",
    ).invoke(itxExpression, args, this.#caller);
    return materializeItxHandleReference(
      this.#detachAnswers ? itxAnswerDetachedFromSession(result, itxExpression, args) : result,
      (expression) => this.invoke(expression),
    );
  }

  cd(path: string): IterateContextRpcTarget {
    // Loaded code's `cd` is an expression through this context's table, where its wall stands.
    if (this.#caller.app)
      return new InvokeHandle((steps) =>
        this.invoke([
          "itx",
          ["cd", path],
          ...(typeof steps === "string" || steps[0] === "itx"
            ? normalizedItxExpression(steps as ItxExpressionInput).slice(1)
            : steps),
        ]),
      ) as unknown as IterateContextRpcTarget;
    const durableObjectAddress = DurableObjectNameCodec.address(
      resolveContextPath(this.#durableObjectAddress.path, path),
    );
    return new IterateContextRpcTarget(
      this.#contextNamespace,
      durableObjectAddress,
      this.#sessionTeardown,
      this.#waitUntil,
      this.#caller,
      this.#statelessResolverOf,
      this.#detachAnswers,
    );
  }

  // A terminal `fetch(request)` rides the DO's fetch channel, the only hop that carries a
  // socket-bearing Response back.
  async invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown> {
    const answer = await this.#dispatch(call, args);
    if (!(answer instanceof Response)) return answer;
    const refused = await loopLimitOf(answer);
    if (refused) throw refused;
    if (!answer.body) return answer;
    // Workaround: a DO's body pumped natively into a Workers-RPC answer can arrive with its chunks
    // out of order; through a JS stream, workerd reads it in order.
    return new Response(answer.body.pipeThrough(new TransformStream()), answer);
  }

  async #dispatch(call: ItxExpressionInput, args: unknown[]): Promise<unknown> {
    const itxExpression = normalizedItxExpression(call);
    const resolver = this.#statelessResolverOf?.(
      this.#durableObjectAddress,
      this.#caller,
      itxExpression,
    );
    const terminalFetch = terminalFetchOf(itxExpression, args);
    if (resolver && terminalFetch)
      return statelessExpressionFetch(
        resolver,
        () => terminalFetch.steps,
        terminalFetch.request,
        encodeFetchExpression(terminalFetch.steps),
      );
    if (resolver) {
      const result = await resolver.invoke(itxExpression, ...args);
      return materializeItxHandleReference(
        itxAnswerDetachedFromSession(result, itxExpression, args),
        (expression) => this.invoke(expression),
      );
    }
    if (terminalFetch) {
      const headers = new Headers(terminalFetch.request.headers);
      stampCallerHeaders(headers, this.#caller);
      headers.set(ITX_EXPRESSION_FETCH_HEADER, encodeFetchExpression(terminalFetch.steps));
      return this.#durableObject.fetch(new Request(terminalFetch.request, { headers }));
    }
    return this.#invokeOnDurableObject(itxExpression, args);
  }

  async provide(
    match: ItxExpressionInput,
    target: ClientRpcStub | ItxExpressionInput | null,
    options: {
      description?: string;
      fetchRoute?: Omit<FetchRouteInput, "target"> & { fetchRouteName: string };
    } = {},
  ): Promise<RewriteRuleHandleRpcTarget> {
    // A row from loaded code must go through its context's table, where a jail's wall stands.
    if (this.#caller.app && (!target || typeof target === "string" || Array.isArray(target)))
      throw codedError(
        "FORBIDDEN",
        "loaded code writes a row with itx.append({ type: 'events.iterate.com/itx/rewrite-rule-configured', payload: { match, target, description } }); provide lends a live stub only",
      );
    const description = options.description ? { description: options.description } : {};
    const matchString = canonicalItxExpressionPrefix(match);
    const sessionTeardownKey = this.#sessionTeardownKey(matchString);
    const isRow = !target || typeof target === "string" || Array.isArray(target);
    if (
      options.fetchRoute &&
      (isRow || this.#caller.app || this.#durableObjectAddress.path !== "/")
    )
      throw codedError(
        "INVALID_INPUT",
        "provide's fetchRoute rides a lent stub on the mind's root \"/\"; set any other route with itx.fetchRoutes.set",
      );
    if (isRow) {
      // Appended before this session's lend is recalled, so the DO's un-set on the pager close
      // finds a row that no longer names the stub and cannot take the fresh one with it.
      const { target: expectedTarget } = normalizeRewriteRuleConfigured({
        match: matchString,
        target,
        ...description,
      });
      const event: StreamEventInput = {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: matchString, target: expectedTarget, ...description },
      };
      await this.#append(event);
      this.#sessionTeardown.dispose(sessionTeardownKey);
      return new RewriteRuleHandleRpcTarget(() =>
        this.#removeRuleInBackground(matchString, expectedTarget),
      );
    }
    // Whoever lends, at whichever context: a name that is the platform's at the mind's root.
    const refused = lendRefusal(matchString, implicitRootsAt("/"));
    if (refused) throw codedError("FORBIDDEN", `itx.provide: ${refused}`);
    // Built before the lend, so a match the codec refuses throws with nothing lent.
    const ruleEvent: StreamEventInput = {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: {
        match: matchString,
        target: ["itx", "builtins", "rpcStubs", ["get", matchString]],
        ...description,
      },
    };
    const fetchRouteEvents = options.fetchRoute
      ? [fetchRouteEventTo(normalizedItxExpression(matchString), options.fetchRoute)]
      : [];
    // Loaded code's row goes through its own table first, so a jail's mask refuses it before a lend.
    if (this.#caller.app) await this.#append(ruleEvent);
    const pager = await lendRpcStubOverPager(
      () => this.#durableObject,
      target,
      matchString,
      this.#caller.app ? [] : [ruleEvent, ...fetchRouteEvents],
      this.#waitUntil,
    );
    // The DO, not this session, un-sets the rule when the key's last pager closes.
    const lease = this.#sessionTeardown.add(sessionTeardownKey, pager);
    return new RewriteRuleHandleRpcTarget(() => lease.dispose(), pager.lendEnded);
  }

  async subscribe(input: {
    name?: string;
    target:
      | ItxExpressionInput
      | ClientRpcStub
      | ((events: unknown[], range: unknown) => void)
      | EventCopyTarget
      | null;
    consumes?: string[];
    afterOffset?: number;
    ordered?: false;
    filter?: string;
  }): Promise<SubscriptionHandleRpcTarget> {
    // An expression target is a row the delivery loop runs as the kernel, so loaded code may only
    // lend a live callback. Reading `path` on a live stub gives another stub, never a string.
    const isLiveCallback =
      !!input.target &&
      typeof input.target !== "string" &&
      !Array.isArray(input.target) &&
      typeof (input.target as { path?: unknown }).path !== "string";
    if (this.#caller.app && !isLiveCallback)
      throw codedError(
        "FORBIDDEN",
        "loaded code writes a subscription row with itx.append({ type: 'events.iterate.com/itx/subscription-configured', payload: { name, target, consumes } }); subscribe lends a live callback only",
      );
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty name must reach the reduce and be refused, not get a minted one
    const name = input.name ?? `sub-${crypto.randomUUID().slice(0, 8)}`;
    const rpcStubKey = `subscription:${name}`;
    const sessionTeardownKey = this.#sessionTeardownKey(rpcStubKey);
    const delivery = {
      consumes: input.consumes,
      afterOffset: input.afterOffset,
      ordered: input.ordered,
      filter: input.filter,
    };
    if (isLiveCallback) {
      const row: StreamEventInput = {
        type: "events.iterate.com/itx/subscription-configured",
        payload: {
          name,
          target: ["itx", "builtins", "rpcStubs", ["get", rpcStubKey]],
          ...delivery,
        },
      };
      if (this.#caller.app) await this.#append(row);
      const pager = await lendRpcStubOverPager(
        () => this.#durableObject,
        input.target as ClientRpcStub,
        rpcStubKey,
        this.#caller.app ? [] : [row],
        this.#waitUntil,
      );
      const lease = this.#sessionTeardown.add(sessionTeardownKey, pager);
      return new SubscriptionHandleRpcTarget(name, () => lease.dispose());
    }
    // Appended before the recall, as in `provide`.
    const target = input.target as ItxExpressionInput | EventCopyTarget | null;
    const [committed] = (await this.#append({
      type: "events.iterate.com/itx/subscription-configured",
      payload: { name, target, ...delivery },
    })) as StreamEvent[];
    this.#sessionTeardown.dispose(sessionTeardownKey);
    return new SubscriptionHandleRpcTarget(name, () => {
      if (target) this.#removeSubscriptionInBackground(name, committed.offset);
    });
  }

  // The platform's is spelled `itx.builtins.append`, so a context's own rows never redirect it.
  #append(event: StreamEventInput): Promise<unknown> {
    return this.#invokeOnDurableObject(
      this.#caller.app ? ["itx", ["append", event]] : ["itx", "builtins", ["append", event]],
    );
  }

  // A compare-and-set delete of the row this handle wrote, never a mask: at a child, a "restore"
  // would be a grant.
  #removeRuleInBackground(matchString: string, expectedTarget: ItxExpression | null): void {
    this.#waitUntil(
      this.#append({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: matchString, target: null, ifTarget: expectedTarget },
      }).catch(() => undefined),
    );
  }

  #removeSubscriptionInBackground(name: string, configuredAtOffset: number): void {
    this.#waitUntil(
      this.#append({
        type: "events.iterate.com/itx/subscription-configured",
        payload: { name, target: null, ifConfiguredAtOffset: configuredAtOffset },
      }).catch(() => undefined),
    );
  }

  // The teardown is shared across the session's contexts, and a stub key is unique per context.
  #sessionTeardownKey(rpcStubKey: string): string {
    return JSON.stringify([this.#durableObjectAddress.name, rpcStubKey]);
  }
}

installPrototypeInvokeFallback(IterateContextRpcTarget, ["itx"]);

// The runtime exports these classes, but the workers-types .d.ts does not declare them.
const {
  RpcStub: NativeRpcStub,
  RpcPromise: NativeRpcPromise,
  RpcProperty: NativeRpcProperty,
} = cloudflareWorkers as unknown as Record<
  "RpcStub" | "RpcPromise" | "RpcProperty",
  abstract new () => unknown
>;
registerPipelinedRpcBrand(NativeRpcPromise);
registerPipelinedRpcBrand(NativeRpcProperty);
registerRpcSessionBrand(NativeRpcStub);
registerRpcSessionBrand(NativeRpcPromise);
registerRpcSessionBrand(NativeRpcProperty);
// A capnweb chain must stay unawaited between steps, or a one-shot batch session dies after its
// first message.
registerPipelinedRpcBrand(CapnwebRpcPromise as unknown as abstract new () => unknown);
registerPipelinedRpcBrand(CapnwebRpcStub as unknown as abstract new () => unknown);

export function nameActiveSpan({ path }: { path: string }): void {
  cloudflareWorkers.tracing.getActiveSpan()?.setAttributes({ "iterate.path": path });
}

// The context is a prop of the stub, never a binding loaded code could reach around.
export type ItxEntrypointScope = ReturnType<Service<ItxEntrypoint>["get"]>;
export class ItxEntrypoint extends cloudflareWorkers.WorkerEntrypoint<
  Env,
  { iterateContextName: string; platform?: true }
> {
  get(cause?: unknown): IterateContextRpcTarget {
    // A loaded isolate's `ctx.exports` are its own module's, so `platform` cannot be forged from one.
    const address = DurableObjectNameCodec.parse(this.ctx.props.iterateContextName);
    nameActiveSpan(address);
    const namespace = contexts();
    return new IterateContextRpcTarget(
      namespace,
      address,
      new SessionTeardown(),
      (p) => this.ctx.waitUntil(p),
      this.#caller(address, parseCause(cause)),
      // A call into the context's own root skips the resolver, which would only send it on after
      // building every portable root. A terminal fetch keeps the resolver's fetch channel and retry.
      (at, caller, expression) =>
        entersOwnRoot(expression) && itxExpressionStepName(expression.at(-1)) !== "fetch"
          ? undefined
          : statelessResolverFor({
              namespace,
              address: at,
              caller,
              ctx: this.ctx,
            }),
      true,
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const address = DurableObjectNameCodec.parse(this.ctx.props.iterateContextName);
    nameActiveSpan(address);
    const caller = this.#caller(address, parseCause(request.headers.get(ITERATE_CAUSE_HEADER)));
    // Loaded code's raw fetch goes through its table, the platform's to its own egress.
    const expression =
      request.headers.get(ITX_EXPRESSION_FETCH_HEADER) ??
      (caller.app ? "itx.fetch" : "itx.builtins.fetch");
    return statelessExpressionFetch(
      statelessResolverFor({
        namespace: contexts(),
        address,
        caller,
        ctx: this.ctx,
      }),
      () => parseFetchExpression(expression),
      request,
      expression,
    );
  }

  #caller(address: DurableObjectAddress, cause: Cause | undefined): Caller {
    return {
      principal: null,
      cause: cause || newChain("loaded code"),
      ...(this.ctx.props.platform ? { path: address.path } : { app: true as const }),
    };
  }
}

// Loaded code may have forged any caller stamp, so every one is stripped. Not in the resolver: the
// context's fetch channel hands the edge's principal on to the app.
export async function statelessExpressionFetch(
  resolver: ItxExpressionResolver,
  steps: () => ItxExpression,
  request: Request,
  label: string,
): Promise<Response> {
  const headers = new Headers(request.headers);
  stampCallerHeaders(headers, null);
  try {
    const result = await resolver.invoke(
      itxExpressionEndingInFetch(steps()),
      new Request(request, { headers }),
    );
    return result instanceof Response
      ? result
      : new Response(`expression fetch: ${JSON.stringify(result)}\n`);
  } catch (error) {
    return expressionFetchErrorAnswer(error, label);
  }
}

function fetchRouteEventTo(
  target: ItxExpression,
  route: Omit<FetchRouteInput, "target"> & { fetchRouteName: string },
): StreamEventInput {
  const parsed = FetchRouteConfiguredPayload.safeParse({
    fetchRouteName: route.fetchRouteName,
    requestMatcher: route.requestMatcher,
    target,
    authRequirement: route.authRequirement || null,
    priority: route.priority || 0,
  });
  if (!parsed.success)
    throw codedError(
      "INVALID_INPUT",
      `provide's fetchRoute ${JSON.stringify(route.fetchRouteName)}: ${z.prettifyError(parsed.error)}`,
    );
  return { type: "events.iterate.com/itx/fetch-route-configured", payload: parsed.data };
}
