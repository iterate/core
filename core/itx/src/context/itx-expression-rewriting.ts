// The platform's own spellings are rooted at `itx.builtins`, so a user's row at `itx.facets` or
// `itx.rpcStubs` redirects the user's calls and nothing else.
import {
  codedError,
  errorCode,
  jsonEqual,
  releaseRpcSessions,
  reportIssue,
  resolveContextPath,
} from "iterate/lib";
import type { RewriteRuleConfigured, RewriteRuleListEntry } from "iterate/api";
import {
  canonicalItxExpressionPrefix,
  normalizedItxExpression,
  containsItxExpressionHole,
  isItxExpressionHole,
  ITX_EXPRESSION_MERGE_KEY,
  itxExpressionStepName,
  parse,
  parseItxExpressionPrefix,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  type ItxExpressionPrefix,
} from "iterate/expression";
import { ACT_DONE, actOfText, type ActRule, actText } from "iterate/acts";
import type { StreamEventInput } from "iterate/stream/processor";
import { crossingOneMore, newChain, recordRefusal, type Cause } from "../cause.ts";
import { isConfigPointerMatch, sha256Hex, type Caller } from "../caller.ts";
import { ScheduledAppendInput } from "../stream/scheduled-appends.ts";
import { itxHost } from "../host.ts";
import { unavailableError } from "../unavailable.ts";
import { callOn, walkSteps, awaitAnswerReleasedIfRejected } from "./dispatch.ts";
import { calledNameOf, heldVerbOf } from "./held-verbs.ts";
import { SNAPSHOT_REREADS, type RuleSnapshot } from "./rule-snapshots.ts";

// Apart from the scope on purpose: the core reduce and the DO's `list()` read it, and neither may
// import the scope. built-ins.ts asserts these keys and `keyof BuiltInScope` are the same set.
const BUILT_IN_ROOT_DESCRIPTIONS = {
  whoami: "who this context is: `itx.whoami()` → { path }",
  fetchRoutes:
    "which itx expression a request on this mind's hosts goes to: `fetchRoutes.set(name, { requestMatcher: { routingSlug?, url?, headers? }, target, authRequirement?, priority? } | null)` · `list()` · `match({ url, headers })`; the platform serves a match from `route.target`, before the config worker's fetch",
  append: "write events to this log: `itx.append({ type, payload })`",
  appendOffsets:
    "write events to this log and answer their offsets only, not the events: `itx.appendOffsets({ type, payload })` → [offset]",
  schedules:
    "durable future appends: `schedules.set({ key, when, events })` · `schedules.cancel(key)`",
  readEvents: "read this log: `(await itx.readEvents(afterOffset, limit)).events`",
  waitForEvent: "block until an event lands: `waitForEvent({ type, afterOffset, timeoutMs })`",
  cd: "any context of the mind, with every verb: `itx.cd('/').waitForEvent(…)`, `itx.cd('./child').append({ type, payload })`; a jail's bare null refuses what reaches in",
  fetch: "the internet through the mind's egress: `itx.fetch(new Request(url))`",
  rpcStubs: "live values clients lent here: `rpcStubs.list()` · `rpcStubs.get(key)`",
  rewriteRules: "this table, described: `await rewriteRules.list()`",
  contexts:
    "the mind's catalog of its contexts, the most recently active first: `await itx.cd('/').contexts.list({ search?, under?, awake?, limit? })` → [{ path, awake?, lastActivityAt, eventCount, eventTypes, recentTypes, processors, description?, metadata? }]; a context describes itself with `itx.append({ type: 'events.iterate.com/itx/described', payload: { description, metadata } })`",
  facets:
    "a durable facet hosted here: `facets.get(name)` · `facets.abort(name, reason?)` resets that one facet",
  abort:
    "reset this context: its log and storage stay, its in-memory state, facets and sockets go — `itx.abort(reason?)`; another: `itx.cd(path).abort()`",
  subscriptions: "the rows delivered each commit: `subscriptions.list()`",
  processors: "hosted processors: `processors.enable(name, spec)` · `list()` · `disable(name)`",
  workers: "load code as a stateless worker: `workers.get({ source }).run()`",
  run: 'a fresh confined run of a script you write as text: `itx.run("async (itx) => …")`',
} as const satisfies Record<string, string>;

export type BuiltInRoot = keyof typeof BUILT_IN_ROOT_DESCRIPTIONS;

// A context's own roots, implicit in every context: nothing else could `append` or `abort` mean at
// `/agents/x`. Every other root is implicit at the mind root only.
const CONTEXT_ROOTS = [
  "whoami",
  "append",
  "appendOffsets",
  "abort",
  "readEvents",
  "waitForEvent",
  "cd",
  "facets",
  "subscriptions",
  "processors",
  "schedules",
  "rewriteRules",
  "rpcStubs",
  "workers",
  "run",
] as const satisfies readonly BuiltInRoot[];

// A security surface: a root belongs here only if it answers identically at every context of a
// mind but for whom it names as the caller.
const PORTABLE_ROOTS = ["fetch"] as const satisfies readonly BuiltInRoot[];

function roots() {
  if (known) return known;
  const hostRoots = itxHost().roots || {};
  for (const name of Object.keys(hostRoots))
    if (Object.hasOwn(BUILT_IN_ROOT_DESCRIPTIONS, name) || name === "builtins")
      throw new Error(`core-itx host: the root "${name}" is the kernel's own`);
  const hostRootNames = Object.keys(hostRoots);
  known = {
    descriptions: {
      ...BUILT_IN_ROOT_DESCRIPTIONS,
      ...Object.fromEntries(
        Object.entries(hostRoots).map(([name, root]) => [name, root.description]),
      ),
    } as Readonly<Record<string, string>>,
    builtIn: new Set<string>([...Object.keys(BUILT_IN_ROOT_DESCRIPTIONS), ...hostRootNames]),
    context: new Set<string>([
      ...CONTEXT_ROOTS,
      ...hostRootNames.filter((name) => hostRoots[name]!.everyContext),
    ]),
    portable: new Set<string>([...PORTABLE_ROOTS, ...hostRootNames]),
  };
  return known;
}
let known:
  | {
      descriptions: Readonly<Record<string, string>>;
      builtIn: ReadonlySet<string>;
      context: ReadonlySet<string>;
      portable: ReadonlySet<string>;
    }
  | undefined;

export function builtInRootDescriptions(): Readonly<Record<string, string>> {
  return roots().descriptions;
}

export function implicitRootsAt(path: string): ReadonlySet<string> {
  return path === "/" ? roots().builtIn : roots().context;
}

// A `null` target is a mask: the row matches like any other and refuses the call.
export type ItxExpressionRewriteRule = {
  match: ItxExpressionPrefix;
  target: ItxExpression | null;
  description?: string;
};

// Every context that resolves through the table reads a rule's target in a snapshot.
export const SOURCE_MAX_CHARS = 1 << 20;

const PROXY_VERBS: readonly string[] = ["invoke", "provide", "subscribe"];

export function isBuiltInsRooted(call: ItxExpression): boolean {
  return call[0] === "itx" && call[1] === "builtins";
}

type ItxExpressionPrefixMatch = { unpinnedArgs?: unknown[]; stepsAfterMatch: ItxExpression };

