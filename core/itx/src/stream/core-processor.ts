// The core reduce: a pure fold the Stream runs inline at every commit, because its readers
// (Stream.append, the dispatcher, the delivery loop) are synchronous. `normalizeControlEvent` parses
// every control event's payload before it is stored, so the fold casts what it reads.

import {
  itxExpressionStepName,
  normalizedItxExpression,
  type ItxExpressionInput,
  parseItxExpressionPrefix,
  type ItxExpression,
  print,
} from "iterate/expression";
import { jsonEqual, resolveContextPath } from "iterate/lib";
import { z } from "zod";
import type {
  EventCopiedFrom,
  StreamEvent,
  ReduceArgs,
  StreamEventInput,
} from "iterate/stream/processor";
import type { EventCopyTarget, FacetSpec, RewriteRuleConfigured } from "iterate/api";
import { RunEventCatalog, RunRequested } from "iterate/stream/run";
import type { Cause } from "../cause.ts";
import { firstPartyFacetClassOf } from "../first-party-facets.ts";
import {
  FetchRouteConfiguredPayload,
  reduceFetchRouteConfigured,
  type FetchRouteTable,
} from "../fetch-routes.ts";
import {
  builtInRootDescriptions,
  builtInsGetStep,
  implicitRootsAt,
  isBuiltInsRooted,
  normalizeRewriteRuleConfigured,
  namesAWorker,
  refuseSelfLoopRow,
  fixedPointOf,
  type ItxExpressionRewriteRule,
} from "../context/itx-expression-rewriting.ts";
import { CoreEventCatalog } from "./core-events.ts";
import { compileEventExpression } from "./event-expressions.ts";
import {
  ScheduledAppendInput,
  ScheduledAppendCancelled,
  ScheduledAppendSettled,
  reduceScheduledAppends,
  type ScheduledAppend,
} from "./scheduled-appends.ts";

type HostingFacetSpec = {
  name: string;
  // Absent for a first-party facet: its class is this worker's own.
  source?: unknown;
  className: string;
  cacheKey?: string;
  mainModule?: string;
};

// Only a target resolved to the fixed point carries the spec, and only in the raw log event: the
// reduce elides the source.
export function facetSpecFromHostingTarget(
  resolvedTarget: ItxExpression,
): HostingFacetSpec | undefined {
  const getStep = builtInsGetStep(resolvedTarget, "facets");
  if (!getStep) return undefined;
  const firstPartyClassName = firstPartyFacetClassOf(getStep[1]);
  if (getStep.length === 2 && firstPartyClassName)
    return { name: getStep[1], className: firstPartyClassName };
  if (getStep.length >= 3 && typeof getStep[2] === "object" && getStep[2] !== null)
    // A malformed caller-authored spec is copied as it is and fails where the facet host loads it.
    return { name: getStep[1], ...facetSpecOf(getStep[2] as FacetSpec) };
  return undefined;
}

export const facetSpecOf = ({ source, cacheKey, className, mainModule }: FacetSpec): FacetSpec => ({
  source,
  // oxlint-disable-next-line iterate/simple-truthiness-check -- the kv memo, the hosting event and JSON.stringify compares all see this shape: an absent cacheKey must stay absent
  ...(cacheKey !== undefined && { cacheKey }),
  className,
  // oxlint-disable-next-line iterate/simple-truthiness-check -- as cacheKey: an absent mainModule stays absent in the canonical shape
  ...(mainModule !== undefined && { mainModule }),
});

// The spec less its source, so a 100 KB processor does not ride the checkpoint. A worker's name is
// short and says which code the facet runs, so it is kept.
export function hostedFacetMarkerOf(
  spec: HostingFacetSpec,
): NonNullable<Subscription["hostedFacet"]> {
  const { source, ...marker } = spec;
  return namesAWorker(spec) ? { ...marker, source } : marker;
}

function resolveThroughState(state: CoreState, target: ItxExpression): ItxExpression | undefined {
  return fixedPointOf(
    () => Object.values(state.itxExpressionRewriteRules),
    target,
    implicitRootsAt(state.path || "/"),
  );
}

