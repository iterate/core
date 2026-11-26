// context-activity-stack.ts — A CONTEXT'S IN-MEMORY STACK OF LIVE ACTIVITIES.
//
// Activities represent what a context is actively doing right now (fetching an HTTP endpoint,
// running a script, waiting on an LLM response, messaging another agent, reading or committing a
// repo, calling an MCP server). The stack lives strictly in RAM on `IterateContextDurableObject`
// and on the open `AwakeSocket` attachment to `/awake`:
// - If the context sleeps, crashes, or evicts, both RAM and its `/awake` socket close together, so
//   stale activities can never stick in SQLite (`context_catalog`).
// - Open browser tabs subscribe via `itx.facets.get("activities").liveSnapshot()` and receive
//   `events.iterate.com/itx/live-state-changed` deltas from `LiveState`.
import { z } from "zod";
import { itxExpressionStepName, type ItxExpression } from "iterate/expression";
import { jsonEqual, resolveContextPath } from "iterate/lib";
import { LiveState, type LiveStateSink, type StreamEvent } from "iterate/stream/processor";
import { RUN_DEADLINE_MS } from "iterate/stream/run";
import type { Caller } from "../caller.ts";
import {
  CONTEXT_ACTIVITY_POPPED_TYPE,
  CONTEXT_ACTIVITY_PUSHED_TYPE,
  CONTEXT_ACTIVITY_STACK_LIMIT,
  ContextActivity,
  ContextActivityPoppedPayload,
  ContextActivityPushedEntry,
  ContextActivityPushedPayload,
} from "../stream/core-events.ts";
import { AWAKE_CONTEXT_PATH } from "./awake.ts";

export {
  CONTEXT_ACTIVITY_POPPED_TYPE,
  CONTEXT_ACTIVITY_PUSHED_TYPE,
  CONTEXT_ACTIVITY_STACK_LIMIT,
  ContextActivity,
  ContextActivityPoppedPayload,
  ContextActivityPushedEntry,
};

export const CONTEXT_ACTIVITIES_FACET = "activities";

const RUN_SETTLED_TYPE = "events.iterate.com/itx/run-settled";

const WebSearchInput = z.object({ query: z.string() });
const WaitFilterInput = z.object({ type: z.string() });

const LlmRequestedActivityPayload = z.object({
  model: z.string().min(1),
  purpose: z.string().optional(),
  expiresAtMs: z.number().finite().optional(),
});

const LlmEndedActivityPayload = z.object({
  llmRequestOffset: z.number().int().positive(),
});

const RunSettledActivityPayload = z.object({
  requestOffset: z.number().int().positive(),
});

/** RPC payload sent from `statelessResolverFor` to an awake context's `reportActivity`. */
export const ContextActivityReport = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("push"),
    entry: ContextActivityPushedEntry,
    createdAt: z.string().optional(),
    runOffset: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("pop"),
    key: z.string().min(1).max(120),
  }),
]);
export type ContextActivityReport = z.infer<typeof ContextActivityReport>;

type StoredContextActivity = {
  item: ContextActivity;
  runOffset?: number;
};

