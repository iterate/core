import { codedError, errorCode, jsonEqual } from "iterate/lib";
import { z } from "zod";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import {
  normalizedItxExpression,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  InvokeHandle,
} from "iterate/expression";
import type { FacetSpec, IterateContextApi } from "iterate/api";
import { ITERATE_ROUTING_SLUG_HEADER } from "iterate/mind-ingress";
import { failureKind, ONCE_NOW, retryPlatformFailures } from "iterate/platform-retry";
import type { Cause } from "../cause.ts";
import { refusePlatformIdempotencyKeys, sha256Hex, stampCaller, type Caller } from "../caller.ts";
import { verifyOnBehalfOf } from "../on-behalf-of.ts";
import { TARGET_FAILURE_CODES } from "../stream/subscription-delivery.ts";
import {
  assertFacetPlacement,
  firstPartyFacetClassOf,
  firstPartyFacetNames,
  firstPartyRowConsumesOf,
} from "../first-party-facets.ts";
import { itxHost, itxLoader, type LibraryItx } from "../host.ts";
import {
  ScheduleKey,
  ScheduledAppendInput,
  ScheduleReceipt,
  type ScheduledAppend,
} from "../stream/scheduled-appends.ts";
import type { ReachableContext } from "../stream/stream.ts";
import {
  FetchRouteConfiguredPayload,
  matchFetchRoute,
  type FetchRouteTable,
} from "../fetch-routes.ts";
import { unavailableError } from "../unavailable.ts";
import { facetSpecOf, hostedFacetMarkerOf } from "../stream/core-processor.ts";
import { requestScriptRun } from "./run.ts";
import type { Connections } from "./connections.ts";
import { FacetHandle, RpcStubHandle, materializeItxHandleReference } from "./dispatch.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  encodeFetchExpression,
  stampCallerHeaders,
  terminalFetchOf,
} from "./rpc-stubs.ts";
import { refuseMoreArguments } from "./held-verbs.ts";
import { admitLoadedCodeRow, namesAWorker } from "./itx-expression-rewriting.ts";
import {
  assertFacetSourceWithinCeiling,
  contentHashOfWorkerModules,
  isLoadedWorkerPlatformFailure,
  isWorkerModules,
  namedWorkerLoad,
  type NamedWorker,
} from "./worker-loader.ts";
import type { BuiltInRoot } from "./itx-expression-rewriting.ts";

// A plain object of own-enumerable closures, not an RpcTarget class: the resolver gates on
// `Object.hasOwn`, so prototype methods would leave every root unreachable.
export interface BuiltInScope {
  // not a key of the record (the resolver strips it): typed so a holder can spell `itx.builtins.…`
  builtins: Omit<BuiltInScope, "builtins">;
  whoami(): Promise<{
    path: string;
    mindSlug?: string;
    principal?: { actor: string; email?: string };
  }>;
  fetchRoutes: IterateContextApi["fetchRoutes"];
  append: IterateContextApi["append"];
  appendOffsets: IterateContextApi["appendOffsets"];
  abort: IterateContextApi["abort"];
  schedules: IterateContextApi["schedules"];
  readEvents: IterateContextApi["readEvents"];
  waitForEvent: IterateContextApi["waitForEvent"];
  cd(path: string): InvokeHandle;
  fetch: IterateContextApi["fetch"];
  rpcStubs: Omit<IterateContextApi["rpcStubs"], "get"> & {
    // branded: the delivery loop reads the brand to know the callee owns its progress
    get(rpcStubKey: string): RpcStubHandle;
  };
  rewriteRules: IterateContextApi["rewriteRules"];
  facets: Omit<IterateContextApi["facets"], "get"> & {
    get(name: string, spec?: FacetSpec): FacetHandle;
  };
  subscriptions: IterateContextApi["subscriptions"];
  processors: IterateContextApi["processors"];
  workers: IterateContextApi["workers"];
  run: IterateContextApi["run"];
}

// `keyof BuiltInScope` and `BUILT_IN_ROOT_DESCRIPTIONS` must be the same set: this fails to typecheck
// when a root is added to one without the other.
type RootsAreTheSameSet = [Exclude<keyof BuiltInScope, "builtins">] extends [BuiltInRoot]
  ? [BuiltInRoot] extends [Exclude<keyof BuiltInScope, "builtins">]
    ? true
    : never
  : never;
const _rootsAreTheSameSet: RootsAreTheSameSet = true;
void _rootsAreTheSameSet;