// Committed state only: a committed table and a row's target are never mutated (a batch drafts a
// copy, `draftOf`), so identity is a safe cache key. Never call it inside a reduce.
function resolveThroughCommittedState(
  state: CoreState,
  target: ItxExpression,
): ItxExpression | undefined {
  const rules = state.itxExpressionRewriteRules;
  const roots = implicitRootsAt(state.path || "/");
  const known = committedFixedPoints.get(target);
  if (known?.rules === rules && known.roots === roots) return known.fixedPoint;
  const fixedPoint = resolveThroughState(state, target);
  committedFixedPoints.set(target, { rules, roots, fixedPoint });
  return fixedPoint;
}
const committedFixedPoints = new WeakMap<
  ItxExpression,
  { rules: object; roots: ReadonlySet<string>; fixedPoint: ItxExpression | undefined }
>();

// Stores the original spelling less the spec, never the resolution: a target re-resolves at every
// delivery.
function elideHostedFacetSource(
  target: ItxExpression,
  resolvedTarget: ItxExpression | undefined,
): {
  target: ItxExpression;
  hostedFacet?: Subscription["hostedFacet"];
} {
  const spec = resolvedTarget && facetSpecFromHostingTarget(resolvedTarget);
  if (!spec) return { target };
  const hostedFacet = hostedFacetMarkerOf(spec);
  const specStepIndex = target.findIndex(
    (step) =>
      Array.isArray(step) &&
      step[0] === "get" &&
      step.length >= 3 &&
      typeof step[1] === "string" &&
      typeof step[2] === "object" &&
      step[2] !== null &&
      "className" in (step[2] as object),
  );
  return {
    target:
      specStepIndex === -1
        ? target
        : [
            ...target.slice(0, specStepIndex),
            ["get", (target[specStepIndex] as [string, string])[1]],
            ...target.slice(specStepIndex + 1),
          ],
    hostedFacet,
  };
}

// A facet or a lent rpc stub keeps its own progress, so the stream keeps no cursor for it. Decided
// from the rules alone, never by evaluating the target: a fresh incarnation classifies every row
// before anything runs.
export function targetOwnsProgress(state: CoreState, row: Subscription): boolean {
  const resolved = resolveThroughCommittedState(state, row.target);
  if (!resolved) return false;
  return !!(builtInsGetStep(resolved, "facets") || builtInsGetStep(resolved, "rpcStubs"));
}

export function targetIsAnotherService(state: CoreState, row: Subscription): boolean {
  const resolved = resolveThroughCommittedState(state, row.target);
  return (
    resolved?.[1] === "builtins" && (resolved[2] === "webhooks" || resolved[2] === "platformHook")
  );
}

// The facet host tells a facet whether any row pushes it (`fedByPushes`), and its engine then trusts
// the head until the next push. So this must never name a row the delivery loop does not push
// (subscription-delivery.ts `#evaluateItxExpressionTargetHead`).
export function rowsPushingFacet(state: CoreState, facetName: string) {
  return Object.entries(state.subscriptions)
    .filter(([, row]) => {
      if (row.halted || row.target.length <= 2 || row.target.at(-1) !== "processEventBatch")
        return false;
      const head = resolveThroughState(state, row.target.slice(0, -1));
      return head?.length === 4 && builtInsGetStep(head, "facets")?.[1] === facetName;
    })
    .map(([name]) => name);
}

// A table is copied once per batch and mutated from then on, so a batch of N events is O(rows + N)
// (test/vitest/os/memory-budget.test.ts). The set never holds a table the caller handed in.
type DraftTables = WeakSet<object> | undefined;
function draftOf<Table extends object>(table: Table, draftTables: DraftTables): Table {
  if (draftTables?.has(table)) return table;
  const draft = { ...table };
  draftTables?.add(draft);
  return draft;
}

// The delivery loop re-resolves at every push and the removal effect trusts the marker, so every
// rule commit re-derives the marker of each row that is not builtins-rooted.
function withHostedFacetMarkersFollowingRules(
  state: CoreState,
  draftTables: DraftTables,
): CoreState {
  let subscriptions: CoreState["subscriptions"] | undefined;
  for (const [name, row] of Object.entries(state.subscriptions)) {
    if (isBuiltInsRooted(row.target)) continue;
    const resolved = resolveThroughState(state, row.target);
    if (!resolved) continue;
    const spec = facetSpecFromHostingTarget(resolved);
    let next: Subscription["hostedFacet"];
    if (spec) next = hostedFacetMarkerOf(spec);
    else if (builtInsGetStep(resolved, "facets")?.[1] === row.hostedFacet?.name) {
      next = row.hostedFacet; // an address of the facet it is marked with: its own spec was elided
    }
    if (jsonEqual(next || null, row.hostedFacet || null)) continue;
    subscriptions ||= draftOf(state.subscriptions, draftTables);
    const { hostedFacet: _previous, ...rest } = row;
    subscriptions[name] = next ? { ...rest, hostedFacet: next } : rest;
  }
  return subscriptions ? { ...state, subscriptions } : state;
}