/** Whether `item` has not yet reached its `expiresAt` at `nowMs`. */
function isContextActivityLive(item: ContextActivity, nowMs: number): boolean {
  if (!item.expiresAt) return true;
  const expiresAtMs = Date.parse(item.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs > nowMs;
}

/** Active items from `items` at `nowMs`, preserving LIFO order (`stack[0]` is newest). */
export function activeContextActivities(
  items: readonly ContextActivity[] | undefined,
  nowMs = Date.now(),
): ContextActivity[] {
  if (!items || items.length === 0) return [];
  return items.filter((item) => isContextActivityLive(item, nowMs));
}

function toWireActivity(entry: ContextActivityPushedEntry, createdAt: string): ContextActivity {
  const baseMs = Date.parse(createdAt);
  const computedExpiresAt =
    entry.expiresAt ||
    (entry.ttlMs !== undefined && Number.isFinite(baseMs)
      ? new Date(baseMs + entry.ttlMs).toISOString()
      : undefined);
  return {
    key: entry.key,
    text: entry.text,
    icon: entry.icon,
    url: entry.url,
    tags: entry.tags?.length ? entry.tags : undefined,
    pushedAt: createdAt,
    expiresAt: computedExpiresAt,
  };
}

function runOffsetOfSource(
  source: StreamEvent["source"] | undefined,
  ownPath: string,
): number | undefined {
  const run = source?.onBehalfOf?.run;
  if (!run) return undefined;
  const prefix = `${ownPath}@`;
  if (!run.startsWith(prefix)) return undefined;
  const parsed = Number.parseInt(run.slice(prefix.length), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export class ContextActivityTracker {
  readonly #liveState: LiveState<ContextActivity[]>;
  readonly #onChanged: (() => void) | undefined;
  #stack: StoredContextActivity[] = [];

  constructor(deps: { sink: LiveStateSink; onChanged?: () => void }) {
    this.#liveState = new LiveState<ContextActivity[]>(deps.sink, CONTEXT_ACTIVITIES_FACET, []);
    this.#onChanged = deps.onChanged;
  }

  push(
    entry: ContextActivityPushedEntry,
    options: { createdAt?: string; runOffset?: number; nowMs?: number } = {},
  ): void {
    const nowMs = options.nowMs ?? Date.now();
    const createdAt = options.createdAt || new Date(nowMs).toISOString();
    const item = toWireActivity(entry, createdAt);
    const nextEntry: StoredContextActivity =
      options.runOffset !== undefined ? { item, runOffset: options.runOffset } : { item };
    this.#stack = [
      nextEntry,
      ...this.#stack.filter(
        (existing) => existing.item.key !== item.key && isContextActivityLive(existing.item, nowMs),
      ),
    ].slice(0, CONTEXT_ACTIVITY_STACK_LIMIT);
    this.#sync(nowMs);
  }

  pop(target: ContextActivityPoppedPayload, nowMs = Date.now()): void {
    if ("key" in target) {
      this.#stack = this.#stack.filter(
        (entry) => entry.item.key !== target.key && isContextActivityLive(entry.item, nowMs),
      );
    } else if ("keys" in target) {
      const keys = new Set(target.keys);
      this.#stack = this.#stack.filter(
        (entry) => !keys.has(entry.item.key) && isContextActivityLive(entry.item, nowMs),
      );
    } else {
      const tag = target.tag;
      this.#stack = this.#stack.filter(
        (entry) => !entry.item.tags?.includes(tag) && isContextActivityLive(entry.item, nowMs),
      );
    }
    this.#sync(nowMs);
  }

  clear(): void {
    if (this.#stack.length === 0 && this.#liveState.get().length === 0) return;
    this.#stack = [];
    this.#liveState.set([]);
    this.#onChanged?.();
  }

  /** Folds committed stream events (both durable and ephemeral) into the live stack. */
  committed(events: readonly StreamEvent[], ownPath: string, nowMs = Date.now()): void {
    let touched = false;
    for (const event of events) {
      if (event.type === CONTEXT_ACTIVITY_PUSHED_TYPE) {
        const parsed = ContextActivityPushedPayload.safeParse(event.payload);
        if (!parsed.success) continue;
        const entries = "items" in parsed.data ? parsed.data.items : [parsed.data];
        const runOffset = runOffsetOfSource(event.source, ownPath);
        for (const entry of entries) {
          const item = toWireActivity(entry, event.createdAt);
          const stored: StoredContextActivity =
            runOffset !== undefined ? { item, runOffset } : { item };
          this.#stack = [
            stored,
            ...this.#stack.filter((existing) => existing.item.key !== item.key),
          ];
        }
        if (this.#stack.length > CONTEXT_ACTIVITY_STACK_LIMIT)
          this.#stack = this.#stack.slice(0, CONTEXT_ACTIVITY_STACK_LIMIT);
        touched = true;
        continue;
      }
      if (event.type === CONTEXT_ACTIVITY_POPPED_TYPE) {
        const parsed = ContextActivityPoppedPayload.safeParse(event.payload);
        if (!parsed.success) continue;
        const popData = parsed.data;
        if ("key" in popData) {
          this.#stack = this.#stack.filter((entry) => entry.item.key !== popData.key);
        } else if ("keys" in popData) {
          const keys = new Set(popData.keys);
          this.#stack = this.#stack.filter((entry) => !keys.has(entry.item.key));
        } else {
          this.#stack = this.#stack.filter((entry) => !entry.item.tags?.includes(popData.tag));
        }
        touched = true;
        continue;
      }
      if (event.type === RUN_SETTLED_TYPE) {
        const parsed = RunSettledActivityPayload.safeParse(event.payload);
        if (!parsed.success) continue;
        const before = this.#stack.length;
        this.#stack = this.#stack.filter((entry) => entry.runOffset !== parsed.data.requestOffset);
        if (this.#stack.length !== before) touched = true;
        continue;
      }
      if (event.type === "events.iterate.com/llm-request/requested") {
        const parsed = LlmRequestedActivityPayload.safeParse(event.payload);
        if (!parsed.success) continue;
        const { model, purpose, expiresAtMs } = parsed.data;
        const shortModel = (model.split("/").at(-1) || model).slice(0, 60);
        const verb = purpose === "summary" ? "Summarizing context" : "Thinking";
        const icon = model.startsWith("anthropic/") ? "claude" : "✨";
        const item = toWireActivity(
          {
            key: `llm:${String(event.offset)}`,
            text: `${verb} · ${shortModel}`.slice(0, 160),
            icon,
            tags: ["llm"],
            ...(expiresAtMs !== undefined
              ? { expiresAt: new Date(expiresAtMs).toISOString() }
              : { ttlMs: 180_000 }),
          },
          event.createdAt,
        );
        this.#stack = [
          { item },
          ...this.#stack.filter((existing) => existing.item.key !== item.key),
        ].slice(0, CONTEXT_ACTIVITY_STACK_LIMIT);
        touched = true;
        continue;
      }
      if (
        event.type === "events.iterate.com/llm-request/settled" ||
        event.type === "events.iterate.com/llm-request/cancelled"
      ) {
        const parsed = LlmEndedActivityPayload.safeParse(event.payload);
        if (!parsed.success) continue;
        const targetKey = `llm:${String(parsed.data.llmRequestOffset)}`;
        const before = this.#stack.length;
        this.#stack = this.#stack.filter((entry) => entry.item.key !== targetKey);
        if (this.#stack.length !== before) touched = true;
      }
    }
    if (!touched) return;
    this.#stack = this.#stack.filter((entry) => isContextActivityLive(entry.item, nowMs));
    this.#sync(nowMs);
  }

  active(nowMs = Date.now()): ContextActivity[] {
    if (this.#stack.some((entry) => !isContextActivityLive(entry.item, nowMs))) {
      this.#stack = this.#stack.filter((entry) => isContextActivityLive(entry.item, nowMs));
      this.#sync(nowMs);
    }
    return this.#liveState.get();
  }

  liveSnapshot(nowMs = Date.now()): { rev: number; state: ContextActivity[] } {
    this.active(nowMs);
    return this.#liveState.snapshot();
  }

  #sync(nowMs: number): void {
    const wire = this.#stack
      .filter((entry) => isContextActivityLive(entry.item, nowMs))
      .map((entry) => entry.item);
    const previous = this.#liveState.get();
    if (jsonEqual(previous, wire)) return;
    this.#liveState.set(wire);
    this.#onChanged?.();
  }
}