function abortReasonOf(reason: unknown, verb: string): string | undefined {
  const parsed = z.string().max(1000).optional().safeParse(reason);
  if (!parsed.success)
    throw codedError(
      "INVALID_INPUT",
      `${verb}(reason?): a reason is a string of at most 1000 chars`,
    );
  return parsed.data;
}

// Only the delivery loop knows the hash of the event it carries: anyone else could hand a
// subscriber an event no log holds.
async function assertDeliveryCaller(
  delivery: string | undefined,
  what: string,
  eventJson: string,
): Promise<void> {
  if (!delivery || delivery !== (await sha256Hex(eventJson)))
    throw codedError("FORBIDDEN", `${what} is the delivery loop's own call`);
}

export interface BuildBuiltInsDeps {
  path: string;
  iterateContextName: string;
  // called inside the loader's `getCode`, so only on a cold isolate
  invoke: (call: ItxExpression) => Promise<unknown>;
  namedWorker: (source: ItxExpressionInput) => Promise<NamedWorker>;
  context: (path: string) => ReachableContext;
  egress: (request: Request) => Promise<Response>;
  caller: () => Caller;
  invokeAs: (caller: Caller, call: ItxExpression) => Promise<unknown>;
  rpcStubs: BuiltInScope["rpcStubs"];
  subscriptions: BuiltInScope["subscriptions"];
  schedules: {
    get(key: string): ScheduledAppend | null;
    list(): ScheduledAppend[];
  };
  rewriteRules: BuiltInScope["rewriteRules"];
  fetchRoutes: () => FetchRouteTable;
  waitForEvent: BuiltInScope["waitForEvent"];
  facets: {
    get: BuiltInScope["facets"]["get"];
    abort(name: string, reason: string | undefined): Promise<void>;
  };
  abortAfterTheAnswer: (message: string) => void;
  claimFacetAlarm: (name: string, at: number | null) => void;
  itxEntrypoint: () => Fetcher;
  itx: LibraryItx;
  // absent in the stateless resolver, which sends a call to a root that needs them to the context
  connections?: Connections;
}