function matchItxExpressionPrefix(
  match: ItxExpressionPrefix,
  call: ItxExpression,
): ItxExpressionPrefixMatch | null {
  let unpinnedArgs: unknown[] | undefined;
  for (let i = 0; i < match.length; i++) {
    const matchStep = match[i];
    const callStep = call[i];
    const final = i === match.length - 1;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- out-of-bounds detection: call[i] is undefined past the call's end, distinct from any present step
    if (callStep === undefined) return null;
    if (typeof matchStep === "string") {
      if (typeof callStep === "string") {
        if (callStep !== matchStep) return null;
      } else if (callStep[0] !== matchStep || !final) return null;
      else unpinnedArgs = callStep.slice(1);
    } else {
      if (typeof callStep === "string" || callStep[0] !== matchStep[0]) return null;
      const pinned = matchStep.slice(1);
      const args = callStep.slice(1);
      if (args.length < pinned.length || !pinned.every((p, k) => jsonEqual(p, args[k])))
        return null;
      const residual = args.slice(pinned.length);
      if (final) unpinnedArgs = residual;
      else if (residual.length > 0) return null;
    }
  }
  return { unpinnedArgs, stepsAfterMatch: call.slice(match.length) };
}

const pinnedArgCount = (match: ItxExpressionPrefix): number =>
  match.reduce<number>((n, step) => n + (Array.isArray(step) ? step.length - 1 : 0), 0);

// A mask row competes like any other.
function pickItxExpressionRewriteRule(
  rules: readonly ItxExpressionRewriteRule[],
  call: ItxExpression,
): { rule: ItxExpressionRewriteRule; match: ItxExpressionPrefixMatch } | null {
  let best: { rule: ItxExpressionRewriteRule; match: ItxExpressionPrefixMatch } | null = null;
  const moreSpecific = (a: ItxExpressionRewriteRule, b: ItxExpressionRewriteRule): boolean =>
    a.match.length !== b.match.length
      ? a.match.length > b.match.length
      : pinnedArgCount(a.match) > pinnedArgCount(b.match);
  for (const rule of rules) {
    const match = matchItxExpressionPrefix(rule.match, call);
    if (match && (!best || moreSpecific(rule, best.rule))) best = { rule, match };
  }
  return best;
}

function fillItxExpressionHoles(
  templateArgs: unknown[],
  unpinnedArgs: unknown[] | undefined,
  target: ItxExpression,
): unknown[] {
  const spelled = print(target, { holes: true });
  const theOneUnpinnedArg = (what: string): unknown => {
    if (unpinnedArgs?.length !== 1)
      throw new Error(
        `${what} in the target ${JSON.stringify(spelled)} takes exactly one argument, got ${unpinnedArgs?.length ?? 0}`,
      );
    return unpinnedArgs[0];
  };
  const fill = (value: unknown): unknown => {
    if (isItxExpressionHole(value)) return theOneUnpinnedArg("a nested `@`");
    if (Array.isArray(value)) return value.map(fill);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `value` is `unknown`; the typeof separates real objects from primitives (bare truthiness would misroute strings/numbers)
    if (value !== null && typeof value === "object") {
      const template = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      if (template[ITX_EXPRESSION_MERGE_KEY] === true) {
        const source = theOneUnpinnedArg("`...@`");
        // oxlint-disable-next-line iterate/simple-truthiness-check -- `source` is `unknown` (a caller-supplied arg); the typeof is real validation that it is a mergeable object
        if (source === null || typeof source !== "object" || Array.isArray(source))
          throw new Error(
            `\`...@\` in the target ${JSON.stringify(spelled)} merges an object; the argument is ${JSON.stringify(source)}`,
          );
        Object.assign(out, source);
      }
      for (const [k, v] of Object.entries(template))
        if (k !== ITX_EXPRESSION_MERGE_KEY) out[k] = fill(v);
      return out;
    }
    return value;
  };
  return templateArgs.flatMap((arg) =>
    isItxExpressionHole(arg) ? unpinnedArgs || [] : [fill(arg)],
  );
}

/** A RULE'S VERB AS A CALL WHOSE ARGUMENTS ARE NOT KNOWN: the name, called with a hole. A row whose
 *  target has an `@` resolves a name only when it is called, and puts the call's arguments where
 *  the `@` is. Resolved this way, the target keeps what the row pins and has the hole where the
 *  arguments go, which is what a call is compared against (./held-verbs.ts). */
function verbWithAHole(verb: ItxExpression): ItxExpression {
  const last = verb.at(-1);
  return typeof last === "string" ? [...verb.slice(0, -1), [last, { "@": true }]] : verb;
}

/** WHAT A RULE'S VERB IS: the name as it resolves, or, when its row fills in the call's arguments,
 *  the call with the hole in it. `called` is the name resolved as a call with a hole. A row with no
 *  `@` only hands the arguments on, so `called` is then `name` called with the hole and no more:
 *  the name is the verb. Any other `called` has what the row pins around the hole. */
function filledInOrName(
  name: ItxExpression | null,
  called: ItxExpression | null,
): ItxExpression | null {
  // The cast: `mergeHoleKept` changes objects among a call's arguments only, so steps stay steps.
  const withHole = called && (called.map(mergeHoleKept) as ItxExpression);
  if (!name || !called) return withHole || name;
  const last = name.at(-1);
  const handedOn: ItxExpression =
    typeof last === "string"
      ? [...name.slice(0, -1), [last, { "@": true }]]
      : [...name, ["", { "@": true }]];
  return jsonEqual(called, handedOn) ? name : withHole;
}

/** A `...@` of a row merges the argument's keys into its own object. Read with the hole as the
 *  argument (`verbWithAHole`), that object holds the hole's one key, `"@"`, beside the row's keys:
 *  it is written back as the `...@` it was, so the call is still one with a hole. */
function mergeHoleKept(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mergeHoleKept);
  if (!(value instanceof Object) || isItxExpressionHole(value)) return value;
  // The cast: an object that is no list, off a parsed expression, so its keys are strings.
  const { "@": hole, ...pinned } = value as Record<string, unknown>;
  const kept = Object.fromEntries(Object.entries(pinned).map(([k, v]) => [k, mergeHoleKept(v)]));
  return hole === true ? { ...kept, [ITX_EXPRESSION_MERGE_KEY]: true } : kept;
}

function applyItxExpressionRewriteRule(
  target: ItxExpression,
  match: ItxExpressionPrefixMatch,
): ItxExpression {
  const { unpinnedArgs, stepsAfterMatch } = match;
  const last = target.at(-1);
  if (Array.isArray(last) && containsItxExpressionHole(last))
    return [
      ...target.slice(0, -1),
      [last[0], ...fillItxExpressionHoles(last.slice(1), unpinnedArgs, target)],
      ...stepsAfterMatch,
    ];
  if (!unpinnedArgs) return [...target, ...stepsAfterMatch];
  return typeof last === "string"
    ? [...target.slice(0, -1), [last, ...unpinnedArgs], ...stepsAfterMatch]
    : [...target, ["", ...unpinnedArgs], ...stepsAfterMatch];
}

// `rules` is a thunk, read at most once and not at all when the call is already builtins-rooted:
// a fixed-point dispatch never materializes the table.
export function resolveItxExpression(
  rules: () => readonly ItxExpressionRewriteRule[],
  call: ItxExpression,
  implicitRoots: ReadonlySet<string>,
): ItxExpression[] {
  const chain: ItxExpression[] = [call];
  let current = call;
  let rulesList: readonly ItxExpressionRewriteRule[] | undefined;
  for (let rewrites = 0; ; rewrites++) {
    if (isBuiltInsRooted(current)) return chain;
    if (rewrites >= REWRITE_BUDGET)
      throw new Error(
        `itx-expression rewriting exceeded depth ${String(REWRITE_BUDGET)} — self-referential rule?`,
      );
    const root = itxExpressionStepName(current[1]);
    const implicit = current[0] === "itx" && !!root && implicitRoots.has(root);
    const winner =
      current[0] === "itx" ? pickItxExpressionRewriteRule((rulesList ||= rules()), current) : null;
    // A bare row with a target yields to an implicit row (the context's own log stays its own under
    // a parent link); a bare null yields to nothing: one row denies all.
    const yields = !!winner && winner.rule.match.length === 1 && !!winner.rule.target && implicit;
    if (winner && !yields) {
      if (!winner.rule.target)
        throw codedError(
          "NO_ITX_EXPRESSION_MATCH",
          `${JSON.stringify(print(current))} is masked: the rule at ${JSON.stringify(print(winner.rule.match))} is null (default-deny; provide a target)`,
        );
      current = applyItxExpressionRewriteRule(winner.rule.target, winner.match);
      chain.push(current);
      continue;
    }
    if (implicit) {
      current = ["itx", "builtins", ...current.slice(1)];
      chain.push(current);
      return chain;
    }
    throw codedError(
      "NO_ITX_EXPRESSION_MATCH",
      `no rewrite rule matches ${JSON.stringify(print(current))} (default-deny; configure a rule first)`,
    );
  }
}