export type Subscription = {
  target: ItxExpression;
  // Absent: every durable event. Naming a type opts its ephemerals in.
  consumes?: string[];
  configuredAtOffset: number;
  // Where cursor delivery starts; absent means `configuredAtOffset`.
  afterOffset?: number;
  ordered?: false;
  // On a copy row, `target` is `itx.cd(path)`, evaluated only to check that the rules still reach it.
  copy?: EventCopyTarget;
  filter?: string;
  hostedFacet?: {
    name: string;
    className: string;
    cacheKey?: string;
    mainModule?: string;
    source?: unknown;
  };
  halted?: { afterOffset: number; attempts: number; error?: string };
  resumed?: { afterOffset?: number; offset?: number; atOffset: number };
};

export type CoreState = {
  path?: string;
  createdAt?: string;
  incarnation?: number;
  contextAbortedOffset?: number;
  wokenAfterContextAbortedOffset?: number;
  paused: { reason: string } | null;
  itxExpressionRewriteRules: Record<string, ItxExpressionRewriteRule>;
  // The offset of the last commit that changed the rules, fetch routes or ingress: the version that
  // names a snapshot (context/rule-snapshots.ts). A write that changes nothing leaves it.
  snapshotVersion: number;
  subscriptions: Record<string, Subscription>;
  ingressTarget: ItxExpression | null;
  fetchRoutes: FetchRouteTable;
  schedules: Record<string, ScheduledAppend>;
  // By the request's offset. A restart never re-runs one: the wake record settles it `interrupted`.
  scriptRuns: Record<number, { requestedAt: string; cause?: Cause }>;
};

// The tables are plain records indexed by name, so a key of Object.prototype would write the
// prototype. `core` is the core reduce: a row of that name would be undeliverable.
const SUBSCRIPTION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
function parseSubscriptionName(name: string): string {
  // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime validation of a name carried in an untrusted event payload (the `: string` type is a claim); the typeof guards the pattern test and prototype-pollution check below
  if (typeof name !== "string" || !SUBSCRIPTION_NAME_PATTERN.test(name) || name in Object.prototype)
    throw new Error(
      `a subscription name is one segment: [A-Za-z0-9_-]+, never a key of Object.prototype (got ${JSON.stringify(name)})`,
    );
  if (name === CoreContract.slug)
    throw new Error(
      `"${CoreContract.slug}" is reserved as a subscription name: it is the core reduce, never a configurable subscription`,
    );
  return name;
}

export const CoreContract = {
  slug: "core",
  // A bump re-reduces the log from offset 0 in the DO constructor.
  version: "17.0.0",
  events: { ...CoreEventCatalog.events, ...RunEventCatalog.events },
  initialState: (): CoreState => ({
    paused: null,
    itxExpressionRewriteRules: {},
    snapshotVersion: 0,
    subscriptions: {},
    ingressTarget: null,
    fetchRoutes: {},
    schedules: {},
    scriptRuns: {},
  }),
};

// A throwing event goes to `onError` and is skipped. The reduce touches a draft only after
// everything that can throw, so the state handed in is never mutated.
export function reduceCoreEventBatch(
  events: StreamEvent[],
  state: CoreState,
  onError: (error: unknown, event: StreamEvent) => void,
): CoreState {
  const draftTables = new WeakSet<object>();
  for (const event of events) {
    try {
      state = reduceCoreEvent({ event, state }, draftTables) ?? state;
    } catch (error) {
      onError(error, event);
    }
  }
  return state;
}