let nextActivitySeq = 0;
function mintActivityKey(prefix: string): string {
  nextActivitySeq = (nextActivitySeq + 1) % 1_000_000_000;
  return `${prefix}:${String(nextActivitySeq)}`;
}

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function cleanHttpTarget(rawUrl: string): {
  host: string;
  shortPath: string;
  cleanUrl: string;
} | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    const shortPath =
      parsed.pathname && parsed.pathname !== "/" ? truncateText(parsed.pathname, 36) : "";
    // Strips userinfo, query parameters, and hash fragments so credentials/tokens never enter live state.
    const cleanUrl = `${parsed.origin}${parsed.pathname}`.slice(0, 500);
    return { host: parsed.hostname, shortPath, cleanUrl };
  } catch {
    return null;
  }
}

/** Builds the live activity item for an outbound `itx.fetch` / egress call. */
export function describeFetchActivity(
  request: { url: string; method?: string },
  options?: { signFor?: string },
): ContextActivityPushedEntry | null {
  const target = cleanHttpTarget(request.url);
  if (!target) return null;
  const method = (request.method || "GET").toUpperCase();
  const label = options?.signFor
    ? `Calling ${options.signFor}${target.shortPath}`
    : method === "GET" || method === "HEAD"
      ? `Fetching ${target.host}${target.shortPath}`
      : `${method} ${target.host}${target.shortPath}`;
  return {
    key: mintActivityKey("fetch"),
    text: truncateText(label, 160),
    url: target.cleanUrl,
    tags: ["web"],
    ttlMs: 60_000,
  };
}