export function fixedPointOf(
  rules: () => readonly ItxExpressionRewriteRule[],
  call: ItxExpression,
  implicitRoots: ReadonlySet<string>,
): ItxExpression | undefined {
  try {
    return resolveItxExpression(rules, call, implicitRoots).at(-1);
  } catch {
    return undefined;
  }
}

// Answered by a resolver that speaks for that context, where the call is, never by a call to it.
const IDENTITY_ROOTS: ReadonlySet<string> = new Set(["whoami"]);

export function entersOwnRoot(call: ItxExpression): boolean {
  const root = itxExpressionStepName(withoutBuiltIns(call)[0]);
  return (
    !!root &&
    roots().context.has(root) &&
    root !== "cd" &&
    root !== "workers" &&
    !IDENTITY_ROOTS.has(root)
  );
}

const withoutBuiltIns = (call: ItxExpression): ItxExpression =>
  isBuiltInsRooted(call) ? call.slice(2) : call.slice(1);

// Only the platform writes a config pointer, so a spec reached through it is the platform's and its
// manifest counts.
function runsThePublishedConfig(
  rules: readonly ItxExpressionRewriteRule[],
  fixedPoint: ItxExpression,
): boolean {
  const steps = withoutBuiltIns(fixedPoint);
  return rules.some((rule) => {
    if (!rule.target || !isConfigPointerMatch(rule.match)) return false;
    const target = withoutBuiltIns(rule.target);
    return jsonEqual(target, steps.slice(0, target.length));
  });
}

// The target is stored parsed: it may carry a whole facet source, which the reduce must never
// re-parse through the string codec (its 2 KiB cap).
export function normalizeRewriteRuleConfigured(
  payload: RewriteRuleConfigured & { ifTarget?: ItxExpressionInput | null },
): {
  match: ItxExpression;
  target: ItxExpression | null;
  description?: string;
  ifTarget?: ItxExpression | null;
} {
  const matchPrefix = parseItxExpressionPrefix(payload.match);
  const d = payload.description;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- wire-fed: a present non-string (a number, an object) must be refused where the event is normalized, not coerced
  if (d && (typeof d !== "string" || d.length > 500))
    throw new Error("a rewrite rule's description is one line: a string of at most 500 chars");
  const description = payload.description ? { description: payload.description } : {};
  if (matchPrefix[0] !== "itx")
    throw new Error(
      `a rewrite rule's match must be rooted at "itx" (every call starts there — ${JSON.stringify(print(matchPrefix))} could never match one)`,
    );
  if (containsItxExpressionHole(matchPrefix))
    throw new Error(
      `\`@\` (the caller's input) is legal only in a rewrite rule's target, not its match (${JSON.stringify(print(matchPrefix))})`,
    );
  const firstName = itxExpressionStepName(matchPrefix[1]);
  if (firstName === "builtins")
    throw new Error(
      `a rewrite rule's match may not be rooted at "itx.builtins" — the reserved root is the fixed point every call rewrites TO, never a name a rule claims (${JSON.stringify(print(matchPrefix))})`,
    );
  if (firstName && PROXY_VERBS.includes(firstName))
    throw new Error(
      `a rewrite rule's match may not start with the proxy's own verb "${firstName}" (${PROXY_VERBS.join(", ")}): the dotted surface never hands those to the table, so the rule could fire from a string invoke but never from the sugar`,
    );
  const targetExpression =
    // oxlint-disable-next-line iterate/simple-truthiness-check -- payload.target is `string | ItxExpression | null`; its null is the explicit mask sentinel (default-deny), distinct from a malformed empty-string target that normalization must still reject
    payload.target === null ? null : normalizedItxExpression(payload.target, { holes: true });
  if (targetExpression && targetExpression[0] !== "itx")
    throw new Error(
      `a rewrite rule's target must be rooted at "itx" (a bare built-in root is unspellable — targets resolve through the rules; the physical spelling is "itx.builtins.…")`,
    );
  if (targetExpression && targetExpression.slice(0, -1).some(containsItxExpressionHole))
    throw new Error(
      `\`@\` (the caller's input) is legal only in the target's FINAL step — ${JSON.stringify(print(targetExpression, { holes: true }))} holds it earlier`,
    );
  const chars = targetExpression ? JSON.stringify(targetExpression).length : 0;
  if (chars > SOURCE_MAX_CHARS)
    throw codedError(
      "FACET_SOURCE_TOO_LARGE",
      `a rewrite rule's target is ${chars} chars, over the ${SOURCE_MAX_CHARS}-char ceiling — every context that resolves through this table reads it in a snapshot: load the source from a producer expression with a cacheKey`,
    );
  // `ifTarget` is normalized as `target` is: the reduce compares it with the stored parsed target,
  // so a string `ifTarget` would never match.
  if (!("ifTarget" in payload))
    return { match: matchPrefix, target: targetExpression, ...description };
  // oxlint-disable-next-line iterate/simple-truthiness-check -- a PRESENT key with an undefined value (reachable over capnweb, never JSON) is malformed and refused loudly here; folding it into the null sentinel would silently turn a handle's undo into a mask-lift
  if (payload.ifTarget === undefined)
    throw new Error(
      "a rewrite rule's ifTarget is an itx expression or null (the mask sentinel), never undefined",
    );
  const ifTarget =
    // oxlint-disable-next-line iterate/simple-truthiness-check -- like `target` above: null is the explicit sentinel (compare against a masked, null-target row), distinct from a malformed empty-string ifTarget that normalization must still parse and reject
    payload.ifTarget === null ? null : normalizedItxExpression(payload.ifTarget, { holes: true });
  return { match: matchPrefix, target: targetExpression, ...description, ifTarget };
}

// Yes when it removes or changes a name that already answered here; no when it only adds a new name
// or changes a description. A name re-added while its removal's fence is pending waits it out.
export function rulesChangeNeedsCommitWait(
  before: Readonly<Record<string, ItxExpressionRewriteRule>>,
  after: Readonly<Record<string, ItxExpressionRewriteRule>>,
  implicitRoots: ReadonlySet<string>,
  takenAway: readonly ItxExpressionPrefix[] = [],
): boolean {
  if (before === after) return false;
  const changed = Object.entries(before).some(
    ([key, old]) => !after[key] || !jsonEqual(old.target, after[key].target),
  );
  // A new row takes only what already answered here: a bare null takes every implicit row, a bare
  // link only names that answered nothing, any other row the calls its match claims.
  const rulesBefore = Object.values(before);
  return (
    changed ||
    Object.entries(after).some(
      ([key, next]) =>
        !before[key] &&
        (next.match.length === 1
          ? !next.target
          : !!fixedPointOf(() => rulesBefore, next.match, implicitRoots) ||
            takenAway.some((match) => matchItxExpressionPrefix(match, next.match))),
    )
  );
}