// `undefined` keeps the state: the host detects change by identity, so a no-op must not return a
// fresh object (it would rewrite the checkpoint and publish a live-state delta). Ephemeral control
// events are ignored: they would vanish from any rebuild.
function reduceCoreEvent(
  { event, state }: ReduceArgs<CoreState>,
  draftTables?: DraftTables,
): CoreState | undefined {
  if (event.ephemeral) return undefined;
  const payload = (event.payload || {}) as Record<string, unknown>;
  const withSubscription = (name: string, row: Subscription | undefined): CoreState => {
    const subscriptions = draftOf(state.subscriptions, draftTables);
    if (row) subscriptions[name] = row;
    else delete subscriptions[name];
    return { ...state, subscriptions };
  };
  switch (event.type) {
    case "events.iterate.com/itx/ingress-configured": {
      const target = payload.target as ItxExpression | null;
      return jsonEqual(state.ingressTarget, target)
        ? undefined
        : { ...state, ingressTarget: target, snapshotVersion: event.offset };
    }
    case "events.iterate.com/itx/fetch-route-configured": {
      const fetchRoutes = reduceFetchRouteConfigured(state.fetchRoutes, event, (table) =>
        draftOf(table, draftTables),
      );
      return fetchRoutes && { ...state, fetchRoutes, snapshotVersion: event.offset };
    }
    case "events.iterate.com/itx/schedule-set":
    case "events.iterate.com/itx/schedule-cancelled":
    case "events.iterate.com/itx/schedule-fired":
    case "events.iterate.com/itx/schedule-failed": {
      const schedules = reduceScheduledAppends(state.schedules, event);
      return schedules === state.schedules ? undefined : { ...state, schedules };
    }
    case "events.iterate.com/itx/run-requested": {
      if (state.scriptRuns[event.offset]) return undefined;
      const scriptRuns = draftOf(state.scriptRuns, draftTables);
      scriptRuns[event.offset] = { requestedAt: event.createdAt, cause: event.source?.cause };
      return { ...state, scriptRuns };
    }
    case "events.iterate.com/itx/run-settled": {
      const requestOffset = payload.requestOffset as number;
      if (!state.scriptRuns[requestOffset]) return undefined; // settled twice, or never requested
      const scriptRuns = draftOf(state.scriptRuns, draftTables);
      delete scriptRuns[requestOffset];
      return { ...state, scriptRuns };
    }
    case "events.iterate.com/itx/created":
      return {
        ...state,
        path: payload.path as string,
        createdAt: event.createdAt,
      };
    case "events.iterate.com/itx/woken":
      return {
        ...state,
        incarnation: payload.incarnation as number,
        wokenAfterContextAbortedOffset: state.contextAbortedOffset,
        contextAbortedOffset: undefined,
      };
    case "events.iterate.com/itx/aborted":
      return { ...state, contextAbortedOffset: event.offset };
    case "events.iterate.com/itx/paused":
      return { ...state, paused: { reason: (payload.reason as string | undefined) ?? "paused" } };
    case "events.iterate.com/itx/resumed":
      return { ...state, paused: null };

    case "events.iterate.com/itx/rewrite-rule-configured": {
      // The match is stored parsed: a second string parse would throw on one over the codec cap.
      const matchPrefix = parseItxExpressionPrefix(payload.match as ItxExpressionInput);
      const matchString = print(matchPrefix);
      const existing = state.itxExpressionRewriteRules[matchString];
      const implicitRoots = implicitRootsAt(event.path);
      const withRule = (rule: ItxExpressionRewriteRule | undefined): CoreState => {
        const rules = draftOf(state.itxExpressionRewriteRules, draftTables);
        if (rule) rules[matchString] = rule; // a match string is `itx…`, never a prototype key
        else delete rules[matchString];
        return withHostedFacetMarkersFollowingRules(
          { ...state, itxExpressionRewriteRules: rules, snapshotVersion: event.offset },
          draftTables,
        );
      };
      // A handle's compare-and-set delete: a no-op once a replacement owns the match. Never a mask.
      if ("ifTarget" in payload)
        return existing && jsonEqual(existing.target, payload.ifTarget)
          ? withRule(undefined)
          : undefined;
      const description =
        typeof payload.description === "string" ? { description: payload.description } : {};
      if (payload.target === null) {
        // A mask where an implicit row or a stored shorter row would answer the match; a plain
        // deletion anywhere else.
        const root = matchPrefix.length === 1 ? undefined : itxExpressionStepName(matchPrefix[1]);
        const answeredBeneath =
          matchPrefix.length === 1 ||
          (!!root && implicitRoots.has(root)) ||
          Object.values(state.itxExpressionRewriteRules).some(
            (row) =>
              !!row.target &&
              row.match.length < matchPrefix.length &&
              row.match.every((step, i) => jsonEqual(step, matchPrefix[i])),
          );
        if (!answeredBeneath) return existing ? withRule(undefined) : undefined;
        if (existing && !existing.target && jsonEqual(existing.description, payload.description))
          return undefined;
        return withRule({ match: matchPrefix, target: null, ...description });
      }
      const target = normalizedItxExpression(payload.target as ItxExpressionInput, { holes: true });
      // A target that restates the implicit row of its match deletes the row, unless a bare `itx`
      // mask stands: then the same spelling is a grant through the wall and is stored.
      const wall =
        matchPrefix.length > 1 && state.itxExpressionRewriteRules["itx"]?.target === null;
      const isImplicitRow =
        matchPrefix.length === 1
          ? implicitRoots.size === Object.keys(builtInRootDescriptions()).length
          : matchPrefix.length === 2 &&
            typeof matchPrefix[1] === "string" &&
            implicitRoots.has(matchPrefix[1]);
      if (!wall && isImplicitRow && jsonEqual(target, ["itx", "builtins", ...matchPrefix.slice(1)]))
        return existing ? withRule(undefined) : undefined;
      // The same row again moves no version, so no snapshot another context holds is invalidated.
      if (
        existing &&
        jsonEqual(existing.target, target) &&
        existing.description === description.description
      )
        return undefined;
      return withRule({ match: matchPrefix, target, ...description });
    }

    case "events.iterate.com/itx/subscription-configured": {
      const name = payload.name as string;
      if (payload.target === null) {
        if (
          "ifConfiguredAtOffset" in payload &&
          state.subscriptions[name]?.configuredAtOffset !== payload.ifConfiguredAtOffset
        )
          return undefined;
        return state.subscriptions[name] ? withSubscription(name, undefined) : undefined;
      }
      const consumes = payload.consumes as string[] | undefined;
      const afterOffset = payload.afterOffset as number | undefined;
      const ordered = payload.ordered as false | undefined;
      const copyTarget = CopyTarget.safeParse(payload.target);
      const copy = copyTarget.success ? copyTarget.data : undefined;
      const filter = payload.filter as string | undefined;
      const configuredTarget: ItxExpression = copy
        ? ["itx", ["cd", copy.path]]
        : normalizedItxExpression(payload.target as ItxExpressionInput);
      const { target, hostedFacet } = elideHostedFacetSource(
        configuredTarget,
        resolveThroughState(state, configuredTarget),
      );
      return withSubscription(name, {
        target,
        // oxlint-disable-next-line iterate/simple-truthiness-check -- canonical subscription row (serialized to the JSON checkpoint, compared with jsonEqual which counts keys): an absent optional field must stay absent, not `field: undefined`
        ...(consumes && { consumes }),
        configuredAtOffset: event.offset,
        // oxlint-disable-next-line iterate/simple-truthiness-check -- canonical subscription row (serialized to the JSON checkpoint, compared with jsonEqual which counts keys): an absent optional field must stay absent, not `field: undefined`
        ...(afterOffset !== undefined && { afterOffset }),
        ...(ordered === false && { ordered }),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- canonical subscription row (serialized to the JSON checkpoint, compared with jsonEqual which counts keys): an absent optional field must stay absent, not `field: undefined`
        ...(copy && { copy }),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- canonical subscription row (serialized to the JSON checkpoint, compared with jsonEqual which counts keys): an absent optional field must stay absent, not `field: undefined`
        ...(filter && { filter }),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- canonical subscription row (serialized to the JSON checkpoint, compared with jsonEqual which counts keys): an absent optional field must stay absent, not `field: undefined`
        ...(hostedFacet && { hostedFacet }),
      });
    }
    case "events.iterate.com/itx/subscription-delivery-halted": {
      const row = state.subscriptions[payload.name as string];
      if (!row) return undefined;
      return withSubscription(payload.name as string, {
        ...row,
        halted: {
          afterOffset: payload.afterOffset as number,
          attempts: payload.attempts as number,
          ...(payload.error !== undefined && { error: payload.error as string }),
        },
      });
    }
    case "events.iterate.com/itx/subscription-delivery-resumed": {
      const row = state.subscriptions[payload.name as string];
      if (!row) return undefined;
      const { halted: _cleared, ...kept } = row;
      return withSubscription(payload.name as string, {
        ...kept,
        resumed: {
          ...(payload.afterOffset !== undefined && {
            afterOffset: payload.afterOffset as number,
          }),
          ...(payload.offset !== undefined && { offset: payload.offset as number }),
          atOffset: event.offset,
        },
      });
    }
    default:
      return undefined;
  }
}