/** Builds the live activity item for an `itx.run` script execution on this context. */
export function describeScriptRunActivity(requestOffset: number): {
  entry: ContextActivityPushedEntry;
  runOffset: number;
} {
  return {
    entry: {
      key: `itx:run:${String(requestOffset)}`,
      text: "Running script",
      icon: "code",
      tags: ["code"],
      ttlMs: RUN_DEADLINE_MS,
    },
    runOffset: requestOffset,
  };
}

const PASSIVE_CONTEXT_ROOTS: ReadonlySet<string> = new Set([
  "whoami",
  "rewriteRules",
  "subscriptions",
  "schedules",
  "contexts",
  "url",
  "members",
  "readEvents",
]);

const PASSIVE_FACET_METHODS: ReadonlySet<string> = new Set([
  "snapshot",
  "liveSnapshot",
  "listPublicMethods",
]);

/** Builds a concise live activity item for an outbound `itx` expression call, or `null` for
 *  local housekeeping, passive reads, or calls already covered by `fetch` / `run` hooks. */
export function describeItxCallActivity(
  expression: ItxExpression,
  ownPath: string,
  caller: Pick<Caller, "platform" | "runsRow" | "libraryHop" | "path">,
): ContextActivityPushedEntry | null {
  if (caller.platform || caller.runsRow || caller.libraryHop) return null;
  const steps =
    expression[0] === "itx" && expression[1] === "builtins"
      ? expression.slice(2)
      : expression.slice(1);
  if (steps.length === 0) return null;

  const first = steps[0]!;
  const root = itxExpressionStepName(first);
  if (!root || PASSIVE_CONTEXT_ROOTS.has(root)) return null;
  // Local `fetch` and `run` have dedicated hooks (`describeFetchActivity`, `describeScriptRunActivity`).
  if (root === "fetch" || root === "run") return null;

  const origin = caller.path || ownPath;

  if (root === "agents") {
    return describeAgentsCall(steps.slice(1), origin);
  }
  if (root === "connectToMcp") {
    const rawUrl = Array.isArray(first) && typeof first[1] === "string" ? first[1] : undefined;
    const target = rawUrl ? cleanHttpTarget(rawUrl) : null;
    const hostLabel = target ? ` ${target.host}` : "";
    return {
      key: mintActivityKey("mcp"),
      text: truncateText(`Calling MCP${hostLabel}`, 160),
      icon: "mcp",
      ...(target && { url: target.cleanUrl }),
      tags: ["mcp"],
      ttlMs: 120_000,
    };
  }
  if (root === "repos" || root === "sandboxes" || root === "workspaces") {
    return describeEntityCollectionCall(root, steps.slice(1), origin);
  }
  if (root === "git") {
    const verbStep = steps[1];
    if (!Array.isArray(verbStep)) return null;
    return {
      key: mintActivityKey("git"),
      text: "Committing to git remote",
      icon: "code",
      tags: ["code", "git"],
      ttlMs: 60_000,
    };
  }
  if (root === "files") {
    const second = steps[1];
    const third = steps[2];
    if (!Array.isArray(second) || second[0] !== "get" || typeof second[1] !== "string") return null;
    if (!Array.isArray(third)) return null;
    const verb = third[0];
    if (verb === "url" || verb === "head") return null;
    const fileLabel = truncateText(second[1], 48);
    const action = verb === "put" ? "Writing" : verb === "delete" ? "Deleting" : "Reading";
    return {
      key: mintActivityKey("files"),
      text: `${action} file ${fileLabel}`,
      icon: "code",
      tags: ["files"],
      ttlMs: 60_000,
    };
  }
  if (root === "ai") {
    const second = steps[1];
    if (!Array.isArray(second)) return null;
    const verb = second[0];
    if (verb === "models") return null;
    if (verb === "websearch") {
      const query = WebSearchInput.safeParse(second[1]).data?.query.trim() || "";
      return {
        key: mintActivityKey("search"),
        text: query ? truncateText(`Searching web: ${query}`, 160) : "Searching web",
        icon: "search",
        tags: ["search", "web"],
        ttlMs: 60_000,
      };
    }
    const modelArg = typeof second[1] === "string" ? second[1].split("/").at(-1) : undefined;
    return {
      key: mintActivityKey("ai"),
      text: truncateText(modelArg ? `Running AI · ${modelArg}` : `Running AI · ${verb}`, 160),
      icon: "✨",
      tags: ["ai"],
      ttlMs: 120_000,
    };
  }
  if (root === "browser") {
    if (steps.length < 2) return null;
    return {
      key: mintActivityKey("browser"),
      text: "Browsing web page",
      icon: "web",
      tags: ["web", "browser"],
      ttlMs: 120_000,
    };
  }
  if (root === "waitForEvent") {
    const filter = Array.isArray(first) ? first[1] : undefined;
    const type = WaitFilterInput.safeParse(filter).data?.type;
    if (type === RUN_SETTLED_TYPE) return null;
    const shortType = type?.startsWith("events.iterate.com/")
      ? type.slice("events.iterate.com/".length)
      : type;
    return {
      key: mintActivityKey("wait"),
      text: truncateText(shortType ? `Waiting for ${shortType}` : "Waiting for event", 160),
      tags: ["itx"],
      ttlMs: 120_000,
    };
  }
  if (root === "cd" && Array.isArray(first) && typeof first[1] === "string") {
    return describeCrossContextCall(resolveContextPath(origin, first[1]), steps.slice(1), ownPath);
  }
  return null;
}