// A row whose target lives in this context is not taken away: an older snapshot sends the call
// here, where the live table resolves it. Nor is a mask, which answered nothing.
export function namesTakenAway(
  before: Readonly<Record<string, ItxExpressionRewriteRule>>,
  after: Readonly<Record<string, ItxExpressionRewriteRule>>,
): ItxExpressionPrefix[] {
  return Object.entries(before)
    .filter(([key, old]) => {
      if (!old.target || jsonEqual(old.target, after[key]?.target)) return false;
      const root = isBuiltInsRooted(old.target) ? itxExpressionStepName(old.target[2]) : undefined;
      return !root || roots().portable.has(root) || root === "cd" || root === "workers";
    })
    .map(([, old]) => old.match);
}

// Decided against one frozen table, so the answer never depends on the order rows were configured.
// A fetch route goes with its stub: a dangling route still takes its host (a 404 for every visitor).
export function rowsNamingRpcStub(args: {
  rpcStubKey: string;
  rules: readonly ItxExpressionRewriteRule[];
  subscriptionTargets: Record<string, ItxExpression>;
  fetchRouteTargets: Record<string, ItxExpression>;
  implicitRoots: ReadonlySet<string>;
}): {
  ruleUnsets: { match: ItxExpressionPrefix; ifTarget: ItxExpression }[];
  subscriptionNames: string[];
  fetchRouteNames: string[];
} {
  const { rpcStubKey, rules, subscriptionTargets, fetchRouteTargets, implicitRoots } = args;
  const names = (target: ItxExpression | null | undefined): boolean =>
    !!target && builtInsGetStep(target, "rpcStubs")?.[1] === rpcStubKey;
  const through = (table: readonly ItxExpressionRewriteRule[], target: ItxExpression) =>
    fixedPointOf(() => table, target, implicitRoots);
  const direct = rules.filter((rule) => names(rule.target));
  const remaining = rules.filter((rule) => !direct.includes(rule));
  const namesThroughRemaining = (target: ItxExpression) => names(through(remaining, target));
  const indirect = remaining.filter((rule) => rule.target && namesThroughRemaining(rule.target));
  const unsetRules = [...direct, ...indirect];
  const survivingRules = rules.filter((rule) => !unsetRules.includes(rule));
  const reachesOnlyRpcStub = (target: ItxExpression): boolean => {
    if (!names(through(rules, target))) return false;
    const afterwards = through(survivingRules, target);
    return !afterwards || names(afterwards);
  };
  return {
    // a compare-and-set: a `provide` that lands at the same match in the detach window owns the row
    // with a different target, and is left untouched
    ruleUnsets: unsetRules.map((rule) => ({
      match: rule.match,
      ifTarget: rule.target!,
    })),
    subscriptionNames: Object.entries(subscriptionTargets)
      .filter(([, target]) => namesThroughRemaining(target))
      .map(([name]) => name),
    fetchRouteNames: Object.entries(fetchRouteTargets)
      .filter(([, target]) => reachesOnlyRpcStub(target))
      .map(([fetchRouteName]) => fetchRouteName),
  };
}

// Loaded code's input, or a row's target, is walled as it will resolve: never the fixed point, and
// a signing secret only at the mind root. A producer is walled at the context the walk reached.
function admitLoadedCodeExpression(expression: ItxExpression, from: string): void {
  let at = from;
  for (const step of expression) {
    const name = typeof step === "string" ? step : step[0];
    if (name === "builtins")
      throw codedError(
        "FORBIDDEN",
        `"itx.builtins" is not a loaded worker's word — this context's rows say what its code may spell (${JSON.stringify(print(expression, { holes: true }))})`,
      );
    if (Array.isArray(step))
      for (const arg of step.slice(1)) {
        // a receiver that verifies a signature trusts the event as the whole mind's
        if (at !== "/" && typeof arg === "object" && !!arg && "signingSecret" in arg)
          throw codedError(
            "FORBIDDEN",
            `a webhook's signing secret is named only at the mind's root, and ${JSON.stringify(at)} is below it`,
          );
        if (isSourceSpec(arg)) {
          const sourceExpression = workerSourceExpressionOf(arg.source);
          if (sourceExpression && namesAWorker(arg)) admitWorkerName(sourceExpression);
          else if (sourceExpression) admitLoadedCodeExpression(sourceExpression, at);
        }
        // A ROW IN A CALL'S ARGUMENTS IS A ROW. A row's target such as
        // `itx.append({ type: rewrite-rule-configured, payload: … })` writes that row when the
        // row runs. So the row is checked here, where loaded code names it: in an event, in a
        // list of events, or in a schedule's. A row that is made only when the row runs is
        // checked then (`admitRowsOfCall`).
        for (const event of rowEventsIn(arg)) admitLoadedCodeRow(event, at);
      }
    if (Array.isArray(step) && step[0] === "cd" && typeof step[1] === "string")
      at = resolveContextPath(at, step[1]);
  }
}

/** The events of the kernel's own namespace in a call's argument, however deep: each may be a row
 *  (`admitLoadedCodeRow` says which types are). */
function rowEventsIn(arg: unknown, depth = 0): { type: string; payload?: unknown }[] {
  if (!(typeof arg === "object" && !!arg) || depth > 8) return [];
  // the argument's fields by name: whatever it is, an event has a `type` that is a string
  const fields = new Map<string, unknown>(Object.entries(arg));
  const type = fields.get("type");
  const own =
    typeof type === "string" && type.startsWith("events.iterate.com/itx/")
      ? [{ type, payload: fields.get("payload") }]
      : [];
  return [...own, ...[...fields.values()].flatMap((value) => rowEventsIn(value, depth + 1))];
}

type WorkerSpecShape = { source?: unknown; cacheKey?: unknown };

// A `source` names or produces a worker only as an itx expression: the resolver reaches nothing
// from any other root, and every host reads a source through it. Anything else under a `source`
// key is the callee's own data, such as the page script of CDP's
// `Page.addScriptToEvaluateOnNewDocument({ source })`, and no host can load it as a worker.
function workerSourceExpressionOf(source: ItxExpressionInput): ItxExpression | null {
  try {
    const expression = normalizedItxExpression(source);
    return expression[0] === "itx" ? expression : null;
  } catch {
    return null;
  }
}

const isSourceSpec = (arg: unknown): arg is WorkerSpecShape & { source: ItxExpressionInput } =>
  typeof arg === "object" &&
  !!arg &&
  "source" in arg &&
  (typeof arg.source === "string" || Array.isArray(arg.source));

// An empty source expression names no worker. The wall and every host read a spec by this alone.
export const namesAWorker = <Spec extends WorkerSpecShape>(
  spec: Spec,
): spec is Spec & { source: ItxExpressionInput } =>
  !spec.cacheKey && (typeof spec.source === "string" || Array.isArray(spec.source));

// A name only reads rules, so the worker it names, and the authority its producer runs with, are
// what a rule says, never what the name spells.
function admitWorkerName(name: ItxExpression): void {
  for (const step of name.slice(1)) {
    const readsRules =
      typeof step === "string"
        ? step !== "builtins"
        : step[0] === "cd" && step.length === 2 && typeof step[1] === "string";
    if (!readsRules)
      throw codedError(
        "FORBIDDEN",
        `a worker's name only reads rules — property steps and cd(path) — and ${JSON.stringify(print(name, { holes: true }))} does more: give a source you produce its cacheKey`,
      );
  }
}