export function buildBuiltIns(deps: BuildBuiltInsDeps): Record<string, unknown> {
  const { path, iterateContextName } = deps;

  const ownContext = () => deps.context(path);
  const append = async (...events: StreamEventInput[]) => {
    const caller = deps.caller();
    if (caller.app) for (const event of events) admitLoadedCodeRow(event, path);
    refusePlatformIdempotencyKeys(events, caller);
    // stable retry effects: during a delivery, an unkeyed event is keyed the same on every attempt
    const writeKey = caller.cause?.writeKey;
    const keyed = writeKey
      ? await Promise.all(
          events.map(async (event) =>
            event.idempotencyKey
              ? event
              : {
                  ...event,
                  idempotencyKey: `${writeKey}:append:${path}:${(await sha256Hex(JSON.stringify(event))).slice(0, 16)}`,
                },
          ),
        )
      : events;
    // nobody's when the cause's on-behalf-of token is forged or absent
    const token = caller.cause?.onBehalfOf;
    const { signingSecret } = itxHost();
    const onBehalfOf =
      token && signingSecret
        ? await verifyOnBehalfOf(token, await signingSecret(), Date.now())
        : undefined;
    return ownContext().append(
      ...keyed.map((event) => stampCaller(event, { ...caller, onBehalfOf }, path)),
    );
  };
  const assertOnMindRoot = (verb: string) => {
    if (path !== "/")
      throw codedError(
        "INVALID_CONTEXT",
        `itx.fetchRoutes.${verb}: a mind's fetch routes live on its root "/" — reach them there, itx.cd("/").fetchRoutes`,
      );
  };

  return {
    ...buildPortableBuiltIns(deps),
    ...buildIdentityRoots(deps),
    fetchRoutes: {
      set: async (fetchRouteName, route) => {
        assertOnMindRoot("set");
        const refusal = (reason: string) =>
          codedError(
            "INVALID_INPUT",
            `itx.fetchRoutes.set(${JSON.stringify(fetchRouteName)}): ${reason}`,
          );
        let target: unknown;
        try {
          target =
            // oxlint-disable-next-line iterate/simple-truthiness-check -- a caller's RPC input, typed but unchecked until FetchRouteConfiguredPayload parses it below
            typeof route?.target === "string" || Array.isArray(route?.target)
              ? normalizedItxExpression(route.target)
              : route?.target;
        } catch (error) {
          throw refusal(`target: ${error instanceof Error ? error.message : String(error)}`);
        }
        const parsed = FetchRouteConfiguredPayload.safeParse(
          !route
            ? { fetchRouteName, requestMatcher: null }
            : {
                fetchRouteName,
                requestMatcher: route.requestMatcher,
                target,
                authRequirement: route.authRequirement || null,
                priority: route.priority || 0,
              },
        );
        if (!parsed.success) throw refusal(z.prettifyError(parsed.error));
        const payload = parsed.data;
        // An absent route stands as the deleting payload does. An own key only: a DNS label may be
        // `constructor`.
        const table = deps.fetchRoutes();
        const { configuredOffset: _configuredOffset, ...current } = Object.hasOwn(
          table,
          fetchRouteName,
        )
          ? table[fetchRouteName]!
          : { requestMatcher: null, configuredOffset: 0 };
        if (jsonEqual({ fetchRouteName, ...current }, payload)) return { fetchRouteName };
        await append({ type: "events.iterate.com/itx/fetch-route-configured", payload });
        return { fetchRouteName };
      },
      list: async () => {
        assertOnMindRoot("list");
        return Object.entries(deps.fetchRoutes())
          .map(([fetchRouteName, route]) => ({ fetchRouteName, ...route }))
          .sort(
            (a, b) => b.priority - a.priority || (a.fetchRouteName < b.fetchRouteName ? -1 : 1),
          );
      },
      match: async (request) => {
        assertOnMindRoot("match");
        return matchFetchRoute(deps.fetchRoutes(), {
          url: request.url,
          headers: new Headers(request.headers),
        });
      },
    },
    append,
    // through this context's table, so a wall or a mask on `append` is this verb's too
    appendOffsets: async (...events) => {
      const appended = await deps.invokeAs(deps.caller(), ["itx", ["append", ...events]]);
      return (appended as StreamEvent[]).map(({ offset }) => offset);
    },
    abort: async (reasonInput) => {
      const reason = abortReasonOf(reasonInput, "itx.abort");
      const { path: callerPath, app } = deps.caller();
      // The fact first, through `append` (attributed, pause-exempt); the reset is the DO's, after
      // the answer leaves.
      const [aborted] = await append({
        type: "events.iterate.com/itx/aborted",
        payload: { reason, callerPath, app },
      });
      deps.abortAfterTheAnswer(
        `itx.abort() reset the context ${path}${reason ? `: ${reason}` : ""}`,
      );
      return aborted;
    },
    schedules: {
      ...deps.schedules,
      get: (key) => deps.schedules.get(ScheduleKey.parse(key)),
      set: async (input, options) => {
        // An interval set again as it stands keeps its clock: an init case sets it after every
        // commit. A failed one, or one set from shallower in a chain, is set again.
        const { key, when, events } = ScheduledAppendInput.parse(input);
        const live = deps.schedules.get(key);
        if (
          live &&
          !live.failure &&
          "everyMs" in when &&
          jsonEqual({ when: live.when, events: live.events }, { when, events }) &&
          (deps.caller().cause?.depth ?? 0) >= (live.source?.cause?.depth ?? 0)
        )
          return { key, scheduledAtOffset: live.scheduledAtOffset };
        const [definition] = await append({
          type: "events.iterate.com/itx/schedule-set",
          payload: input,
          idempotencyKey: options?.idempotencyKey,
        });
        return ScheduleReceipt.parse({
          key: definition.payload?.key,
          scheduledAtOffset: definition.offset,
        });
      },
      cancel: (schedule) => {
        const receipt = ScheduleReceipt.safeParse(schedule);
        return append({
          type: "events.iterate.com/itx/schedule-cancelled",
          payload: receipt.success
            ? { key: receipt.data.key, ifScheduledAtOffset: receipt.data.scheduledAtOffset }
            : { key: ScheduleKey.parse(schedule) },
        });
      },
    },
    readEvents: (afterOffset?: number, limit?: number, options?: { includeEphemeral?: boolean }) =>
      ownContext().read(afterOffset, limit, options),
    waitForEvent: deps.waitForEvent,
    rpcStubs: deps.rpcStubs,
    facets: {
      get: deps.facets.get,
      // The reset, then its fact: the host holds every other event off meanwhile, so the fact's
      // delivery to a processor facet meets the fresh instance.
      abort: async (name, reasonInput) => {
        const reason = abortReasonOf(reasonInput, "itx.facets.abort");
        const { path: callerPath, app } = deps.caller();
        await deps.facets.abort(name, reason);
        const [aborted] = await append({
          type: "events.iterate.com/itx/facet-aborted",
          payload: { name, reason, callerPath, app },
        });
        return aborted;
      },
    },
    subscriptions: deps.subscriptions,
    processors: {
      enable: async (name, spec) => {
        // Refused here, before anything is appended, so a row that could never deliver is never
        // appended.
        const firstPartyClassName = firstPartyFacetClassOf(name);
        const given = spec as (FacetSpec & { consumes?: string[] }) | undefined;
        // Keyed by content, the key the loader gives it anyway: the same code again appends nothing.
        const loaded =
          given && !given.cacheKey && isWorkerModules(given.source)
            ? { ...given, cacheKey: contentHashOfWorkerModules(given.source) }
            : given;
        if (firstPartyClassName) {
          if (loaded && ("source" in loaded || "className" in loaded))
            throw new Error(
              `processors.enable(${JSON.stringify(name)}): "${name}" is first-party — hosted from this worker's own ${firstPartyClassName}; pass { consumes? } at most, never a source`,
            );
        } else {
          // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of a caller-supplied spec (its static type is a claim, not a guarantee, across the capability boundary)
          if (typeof loaded !== "object" || loaded === null || typeof loaded.className !== "string")
            throw new Error(
              `processors.enable(${JSON.stringify(name)}, { source, className, consumes? }): name the host class the source exports — only a first-party name (${firstPartyFacetNames().join(", ")}) is enabled without one`,
            );
          assertFacetSourceWithinCeiling(loaded, `processors.enable("${name}")`);
        }
        assertFacetPlacement(name, path);
        const consumes = spec?.consumes || firstPartyRowConsumesOf(name);
        // Idempotent: every entity's `create()` enables its row on every call. A row stored without
        // the filter takes it here.
        const { restarts: _restarts, ...existing } = deps.subscriptions.get(name)?.hostedFacet ?? {
          restarts: 0,
        };
        const requested = firstPartyClassName
          ? { name, className: firstPartyClassName }
          : hostedFacetMarkerOf({ name, ...facetSpecOf(loaded!) });
        if (
          jsonEqual(existing, requested) &&
          jsonEqual(deps.subscriptions.get(name)?.consumes ?? null, consumes || null)
        )
          return { name };
        await append({
          type: "events.iterate.com/itx/subscription-configured",
          payload: {
            name,
            target: [
              "itx",
              ...(deps.caller().app ? [] : ["builtins"]),
              "facets",
              firstPartyClassName ? ["get", name] : ["get", name, facetSpecOf(loaded!)],
              "processEventBatch",
            ],
            consumes,
          },
        });
        return { name };
      },
      disable: async (name) => {
        await append({
          type: "events.iterate.com/itx/subscription-configured",
          payload: { name, target: null },
        });
      },
      list: () => deps.subscriptions.list().filter((row) => row.hostedFacet),
      claim: async (name, at) => deps.claimFacetAlarm(name, at),
    },
    rewriteRules: deps.rewriteRules,
    workers: workersRoot({
      path,
      iterateContextName,
      itxEntrypoint: deps.itxEntrypoint,
      invoke: deps.invoke,
      caller: deps.caller,
      delivery: () => deps.caller().delivery,
      cause: () => deps.caller().cause,
      namedWorker: deps.namedWorker,
    }),
  } satisfies Omit<BuiltInScope, "builtins">;
}

