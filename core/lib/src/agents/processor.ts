// processor.ts — THE AGENT PROCESSOR: the reduce, the birth and death sagas, the debounced turn
// loop, interrupts, expiry, retries, breakers and compaction, with each request built for OpenAI's
// prompt cache, after Pi 1.0 and Pi Durable. render.ts says how the input stays append-only; this
// loop records what that needs: the calls of the one tool, `run({ status, script })`, the
// standing sections' changes (`#syncSections`) and the response's own items.
//
// - a message that arrives while this loop's own script is still running waits for its result
//   (up to HOLD_FOR_RUN_MS), so a call is always followed by its output;
// - every request's usage carries cache writes and its dollar cost (pricing.ts); a compaction's too.
//
// The event log spells an answer's content as its prose plus the call rendered as a `<codemode>`
// block, the format the Agents app, the relays and voice read.
import { z } from "zod";
import { bytesToBase64, errorCode } from "../lib.ts";
import {
  type ConsumedEvent,
  type EmittedEventInput,
  type ProcessEventArgs,
  type ReduceArgs,
  StreamProcessor,
} from "../stream/processor.ts";
import type { IterateContextApi } from "../api.ts";
import { parseCodemodeResponse } from "./codemode-format.ts";
import { formatScriptDuration, renderScriptSettlement } from "./result-render.ts";
import {
  classifyScriptResult,
  envelopeLoader,
  guardPreamble,
  pinnedEntryThrew,
  pinnedEntryThrewNote,
  preambleEntryQuarantined,
  preambleEntrySet,
  preambleSection,
  RETAINED_SCRIPT_RESULTS,
  wrapScript,
} from "./results-preamble.ts";
import {
  type AgentInputGate,
  isForeignAgentFact,
  isOtherContext,
  trustBoundary,
} from "./message.ts";
import { standingFileSection, standingInstructionFiles } from "./standing-instructions.ts";
import { AgentContract, type AgentState, type LlmUsage } from "./contract.ts";
import { AGENT_COMPACTION_PROMPT, DEFAULT_AGENT_SYSTEM_PROMPT } from "./system-prompt.ts";
import {
  answerText,
  buildResponsesInput,
  type InputItem,
  messageText,
  OutputItem,
  type RenderItem,
  RUN_TOOL,
  sectionChanges,
  stableCapabilityTree,
} from "./render.ts";
import { requestCostUsd } from "./pricing.ts";

/** THE AI GATEWAY the agent's model calls go through — `default`, the gateway Cloudflare creates on
 *  an account's first authenticated request; unified billing pays the provider, no key anywhere. A
 *  property of the code, not of a deployment. */
const AI_GATEWAY_ID = "default";
/** How long a new message waits for this loop's own running script before a turn starts anyway:
 *  the call's result then comes back before the message is read, so the call is followed by its
 *  output and nothing in the prompt has to move. A script still running after this is answered
 *  with "no result yet", and its result arrives later as its own message (render.ts). */
const HOLD_FOR_RUN_MS = 20_000;
/** THE IDLE SUMMARIES' instructions: the compaction prompt (../system-prompt.ts) with a cap, the
 *  pending asks and the exact identifiers. The first summary, and a merge of summaries that grew
 *  too long, carries everything forward; every other one summarizes only what happened after the
 *  earlier summaries, which stay word for word, because a summary rewritten from the summary
 *  before it loses facts. At the agent's own reasoning effort: the effort is part of the
 *  provider's cache key. */
const IDLE_SUMMARY_PROMPT = `${AGENT_COMPACTION_PROMPT}

If the history above begins with earlier summaries, carry all of their facts forward, updated. End with two short lists: PENDING (every open item and every question awaiting someone's answer, with who and what next) and IDENTIFIERS (exact ids, threads, paths, kv keys, amounts and dates). Keep it all under 1,500 words.`;
const IDLE_SUMMARY_SINCE_PROMPT = `${AGENT_COMPACTION_PROMPT}

The earlier summaries above stay in your context word for word, so do not repeat anything in them. Summarize only what happened after them, the same way, and say where it updates or supersedes them. End with two short lists: PENDING and IDENTIFIERS (only new or changed ones). Keep it under 1,000 words.`;

/** A KEEP-WARM PING's input after the request's own: it asks for nothing, and the answer is dropped. */
const KEEP_WARM_PROMPT =
  "[Keep-warm request from the platform, not from anyone: it only keeps this conversation in the prompt cache. Do nothing and reply with exactly: ok]";

/** A voice call's agent: its call is over once it goes quiet, so it neither pings nor summarizes. */
const isVoiceCall = (path: string) => path.startsWith("/agents/voice/");
/** A long-lived agent (`/agents/<name>`), which pings to keep its history cached; a task's
 *  subagent or a thread goes cold, with an idle summary when it is worth one. */
export const keepsWarm = (path: string) => /^\/agents\/[^/]+$/.test(path) && !isVoiceCall(path);

/** The conversation after the newest summary, in tokens, estimated from its characters: what an
 *  idle summary would take out of the next wake-up's uncached input. */
export function historyTokensSinceSummary(state: AgentState): number {
  const cutoff = Math.max(
    0,
    ...state.contextItems.flatMap((item) =>
      item.compaction ? [item.compaction.replacesHistoryThrough] : [],
    ),
  );
  const chars = state.contextItems
    .filter((item) => item.role !== "system" && !item.compaction && item.offset > cutoff)
    .reduce((sum, item) => sum + item.content.length, 0);
  return Math.round(chars / 3.6);
}

/** What an idle check does at `now`: nothing if anything happened since the request it names (that
 *  is no longer the newest request, or something is open, running or waiting, or a summary covers
 *  it); a ping while the keep-warm window lasts past the next check; then a summary, when enough
 *  history came after the newest one to be worth it. */
export function idleAction(
  state: AgentState,
  check: { afterRequestOffset: number; inputTokens: number; keepWarmUntil?: string },
  now: number,
): "keep-warm" | "compact" | undefined {
  if (!quietSince(state, check.afterRequestOffset)) return undefined;
  if (check.keepWarmUntil && now + state.config.keepWarmEveryMs <= Date.parse(check.keepWarmUntil))
    return "keep-warm";
  return historyTokensSinceSummary(state) >= state.config.idleCompactionMinNewTokens
    ? "compact"
    : undefined;
}

/** Nothing happened since the request at `requestOffset`, and no summary covers it. */
function quietSince(state: AgentState, requestOffset: number): boolean {
  const newest = Math.max(
    0,
    ...state.contextItems.filter((item) => item.stamp).map((item) => item.offset),
  );
  return (
    newest === requestOffset &&
    !state.openRequest &&
    !state.pendingLlmRequestTrigger &&
    Object.keys(state.pendingRuns).length === 0 &&
    !state.paused &&
    !state.deletion &&
    !state.contextItems.some(
      (item) =>
        item.compaction &&
        (item.compaction.replacesHistoryThrough >= requestOffset || item.offset > requestOffset),
    )
  );
}

/** Why an input is OWED AN ANSWER, or null when its turn may end in silence: a job an agent
 *  scheduled (an input a schedule delivers, set by a script rather than by the project's own code
 *  at `/`, whose WhatsApp reviews mostly end in silence), or words their writer marked
 *  `answerOwed`; `answerOwed: false` opts a scheduled input out. */
export function answerOwedFor(event: {
  payload: { answerOwed?: boolean };
  source: { origin?: string; schedule?: { key: string } };
}): string | null {
  const { answerOwed } = event.payload;
  const { schedule, origin } = event.source;
  if (answerOwed === false || !(answerOwed || (schedule && origin !== "/"))) return null;
  return schedule ? `the scheduled job "${schedule.key}"` : "the message";
}

/** The result note of a script that returned nothing while its turn still owes an answer: the
 *  plain note, then why the turn goes on once more. A deliberate silence stays one empty answer
 *  away. */
function answerReminder(note: string, owed: { offset: number; why: string }): string {
  return `${note} That would end your turn, but nothing has been said yet for ${owed.why} @${String(owed.offset)}, which expects an answer (words written beside a call do not count: some readers hold them back). If it needs a message or a report, write it now as your final message, with no call. If it needs none, or \`sendMessage\` already sent it, reply with nothing.`;
}

/** A script body that is already a complete async function, passed through unwrapped
 *  (codemode-format.ts's rule). */