// Leaves out the original's `offset` (append would land the copy at it) and its `source`, which
// `copiedFrom` replaces.
export type EventCopy = Pick<StreamEvent, "type" | "payload" | "metadata"> & {
  copiedFrom: EventCopiedFrom;
};

// A copy is never an `itx/*` event: deliveries run as the kernel, so a copied rewrite rule or
// subscription row would skip the check on what loaded code may write (`admitLoadedCodeRow`).
const CopyTarget = z.strictObject({
  type: z
    .string()
    .min(1)
    .refine((type) => !type.startsWith("events.iterate.com/itx/"), {
      error: "a copy is never an `itx/*` event",
    })
    .optional(),
  payload: z.string({ error: "a copy's `payload` is a JSONata expression" }).min(1).optional(),
  path: z.string().startsWith("/", { error: "a copy's path is absolute" }),
}) satisfies z.ZodType<EventCopyTarget>;
const FilterExpression = z
  .string({ error: "a subscription's `filter` is a JSONata expression" })
  .min(1)
  .optional();

function normalizeSubscriptionConfigured(input: {
  name: string;
  target: ItxExpressionInput | EventCopyTarget | null;
  consumes?: string[];
  afterOffset?: number;
  ordered?: boolean;
  filter?: string;
  ifConfiguredAtOffset?: number;
}): Record<string, unknown> {
  const name = parseSubscriptionName(input.name);
  const { afterOffset } = input;
  if (afterOffset !== undefined && !(Number.isInteger(afterOffset) && afterOffset >= 0))
    throw new Error(
      `a subscription's afterOffset is a non-negative integer offset (got ${JSON.stringify(afterOffset)})`,
    );
  const ordered = z
    .boolean({ error: "a subscription's `ordered` is a boolean: false for fan-out delivery" })
    .optional()
    .parse(input.ordered);
  // Stored parsed: a target can carry a facet's whole source, which the reduce must never re-parse
  // through the string codec (its 2 KiB cap). A copy target is the one object target.
  const copy =
    input.target && typeof input.target === "object" && !Array.isArray(input.target)
      ? CopyTarget.parse(input.target)
      : undefined;
  const target: ItxExpression | EventCopyTarget | null = copy
    ? { ...copy, path: resolveContextPath("/", copy.path) }
    : // oxlint-disable-next-line iterate/simple-truthiness-check -- null removes the row; an empty string must reach the codec, which refuses it
      input.target === null
      ? null
      : normalizedItxExpression(input.target as ItxExpressionInput);
  if (Array.isArray(target) && target[0] !== "itx")
    throw new Error(
      `a subscription target must be rooted at "itx" (got ${JSON.stringify(print(target))})`,
    );
  const filter = FilterExpression.parse(input.filter);
  if (!copy && filter) throw new Error("a subscription's `filter` is for a row with a copy target");
  if (copy && ordered === true) throw new Error("a copy row is `ordered: false`");
  for (const text of [filter, copy?.payload]) if (text) compileEventExpression(text);
  return {
    name,
    target,
    ...(target && input.consumes && { consumes: input.consumes }),
    ...(target && afterOffset !== undefined && { afterOffset }),
    ...(target && (copy || ordered === false) && { ordered: false }),
    // oxlint-disable-next-line iterate/simple-truthiness-check -- the stored payload is compared with jsonEqual on an idempotent retry, which counts keys: an absent filter must stay absent
    ...(filter && { filter }),
    ...(!target &&
      input.ifConfiguredAtOffset !== undefined && {
        ifConfiguredAtOffset: input.ifConfiguredAtOffset,
      }),
  };
}