export function buildIdentityRoots(
  deps: Pick<BuildBuiltInsDeps, "path" | "caller">,
): Pick<BuiltInScope, "whoami"> {
  const { path } = deps;
  return {
    whoami: async () => {
      const { mindSlug } = itxHost();
      const principal = deps.caller().principal;
      return {
        path,
        // oxlint-disable-next-line iterate/simple-truthiness-check -- the wire view: an absent optional field must stay ABSENT, not `field: undefined` (capnweb / Workers RPC serialize an undefined-valued key as present, and readers test presence)
        ...(mindSlug && { mindSlug }),
        ...(principal && {
          principal: {
            actor: principal.actor,
            // oxlint-disable-next-line iterate/simple-truthiness-check -- the wire view: an absent optional field must stay ABSENT, not `field: undefined` (capnweb / Workers RPC serialize an undefined-valued key as present, and readers test presence)
            ...(principal.email && { email: principal.email }),
          },
        }),
      };
    },
  };
}

type PortableBuiltInsDeps = Pick<
  BuildBuiltInsDeps,
  "path" | "context" | "egress" | "caller" | "invokeAs" | "itx" | "connections"
>;

// What answers the same from every context of a Worker, so a context's Durable Object and the
// stateless entrypoint both build them. A host root the scope cannot build answers undefined.
export function buildPortableBuiltIns(deps: PortableBuiltInsDeps) {
  const { path } = deps;
  const hostRoots = Object.entries(itxHost().roots || {}).flatMap(([name, root]) => {
    const value = root.build(deps);
    return value === undefined ? [] : [[name, value] as const];
  });
  return {
    ...Object.fromEntries(hostRoots),
    cd: (contextPath: string) => {
      // Who crosses is captured when the handle is made: a handle loaded code holds and calls later
      // runs as that code. Its delivery authority and cause are read per call.
      const made = deps.caller();
      return new InvokeHandle((steps) => {
        const now = deps.caller();
        return deps.invokeAs(
          {
            ...made,
            path: made.path || path,
            delivery: now.delivery,
            cause: now.cause || made.cause,
          },
          ["itx", "builtins", ["cd", contextPath], ...steps],
        );
      });
    },
    fetch: (request: Request) => deps.egress(request),
    run: (script: string) => {
      itxLoader("itx.run");
      return requestScriptRun(deps.itx, path, script);
    },
  } satisfies Pick<BuiltInScope, "cd" | "fetch" | "run">;
}