// Otherwise a jail granted `itx.append` would write itself `itx.x ⇒ itx.builtins.cd('/').x`. A
// removal is refused: it hands the name back to what lies beneath, a jail's null or a parent link.
// An ingress row is a row too: its target answers the next request on the mind's hosts, as the
// person who makes that request, so loaded code names no built-in there either.
export function admitLoadedCodeRow(
  event: { type: string; payload?: unknown },
  landsAt: string,
): void {
  if (event.type === "events.iterate.com/itx/schedule-set") {
    for (const occurrence of ScheduledAppendInput.parse(event.payload).events)
      admitLoadedCodeRow(occurrence, landsAt);
    return;
  }
  if (
    event.type !== "events.iterate.com/itx/rewrite-rule-configured" &&
    event.type !== "events.iterate.com/itx/subscription-configured" &&
    event.type !== "events.iterate.com/itx/ingress-configured"
  )
    return;
  const payload = event.payload as { target?: unknown } | undefined;
  if (
    event.type === "events.iterate.com/itx/rewrite-rule-configured" &&
    payload &&
    Object.hasOwn(payload, "ifTarget")
  )
    throw codedError(
      "FORBIDDEN",
      "loaded code removes no row (`ifTarget`): the name would answer from beneath it again — write `target: null` to mask it",
    );
  const target = payload?.target;
  if (!target) return;
  // a live object is checked when it is lent; a copy target's path may be anywhere in the mind
  if (typeof target !== "string" && !Array.isArray(target)) return;
  const expression = normalizedItxExpression(target as ItxExpressionInput, { holes: true });
  if (isOwnLendRow(event, expression)) return;
  admitLoadedCodeExpression(expression, landsAt);
}

/** THE ONE ROW AT A LENT STUB THAT LOADED CODE WRITES: the row that `provide` and `subscribe`
 *  write for it when it lends a live object (../iterate-context.ts). A rule whose target is the
 *  stub under the rule's own match, or a subscription whose target is the stub under its own
 *  name: the `get` and its one key, with nothing after it. A stub under any other key is another
 *  lender's, which this context's rows may keep from its code; and an ingress row is written by
 *  neither verb. */
function isOwnLendRow(event: { type: string; payload?: unknown }, target: ItxExpression): boolean {
  const lent = builtInsGetStep(target, "rpcStubs");
  if (!lent || lent.length !== 2 || target.length !== 4) return false;
  const [, key] = lent;
  // the row's fields by name: a row that loaded code wrote may hold anything
  const fields = new Map<string, unknown>(Object.entries(Object(event.payload)));
  if (event.type === "events.iterate.com/itx/subscription-configured") {
    const name = fields.get("name");
    return typeof name === "string" && key === `subscription:${name}`;
  }
  if (event.type !== "events.iterate.com/itx/rewrite-rule-configured") return false;
  const match = fields.get("match");
  if (typeof match !== "string" && !Array.isArray(match)) return false;
  try {
    // as `provide` makes the key: one spelling for every spelling of the match
    return key === canonicalItxExpressionPrefix(match);
  } catch {
    return false;
  }
}

/** WHOSE ROWS ARE CHECKED: loaded code's, and those of a call that runs a stored row's target
 *  (`Caller.runsRow`). Loaded code may have written the row that runs, and the check on each row
 *  it writes does not see what two rows make together: a rule with a hole, and a call that fills
 *  it, are a row with a built-in target only when the call runs. No check of spellings closes
 *  that, so the row is checked here, where it is written. */
export function admitRowsOfCall(
  caller: Caller,
  events: readonly { type: string; payload?: unknown }[],
  landsAt: string,
): void {
  if (!caller.app && !caller.runsRow) return;
  for (const event of events) admitLoadedCodeRow(event, landsAt);
}

// While a context's table holds its bare `itx ⇒ null`, only a member's session (a principal) may
// re-point or remove it: anything else would bring back `cd`, and with it the whole mind.
export function refuseLiftingAJail(
  events: readonly StreamEventInput[],
  rules: Readonly<Record<string, ItxExpressionRewriteRule>>,
  caller: Caller,
): void {
  if (caller.principal || !rules.itx || rules.itx.target) return;
  for (const event of events) {
    if (event.type !== "events.iterate.com/itx/rewrite-rule-configured") continue;
    const payload = event.payload as { match: ItxExpressionPrefix; target: ItxExpression | null };
    if (payload.match.length === 1 && (payload.target || Object.hasOwn(payload, "ifTarget")))
      throw codedError(
        "FORBIDDEN",
        "this context is a jail (a bare `itx ⇒ null`): only a member's session re-points or removes it, never code",
      );
  }
}

// A bare `itx ⇒ cd(<self>)` row is a loop no depth budget can see: every hop is a fresh resolve.
export function refuseSelfLoopRow(
  row: { match: ItxExpression; target: ItxExpression | null },
  ownPath: string,
): void {
  if (row.match.length !== 1 || !row.target) return;
  const cdStep = row.target[1] === "builtins" ? row.target[2] : row.target[1];
  if (!Array.isArray(cdStep) || cdStep[0] !== "cd" || typeof cdStep[1] !== "string") return;
  if (resolveContextPath(ownPath, cdStep[1]) === ownPath)
    throw new Error(
      `a bare itx row may not name its own context: "itx ⇒ ${print(row.target, { holes: true })}" at ${JSON.stringify(ownPath)} would route every call back to itself`,
    );
}

export function builtInsGetStep(
  resolved: ItxExpression,
  registry: "facets" | "rpcStubs",
): [method: "get", name: string, ...args: unknown[]] | undefined {
  const getStep = resolved[3];
  return resolved[1] === "builtins" &&
    resolved[2] === registry &&
    Array.isArray(getStep) &&
    getStep[0] === "get" &&
    typeof getStep[1] === "string"
    ? (getStep as [method: "get", name: string, ...args: unknown[]])
    : undefined;
}

export function rpcStubKeysNamed(args: {
  rules: readonly ItxExpressionRewriteRule[];
  subscriptionTargets: Record<string, ItxExpression>;
  fetchRouteTargets: Record<string, ItxExpression>;
  implicitRoots: ReadonlySet<string>;
}): Set<string> {
  const { rules, subscriptionTargets, fetchRouteTargets, implicitRoots } = args;
  const keys = new Set<string>();
  const targets = [
    ...rules.flatMap((rule) => (rule.target ? [rule.target] : [])),
    ...Object.values(subscriptionTargets),
    ...Object.values(fetchRouteTargets),
  ];
  for (const target of targets) {
    const resolved = fixedPointOf(() => rules, target, implicitRoots);
    const getStep = resolved && builtInsGetStep(resolved, "rpcStubs");
    if (getStep) keys.add(getStep[1]);
  }
  return keys;
}

// Also how many bare links `rewriteRules.list()` follows: a list that stopped sooner would leave out
// names a call from the same context reaches.
export const REWRITE_BUDGET = 32;