function describeAgentsCall(
  rest: ItxExpression,
  origin: string,
): ContextActivityPushedEntry | null {
  const [first, second] = rest;
  if (!Array.isArray(first)) return null;
  const method = first[0];
  if (method === "list" || method === "at") return null;
  const rawTarget = typeof first[1] === "string" ? first[1] : undefined;
  if (!rawTarget) return null;
  const targetPath = resolveContextPath(origin, rawTarget);
  if (method === "create") {
    return {
      key: mintActivityKey("agent"),
      text: truncateText(`Starting agent ${targetPath}`, 160),
      icon: "agent",
      url: targetPath.slice(0, 500),
      tags: ["agent"],
      ttlMs: 60_000,
    };
  }
  if (method === "delete") {
    return {
      key: mintActivityKey("agent"),
      text: truncateText(`Deleting agent ${targetPath}`, 160),
      icon: "agent",
      url: targetPath.slice(0, 500),
      tags: ["agent"],
      ttlMs: 60_000,
    };
  }
  if (method === "get" && Array.isArray(second)) {
    const action = second[0];
    const label =
      action === "message"
        ? `Messaging ${targetPath}`
        : action === "recent"
          ? `Reading ${targetPath}`
          : `Calling ${targetPath} · ${action}`;
    return {
      key: mintActivityKey("agent"),
      text: truncateText(label, 160),
      icon: "agent",
      url: targetPath.slice(0, 500),
      tags: ["agent"],
      ttlMs: 60_000,
    };
  }
  return null;
}