// A genuine InvokeHandle, so `workers.get(spec).run()` pipelines over every transport (workerd#6873).
// The code loads here, with the authority of the context `iterateContextName` names.
export function workersRoot(deps: {
  path: string;
  iterateContextName: string;
  itxEntrypoint: () => Fetcher;
  invoke: (call: ItxExpression) => Promise<unknown>;
  caller: () => Caller;
  delivery: () => string | undefined;
  cause: () => Cause | undefined;
  namedWorker: (source: ItxExpressionInput) => Promise<NamedWorker>;
  // the spec is the config pointer's, which only the platform writes
  vouched?: boolean;
}): BuiltInScope["workers"] {
  const { path, iterateContextName } = deps;
  return {
    get: (spec: Parameters<BuiltInScope["workers"]["get"]>[0], ...more: unknown[]) => {
      refuseMoreArguments("workers.get(spec)", more);
      return new InvokeHandle(async (methodSteps) => {
        const [call] = methodSteps;
        if (methodSteps.length !== 1 || !Array.isArray(call) || call[0] === "")
          throw new Error(
            `workers.get(spec).${print(methodSteps)}: a WorkerEntrypoint exposes flat methods`,
          );
        const [method, ...callArgs] = call;
        if (method === "callWithCause" || method === "getItx")
          throw codedError("NOT_A_METHOD", `workers.get(spec).${method}: no caller reaches it`);
        // A loaded worker's `fetch` reads who is asking off its Request: the call's own caller,
        // stamped here, never what the Request says, which the calling code could write.
        const cause = deps.cause();
        const callerPath = deps.caller().path || path;
        const args =
          method === "fetch" ? [callerStampedRequest(callArgs, deps.caller(), cause)] : callArgs;
        // one-event hooks are the delivery loop's to call, as a subscriber's `deliverEvent` is
        if (method === "deliverEvent" || method === "processEvent")
          await assertDeliveryCaller(
            deps.delivery(),
            `workers.get(spec).${method}`,
            JSON.stringify(args[0]),
          );
        const loader = itxLoader("workers.get");
        // A source expression with no cacheKey names a worker, resolved per call so the call after a
        // publication runs the new code.
        const named = namesAWorker(spec)
          ? await deps.namedWorker(spec.source)
          : deps.vouched
            ? { spec, vouched: true, invoke: deps.invoke }
            : undefined;
        const worker = named
          ? { ...namedWorkerLoad(named, spec.mainModule, "workers.get"), invoke: named.invoke }
          : { source: spec.source, cacheKey: spec.cacheKey, invoke: deps.invoke };
        // Workaround for the Worker Loader defect `isLoadedWorkerPlatformFailure` names: the call
        // retires the identity, and is replayed once only when it cannot do anything twice (GET/HEAD).
        const unavailableNow = (failure: Error) =>
          unavailableError("disconnected", `workers.get(spec).${method}: ${failure.message}`);
        let loaderId: string | undefined;
        const attempt = async () => {
          const prepared = await loader.prepareConfinedWorker({
            itxEntrypoint: deps.itxEntrypoint(),
            kind: "worker",
            owner: iterateContextName,
            source: worker.source,
            cacheKey: worker.cacheKey,
            mainModule: spec.mainModule,
            moduleIdentity: worker.moduleIdentity,
            invoke: worker.invoke,
            where: "workers.get",
          });
          const { load, retire } = prepared;
          loaderId = prepared.loaderId;
          try {
            const entrypoint = load().getEntrypoint(
              spec.className,
              spec.props === undefined ? undefined : { props: spec.props },
            ) as Fetcher & Record<string, (...a: unknown[]) => Promise<unknown>>;
            const fn = entrypoint[method];
            if (typeof fn !== "function")
              throw new Error(`workers.get(spec): the entrypoint has no method "${method}"`);
            const called =
              method === "fetch"
                ? Reflect.apply(fn, entrypoint, args)
                : entrypoint.callWithCause!(cause, [[method, ...args]], callerPath);
            if (method !== "deliverEvent") return await called;
            // A handler's own refusal is its event's failure, retried on that event's ladder, never
            // the row's, which those codes dangle or halt.
            return await called.catch((error: unknown) => {
              const code = errorCode(error);
              if (code && TARGET_FAILURE_CODES.has(code))
                throw new Error(error instanceof Error ? error.message : String(error));
              throw error;
            });
          } catch (error) {
            if (isLoadedWorkerPlatformFailure(error)) retire();
            throw error;
          }
        };
        try {
          return await attempt();
        } catch (error) {
          if (!isLoadedWorkerPlatformFailure(error)) throw error;
          const request = method === "fetch" && args[0] instanceof Request ? args[0] : undefined;
          const replayable =
            request && !request.body && (request.method === "GET" || request.method === "HEAD");
          console.warn({
            event: replayable
              ? "workers.platform-failure-retry"
              : "workers.platform-failure-retire",
            namespace: "iterate-context",
            name: iterateContextName,
            method,
            requestMethod: request?.method,
            loaderId,
            message: error.message,
          });
          if (!replayable) throw unavailableNow(error);
          return await attempt().catch((failure: unknown) => {
            throw isLoadedWorkerPlatformFailure(failure) ? unavailableNow(failure) : failure;
          });
        }
      });
    },
  };
}