// Behind a bare row that hops (`itx ⇒ itx.builtins.cd(path)`), that context's list minus what this
// one's rows claim. A bare null denies all: nothing implicit, nothing inherited.
export async function describeRewriteRules(args: {
  rules: readonly ItxExpressionRewriteRule[];
  implicitRoots: ReadonlySet<string>;
  path: string;
  depth: number;
  inherit: (path: string, depth: number) => Promise<RewriteRuleListEntry[]>;
}): Promise<RewriteRuleListEntry[]> {
  const { rules, implicitRoots, path: ownPath, depth } = args;
  const own = rules.map((rule): RewriteRuleListEntry => ({
    match: print(rule.match),
    target: rule.target && print(rule.target, { holes: true }),
    description: rule.description,
    context: ownPath,
  }));
  const claimed = new Set(own.map((row) => row.match));
  const implicit = (implicitHere: Iterable<string>): RewriteRuleListEntry[] =>
    [...implicitHere]
      .filter((root) => !claimed.has(`itx.${root}`))
      .map((root) => ({
        match: `itx.${root}`,
        target: `itx.builtins.${root}`,
        description: builtInRootDescriptions()[root],
        context: ownPath,
      }));
  const bare = rules.find((rule) => rule.match.length === 1);
  if (bare && !bare.target) return own;
  const rows = [...own, ...implicit(implicitRoots)];
  if (!bare?.target) return rows;
  let target: ItxExpression;
  try {
    target = resolveItxExpression(() => rules, bare.target, args.implicitRoots).at(-1)!;
  } catch (error) {
    if (errorCode(error) === "NO_ITX_EXPRESSION_MATCH") return rows;
    throw error;
  }
  if (target.length === 2 && target[1] === "builtins")
    return [
      ...rows,
      ...implicit(
        Object.keys(builtInRootDescriptions()).filter((root) => !implicitRoots.has(root)),
      ),
    ];
  const cdStep = target[2];
  if (
    depth <= 0 ||
    target.length !== 3 ||
    target[1] !== "builtins" ||
    !Array.isArray(cdStep) ||
    cdStep[0] !== "cd" ||
    typeof cdStep[1] !== "string"
  )
    return rows;
  const there = resolveContextPath(ownPath, cdStep[1]);
  if (there === ownPath) return rows;
  // An inherited row is shown iff a call spelled like it would reach that context: the most specific
  // own row claiming it is the link itself, and the link yields to no implicit row here.
  const forwarded = (spelling: string): boolean => {
    if (spelling === "itx") return false;
    let call: ItxExpression;
    try {
      call = parse(spelling);
    } catch {
      return false;
    }
    const root = itxExpressionStepName(call[1]);
    if (root && implicitRoots.has(root)) return false;
    return pickItxExpressionRewriteRule(rules, call)?.rule === bare;
  };
  const inherited = await args.inherit(there, depth - 1);
  return [...rows, ...inherited.filter((row) => forwarded(row.match))];
}

type ResolverReach = {
  recordLoopLimit: (path: string, cause: Cause, message: string) => void;
  snapshotOf: (path: string) => Promise<Pick<RuleSnapshot, "rules" | "readAt" | "expiresAt">>;
  located: (
    path: string,
    expression: ItxExpression,
    args: unknown[],
    caller: Caller,
  ) => Promise<unknown>;
  workersOf: (path: string, caller: Caller, hops: number, vouched: boolean) => unknown;
};

export class ItxExpressionResolver {
  // built on first use: a call routed to a context walks none of them
  get #builtIns(): Record<string, unknown> {
    return (this.#builtInsBuilt ??= this.#buildBuiltIns());
  }
  readonly #buildBuiltIns: () => Record<string, unknown>;
  #builtInsBuilt?: Record<string, unknown>;
  readonly #rewriteRules: (() => readonly ItxExpressionRewriteRule[]) | undefined;
  readonly #path: string;
  readonly #caller: () => Caller;
  readonly #reach: ResolverReach;

  constructor(args: {
    builtIns: Record<string, unknown> | (() => Record<string, unknown>);
    rewriteRules?: () => readonly ItxExpressionRewriteRule[];
    path: string;
    caller: () => Caller;
    reach: ResolverReach;
  }) {
    const { builtIns } = args;
    this.#buildBuiltIns = typeof builtIns === "function" ? builtIns : () => builtIns;
    this.#rewriteRules = args.rewriteRules;
    this.#path = args.path;
    this.#caller = args.caller;
    this.#reach = args.reach;
  }

  // On the input only: the rows a call rewrites through are the owner's grants and are never checked.
  #admit(expression: ItxExpression): void {
    const caller = this.#caller();
    // A trusted cd hop stamps `path` after the whole input passed this check; the rest now holds
    // the owner's rewrites, which are not rejected again at their destination.
    if (caller.app && !caller.path) admitLoadedCodeExpression(expression, this.#path);
  }