const IngressConfigured = z.object({
  target: z
    .custom<ItxExpressionInput>((value) => typeof value === "string" || Array.isArray(value))
    .nullable(),
});

function normalizeIngressConfigured(input: unknown): { target: ItxExpression | null } {
  const { target } = IngressConfigured.parse(input);
  // oxlint-disable-next-line iterate/simple-truthiness-check -- null disables ingress; an empty expression must be rejected by the codec
  if (target === null) return { target: null };
  const expression = normalizedItxExpression(target);
  if (expression[0] !== "itx") throw new Error("ingress target must be rooted at itx");
  return { target: expression };
}

// The platform appends these straight through `Stream.append`; `normalizeControlEvent` refuses them
// from anyone else, so no caller can forge who a context is, a halt, or a run's settlement.
export const STREAM_RECORD_TYPES = new Set<string>([
  "events.iterate.com/itx/created",
  "events.iterate.com/itx/woken",
  "events.iterate.com/itx/subscription-delivery-halted",
  "events.iterate.com/itx/subscription-delivery-failed",
  "events.iterate.com/itx/alarm-trace",
  "events.iterate.com/itx/run-settled",
  "events.iterate.com/itx/loop-limit",
  "events.iterate.com/itx/work-failed",
]);

export function normalizeControlEvent(event: StreamEventInput, ownPath: string): StreamEventInput {
  if (STREAM_RECORD_TYPES.has(event.type))
    throw new Error(`${event.type} is the platform's own record: it cannot be appended`);
  // Checked, never rewritten: an idempotent retry compares the stored payload with `jsonEqual`.
  if (event.type === "events.iterate.com/itx/paused") {
    z.strictObject({ reason: z.string().optional() }).optional().parse(event.payload);
    return event;
  }
  if (event.type === "events.iterate.com/itx/resumed") {
    z.strictObject({}).optional().parse(event.payload);
    return event;
  }
  if (event.type === "events.iterate.com/itx/subscription-delivery-resumed") {
    z.strictObject({
      name: z.string().transform(parseSubscriptionName),
      afterOffset: z.number().int().nonnegative().optional(),
      offset: z.number().int().positive().optional(),
    })
      .refine((payload) => payload.afterOffset === undefined || payload.offset === undefined, {
        message: "a resume seeks (afterOffset) or delivers one event again (offset), not both",
      })
      .parse(event.payload);
    return event;
  }
  if (event.type === "events.iterate.com/itx/ingress-configured") {
    if (event.ephemeral) throw new Error("ingress configuration must be durable");
    return { ...event, payload: normalizeIngressConfigured(event.payload) };
  }
  if (event.type === "events.iterate.com/itx/fetch-route-configured") {
    if (event.ephemeral) throw new Error("a fetch route must be durable");
    return { ...event, payload: FetchRouteConfiguredPayload.parse(event.payload) };
  }
  // `String(…)`: a non-string type is Stream.append's to refuse, with its own message.
  if (String(event.type).startsWith("events.iterate.com/itx/schedule-")) {
    if (event.ephemeral) throw new Error("scheduled append control events must be durable");
    if (event.type === "events.iterate.com/itx/schedule-set") {
      const payload = ScheduledAppendInput.parse(event.payload);
      return {
        ...event,
        payload: {
          ...payload,
          events: payload.events.map((scheduled) => normalizeControlEvent(scheduled, ownPath)),
        },
      };
    }
    if (event.type === "events.iterate.com/itx/schedule-cancelled")
      return { ...event, payload: ScheduledAppendCancelled.parse(event.payload) };
    if (
      event.type === "events.iterate.com/itx/schedule-fired" ||
      event.type === "events.iterate.com/itx/schedule-failed"
    )
      return { ...event, payload: ScheduledAppendSettled.parse(event.payload) };
    throw new Error(`unknown scheduled append control event: ${event.type}`);
  }
  if (event.type === "events.iterate.com/itx/run-requested") {
    if (event.ephemeral)
      throw new Error("a run's request is durable: the scriptRuns table is rebuilt from the log");
    return { ...event, payload: RunRequested.parse(event.payload) };
  }
  if (event.type === "events.iterate.com/itx/subscription-configured")
    return {
      ...event,
      payload: normalizeSubscriptionConfigured(
        event.payload as Parameters<typeof normalizeSubscriptionConfigured>[0],
      ),
    };
  if (event.type === "events.iterate.com/itx/rewrite-rule-configured") {
    // The reduce keys its compare-and-set off `"ifTarget" in payload`, so the key passes through
    // only when the caller sent one.
    const payload = event.payload as RewriteRuleConfigured & {
      ifTarget?: ItxExpressionInput | null;
    };
    const normalized = normalizeRewriteRuleConfigured(payload);
    refuseSelfLoopRow(normalized, ownPath);
    return { ...event, payload: normalized };
  }
  return event;
}