function describeEntityCollectionCall(
  collection: "repos" | "sandboxes" | "workspaces",
  rest: ItxExpression,
  origin: string,
): ContextActivityPushedEntry | null {
  const [first, second, third] = rest;
  if (!Array.isArray(first)) return null;
  const method = first[0];
  if (method === "list") return null;
  const rawTarget = typeof first[1] === "string" ? first[1] : undefined;
  if (!rawTarget) return null;
  const targetPath = resolveContextPath(origin, rawTarget);
  const tag =
    collection === "repos" ? "repo" : collection === "sandboxes" ? "sandbox" : "workspace";
  if (method === "create" || method === "delete") {
    const verbLabel = method === "create" ? "Creating" : "Deleting";
    return {
      key: mintActivityKey(tag),
      text: truncateText(`${verbLabel} ${targetPath}`, 160),
      icon: "code",
      url: targetPath.slice(0, 500),
      tags: ["code", tag],
      ttlMs: 60_000,
    };
  }
  if (method !== "get" || !second) return null;
  const stepName = itxExpressionStepName(second) || "";
  if (!stepName || PASSIVE_FACET_METHODS.has(stepName)) return null;
  if (second === "container" && !Array.isArray(third)) return null;
  const detail =
    second === "container" && Array.isArray(third) ? `container.${third[0]}` : stepName;
  const repoLabel =
    collection === "repos"
      ? stepName === "commitFiles"
        ? `Committing to ${targetPath}`
        : stepName === "pull" || stepName === "push"
          ? `Syncing ${targetPath}`
          : stepName === "readFile"
            ? `Reading ${targetPath}`
            : `${targetPath} · ${detail}`
      : `${targetPath} · ${detail}`;
  return {
    key: mintActivityKey(tag),
    text: truncateText(repoLabel, 160),
    icon: "code",
    url: targetPath.slice(0, 500),
    tags: ["code", tag],
    ttlMs: collection === "sandboxes" ? 300_000 : 60_000,
  };
}

function describeCrossContextCall(
  targetPath: string,
  rest: ItxExpression,
  ownPath: string,
): ContextActivityPushedEntry | null {
  if (targetPath === ownPath || targetPath === AWAKE_CONTEXT_PATH || rest.length === 0) return null;
  const first = rest[0]!;
  const root = itxExpressionStepName(first);
  if (!root || PASSIVE_CONTEXT_ROOTS.has(root)) return null;
  if (root === "processors" && Array.isArray(rest[1]) && rest[1][0] === "list") return null;
  if (root === "facets") {
    const getStep = rest[1];
    const callStep = rest[2];
    if (!Array.isArray(getStep) || !callStep) return null;
    const facetMethod = itxExpressionStepName(callStep) || "";
    if (PASSIVE_FACET_METHODS.has(facetMethod)) return null;
  }
  // A bare handle step with no call on the end returns a handle synchronously without remote work.
  const last = rest.at(-1)!;
  if (!Array.isArray(last)) return null;

  const isAgent = targetPath.startsWith("/agents/");
  const label =
    root === "run"
      ? `Running script on ${targetPath}`
      : root === "append" && isAgent
        ? `Messaging ${targetPath}`
        : `Calling ${targetPath} · ${root}`;
  return {
    key: mintActivityKey(isAgent ? "agent" : "cd"),
    text: truncateText(label, 160),
    ...(isAgent && { icon: "agent" }),
    url: targetPath.slice(0, 500),
    tags: [isAgent ? "agent" : "itx"],
    ttlMs: root === "run" ? RUN_DEADLINE_MS : 60_000,
  };
}

/** Pushes `entry` before `work()` and pops its key when `work()` settles. */
export async function withTrackedActivity<T>(
  entry: ContextActivityPushedEntry | null,
  hooks: {
    push: (entry: ContextActivityPushedEntry) => void;
    pop: (key: string) => void;
  },
  work: () => Promise<T>,
): Promise<T> {
  if (!entry) return work();
  hooks.push(entry);
  try {
    return await work();
  } finally {
    hooks.pop(entry.key);
  }
}