// For loaded code, no routing slug: the host a request arrived on is the edge's word.
function callerStampedRequest(
  [input, init]: unknown[],
  caller: Caller,
  cause: Cause | undefined,
): Request {
  const request = new Request(input as RequestInfo, init as RequestInit | undefined);
  const headers = new Headers(request.headers);
  stampCallerHeaders(headers, { principal: caller.principal, grant: caller.grant, cause });
  if (caller.app) headers.delete(ITERATE_ROUTING_SLUG_HEADER);
  return new Request(request, { headers });
}

// Delivery authority is read per call, never the one `caller` carried: the delivery loop evaluates
// a target without it and reuses the handle. The context is acquired per call: a stub replays a reset.
export function callContext(
  contextOf: () => Pick<ReachableContext, "fetch" | "invoke">,
  expression: ItxExpression,
  args: unknown[],
  caller: Caller,
  path: string,
  delivery?: () => string | undefined,
): Promise<unknown> {
  const { delivery: _made, ...made } = caller;
  const callerNow = (): Caller => {
    const now = delivery?.();
    return now ? { ...made, delivery: now } : made;
  };
  const terminalFetch = terminalFetchOf(expression, args);
  if (terminalFetch) {
    const headers = new Headers(terminalFetch.request.headers);
    stampCallerHeaders(headers, made);
    headers.set(ITX_EXPRESSION_FETCH_HEADER, encodeFetchExpression(terminalFetch.steps));
    const request = new Request(terminalFetch.request, { headers });
    return retryPlatformFailures(() => contextOf().fetch(request), {
      area: "cd",
      schedule: ONCE_NOW,
      idempotent:
        !request.body &&
        (request.method === "GET" || request.method === "HEAD") &&
        !request.headers.has("upgrade"),
      kind: failureKind,
      describe: () => ({ name: "fetch", path }),
    });
  }
  // A call of the handle that the call answered is a new call: an approved act's text is for the
  // one call that it arrives with (`Caller.approvedAct`), and does not go with the next.
  const { approvedAct: _spent, ...afterTheCall } = made;
  return Promise.resolve(contextOf().invoke(expression, args, callerNow())).then((result) =>
    materializeItxHandleReference(result, (handleExpression) => {
      const now = delivery?.();
      return contextOf().invoke(
        handleExpression,
        [],
        now ? { ...afterTheCall, delivery: now } : afterTheCall,
      );
    }),
  );
}