  resolve(call: ItxExpressionInput): ItxExpression[] {
    if (!this.#rewriteRules) throw new Error("a stateless resolver has no table of its own");
    const expression = normalizedItxExpression(call);
    this.#admit(expression);
    return resolveItxExpression(this.#rewriteRules, expression, implicitRootsAt(this.#path));
  }

  // A call that crosses a `cd` keeps resolving with the next context's table instead of being
  // forwarded, so no context sits on the path of another's traffic.
  // Live `extraArgs` fold into a call that ends in a name before resolving, so a mask refuses
  // `invoke("itx.kv.get", "k")` exactly as it refuses `itx.kv.get("k")`.
  async invoke(call: ItxExpressionInput, ...extraArgs: unknown[]): Promise<unknown> {
    return this.#invoked(call, extraArgs);
  }

  // THE ONE CALL THAT COMES WITH AN APPROVED ACT'S TEXT (`Caller.approvedAct`): the call that does
  // an act a member approved after its caller stopped waiting, or a call that another context
  // sent on after its approval. The text is for this call alone. It is given by hand, and the
  // caller that the walk and every call made on the way see does not carry it.
  async invokeApproved(
    approved: string,
    call: ItxExpressionInput,
    extraArgs: unknown[],
  ): Promise<unknown> {
    return this.#invoked(call, extraArgs, approved);
  }

  async #invoked(call: ItxExpressionInput, extraArgs: unknown[], approved?: string) {
    try {
      return (await this.#dispatch(call, extraArgs, approved)).value;
    } catch (error) {
      recordRefusal(error, (cause, message) =>
        this.#reach.recordLoopLimit(this.#path, cause, message),
      );
      throw error;
    }
  }

  // A CALL THAT NOBODY WAITS FOR IS REFUSED WHEN AN APPROVAL RULE NAMES IT. A subscription's
  // delivery reads its target's head here and then calls the head's function itself, past
  // `#dispatch`, so `#heldUntilApproved` never sees that call. There is no caller who could wait
  // for a member either: every batch of events would ask again. So a row whose target is a held
  // verb delivers nothing, and its delivery halts with this. `name` is what the delivery calls.
  async refuseHeldVerb(name: ItxExpression): Promise<void> {
    const gate = itxHost().acts;
    if (!gate) return;
    const verbRules = await gate.verbRules();
    if (verbRules.length === 0) return;
    // as a call of the name with one argument, which is what a delivery makes of it
    const { route, rules } = await this.#route(name, [null]);
    let table = rules;
    let called: ItxExpression;
    if (route.kind === "walked") called = route.fixedPoint;
    else {
      // sent on: asked with the table of the context it goes to
      table = (await this.#reach.snapshotOf(route.at)).rules;
      try {
        called = resolveItxExpression(() => table, route.expression, implicitRootsAt(route.at)).at(
          -1,
        )!;
      } catch {
        return;
      }
    }
    if (await this.#heldBy(verbRules, called, route.extraArgs, route.at, table))
      throw codedError(
        "PERMANENT_FAILURE",
        `${JSON.stringify(print(name))} waits for a member's approval when it is called, so a subscription does not deliver to it: nobody is there to wait`,
      );
  }

  // `validUntil`: until the first snapshot it read expires. `routedTo` moves when a rule re-points
  // what the target names.
  async evaluate(
    call: ItxExpression,
  ): Promise<{ value: unknown; validUntil: number; routedTo: string }> {
    const { value, validUntil, route } = await this.#dispatch(call, []);
    const ran = route.kind === "located" ? route.expression : route.fixedPoint;
    return { value, validUntil, routedTo: JSON.stringify([route.at, ran]) };
  }

  // A worker's name, routed to a rule whose target is exactly `itx.builtins.workers.get(spec)`; its
  // manifest counts only when that rule is the config pointer (`vouched`).
  async namedWorker(
    call: ItxExpressionInput,
  ): Promise<{ at: string; spec: unknown; vouched: boolean; validUntil: number }> {
    const name = normalizedItxExpression(call);
    admitWorkerName(name);
    const { route, rules, validUntil } = await this.#route(name, []);
    const getStep = route.kind === "walked" ? route.fixedPoint[3] : undefined;
    const publishing =
      route.kind === "walked"
        ? rules.filter(
            (rule) =>
              !!rule.target &&
              jsonEqual(withoutBuiltIns(rule.target), withoutBuiltIns(route.fixedPoint)),
          )
        : [];
    if (
      route.kind !== "walked" ||
      route.fixedPoint.length !== 4 ||
      route.fixedPoint[2] !== "workers" ||
      !Array.isArray(getStep) ||
      getStep[0] !== "get" ||
      publishing.length === 0
    )
      throw codedError(
        "NO_ITX_EXPRESSION_MATCH",
        `${JSON.stringify(print(name))} names no worker: no rule it resolves through is itx.builtins.workers.get(spec)`,
      );
    return {
      at: route.at,
      spec: getStep[1],
      vouched: publishing.some((rule) => isConfigPointerMatch(rule.match)),
      validUntil,
    };
  }

  // A snapshot may expire while the next is read: the route is resolved again, a bounded number of times.
  // `approved`: the text of the act that this call is said to be (`invokeApproved`).
  async #dispatch(call: ItxExpressionInput, extraArgs: unknown[], approved?: string) {
    for (let routes = 0; routes < SNAPSHOT_REREADS; routes++) {
      const { route, validUntil, rules } = await this.#route(call, extraArgs);
      if (Date.now() >= validUntil) continue;
      // Every call that is walked here, whoever walks it: a context's own object, or a resolver
      // with no object behind it (a script's, an agent's, loaded code's), which walks a worker's
      // verb and a portable root itself. A call that is sent on is walked, and so asked about,
      // where it arrives.
      if (route.kind === "walked") {
        const waited = !approved;
        approved = await this.#heldUntilApproved(route, rules, approved);
        // The wait is minutes long, and the table may have moved under it: the call is routed
        // again, and must still be the act the member approved.
        if (approved && waited) continue;
      }
      // An approved text goes on with a call that is sent on: the context where the call arrives
      // says whether the call still is that act.
      const value =
        route.kind === "located"
          ? await this.#reach.located(
              route.at,
              route.expression,
              route.extraArgs,
              approved ? { ...route.caller, approvedAct: approved } : route.caller,
            )
          : await this.#walk(route.builtIns, route.fixedPoint, route.extraArgs);
      return { value, validUntil, route };
    }
    throw unavailableError(
      "overloaded",
      `${JSON.stringify(print(normalizedItxExpression(call)))}: the rule snapshots it resolves through expired ${SNAPSHOT_REREADS} times before it could run`,
    );
  }

  // A VERB AN APPROVAL RULE NAMES WAITS FOR A MEMBER'S YES (./held-verbs.ts, the host's `acts`).
  // Asked by both readings of a rule's name (`#heldBy`), so every name for one function meets the
  // same rule. The platform's own calls are not held. An act that a member
  // approved after its caller stopped waiting is no platform's call: it comes with the approved
  // text (`invokeApproved`), and runs only when the call is still that act. A CALL THAT COMES WITH
  // AN APPROVED TEXT AND IS NOT HELD NOW IS REFUSED: its name went to a function that no rule
  // names, or its rule is gone, and the member read another call. Answers the act's text once a
  // member approved it, and nothing for a call that no rule names.
  async #heldUntilApproved(
    route: { fixedPoint: ItxExpression; extraArgs: unknown[]; at: string },
    rules: readonly ItxExpressionRewriteRule[],
    approved: string | undefined,
  ): Promise<string | undefined> {
    const gate = itxHost().acts;
    const caller = this.#caller();
    if (caller.platform) return undefined;
    const changed = (name: string) =>
      codedError(
        "FORBIDDEN",
        `${name} changed while it waited for a member's approval: call it again`,
      );
    const verbRules = gate ? await gate.verbRules() : [];
    const by =
      verbRules.length > 0
        ? await this.#heldBy(verbRules, route.fixedPoint, route.extraArgs, route.at, rules)
        : null;
    if (!gate || !by) {
      if (approved) throw changed(actOfText(approved)?.act || "the approved call");
      return undefined;
    }
    const { held } = by;
    if ("refused" in held) throw codedError("FORBIDDEN", held.refused);
    // The act's marks (iterate/acts `VerbAct`): the context that read its name, whether loaded
    // code asked, and what that context reads the name as now. The last is of the act's name, not
    // of the call as it is spelled: every spelling of one function is one act, and a late
    // approval, which calls the act's name, makes the same text.
    const named =
      (await by.read(normalizedItxExpression(held.act))) ?? calledNameOf(route.fixedPoint);
    const text = actText({
      ...held,
      at: by.readAt,
      ...(caller.app && { byLoadedCode: true as const }),
      ...(caller.runsRow && { byRow: true as const }),
      resolved: await sha256Hex(print(named)),
    });
    if (approved === text) return approved;
    if (approved) throw changed(held.act);
    const from = caller.path || this.#path;
    // The gate's facts are the platform's own, on the context it names.
    const record = (facts: { path: string; events: StreamEventInput[] }[]) =>
      Promise.all(
        facts.map(({ path, events }) =>
          this.#reach
            .located(path, ["itx", "builtins", ["append", ...events]], [], {
              principal: null,
              platform: true,
            })
            .catch((error: unknown) => reportIssue("approval.facts-not-recorded", error, { path })),
        ),
      );
    let answer = await gate.ask({ text, from });
    if (answer.state === "held") {
      await record(answer.facts);
      answer = await gate.ask({ text, from, wait: true });
    }
    if (answer.state === "free") return undefined;
    if (answer.state === "go") return text;
    await record(answer.facts);
    const where = `/secrets/approvals?digest=${answer.digest} on the platform's origin`;
    throw codedError(
      "FORBIDDEN",
      answer.state === "rejected"
        ? `${held.act}: ${answer.by} rejected this call: ${answer.reason} (${where})`
        : answer.state === "done"
          ? `${held.act}: this exact call was done before, for a member's one approval: a new call differs (${where})`
          : `${held.act} waits for a member's approval, at ${where}. It can be approved for a day. When it is, it is done then, and this context gets an event that says so (${ACT_DONE}): do not call it again.`,
      { digest: answer.digest, state: answer.state },
    );
  }

  // THE CALL AS AN ACT THAT A RULE HOLDS, AND WHO READ THE RULE'S NAME. A rule's name is read
  // twice. First by the table that resolved the call, the table of `at`. Then from the mind's
  // root, where a member writes it, through every context its rows cross (`#readFromRoot`): the
  // root's `itx.agents` is a facet of `/agents`, the call is walked there, and the table there has
  // no name `itx.agents`. `readAt` is the context whose table read the name that holds the call,
  // and `read` reads any name as that context does, at `at`.
  async #heldBy(
    verbRules: readonly ActRule[],
    called: ItxExpression,
    extraArgs: readonly unknown[],
    at: string,
    rules: readonly ItxExpressionRewriteRule[],
  ) {
    // A name is read twice, as it is written and as a call with a hole (`verbWithAHole`): the
    // second reading shows a row that fills in the call's arguments (`filledInOrName`).
    const readHere = (verb: ItxExpression) => {
      const read = (spelled: ItxExpression) => {
        try {
          return resolveItxExpression(() => rules, spelled, implicitRootsAt(at)).at(-1)!;
        } catch {
          return null;
        }
      };
      return filledInOrName(read(verb), read(verbWithAHole(verb)));
    };
    const readFromRoot = async (verb: ItxExpression) => {
      const [name, called] = await Promise.all([
        this.#readFromRoot(verb),
        this.#readFromRoot(verbWithAHole(verb)),
      ]);
      const here = (read: typeof name) => (read?.at === at ? read.fixedPoint : null);
      return filledInOrName(here(name), here(called));
    };
    const names: ItxExpression[] = [];
    const here = heldVerbOf(verbRules, called, extraArgs, (verb) => {
      names.push(verb);
      return readHere(verb);
    });
    if (here)
      return { held: here, readAt: at, read: async (verb: ItxExpression) => readHere(verb) };
    const fromRoot = new Map<string, ItxExpression>();
    for (const verb of names) {
      const read = await readFromRoot(verb);
      if (read) fromRoot.set(print(verb), read);
    }
    if (fromRoot.size === 0) return null;
    const held = heldVerbOf(
      verbRules,
      called,
      extraArgs,
      (verb) => fromRoot.get(print(verb)) ?? null,
    );
    return held ? { held, readAt: "/", read: readFromRoot } : null;
  }