const ASYNC_FUNCTION_BODY_RE = /^(?:async\s*(?:function|\()|\(?async\s*\()/;
/** The provider's prompt-cache key is at most this long (Pi: clampOpenAIPromptCacheKey). */
const PROMPT_CACHE_KEY_MAX = 64;

/** The cache key a request is routed with: the agent's path, except a voice call's agent, which
 *  shares its client's key (`voice/<client>`) so calls with the same person share their cached head
 *  (render.ts OWN_SECTIONS). */
export function promptCacheKey(path: string): string {
  const voice = /^\/agents\/voice\/([^/]+)\/[^/]+$/.exec(path);
  const key = voice ? `voice/${voice[1]}` : path;
  return Array.from(key).slice(0, PROMPT_CACHE_KEY_MAX).join("");
}

/** The failure backoff, folded into the debounce window: doubling from the policy's base per
 *  consecutive failure, capped at its ceiling; nothing after a success. */
function retryBackoffMs(state: Pick<AgentState, "consecutiveLlmFailures" | "config">): number {
  const { backoffBaseMs, backoffMaxMs } = state.config.llmRequestRetryPolicy;
  if (state.consecutiveLlmFailures <= 0) return 0;
  return Math.min(2 ** (state.consecutiveLlmFailures - 1) * backoffBaseMs, backoffMaxMs);
}

/** The request stamp a newly opened request adds to the conversation: the moment it was asked for,
 *  in UTC (a person's own zone is theirs to state: AGENTS.md, a role file). It stays in place, so
 *  the prompt a provider cached stays a prefix. */
function requestStamp(createdAt: string): string {
  return `Requested at: ${createdAt} (UTC)`;
}

/** The coalescing window: how much streamed text rides one `llm-response-frame` append — ~7
 *  repaints a second, and one commit per window instead of per token. */
const FRAME_WINDOW_MS = 150;
/** A window whose text grew past this lands early rather than as one oversized append. */
const FRAME_WINDOW_MAX_CHARS = 64_000;
/** The idle watchdog: a stream that carries nothing for this long fails the attempt, so a stalled
 *  provider never wedges a turn until its expiry. Short, because a person may be waiting on the
 *  line: a low-effort reasoning model streams within seconds, and a stall is retried at once. */
const STREAM_IDLE_BUDGET_MS = 25_000;

/** The context windows of the models this loop names; a conservative floor for the rest. OpenAI's
 *  figures are the operating window (where pricing doubles), not the documented one. */
function contextWindowTokens(model: string): number {
  if (/^gpt-(6|5)/.test(model)) return 272_000;
  if (model.startsWith("@cf/meta/llama-4-scout")) return 131_072;
  return 128_000;
}

/** The abort reason an interruption carries, so the runner tells it from a clock. */
class InterruptedError extends Error {
  constructor() {
    super("interrupted by the person's next words");
    this.name = "InterruptedError";
  }
}

/** An append that may LOSE to an earlier one under the same idempotency key with a different
 *  body — the settle of a request an interruption already settled — and then appends nothing:
 *  the first settlement stands, the later one was never a fact. */
async function appendUnlessLost(
  append: AgentArgs["append"],
  ...events: AgentEmitted[]
): Promise<void> {
  try {
    await append(...events);
  } catch (error) {
    if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
  }
}

// ── the model call's wire shapes ──

/** The usage a provider reports, both dialects: OpenAI Responses
 *  (`input_tokens`/`output_tokens`) and chat completions (`prompt_tokens`/`completion_tokens`),
 *  with the cached/reasoning breakdowns when present. Loose: vendors keep adding fields. */
const ProviderUsage = z.looseObject({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: z
    .looseObject({ cached_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  completion_tokens_details: z
    .looseObject({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  input_tokens_details: z
    .looseObject({
      cached_tokens: z.number().int().nonnegative().optional(),
      cache_write_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  output_tokens_details: z
    .looseObject({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .optional(),
});

function normalizeUsage(raw: unknown): LlmUsage | undefined {
  const parsed = ProviderUsage.safeParse(raw);
  if (!parsed.success) return undefined;
  const inputTokens = parsed.data.prompt_tokens ?? parsed.data.input_tokens;
  const outputTokens = parsed.data.completion_tokens ?? parsed.data.output_tokens;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens =
    parsed.data.prompt_tokens_details?.cached_tokens ??
    parsed.data.input_tokens_details?.cached_tokens;
  const reasoningOutputTokens =
    parsed.data.completion_tokens_details?.reasoning_tokens ??
    parsed.data.output_tokens_details?.reasoning_tokens;
  const cacheWriteInputTokens = parsed.data.input_tokens_details?.cache_write_tokens;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningOutputTokens,
  };
}

/** One OpenAI Responses API stream event — the loop reads the few types it knows and skips the
 *  rest. A delta's text and a finished item are read when well-formed, and ignored otherwise. */
const ResponsesEvent = z.looseObject({
  type: z.string(),
  delta: z.string().optional().catch(undefined),
  item: OutputItem.optional().catch(undefined),
});

/** A call of the one tool: its id and its arguments, a JSON string as the provider sends it. */
const FunctionCallItem = z.looseObject({
  call_id: z.string().catch(""),
  arguments: z.string().catch(""),
});

/** `run`'s arguments, when they are the JSON the tool declares. */
const RunArguments = z.looseObject({ status: z.string().catch(""), script: z.string() });

/** Read an SSE body frame by frame, handing each `data:` JSON to `onEvent`; the reader is cancelled
 *  when `signal` aborts, so nothing lands after the caller has settled. */
async function drainSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  let completed = false;
  const cancel = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) cancel();
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffered = "";
  const frame = (text: string) => {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    if (data === "" || data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      event = data;
    }
    onEvent(event);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split(/\r?\n\r?\n/);
      buffered = frames.pop() || "";
      frames.forEach(frame);
    }
    buffered += decoder.decode();
    if (buffered.trim()) frame(buffered);
    completed = true;
  } finally {
    signal.removeEventListener("abort", cancel);
    // A parser error (for example, a `response.failed` event) stops this consumer before the
    // provider has finished: cancel the body so the provider's stream stops too. Not awaited, so a
    // stalled provider cannot hold the error path.
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

/** Race an un-abortable dial against the caller's signal: the caller regains control the moment it
 *  aborts (an interruption, the expiry, the idle watchdog). A Response or stream the orphaned dial
 *  answers after that is cancelled, so the provider stops and no unread body holds the edge's
 *  invocation open; a stream already open is cancelled by `drainSse` itself. */
export function raceAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  const cancelLateBody = () =>
    void work.then(
      (late) => {
        const body = late instanceof Response ? late.body : late;
        if (body instanceof ReadableStream) void body.cancel(signal.reason).catch(() => undefined);
      },
      () => undefined,
    );
  if (signal.aborted) {
    cancelLateBody();
    return Promise.reject(signal.reason || new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason || new Error("aborted"));
      cancelLateBody();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // The listener goes in the same turn the dial settles: an answer handed over is its reader's.
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

type AgentEvent = ConsumedEvent<typeof AgentContract>;
/** What one model call answered: the rendered text (prose, then the call as a `<codemode>` block),
 *  its parts, the response's own items and the usage. */
type StreamAnswer = {
  text: string;
  prose: string;
  call?: { callId: string; status: string; script: string };
  providerItems: unknown[];
  usage?: LlmUsage;
};
type AgentArgs = ProcessEventArgs<AgentState, AgentEvent, AgentEmitted>;
/** What the loop appends: each type the contract emits, its payload as the catalog spells it. */
type AgentEmitted = EmittedEventInput<typeof AgentContract>;

type CachedAgentProcessorDeps = {
  /** The host's scope accessor: `itx.ai`, `itx.files`, `itx.whoami()` — the effects this loop
   *  reaches through the context, under its rules (a test lends a fake `itx.ai` there). */
  getItx: () => IterateContextApi & Disposable;
  /** The clock and the wait, injected only so a unit test can make the debounce instant. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The project's gate on words another agent sent (message.ts), read when it is needed: the
   *  facet class's `messageGate`, which the config's agents.ts sets. */
  messageGate?: () => AgentInputGate | undefined;
};

export class AgentProcessor extends StreamProcessor<AgentState, AgentEvent> {
  readonly contract = AgentContract;

  private readonly deps: CachedAgentProcessorDeps;
  readonly #now: () => number;
  /** The debounce window's wait — a test makes it instant. */
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(deps: CachedAgentProcessorDeps) {
    super();
    this.deps = deps;
    this.#now = deps.now || (() => Date.now());
    this.#sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** This incarnation's birth attempt, so one at-head pass does not start a second; the durable
   *  ground is `state.creation`. */
  #creating = false;
  /** The inputs THIS incarnation is asking the gate about; the durable ground is the trigger's
   *  `gate.waiting` and the `agent/input-gated` that answers each. */
  readonly #gatesInFlight = new Set<number>();
  /** The same for this incarnation's death attempt; the durable ground is `state.deletion`. */
  #deleting = false;

  /** The requests THIS incarnation is running, so a later at-head pass over the same fold does
   *  not start a second attempt; the durable ground is the fold (`openRequest`). */
  readonly #llmRequestsInFlight = new Map<
    number,
    { controller: AbortController; partialText: string }
  >();

  #identityRead?: { projectId: string; path: string };
  /** Which context this is — its project and path — read once. */
  async #identity(): Promise<{ projectId: string; path: string }> {
    if (this.#identityRead) return this.#identityRead;
    using itx = this.deps.getItx();
    return (this.#identityRead = await itx.whoami());
  }

  /** A certificate on `/`, where the catalog folds it (catalog.ts): stamped with this agent's path,
   *  which is all the catalog trusts. Unkeyed there: a key on `/` is anyone's to take first, and a
   *  same-body event under it would swallow this one; the catalog's fold is idempotent, so a retry
   *  that lands it twice changes nothing. */
  async #postToTheCatalog({ type, payload }: AgentEmitted): Promise<unknown> {
    using itx = this.deps.getItx();
    return await itx.cd("/").append({ type, payload });
  }

  /** Every change the facts make is stamped with the event's time: `lastActivityAt` moves exactly
   *  when the state does, so a harmless fact (a late intent, a repeated certificate) never reorders
   *  the sidebar. */
  reduce(args: ReduceArgs<AgentState, AgentEvent>): AgentState | undefined {
    if (isForeignAgentFact(args.event)) return undefined;
    const next = this.#reduceFacts(args);
    return next && { ...next, lastActivityAt: args.event.createdAt };
  }

  #reduceFacts({ state, event }: ReduceArgs<AgentState, AgentEvent>): AgentState | undefined {
    switch (event.type) {
      case "events.iterate.com/agent/create-requested":
        // Born once: a request after the certificate is a harmless fact; after a failure, a new
        // attempt. A deleted agent is not re-creatable: `creation` stays as it was, so the request
        // is a harmless fact there too (the collection refuses it before it lands).
        return state.creation?.status === "created"
          ? undefined
          : {
              ...state,
              creation: { status: "requested", offset: event.offset },
            };
      case "events.iterate.com/agent/created":
        return { ...state, creation: { status: "created", offset: event.offset } };
      case "events.iterate.com/agent/create-failed":
        // A failure after the certificate is a harmless fact too (an attempt whose own-path append
        // lost its answer): the entity stays created, and the next create() answers at once.
        return state.creation?.status === "created"
          ? undefined
          : { ...state, creation: { status: "failed", offset: event.offset } };
      case "events.iterate.com/agent/delete-requested":
        // Dies once: a request after the death certificate is a harmless fact. Deletion never
        // touches `creation` — the log still says the agent was born.
        return state.deletion?.status === "deleted"
          ? undefined
          : { ...state, deletion: { status: "requested", offset: event.offset } };
      case "events.iterate.com/agent/deleted":
        return { ...state, deletion: { status: "deleted", offset: event.offset } };

      case "events.iterate.com/agent/configured": {
        const patch = event.payload.config;
        return {
          ...state,
          config: {
            llm: {
              model: patch.llm?.model || state.config.llm.model,
              reasoningEffort: patch.llm?.reasoningEffort || state.config.llm.reasoningEffort,
            },
            maxAutonomousTurns: patch.maxAutonomousTurns ?? state.config.maxAutonomousTurns,
            llmRequestExpiryMs: patch.llmRequestExpiryMs ?? state.config.llmRequestExpiryMs,
            llmRequestDebounceMs: patch.llmRequestDebounceMs ?? state.config.llmRequestDebounceMs,
            scriptResultHistoryLimit:
              patch.scriptResultHistoryLimit ?? state.config.scriptResultHistoryLimit,
            compactionTriggerFraction:
              patch.compactionTriggerFraction ?? state.config.compactionTriggerFraction,
            idleCompactionAfterMs:
              patch.idleCompactionAfterMs ?? state.config.idleCompactionAfterMs,
            idleCompactionMinNewTokens:
              patch.idleCompactionMinNewTokens ?? state.config.idleCompactionMinNewTokens,
            idleSummariesMaxChars:
              patch.idleSummariesMaxChars ?? state.config.idleSummariesMaxChars,
            keepWarmForMs: patch.keepWarmForMs ?? state.config.keepWarmForMs,
            keepWarmEveryMs: patch.keepWarmEveryMs ?? state.config.keepWarmEveryMs,
            llmRequestRetryPolicy: {
              maxAttempts:
                patch.llmRequestRetryPolicy?.maxAttempts ??
                state.config.llmRequestRetryPolicy.maxAttempts,
              backoffBaseMs:
                patch.llmRequestRetryPolicy?.backoffBaseMs ??
                state.config.llmRequestRetryPolicy.backoffBaseMs,
              backoffMaxMs:
                patch.llmRequestRetryPolicy?.backoffMaxMs ??
                state.config.llmRequestRetryPolicy.backoffMaxMs,
            },
          },
        };
      }

      case "events.iterate.com/agent/context-added": {
        // THE TRUST BOUNDARY (message.ts): what another agent's context appended is its words, a
        // user item from that context, whatever role, actor or sections it claims
        const payload = trustBoundary(event);
        const { role, content, actor, llmRequestPolicy, llmRequestOffset, compaction } = payload;
        // The previous loop journaled its default prompt beside the birth certificate, under this
        // key. The sections supersede it, so it is not part of the conversation.
        if (role === "system" && event.idempotencyKey?.startsWith("agent/system-prompt:"))
          return undefined;
        // A COMPACTION SUMMARY replaces the conversation through its barrier. The standing sections
        // collapse into ONE head snapshot of what the model has been shown (every update folded
        // in), other system items survive, then the earlier summaries when it keeps them, then the
        // summary, then everything after the barrier verbatim — what arrived while the summary
        // was written included. A summary no newer than one already applied is a harmless fact.
        // It raises no turn.
        if (role === "developer" && compaction) {
          const cutoff = compaction.replacesHistoryThrough;
          const applied = state.contextItems.some(
            (item) => item.compaction && item.compaction.replacesHistoryThrough >= cutoff,
          );
          if (applied || cutoff >= event.offset) return undefined;
          const firstSection = state.contextItems.find((item) => item.sections);
          const head =
            Object.keys(state.sections).length > 0
              ? [
                  {
                    offset: firstSection?.offset ?? event.offset,
                    role: "system" as const,
                    content: "",
                    sections: state.sections,
                    snapshot: true,
                  },
                ]
              : [];
          return {
            ...state,
            contextItems: [
              ...head,
              ...state.contextItems.filter((item) => item.role === "system" && !item.sections),
              ...(compaction.keepsEarlierSummaries
                ? state.contextItems.filter((item) => item.compaction && item.offset <= cutoff)
                : []),
              { offset: event.offset, role, content, actor, compaction },
              ...state.contextItems.filter(
                (item) => item.role !== "system" && item.offset > cutoff,
              ),
            ],
            runs: Object.fromEntries(
              Object.entries(state.runs).filter(([run]) => Number(run) > cutoff),
            ),
          };
        }
        // WHO SENT IT: another context's stamp (apps/os caller.ts `stampCaller`), else the sender
        // the collection relayed through this agent's own facet (`message`; its base is the
        // caller's to choose through the public `at(base)`, collection.ts). `/` is the people's
        // (the dash, a member's session, the root's collection): a person's words carry no sender.
        // The sender signs nothing, so the label is advisory.
        const { origin } = event.source;
        const sender = origin !== event.path ? origin : payload.from;
        const { call, providerItems, providerModel, sections, snapshot } = payload;
        // A standing-instructions item folds into what the model has been shown.
        const shown =
          role === "system" && sections
            ? Object.fromEntries(
                Object.entries({ ...state.sections, ...sections }).filter(
                  (entry): entry is [string, string] => entry[1] !== null,
                ),
              )
            : state.sections;
        // An answer's call waits for the run this loop requests for it next (the previous
        // loop's `<codemode>` answer, re-reduced, makes its call the same way).
        const awaitingRun =
          role === "assistant" && llmRequestOffset !== undefined
            ? call
              ? { callId: call.callId }
              : parseCodemodeResponse(content).kind === "script"
                ? { callId: `call_${String(event.offset)}` }
                : null
            : state.awaitingRun;
        const next: AgentState = {
          ...state,
          sections: shown,
          awaitingRun,
          contextItems: [
            ...state.contextItems,
            {
              offset: event.offset,
              role,
              content,
              actor,
              llmRequestOffset,
              files: payload.files,
              from: sender === "/" ? undefined : sender,
              call,
              providerItems,
              providerModel,
              sections,
              snapshot,
            },
          ],
        };
        // A person's or a developer's words raise the trigger — the system prompt and the
        // assistant's own output never do, nor words whose policy says not to.
        const triggers =
          (role === "user" || role === "developer") &&
          llmRequestPolicy?.behaviour !== "dont-trigger-request";
        // A script's note that starts no turn (it returned nothing) ends the turn: an answer still
        // owed after its one reminder is given up with it, unless a turn goes on anyway.
        if (!triggers) {
          const givenUp =
            actor?.type === "script" &&
            state.owedAnswer?.reminded === true &&
            !state.openRequest &&
            !state.pendingLlmRequestTrigger;
          if (!givenUp) return next;
          return { ...next, owedAnswer: null };
        }
        const source =
          actor?.type === "script" || actor?.type === "agent" ? "agent-loop" : "external";
        // words that must be answered: the newest such input is the one owed
        const why = source === "external" ? answerOwedFor({ ...event, payload }) : null;
        // THE GATE (message.ts `AgentInputGate`): words from another agent wait for the project's
        // gate when everything the trigger stands for came from other agents; once a person's or
        // the loop's own words are pending, a turn is owed anyway and nothing waits
        const prior = state.pendingLlmRequestTrigger;
        const gate =
          source === "external" && isOtherContext(event.path, sender) && (!prior || prior.gate)
            ? { waiting: [...(prior?.gate?.waiting || []), event.offset] }
            : undefined;
        return {
          ...next,
          pendingLlmRequestTrigger: {
            offset: event.offset,
            atMs: Date.parse(event.createdAt),
            source,
            gate,
          },
          ...(why && { owedAnswer: { offset: event.offset, why, reminded: false } }),
          // a person's words start the breakers over (a transient outage's backoff ends with them)
          // and answer whatever the agent was waiting for
          ...(source === "external" && {
            autonomousTurnCount: 0,
            consecutiveLlmFailures: 0,
            summary: { ...state.summary, waitingFor: null },
          }),
        };
      }

      case "events.iterate.com/agent/llm-request-requested": {
        // A late intent — its trigger answered, moved on, or a request already open — is a harmless
        // stream fact: only the intent naming THE pending trigger opens a request, so a sleep the
        // debounce left behind for a trigger that moved can neither skip the new trigger's window
        // nor a failure's backoff. The request's identity is the offset of the intent that opened it.
        const trigger = state.pendingLlmRequestTrigger;
        if (!trigger || state.openRequest || trigger.offset !== event.payload.triggerOffset)
          return undefined;
        return {
          ...state,
          // the request's stamp: the model's clock, at the request's own offset (processor
          // `#messages` reads items through it)
          contextItems: [
            ...state.contextItems,
            {
              offset: event.offset,
              role: "developer",
              content: requestStamp(event.createdAt),
              actor: { type: "agent" },
              stamp: true,
            },
          ],
          pendingLlmRequestTrigger: null,
          openRequest: {
            requestedAtOffset: event.offset,
            expiresAt: event.payload.expiresAt,
            model: event.payload.model,
            triggerSource: trigger.source,
          },
          autonomousTurnCount:
            trigger.source === "agent-loop"
              ? state.autonomousTurnCount + 1
              : state.autonomousTurnCount,
        };
      }

      case "events.iterate.com/agent/llm-request-settled": {
        const open = state.openRequest;
        if (!open || open.requestedAtOffset !== event.payload.requestOffset) return undefined;
        const { result } = event.payload;
        if (result.status === "succeeded")
          return {
            ...state,
            openRequest: null,
            consecutiveLlmFailures: 0,
            // an answer with no call ends the turn the model's own way, in words or a deliberate
            // silence: nothing more is owed
            ...(parseCodemodeResponse(result.text).kind === "none" && { owedAnswer: null }),
          };
        if (result.status === "failed")
          // The trigger comes back for the retry, still the same source; the pass caps the retries.
          return {
            ...state,
            openRequest: null,
            consecutiveLlmFailures: state.consecutiveLlmFailures + 1,
            pendingLlmRequestTrigger: {
              offset: open.requestedAtOffset,
              atMs: Date.parse(event.createdAt),
              source: open.triggerSource,
            },
          };
        // Expired: the turn is dropped; the person's next words start fresh.
        return { ...state, openRequest: null };
      }

      case "events.iterate.com/agent/paused":
        // A pause DROPS the parked trigger: what tripped the breaker (a script's result, a retry)
        // must not be what resumes it. Only words that arrive after the pause raise a new one.
        return state.paused
          ? undefined
          : {
              ...state,
              paused: { reason: event.payload.reason, atOffset: event.offset },
              pendingLlmRequestTrigger: null,
            };

      case "events.iterate.com/agent/resumed":
        return state.paused
          ? { ...state, paused: null, autonomousTurnCount: 0, consecutiveLlmFailures: 0 }
          : undefined;

      // THIS LOOP'S OWN RUNS: a run request the engine stamped as this processor's, on this
      // context. A run anyone else asked for here is theirs: its settlement wakes no turn.
      case "events.iterate.com/itx/run-requested":
        if (
          event.source.processor?.slug !== this.contract.slug ||
          event.source.origin !== event.path
        )
          return undefined;
        return {
          ...state,
          pendingRuns: {
            ...state.pendingRuns,
            [String(event.offset)]: { requestedAt: Date.parse(event.createdAt) },
          },
          // the run answers the newest answer's call: its result becomes that call's output
          ...(state.awaitingRun && {
            runs: { ...state.runs, [String(event.offset)]: { callId: state.awaitingRun.callId } },
            awaitingRun: null,
          }),
        };

      // An own run's outcome joins `results` (the newest ten); the note itself is processEvent's.
      case "events.iterate.com/itx/run-settled": {
        const { requestOffset, settlement } = event.payload;
        const key = String(requestOffset);
        if (!state.pendingRuns[key]) return undefined;
        const { [key]: _settled, ...pendingRuns } = state.pendingRuns;
        const row = classifyScriptResult({
          agentPath: event.path,
          requestOffset,
          offset: event.offset,
          settlement,
        });
        return {
          ...state,
          pendingRuns,
          scriptResults: [...state.scriptResults, row].slice(-RETAINED_SCRIPT_RESULTS),
        };
      }

      // What the agent says about itself: each field it names replaces that field.
      case "events.iterate.com/agent/summary-updated": {
        const { activity, title, waitingFor, description } = event.payload;
        return {
          ...state,
          summary: {
            title: title || state.summary.title,
            activity: activity || state.summary.activity,
            // oxlint-disable-next-line iterate/simple-truthiness-check -- null clears what it waits for; absent keeps it (contract.ts summary-updated)
            waitingFor: waitingFor === undefined ? state.summary.waitingFor : waitingFor,
            description: description || state.summary.description,
          },
        };
      }

      // The gate's decision on words another agent sent: a wake lets the trigger go on to a
      // request; a hold drops the input from what waits, and the trigger with the last of them
      // (the words stay in the context, read on the next turn).
      case "events.iterate.com/agent/input-gated": {
        const trigger = state.pendingLlmRequestTrigger;
        const { inputOffset, wake } = event.payload;
        if (!trigger?.gate?.waiting.includes(inputOffset)) return undefined;
        if (wake) {
          const { gate: _decided, ...woken } = trigger;
          return { ...state, pendingLlmRequestTrigger: woken };
        }
        const waiting = trigger.gate.waiting.filter((offset) => offset !== inputOffset);
        return {
          ...state,
          pendingLlmRequestTrigger: waiting.length > 0 ? { ...trigger, gate: { waiting } } : null,
        };
      }

      // The one reminder an owed answer gets is spent.
      case "events.iterate.com/agent/answer-reminded":
        return state.owedAnswer?.offset === event.payload.inputOffset
          ? { ...state, owedAnswer: { ...state.owedAnswer, reminded: true } }
          : undefined;

      // Pinned code (results-preamble.ts): set, replaced or removed by a script, and taken out by
      // the loop when it breaks scripts.
      case "events.iterate.com/agent/preamble-entry-set":
        return { ...state, ...preambleEntrySet(state, event.payload, event.offset) };

      case "events.iterate.com/agent/preamble-entry-quarantined":
        return { ...state, ...preambleEntryQuarantined(state, event.payload, event.offset) };

      default:
        return undefined;
    }
  }

  /** THE PINNED ENTRIES' GUARD before a run (results-preamble.ts `guardPreamble`): an entry the
   *  script envelope would not load with is quarantined just before the run request, which then
   *  carries the envelope without it, so a broken entry costs no failed run and never blocks the
   *  script that removes it. One load per run of an agent with pinned entries, warm while they stay
   *  the same; an agent without any pays nothing. */
  async #guardPinned(
    consequences: AgentEmitted[],
    state: AgentState,
    event: AgentEvent,
    code: string,
  ): Promise<AgentEmitted[]> {
    if (state.preamble.length === 0) return consequences;
    using itx = this.deps.getItx();
    const { keep, quarantined } = await guardPreamble(
      envelopeLoader(itx),
      event.path,
      state.preamble,
    );
    if (quarantined.length === 0) return consequences;
    return consequences.flatMap((consequence): AgentEmitted[] =>
      consequence.type === "events.iterate.com/itx/run-requested"
        ? [
            ...quarantined.map(
              (payload) =>
                ({
                  type: "events.iterate.com/agent/preamble-entry-quarantined",
                  idempotencyKey: this.idempotencyKey(`preamble-quarantined/${payload.key}`, event),
                  payload,
                }) satisfies AgentEmitted,
            ),
            {
              ...consequence,
              payload: {
                code: wrapScript({
                  code,
                  agentPath: event.path,
                  rows: state.scriptResults,
                  preamble: keep,
                }),
              },
            },
          ]
        : [consequence],
    );
  }

  processEvent(args: AgentArgs): undefined {
    const { event, state, previousState, append, blockProcessorWhile, runInBackground } = args;
    // An agent asked to go acts no more: no consequence of a late event (a script result landing
    // after the request raises no turn), no interrupt to settle — only the death itself, at head.
    // Another context's fact about this loop (message.ts) is not this loop's: it has no consequence.
    if (state.deletion || (event && isForeignAgentFact(event))) {
      this.#atHead(args);
      return;
    }
    // THE INTERRUPT: cancellation is a property of new input, never a command. The
    // person's words abort whatever this incarnation is streaming, keep what streamed as an
    // assistant item the next turn can see (no llmRequestOffset: a record, never parsed for a
    // script), and settle the request cancelled — blocked, so an eviction can never leave the
    // request open for the next at-head pass to adopt. Their reduce already moved the trigger; the
    // settlement's own delivery re-runs the at-head pass, which then records the next request.
    if (
      event?.type === "events.iterate.com/agent/context-added" &&
      event.payload.llmRequestPolicy?.behaviour === "interrupt-current-request" &&
      ["user", "developer"].includes(trustBoundary(event).role) &&
      state.openRequest
    ) {
      const open = state.openRequest;
      const inFlight = this.#llmRequestsInFlight.get(open.requestedAtOffset);
      inFlight?.controller.abort(new InterruptedError());
      const partialText = inFlight?.partialText || undefined;
      blockProcessorWhile(() =>
        appendUnlessLost(
          append,
          ...(partialText
            ? [
                {
                  type: "events.iterate.com/agent/context-added",
                  idempotencyKey: this.idempotencyKey(
                    `interrupted/${String(open.requestedAtOffset)}`,
                  ),
                  payload: {
                    role: "assistant",
                    content: `[Response interrupted by the user's next message; partial output follows]\n${partialText}`,
                  },
                } satisfies AgentEmitted,
              ]
            : []),
          {
            type: "events.iterate.com/agent/llm-request-settled",
            idempotencyKey: this.idempotencyKey(`settle/${String(open.requestedAtOffset)}`),
            payload: {
              requestOffset: open.requestedAtOffset,
              result: { status: "cancelled", reason: "interrupted-by-user-input", partialText },
            },
          },
        ),
      );
      // Not at head this frame: the pass reads the pre-cancel fold and would adopt the very
      // request the queued settlement cancels.
      return;
    }

    // ── per-event consequences, blocked: the event is delivered once ──
    // The assistant's answer, interpreted (mmkal's order: the status precedes the script so the step
    // is born with its label, the script precedes the prose so a feed groups the turn as one).
    // Only an answer this agent's own context wrote: another context's is its words (message.ts).
    if (
      event?.type === "events.iterate.com/agent/context-added" &&
      trustBoundary(event).role === "assistant" &&
      event.payload.llmRequestOffset !== undefined
    ) {
      const { llmRequestOffset, call } = event.payload;
      const parsed = parseCodemodeResponse(event.payload.content);
      // THIS loop's answer names its call: the script is the call's own text, never re-parsed out of
      // the rendered block (a script may itself contain `<codemode>` lines); the prose is what the
      // rendering put before it.
      const outcome: ReturnType<typeof parseCodemodeResponse> = call
        ? {
            kind: "script",
            code: ASYNC_FUNCTION_BODY_RE.test(call.script.trim())
              ? call.script.trim()
              : `async (itx) => {\n${call.script}\n}`,
            status: call.status.trim() || undefined,
            prose:
              (parsed.kind === "script" || parsed.kind === "none"
                ? parsed.prose
                : event.payload.content.split(/\n*<codemode /)[0]!.trim()) || undefined,
          }
        : parsed;
      const consequences: AgentEmitted[] = [];
      if (outcome.kind === "malformed" || outcome.kind === "multiple")
        consequences.push({
          type: "events.iterate.com/agent/context-added",
          idempotencyKey: this.idempotencyKey("format-feedback", event),
          payload: { role: "developer", content: outcome.feedback, actor: { type: "agent" } },
        });
      if (outcome.kind === "script") {
        if (outcome.status)
          consequences.push({
            type: "events.iterate.com/agent/summary-updated",
            idempotencyKey: this.idempotencyKey("codemode-status", event),
            payload: { activity: outcome.status },
          });
        consequences.push({
          type: "events.iterate.com/itx/run-requested",
          idempotencyKey: this.idempotencyKey("run-requested", event),
          // the model's script in its envelope: `results`, pinned entries, the serializer
          payload: {
            code: wrapScript({
              code: outcome.code,
              agentPath: event.path,
              rows: state.scriptResults,
              preamble: state.preamble,
            }),
          },
        });
      }
      // The prose — beside a tag or on its own — is the message, appended directly on this context.
      // Where a reply GOES from here is a subscriber's business (events are the interface), never a
      // script would need a row for.
      if ((outcome.kind === "script" || outcome.kind === "none") && outcome.prose)
        consequences.push({
          type: "events.iterate.com/agent/web-message-sent",
          idempotencyKey: this.idempotencyKey("codemode-prose", event),
          payload: {
            message: outcome.prose,
            llmRequestOffset,
            ...(outcome.kind === "script" && { besideScript: true }),
          },
        });
      // Words with no script end the turn on the person: the agent now waits for their answer.
      if (outcome.kind === "none" && outcome.prose)
        consequences.push({
          type: "events.iterate.com/agent/summary-updated",
          idempotencyKey: this.idempotencyKey("waiting-for", event),
          payload: { waitingFor: "user_input" },
        });
      // A pinned entry the script envelope would not load with is quarantined before the run,
      // which goes ahead without it (`#guardPinned`).
      if (consequences.length > 0)
        blockProcessorWhile(async () =>
          append(
            ...(outcome.kind === "script"
              ? await this.#guardPinned(consequences, state, event, outcome.code)
              : consequences),
          ),
        );
    }

    // THE CONTEXT ran one of this loop's scripts: its settlement is the model's next input — only
    // an own run's (the reduce knew it as pending), with how long it ran. A large result is written
    // to its file first, inside the block: the note must never land before the file it names.
    if (event?.type === "events.iterate.com/itx/run-settled") {
      const { requestOffset, settlement } = event.payload;
      const pending = previousState.pendingRuns[String(requestOffset)];
      const row = state.scriptResults.find((entry) => entry.offset === event.offset);
      if (pending && row)
        blockProcessorWhile(async () => {
          // A PINNED ENTRY THAT THREW before the script began is quarantined (results-preamble.ts):
          // it would throw before every later script too.
          const threw = pinnedEntryThrew(settlement, state.preamble, requestOffset);
          if (threw)
            await append({
              type: "events.iterate.com/agent/preamble-entry-quarantined",
              idempotencyKey: this.idempotencyKey("preamble-threw", event),
              payload: threw,
            });
          const rendered = await renderScriptSettlement({
            settlement,
            row,
            durationMs: Math.max(0, Date.parse(event.createdAt) - pending.requestedAt),
            historyLimit: state.config.scriptResultHistoryLimit,
            write: async (path, text) => {
              using itx = this.deps.getItx();
              await itx.files.get(path).put({
                contentType: row.text ? "text/plain; charset=utf-8" : "application/json",
                data: new TextEncoder().encode(text),
              });
            },
          });
          const content = rendered && threw ? pinnedEntryThrewNote(rendered, threw) : rendered;
          const nothing = `Your script finished and returned nothing (in ${formatScriptDuration(Math.max(0, Date.parse(event.createdAt) - pending.requestedAt))}).`;
          // A script that returned nothing still answers its call (every call needs its output),
          // and starts no turn: returning nothing ends the loop. Except, ONCE, on a turn that
          // still owes an answer and that nothing else carries on (no request open, no new
          // words waiting): a script that only updated notes must not end a turn whose answer
          // never went out. The note then says so and starts one more request, and
          // `answer-reminded` records it.
          const owed = state.owedAnswer;
          const reminder =
            !content &&
            owed &&
            !owed.reminded &&
            !state.openRequest &&
            !state.pendingLlmRequestTrigger &&
            !state.paused
              ? owed
              : null;
          await append(
            ...(reminder
              ? [
                  {
                    type: "events.iterate.com/agent/answer-reminded",
                    idempotencyKey: this.idempotencyKey("answer-reminded", event),
                    payload: {
                      inputOffset: reminder.offset,
                      runRequestOffset: requestOffset,
                      why: reminder.why,
                    },
                  } satisfies AgentEmitted,
                ]
              : []),
            {
              type: "events.iterate.com/agent/context-added",
              idempotencyKey: this.idempotencyKey("script-result", event),
              payload: {
                role: "developer",
                content: content || (reminder ? answerReminder(nothing, reminder) : nothing),
                actor: { type: "script", requestOffset },
                ...(!content &&
                  !reminder && { llmRequestPolicy: { behaviour: "dont-trigger-request" } }),
              },
            },
          );
        });
    }

    if (event?.type === "events.iterate.com/agent/llm-request-settled") {
      const { requestOffset, result } = event.payload;
      const open = previousState.openRequest;
      // A LOST TURN IS SAID: a failed attempt or an expired request becomes a note the next turn
      // reads, so the model can tell the person — raising no turn of its own (the retry is the
      // reduce's; `agent` actor, so it resets no breaker).
      const lost =
        result.status === "failed"
          ? `The model request @${String(requestOffset)} failed (attempt ${String(state.consecutiveLlmFailures)} of ${String(state.config.llmRequestRetryPolicy.maxAttempts)}): ${result.errorMessage.slice(0, 500)}. ${state.consecutiveLlmFailures < state.config.llmRequestRetryPolicy.maxAttempts ? "Retrying." : "Giving up until the next message."}`
          : result.status === "cancelled" && result.reason === "expired"
            ? `The model request @${String(requestOffset)} expired before it finished; that turn was dropped.`
            : null;
      if (lost && open?.requestedAtOffset === requestOffset)
        blockProcessorWhile(() =>
          append({
            type: "events.iterate.com/agent/context-added",
            idempotencyKey: this.idempotencyKey("lost-turn", event),
            payload: {
              role: "developer",
              content: lost,
              actor: { type: "agent" },
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            },
          }),
        );
      // COMPACTION: a request that filled its share of the window has the conversation through it
      // summarized, in the background — the turn's own consequences (its script) go on meanwhile,
      // and the summary replaces that history when it lands (the reduce). One at a time per
      // incarnation; a summary already covering this request is not asked for twice.
      if (
        result.status === "succeeded" &&
        result.usage &&
        open?.requestedAtOffset === requestOffset
      ) {
        const usedTokens = result.usage.inputTokens + result.usage.outputTokens;
        const thresholdTokens = Math.floor(
          contextWindowTokens(open.model) * state.config.compactionTriggerFraction,
        );
        // covered: a summary already reaches this request, or landed after its prompt was built
        // (its prompt held the whole pre-summary history, so its size says nothing now)
        const covered = state.contextItems.some(
          (item) =>
            item.compaction &&
            (item.compaction.replacesHistoryThrough >= requestOffset ||
              item.offset > requestOffset),
        );
        const history = state.contextItems.some(
          (item) => item.role !== "system" && item.offset < requestOffset,
        );
        // GOING QUIET, armed: a check this long after the request, which pings or compacts if
        // nothing happened since (the schedule is the agent's own; a newer request re-arms it)
        const settledAt = Date.parse(event.createdAt);
        const warm = keepsWarm(event.path) && state.config.keepWarmForMs > 0;
        if (
          state.config.idleCompactionAfterMs > 0 &&
          !isVoiceCall(event.path) &&
          !covered &&
          (warm || historyTokensSinceSummary(state) >= state.config.idleCompactionMinNewTokens)
        )
          runInBackground(() =>
            this.#armIdleCheck(
              {
                afterRequestOffset: requestOffset,
                inputTokens: result.usage!.inputTokens,
                ...(warm && {
                  keepWarmUntil: new Date(settledAt + state.config.keepWarmForMs).toISOString(),
                }),
              },
              settledAt + state.config.idleCompactionAfterMs,
              `idle-compaction/${String(requestOffset)}`,
            ),
          );
        if (usedTokens >= thresholdTokens && history && !covered && !this.#compacting) {
          this.#compacting = true;
          runInBackground(async () => {
            try {
              await this.#compact({
                state,
                requestOffset,
                model: open.model,
                usedTokens,
                thresholdTokens,
                append,
              });
            } finally {
              this.#compacting = false;
            }
          });
        }
      }
    }

    // GOING QUIET, due: the agent's own schedule fired and nothing has happened since the request
    // it names. `idleAction` says whether to ping or to summarize; contract.ts's `keepWarmForMs`
    // and `idleCompactionAfterMs` say why.
    const idle =
      event?.type === "events.iterate.com/agent/idle-check" && !this.#compacting
        ? idleAction(state, event.payload, Date.parse(event.createdAt))
        : undefined;
    if (event?.type === "events.iterate.com/agent/idle-check" && idle === "keep-warm") {
      const check = event.payload;
      runInBackground(() => this.#keepWarm({ state, check, checkOffset: event.offset, append }));
    }
    if (event?.type === "events.iterate.com/agent/idle-check" && idle === "compact") {
      this.#compacting = true;
      runInBackground(async () => {
        try {
          await this.#compact({
            state,
            requestOffset: event.payload.afterRequestOffset,
            model: state.config.llm.model,
            usedTokens: event.payload.inputTokens,
            thresholdTokens: state.config.idleCompactionMinNewTokens,
            append,
            idle: true,
          });
        } finally {
          this.#compacting = false;
        }
      });
    }

    this.#atHead(args);
  }

  /** The idle check `check`, at `at`: the agent's own schedule, `idle-compaction`, which a newer
   *  request's check replaces. */
  async #armIdleCheck(
    check: { afterRequestOffset: number; inputTokens: number; keepWarmUntil?: string },
    at: number,
    key: string,
  ): Promise<void> {
    using itx = this.deps.getItx();
    await itx.schedules.set(
      {
        key: "idle-compaction",
        when: { at: new Date(at).toISOString() },
        events: [{ type: "events.iterate.com/agent/idle-check", payload: check }],
      },
      { idempotencyKey: this.idempotencyKey(key) },
    );
  }

  /** THE KEEP-WARM PING: the named request's own input (so its cached prefix is what is read) and
   *  the ping, on the agent's model and effort (both part of the cache key), the tool declared
   *  but not callable. Its cost lands as `cache-kept-warm`, and the next check is set a ping
   *  interval later. Best effort: a failed ping still sets the next check, which then compacts or
   *  pings again. */
  async #keepWarm(input: {
    state: AgentState;
    check: { afterRequestOffset: number; inputTokens: number; keepWarmUntil?: string };
    checkOffset: number;
    append: AgentArgs["append"];
  }): Promise<void> {
    const { state, check, checkOffset, append } = input;
    const model = state.config.llm.model;
    try {
      const { path } = await this.#identity();
      const answer = await this.#stream({
        model,
        effort: state.config.llm.reasoningEffort,
        input: [
          ...(await this.#requestInput(state, check.afterRequestOffset, model, append)),
          { role: "user", content: KEEP_WARM_PROMPT },
        ],
        cacheKey: promptCacheKey(path),
        signal: AbortSignal.timeout(state.config.llmRequestExpiryMs),
        onDelta: () => undefined,
        toolChoice: "none",
      });
      await appendUnlessLost(append, {
        type: "events.iterate.com/agent/cache-kept-warm",
        idempotencyKey: this.idempotencyKey(`keep-warm/${String(checkOffset)}`),
        payload: {
          afterRequestOffset: check.afterRequestOffset,
          ...(answer.usage && {
            usage: { ...answer.usage, costUsd: requestCostUsd(model, answer.usage) },
          }),
        },
      });
    } catch (error) {
      console.error("[agent] keep-warm ping failed", { error, check });
    }
    await this.#armIdleCheck(
      check,
      Date.now() + state.config.keepWarmEveryMs,
      `idle-compaction/${String(check.afterRequestOffset)}/${String(checkOffset)}`,
    );
  }

  // ── state-derived consequences, at head, in the background: re-derived by any later delivery ──
  #atHead({ event, state, delivery, append, runInBackground }: AgentArgs): void {
    if (!delivery.caughtUp) return;

    // THE SAGA — the birth, from state at head, in the background: at most once per incarnation,
    // and any later delivery over the same state runs it again, so an attempt lost to an eviction
    // costs nothing. Nothing to provision: the certificate goes to `/` (the project catalog) first,
    // then lands here in ONE append with the default system prompt beside it — keyed here, so a
    // retry appends nothing twice. An operator's instructions are their own `context-added` after.
    if (state.creation?.status === "requested") {
      if (this.#creating) return;
      this.#creating = true;
      runInBackground(async () => {
        try {
          let whoami;
          {
            using itx = this.deps.getItx();
            whoami = await itx.whoami();
          }
          const { path } = whoami;
          const certificate: AgentEmitted = {
            type: "events.iterate.com/agent/created",
            payload: { path },
            idempotencyKey: `agent/created:${path}`,
          };
          await this.#postToTheCatalog(certificate); // the project catalog first
          // this path last: the certificate closes the obligation. The instructions are the
          // sections, snapshotted by the first request (`#syncSections`).
          await append(certificate);
        } catch (error) {
          await append({
            type: "events.iterate.com/agent/create-failed",
            payload: { error: error instanceof Error ? error.message : String(error) },
          });
        } finally {
          this.#creating = false;
        }
      });
      return;
    }
    if (state.creation?.status !== "created") return;

    // THE DEATH — the birth's mirror, only of an agent that was born, and the LOOP's gate: a deleted
    // agent (or one asked to go) runs no more turns, whatever the fold below says. Nothing to tear
    // down, so the saga is the death certificate alone: `/` first (the catalog drops the entry), then
    // here — keyed, so a retry appends nothing twice. A throw appends nothing: the next at-head pass
    // is the retry, and there is no delete-failed fact.
    if (state.deletion) {
      if (state.deletion.status !== "requested" || this.#deleting) return;
      this.#deleting = true;
      runInBackground(async () => {
        try {
          const { path } = await this.#identity();
          const certificate: AgentEmitted = {
            type: "events.iterate.com/agent/deleted",
            payload: { path },
            idempotencyKey: `agent/deleted:${path}`,
          };
          await this.#postToTheCatalog(certificate); // the project catalog first
          await append(certificate); // this path last: closes the obligation
        } finally {
          this.#deleting = false;
        }
      });
      return;
    }
    const now = this.#now();

    // THE GATE: words another agent sent wait for the project's gate (message.ts), asked once per
    // input while no request is open; its `agent/input-gated` lets the trigger on or drops it. An
    // input from a sender the gate does not apply to, or no gate at all, wakes the agent as before.
    const trigger = state.pendingLlmRequestTrigger;
    const gate = trigger?.gate && !state.openRequest ? this.deps.messageGate?.() : undefined;
    if (trigger?.gate && gate) {
      const waiting = trigger.gate.waiting.map((offset) => ({
        offset,
        item: state.contextItems.find((item) => item.offset === offset),
      }));
      // this agent's path: every event delivered here is on its context
      const path = this.#identityRead?.path ?? event?.path;
      if (
        path &&
        waiting.every(({ item }) => item?.from && gate.applies({ path, from: item.from }))
      ) {
        for (const { offset, item } of waiting) {
          if (this.#gatesInFlight.has(offset)) continue;
          this.#gatesInFlight.add(offset);
          const recent = state.contextItems
            .filter((earlier) => earlier.role === "user" && earlier.offset < offset)
            .slice(-3)
            .map((earlier) => (earlier.from ? `[from ${earlier.from}] ` : "") + earlier.content);
          runInBackground(async () => {
            try {
              const decided = await gate
                .decide({
                  getItx: this.deps.getItx,
                  path,
                  from: item!.from!,
                  offset,
                  at: new Date(now).toISOString(),
                  content: item!.content,
                  recent,
                })
                .catch((error: unknown) => {
                  console.warn("[agent] the message gate failed: the input wakes the agent", {
                    offset,
                    error,
                  });
                  return { wake: true, decision: { error: String(error) } };
                });
              await append({
                type: "events.iterate.com/agent/input-gated",
                idempotencyKey: this.idempotencyKey(`input-gated/${String(offset)}`),
                payload: {
                  inputOffset: offset,
                  wake: decided.wake,
                  decision: decided.decision,
                },
              });
            } finally {
              this.#gatesInFlight.delete(offset);
            }
          });
        }
        return;
      }
    }

    // A person's words resume a paused loop; the loop's own never do (they are what paused it).
    if (state.paused && trigger?.source === "external") {
      runInBackground(() =>
        append({
          type: "events.iterate.com/agent/resumed",
          idempotencyKey: this.idempotencyKey(`resume/${String(trigger.offset)}`),
          payload: { reason: "external input" },
        }),
      );
      return;
    }

    // A trigger and nothing open: record the request — or trip a breaker instead.
    if (trigger && !state.openRequest && !state.paused) {
      const { maxAutonomousTurns, llmRequestRetryPolicy, llmRequestExpiryMs, llm } = state.config;
      const breaker =
        trigger.source === "agent-loop" && state.autonomousTurnCount >= maxAutonomousTurns
          ? `autonomous turn limit reached (${String(maxAutonomousTurns)} consecutive turns without external input)`
          : state.consecutiveLlmFailures >= llmRequestRetryPolicy.maxAttempts
            ? `the model failed ${String(state.consecutiveLlmFailures)} times in a row`
            : null;
      if (breaker) {
        runInBackground(() =>
          append({
            type: "events.iterate.com/agent/paused",
            idempotencyKey: this.idempotencyKey(`pause/${String(trigger.offset)}`),
            payload: { reason: breaker, triggerOffset: trigger.offset },
          }),
        );
        return;
      }
      // THE DEBOUNCE: wait for more content, plus the failure backoff — one window,
      // anchored at the trigger. The delayed append IS the intent (no wake event): more words inside
      // the window move the trigger; the old trigger's intent then lands as a harmless fact (the
      // reduce opens a request only for the trigger it names) and the moved trigger's own intent, a
      // window later, opens the one request for them all — the prompt is built from the log at run
      // time. Every at-head pass inside the window schedules another
      // sleep-then-append for the same trigger, so the body is DETERMINISTIC from trigger + config
      // (expiresAt anchored at the trigger's time, never `now`): identical bodies dedupe on the key.
      // A droppable attempt: dying mid-window, the revival pass re-runs this with the window long
      // closed and appends at once.
      const windowMs = state.config.llmRequestDebounceMs + retryBackoffMs(state);
      // THE HOLD: while this loop's own script runs, the turn waits for its result (the
      // settlement's delivery re-runs this pass and the result moves the trigger), so the call is
      // answered before anything else is read — up to HOLD_FOR_RUN_MS after the oldest run began.
      const running = Object.values(state.pendingRuns).map((run) => run.requestedAt);
      const holdUntil = running.length > 0 ? Math.min(...running) + HOLD_FOR_RUN_MS : 0;
      const windowClosesInMs = Math.max(trigger.atMs + windowMs, holdUntil) - now;
      const intent: AgentEmitted = {
        type: "events.iterate.com/agent/llm-request-requested",
        idempotencyKey: this.idempotencyKey(`request/${String(trigger.offset)}`),
        payload: {
          model: llm.model,
          expiresAt: trigger.atMs + llmRequestExpiryMs,
          triggerOffset: trigger.offset,
        },
      };
      runInBackground(async () => {
        if (windowClosesInMs > 0) await this.#sleep(windowClosesInMs);
        await append(intent);
      });
      return;
    }

    // An open request nobody HERE is running, within its expiry: run it — the first time and after
    // an eviction are the same path (the engine's revive wakes a dead context while an attempt is
    // in flight; the wake's push lands here).
    const open = state.openRequest;
    // Past its expiry, a request is settled expired even when this incarnation believes it is
    // running it — its attempt is aborted: a request wedged in an await must not hold the loop.
    if (open && now >= open.expiresAt) {
      this.#llmRequestsInFlight
        .get(open.requestedAtOffset)
        ?.controller.abort(new Error("the model did not finish before the request expired"));
      runInBackground(() =>
        appendUnlessLost(append, {
          type: "events.iterate.com/agent/llm-request-settled",
          idempotencyKey: this.idempotencyKey(`settle/${String(open.requestedAtOffset)}`),
          payload: {
            requestOffset: open.requestedAtOffset,
            result: { status: "cancelled", reason: "expired" },
          },
        }),
      );
      return;
    }
    if (open && !this.#llmRequestsInFlight.has(open.requestedAtOffset)) {
      const inFlight = { controller: new AbortController(), partialText: "" };
      this.#llmRequestsInFlight.set(open.requestedAtOffset, inFlight);
      runInBackground(() => this.#runLlmRequest(open, state, append, inFlight));
    }
  }

  /** The model over the conversation up to the request, STREAMED: each coalescing window of the
   *  answer's text and thinking is one ephemeral `llm-response-frame` (a feed renders the answer as
   *  it is written); ONE batch then settles the request, lands the assistant's words and reports the
   *  cost, so an eviction between them is impossible. An interruption settles the request itself (processEvent) — an
   *  aborted stream ends here silently, and a success that raced it loses on the settle key. */
  async #runLlmRequest(
    open: NonNullable<AgentState["openRequest"]>,
    state: AgentState,
    append: AgentArgs["append"],
    inFlight: { controller: AbortController; partialText: string },
  ): Promise<void> {
    const startedAt = this.#now();
    const { controller } = inFlight;
    // Two clocks fail a stalled stream, never wedge it: the request's own expiry, and the idle
    // budget since the last provider event.
    const expiry = setTimeout(
      () => controller.abort(new Error("the model did not finish before the request expired")),
      Math.max(1_000, open.expiresAt - startedAt),
    );
    let idle = setTimeout(
      () => controller.abort(new Error("the model stream stalled")),
      STREAM_IDLE_BUDGET_MS,
    );
    try {
      const { path } = await raceAbort(controller.signal, this.#identity());
      // raced, so the expiry frees a request stuck before its stream (a hung read) too
      const input = await raceAbort(
        controller.signal,
        this.#requestInput(state, open.requestedAtOffset, open.model, append),
      );
      // THE WINDOWS: the text and thinking the stream adds pile into one buffer; a window closes
      // FRAME_WINDOW_MS after its first delta (or at the size cap) and lands as one ephemeral
      // append, windows in order — each waits for the one before. Nothing is stored: the
      // settlement below carries the durable text.
      const llmRequestOffset = open.requestedAtOffset;
      let responseDelta = "";
      let thinkingDelta = "";
      let windowOpen = false;
      let sequence = 0;
      let windows = Promise.resolve();
      const closeWindow = () => {
        windowOpen = false;
        if (!responseDelta && !thinkingDelta) return;
        const payload = { llmRequestOffset, responseDelta, thinkingDelta, sequence: sequence++ };
        responseDelta = "";
        thinkingDelta = "";
        windows = windows
          .then(() =>
            append({
              type: "events.iterate.com/agent/llm-response-frame",
              ephemeral: true,
              payload,
            }),
          )
          .then(
            () => undefined,
            () => undefined, // a lost window loses only its repaint; the settlement is the truth
          );
      };
      const settle = async (
        result: Extract<
          AgentEvent,
          { type: "events.iterate.com/agent/llm-request-settled" }
        >["payload"]["result"],
        ...alongside: AgentEmitted[]
      ) => {
        closeWindow();
        await windows; // every window before the terminal fact
        await appendUnlessLost(
          append,
          {
            type: "events.iterate.com/agent/llm-request-settled",
            idempotencyKey: this.idempotencyKey(`settle/${String(llmRequestOffset)}`),
            payload: {
              requestOffset: llmRequestOffset,
              durationMs: this.#now() - startedAt,
              result,
            },
          },
          ...alongside,
        );
      };
      let answer: StreamAnswer;
      const onDelta = (text: string, thinking: string) => {
        if (controller.signal.aborted) return;
        clearTimeout(idle);
        idle = setTimeout(
          () => controller.abort(new Error("the model stream stalled")),
          STREAM_IDLE_BUDGET_MS,
        );
        if (!text && !thinking) return; // a bookkeeping event: alive, nothing to show
        // The partial accrues BEFORE buffering: an interrupt keeps the whole streamed text even
        // when its last window never landed.
        inFlight.partialText += text;
        responseDelta += text;
        thinkingDelta += thinking;
        if (responseDelta.length + thinkingDelta.length >= FRAME_WINDOW_MAX_CHARS)
          return closeWindow();
        if (windowOpen) return;
        windowOpen = true;
        void this.#sleep(FRAME_WINDOW_MS).then(closeWindow);
      };
      try {
        const request = {
          model: open.model,
          effort: state.config.llm.reasoningEffort,
          cacheKey: promptCacheKey(path),
          signal: controller.signal,
          onDelta,
        };
        try {
          answer = await this.#stream({ ...request, input });
        } catch (error) {
          // The provider refused the replayed reasoning (a model change, a rotated key): once more
          // without it. Every other failure is the retry policy's.
          if (
            !/reasoning|encrypted_content|\brs_/i.test(String(error)) ||
            controller.signal.aborted
          )
            throw error;
          answer = await this.#stream({
            ...request,
            input: await this.#requestInput(
              state,
              open.requestedAtOffset,
              open.model,
              append,
              false,
            ),
          });
        }
      } catch (error) {
        // The interrupt path's story — it settled the request itself.
        if (controller.signal.reason instanceof InterruptedError) return;
        await settle({
          status: "failed",
          errorMessage: String(error instanceof Error ? error.message : error).slice(0, 4_000),
          partialText: inFlight.partialText || undefined,
        });
        return;
      }
      // An answer that arrived after the interruption is the interrupt path's story too.
      if (controller.signal.reason instanceof InterruptedError) return;
      const { text, call, providerItems } = answer;
      const usage = answer.usage && {
        ...answer.usage,
        costUsd: requestCostUsd(open.model, answer.usage),
      };
      await settle(
        { status: "succeeded", text, usage },
        // an empty answer adds no assistant message: nothing was said
        ...(text
          ? [
              {
                type: "events.iterate.com/agent/context-added",
                idempotencyKey: this.idempotencyKey(`assistant/${String(llmRequestOffset)}`),
                payload: {
                  role: "assistant",
                  content: text,
                  llmRequestOffset,
                  call,
                  providerItems,
                  providerModel: open.model,
                },
              } satisfies AgentEmitted,
            ]
          : []),
        ...(usage
          ? [
              {
                type: "events.iterate.com/agent/token-usage-reported",
                idempotencyKey: this.idempotencyKey(`usage/${String(llmRequestOffset)}`),
                payload: {
                  model: open.model,
                  maxContextTokens: contextWindowTokens(open.model),
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cachedInputTokens: usage.cachedInputTokens,
                  cacheWriteInputTokens: usage.cacheWriteInputTokens,
                  costUsd: usage.costUsd,
                },
              } satisfies AgentEmitted,
            ]
          : []),
      );
    } finally {
      clearTimeout(expiry);
      clearTimeout(idle);
      this.#llmRequestsInFlight.delete(open.requestedAtOffset);
    }
  }

  /** THE STANDING SECTIONS as they are now: the system prompt, the role's files (read fresh from
   *  /repos/config), the pinned preamble, the stable capability tree and this agent's identity, in
   *  that order. A file or tree that cannot be read this time keeps the version the model was shown
   *  (a passing failure must not read as the section being withdrawn); an empty file is gone. */
  async #currentSections(state: AgentState): Promise<Record<string, string>> {
    const whoami = await this.#identity();
    const { path } = whoami;
    const sections: Record<string, string> = { system: DEFAULT_AGENT_SYSTEM_PROMPT };
    for (const file of standingInstructionFiles(path)) {
      try {
        using itx = this.deps.getItx();
        // the handle first: a pipelined `get` that refuses (a project with no config repo) would
        // reject a second promise nobody awaits
        const repo = await itx.repos.get("/repos/config");
        const text = await repo.readFile(file);
        if (text) sections[file] = standingFileSection(file, text);
      } catch {
        if (state.sections[file]) sections[file] = state.sections[file]!;
      }
    }
    const pinned = preambleSection(state.preamble, state.preambleQuarantined);
    if (pinned) sections.preamble = pinned;
    try {
      using itx = this.deps.getItx();
      const tree = stableCapabilityTree(await itx.cd(path).rewriteRules.list());
      if (tree) sections["capability-tree"] = tree;
    } catch (error) {
      // a fully masked agent denies introspection too: no tree. Anything else keeps the last one.
      if (errorCode(error) !== "NO_ITX_EXPRESSION_MATCH" && state.sections["capability-tree"])
        sections["capability-tree"] = state.sections["capability-tree"]!;
    }
    sections.identity = `CURRENT PROJECT: ${JSON.stringify(whoami)}`;
    return sections;
  }

  /** Before a request: what changed in the standing sections since the model last saw them, as
   *  ONE system item keyed to the request (the head snapshot on the first request). It lands after
   *  the request's stamp and before its answer, which is exactly where every later request renders
   *  it, so the input stays append-only. Answers the item for the request being built (the state
   *  may not have it yet); null when nothing changed or the item is already in the state. */
  async #syncSections(
    state: AgentState,
    append: AgentArgs["append"],
    requestOffset: number,
  ): Promise<RenderItem | null> {
    if (state.contextItems.some((item) => item.sections && item.llmRequestOffset === requestOffset))
      return null;
    const current = await this.#currentSections(state);
    const first = Object.keys(state.sections).length === 0;
    const change = first
      ? { sections: current, content: "[standing instructions: the head snapshot]" }
      : sectionChanges(state.sections, current);
    if (!change) return null;
    const payload = {
      role: "system" as const,
      content: change.content,
      sections: change.sections,
      llmRequestOffset: requestOffset,
      ...(first && { snapshot: true }),
    };
    await appendUnlessLost(append, {
      type: "events.iterate.com/agent/context-added",
      idempotencyKey: this.idempotencyKey(`sections/${String(requestOffset)}`),
      payload,
    });
    return { offset: requestOffset + 0.5, ...payload };
  }

  /** THE INPUT of the request at `throughOffset`: its conversation (the items up to its stamp,
   *  plus the section item written for it), rendered by render.ts. A turn and the compaction of that
   *  turn build the same input, so the summary request reads it from cache. */
  async #requestInput(
    state: AgentState,
    throughOffset: number,
    model: string,
    append: AgentArgs["append"],
    replayReasoning = true,
  ): Promise<InputItem[]> {
    const { path } = await this.#identity();
    const update = await this.#syncSections(state, append, throughOffset);
    const items: RenderItem[] = [
      ...state.contextItems.filter(
        (item) =>
          item.offset <= throughOffset ||
          (item.sections && item.llmRequestOffset === throughOffset),
      ),
      ...(update ? [update] : []),
    ];
    // The images the model will see: read now, the freshest bytes at the request; one that is
    // gone (deleted meanwhile) is named instead of shown.
    const images = new Map<string, { contentType: string; base64: string }>();
    for (const item of items)
      for (const file of item.files || []) {
        if (!file.contentType.startsWith("image/") || images.has(file.path)) continue;
        try {
          using itx = this.deps.getItx();
          images.set(file.path, {
            contentType: file.contentType,
            base64: bytesToBase64(await itx.files.get(file.path).bytes()),
          });
        } catch {
          // named by its hint line instead
        }
      }
    return buildResponsesInput({
      items,
      images,
      runs: state.runs,
      model,
      ownPath: path,
      replayReasoning,
    });
  }

  /** This incarnation's compaction, so a second over-threshold request waits for the first. */
  #compacting = false;

  /** THE COMPACTION: the request's own input, the
   *  summarize instruction appended as its last message (user role: the cache breakpoint before it
   *  is the turn's own, so that whole input is read from cache), on the request's own model, the
   *  tool declared but not callable (declared, so the prefix is the turn's). The summary lands as
   *  one developer item whose `compaction` barrier the reduce applies, with what it cost. Best
   *  effort: a failure appends nothing, and the next request over the threshold tries again. */
  async #compact(input: {
    state: AgentState;
    requestOffset: number;
    model: string;
    usedTokens: number;
    thresholdTokens: number;
    append: AgentArgs["append"];
    /** An idle compaction (idle-check): a capped summary of the history since the earlier
     *  summaries, which it keeps, or of everything once they grew past their cap. */
    idle?: boolean;
  }): Promise<void> {
    const { state, requestOffset, model, usedTokens, thresholdTokens, append, idle } = input;
    const earlier = state.contextItems.filter((item) => item.compaction);
    const keepsEarlierSummaries =
      idle === true &&
      earlier.length > 0 &&
      earlier.reduce((sum, item) => sum + item.content.length, 0) <=
        state.config.idleSummariesMaxChars;
    let prompt = AGENT_COMPACTION_PROMPT;
    if (idle) prompt = keepsEarlierSummaries ? IDLE_SUMMARY_SINCE_PROMPT : IDLE_SUMMARY_PROMPT;
    try {
      const { path } = await this.#identity();
      const items = [
        ...(await this.#requestInput(state, requestOffset, model, append)),
        { role: "user", content: prompt },
      ];
      const answer = await this.#stream({
        model,
        effort: state.config.llm.reasoningEffort,
        input: items,
        cacheKey: promptCacheKey(path),
        signal: AbortSignal.timeout(state.config.llmRequestExpiryMs),
        onDelta: () => undefined,
        toolChoice: "none",
      });
      if (!answer.prose) throw new Error("the model wrote an empty summary");
      const usage = answer.usage && {
        ...answer.usage,
        costUsd: requestCostUsd(model, answer.usage),
      };
      await appendUnlessLost(append, {
        type: "events.iterate.com/agent/context-added",
        idempotencyKey: this.idempotencyKey(`compact/${String(requestOffset)}`),
        payload: {
          role: "developer",
          content: keepsEarlierSummaries
            ? `[The conversation after the summaries above was compacted through @${String(requestOffset)} while idle (~${String(historyTokensSinceSummary(state))} tokens). Summary:]\n\n${answer.prose}`
            : idle
              ? `[Earlier conversation history was compacted through @${String(requestOffset)} while idle (~${String(usedTokens)} tokens). Summary:]\n\n${answer.prose}`
              : `[Earlier conversation history was compacted through @${String(requestOffset)} (~${String(usedTokens)} tokens > ${String(thresholdTokens)}). Summary:]\n\n${answer.prose}`,
          actor: { type: "agent" },
          compaction: {
            replacesHistoryThrough: requestOffset,
            ...(keepsEarlierSummaries && { keepsEarlierSummaries: true }),
            usage,
          },
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      });
    } catch (error) {
      console.error("[agent] compaction failed", { error, requestOffset });
    }
  }

  /** One STREAMED Responses API call with the one tool: every provider event reaches `onDelta`
   *  (text and thinking it adds, both "" for any other event, which keeps the idle watchdog fed
   *  while a long script's arguments stream); the call answers once the stream ends with the
   *  response's own items (stored for exact replay), its prose, its first `run` call, and the
   *  usage. An `openai/…` Workers AI partner model through `itx.ai` and the account's AI Gateway:
   *  Cloudflare's billing, no key, and the gateway's spend limits partition on the metadata
   *  (project, stream path). `store: false` with the encrypted reasoning included: nothing lives on the provider's side,
   *  and the reasoning comes back on the next request (render.ts). */
  async #stream({
    model,
    input,
    cacheKey,
    signal,
    onDelta,
    toolChoice = "auto",
    effort,
  }: {
    model: string;
    /** The Responses API's `reasoning.effort` (the agent's config, `llm.reasoningEffort`). */
    effort: string;
    input: InputItem[];
    /** The provider's prompt-cache routing key (promptCacheKey). */
    cacheKey: string;
    signal: AbortSignal;
    onDelta(text: string, thinking: string): void;
    toolChoice?: "auto" | "none";
  }): Promise<StreamAnswer> {
    if (model.startsWith("@cf/"))
      throw new Error(
        `model ${model}: the agent speaks OpenAI's Responses API only; configure an OpenAI model`,
      );
    const { projectId, path } = await this.#identity();
    using itx = this.deps.getItx();
    const raw: unknown = await raceAbort(
      signal,
      itx.ai.run(
        // Two casts, both because workers-types spells Workers AI's OWN catalog as literals: a
        // partner model's name (`openai/…`) is not among them though the binding takes any model
        // the account can reach, and a partner model takes the PROVIDER's request body (here the
        // Responses API's), which no catalog input type names.
        `openai/${model}` as Parameters<Ai["run"]>[0],
        {
          input,
          tools: [RUN_TOOL],
          tool_choice: toolChoice,
          parallel_tool_calls: false,
          stream: true,
          store: false,
          include: ["reasoning.encrypted_content"],
          prompt_cache_key: cacheKey,
          reasoning: { effort, summary: "auto" },
        } as never,
        {
          returnRawResponse: true,
          gateway: {
            id: AI_GATEWAY_ID,
            skipCache: true,
            metadata: { projectId, streamPath: path, context: "agent-turn" },
          },
        },
      ),
    );
    if (!(raw instanceof Response))
      throw new Error(`model ${model}: Workers AI did not answer with the raw response`);
    const response = raw;
    if (!response.ok || !response.body)
      throw new Error(
        `openai/${model} ${String(response.status)}: ${(await response.text()).slice(0, 400)}`,
      );
    let usage: LlmUsage | undefined;
    const done: OutputItem[] = [];
    let output: OutputItem[] | undefined;
    await drainSse(response.body, signal, (raw) => {
      const event = ResponsesEvent.safeParse(raw);
      if (!event.success) return;
      const { type, delta, item } = event.data;
      if (type === "response.output_text.delta") onDelta(delta || "", "");
      else if (type === "response.reasoning_summary_text.delta") onDelta("", delta || "");
      else onDelta("", "");
      if (type === "response.output_item.done" && item) done.push(item);
      else if (type === "response.completed" || type === "response.incomplete") {
        const finished = z
          .looseObject({
            response: z.looseObject({ usage: z.unknown(), output: z.array(OutputItem).optional() }),
          })
          .safeParse(raw);
        if (finished.success) {
          usage = normalizeUsage(finished.data.response.usage) ?? usage;
          output = finished.data.response.output;
        }
      } else if (type === "response.failed" || type === "error") {
        const failure = z
          .looseObject({
            error: z.looseObject({ message: z.string() }).optional(),
            response: z
              .looseObject({ error: z.looseObject({ message: z.string() }).optional() })
              .optional(),
          })
          .safeParse(raw);
        throw new Error(
          `openai: ${failure.success ? failure.data.error?.message || failure.data.response?.error?.message || type : type}`,
        );
      }
    });
    const items = (output && output.length > 0 ? output : done).filter(
      (item) =>
        item.type === "reasoning" || item.type === "message" || item.type === "function_call",
    );
    const prose = items
      .map((item) => (item.type === "message" ? messageText(item) : ""))
      .join("")
      .trim();
    const first = items.find((item) => item.type === "function_call");
    let call: StreamAnswer["call"];
    if (first) {
      const { call_id: callId, arguments: args } = FunctionCallItem.parse(first);
      let run = { status: "", script: args };
      try {
        run = RunArguments.parse(JSON.parse(args));
      } catch {
        // arguments that are not `run`'s JSON are the script itself
      }
      call = { callId, status: run.status, script: run.script };
    }
    // An empty answer is the model choosing to say nothing (a chief of staff's input that needs no
    // reply): the turn ends quietly, never a failure that would retry and pause the agent.
    return { text: answerText(prose, call), prose, call, providerItems: items, usage };
  }
}