  // WHERE A RULE'S NAME ENDS WHEN THE MIND'S ROOT READS IT, and what it is there: resolved by the
  // root's table and by the table of each context that a `cd` in a row sends it on to, as a call
  // of that name from the root is routed, without calling any of them. Null when a table on the
  // way has no row for it.
  async #readFromRoot(
    verb: ItxExpression,
  ): Promise<{ at: string; fixedPoint: ItxExpression } | null> {
    let at = "/";
    let entered = verb;
    // a row that sends a name back where it came from ends here, as a name that no rule reads
    for (let hops = 0; hops < 8; hops++) {
      const rules =
        at === this.#path && this.#rewriteRules
          ? this.#rewriteRules()
          : (await this.#reach.snapshotOf(at)).rules;
      let fixedPoint: ItxExpression;
      try {
        fixedPoint = resolveItxExpression(() => rules, entered, implicitRootsAt(at)).at(-1)!;
      } catch {
        return null;
      }
      const cdStep = fixedPoint[2];
      if (
        fixedPoint.length <= 3 ||
        !Array.isArray(cdStep) ||
        cdStep[0] !== "cd" ||
        typeof cdStep[1] !== "string"
      )
        return { at, fixedPoint };
      at = resolveContextPath("/", cdStep[1]);
      entered = ["itx", ...fixedPoint.slice(3)];
    }
    return null;
  }

  // Admitted whole, as its caller made it, then resolved through every context its chain crosses
  // without calling any of them. A located call's `Caller.path` marks its input as already admitted.
  async #route(call: ItxExpressionInput, extraArgs: unknown[]) {
    let expression = normalizedItxExpression(call);
    const last = expression.at(-1);
    if (extraArgs.length > 0 && typeof last === "string" && expression.length > 1) {
      expression = [...expression.slice(0, -1), [last, ...extraArgs]];
      extraArgs = [];
    }
    this.#admit(expression);
    const caller = this.#caller();
    const origin = caller.path || this.#path;
    const walked = (builtIns: Record<string, unknown>, fixedPoint: ItxExpression, at: string) =>
      ({ kind: "walked", builtIns, fixedPoint, extraArgs, at }) as const;
    const located = (there: string, target: ItxExpression, callerThere: Caller) =>
      ({ kind: "located", at: there, expression: target, extraArgs, caller: callerThere }) as const;
    const own = () => located(this.#path, expression, caller);
    let validUntil = Infinity;
    let readAt = Infinity;
    let at = this.#path;
    let entered = expression;
    let cause = caller.cause || newChain("a call");
    for (let hops = 0; ; hops++) {
      const liveRules = at === this.#path ? this.#rewriteRules : undefined;
      let fixedPoint: ItxExpression = ["itx", "builtins", ...withoutBuiltIns(entered)];
      let rules: readonly ItxExpressionRewriteRule[] = [];
      if (liveRules || !entersOwnRoot(entered)) {
        if (liveRules) rules = liveRules();
        else if (!isBuiltInsRooted(entered)) {
          const snapshot = await this.#reach.snapshotOf(at);
          validUntil = Math.min(validUntil, snapshot.expiresAt);
          readAt = Math.min(readAt, snapshot.readAt);
          rules = snapshot.rules;
        }
        try {
          fixedPoint = resolveItxExpression(() => rules, entered, implicitRootsAt(at)).at(-1)!;
        } catch (error) {
          if (errorCode(error) !== "NO_ITX_EXPRESSION_MATCH") throw error;
          if (hops === 0 && !liveRules) return { route: own(), validUntil, rules };
          // A refusal the snapshots gave stands only as long as they do. Refusing the config
          // pointer, which only a publication writes, means the mind has published no config.
          if (hops > 0 && error instanceof Error)
            Object.assign(error, {
              validUntil,
              readAt,
              ...(isConfigPointerMatch(entered) && { unpublishedConfig: true }),
            });
          throw error;
        }
        const cdStep = fixedPoint[2];
        if (fixedPoint.length > 3 && Array.isArray(cdStep) && cdStep[0] === "cd") {
          if (typeof cdStep[1] !== "string")
            throw codedError("INVALID_INPUT", `cd takes a path, got ${JSON.stringify(cdStep[1])}`);
          at = resolveContextPath(origin, cdStep[1]);
          entered = ["itx", ...fixedPoint.slice(3)];
          cause = crossingOneMore(cause, JSON.stringify(print(expression)));
          continue;
        }
      }
      const root = itxExpressionStepName(fixedPoint[2]) || "";
      const portable = roots().portable.has(root);
      const ownIdentity =
        IDENTITY_ROOTS.has(root) && at === this.#path && Object.hasOwn(this.#builtIns, root);
      // The worker the config pointer names is vouched for, so it loads that way at this context's
      // own hop 0 too.
      const vouched = root === "workers" && runsThePublishedConfig(rules, fixedPoint);
      const route =
        root === "workers" && (vouched || !(liveRules && hops === 0))
          ? walked(
              { workers: this.#reach.workersOf(at, { ...caller, path: origin }, hops, vouched) },
              fixedPoint,
              at,
            )
          : liveRules ||
              (portable && Object.hasOwn(this.#builtIns, root)) ||
              root === "cd" ||
              ownIdentity
            ? walked(this.#builtIns, fixedPoint, at)
            : hops > 0 && !portable
              ? located(at, entered, { ...caller, path: origin, cause })
              : own();
      return { route, validUntil, rules };
    }
  }

  // A session-holding value the walk steps past would hold its far end, and this actor, open until
  // the next deploy; the answer is the caller's unless it rejects.
  async #walk(
    builtIns: Record<string, unknown>,
    fixedPoint: ItxExpression,
    extraArgs: unknown[],
  ): Promise<unknown> {
    const rootName = itxExpressionStepName(fixedPoint[2]);
    const roots = () => Object.keys(builtIns).join(", ");
    if (!rootName)
      throw new Error(
        `"itx.builtins" names the reserved root — name a built-in under it (${roots()})`,
      );
    if (!Object.hasOwn(builtIns, rootName))
      throw codedError(
        "NO_ITX_EXPRESSION_MATCH",
        `no built-in ${JSON.stringify(rootName)} under itx.builtins (${roots()})`,
      );
    const rpcSessionsSteppedPast: unknown[] = [];
    try {
      const { value, receiver } = await walkSteps(
        { value: builtIns, receiver: undefined },
        fixedPoint.slice(2),
        rpcSessionsSteppedPast,
      );
      return extraArgs.length > 0
        ? await callOn(value, receiver, extraArgs)
        : await awaitAnswerReleasedIfRejected(value);
    } finally {
      releaseRpcSessions(rpcSessionsSteppedPast);
    }
  }
}
