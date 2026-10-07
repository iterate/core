// contract.ts — AN AGENT'S EVENTS AND STATE: the vocabulary the Agents app, the WhatsApp relays and
// voice read, and what a cache-friendly loop keeps beside each item: the `run` call an answer made and the provider's
// own output items (replayed verbatim, render.ts), the standing-instruction SECTIONS as positional
// items (a head snapshot, then updates where they happen), which call each script run answered, and
// what a request cost (cache writes and dollars included). An agent whose log the previous
// loop wrote has it re-reduced once, and its `<codemode>` answers render as calls.
import { z } from "zod";
// the contract module alone, never the engine: the Agents page loads this file
import { defineProcessorContract, type ProcessorState } from "../stream/contract.ts";
import { RunEventCatalog } from "../stream/run.ts";

/** Who put words into the context: a person, a script's result, or the loop itself (a format
 *  correction). A script's or the loop's words are self-triggered input — the autonomous-turn
 *  breaker counts them; a person's are external and reset it. */
const Actor = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user") }),
  z.object({ type: z.literal("script"), requestOffset: z.number().int().positive() }),
  z.object({ type: z.literal("agent") }),
]);

const Role = z.enum(["system", "developer", "user", "assistant"]);

/** A file attached to a context item (an attachment record, minus its signed URL): the
 *  project file it was stored as (`itx.files`), its content type, original name and size. */
const FileAttachment = z.object({
  contentType: z.string().min(1),
  filename: z.string().min(1),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
});
export type FileAttachment = z.infer<typeof FileAttachment>;

/** Where a request's trigger came from: a person (`external`) or the loop's own consequences. */
const TriggerSource = z.enum(["external", "agent-loop"]);

/** What a model call cost, normalized: the provider's totals, and the cached/reasoning breakdowns
 *  when it reports them. */
/** Why an LLM request stopped short: a person typed over it, or it ran past its deadline. The
 *  Agents UI reads it too (src/lib/events/agent-ui-reducer.ts). */
export const AgentLlmRequestCancelReason = z.enum(["interrupted-by-user-input", "expired"]);
export type AgentLlmRequestCancelReason = z.infer<typeof AgentLlmRequestCancelReason>;

/** What the agent is waiting for when it hands back: a person's words, something outside (a
 *  webhook, another agent's report), or a time it set. Cleared when a person's words arrive. */
const WaitingFor = z.enum(["user_input", "external_event", "timer"]);

const LlmUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  /** Input written to the prompt cache (billed 1.25x for the GPT-6 family). */
  cacheWriteInputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  /** What the request cost in US dollars (pricing.ts), when the model has a price. */
  costUsd: z.number().nonnegative().optional(),
});
export type LlmUsage = z.infer<typeof LlmUsage>;

/** A compaction summary's barrier: the offset through which it replaced the conversation, and what
 *  the summary request cost. An idle summary that `keepsEarlierSummaries` covers only the history
 *  after the newest earlier summary, and those stay in the conversation word for word. */
const Compaction = z.object({
  replacesHistoryThrough: z.number().int().positive(),
  keepsEarlierSummaries: z.boolean().optional(),
  usage: LlmUsage.optional(),
});

/** The `run` call an answer made: its id (the provider's call_id), its status label and script. */
const RunCall = z.object({ callId: z.string().min(1), status: z.string(), script: z.string() });

/** Standing-instruction sections an item sets, by name (null: the section is gone). */
const Sections = z.record(z.string(), z.string().nullable());

export const AgentContract = defineProcessorContract({
  slug: "agent",
  // Bumping the version re-reduces every agent's log from offset 0 (stream/processor.ts).
  version: "16",
  description:
    "An agent: a conversation on its own context, driven by a model that acts through one tool, run(script), against itx; each request's input extends the previous one, so the provider's prompt cache holds the conversation.",
  /** THE REDUCED STATE — what the reduce keeps between events: where creation stands (as the OFFSET
   *  of the event that says so — the request, the certificate, or the failure; read that event for
   *  the error), where deletion stands the same way (the request, or the certificate — set, the loop
   *  runs no more turns), the conversation as the model will read it, and the loop's obligations —
   *  the one pending trigger, the one open request, the breakers' counts, a pause (a script it asked
   *  for is the CONTEXT's obligation: core state `runs`). It is the checkpoint the facet stores, what
   *  `snapshot()` and `liveSnapshot()` answer, the guard `message()` reads before it speaks, and
   *  what the agents app renders as the live status beside the log. */
  stateSchema: z.object({
    creation: z
      .object({
        status: z.enum(["requested", "created", "failed"]),
        offset: z.number().int().positive(),
      })
      .nullable()
      .default(null),
    /** Where deletion stands, as the offset of the event that says so; null while the agent lives. */
    deletion: z
      .object({
        status: z.enum(["requested", "deleted"]),
        offset: z.number().int().positive(),
      })
      .nullable()
      .default(null),
    /** The knobs `agent/configured` patches; every one defaulted, so `{}` is a whole config. */
    config: z
      .object({
        llm: z
          // OpenAI's gpt-6.1-sol at medium reasoning effort by default: a fifth of
          // gpt-6-astra's input price and a tenth of its cached price. `reasoningEffort` is the
          // Responses API's `reasoning.effort`; reasoning tokens are billed as output.
          .object({
            model: z.string().min(1).default("gpt-6.1-sol"),
            reasoningEffort: z.string().min(1).default("medium"),
            // Empty uses the deployment's AI Gateway; otherwise see responses-keys.ts for key handling.
            apiKeys: z.array(z.string().min(1)).default([]),
          })
          .prefault({}),
        /** Consecutive self-triggered turns (script results, corrections) before the loop pauses. */
        maxAutonomousTurns: z.number().int().positive().default(50),
        /** How long a recorded request stays runnable; past it, settled as expired. */
        llmRequestExpiryMs: z
          .number()
          .int()
          .positive()
          .default(10 * 60_000),
        /** The debounce window: a request waits this long after its trigger for more content — a second
         *  message inside the window moves the trigger and ONE request answers both. */
        llmRequestDebounceMs: z.number().int().nonnegative().default(250),
        /** Consecutive model failures before the loop pauses; between attempts, the backoff —
         *  `backoffBaseMs · 2^(failures−1)`, capped at `backoffMaxMs` — folded into the debounce window. */
        llmRequestRetryPolicy: z
          .object({
            maxAttempts: z.number().int().positive().default(3),
            backoffBaseMs: z.number().int().nonnegative().default(2_000),
            backoffMaxMs: z.number().int().nonnegative().default(60_000),
          })
          .prefault({}),
        /** A script result longer than this (in characters) is written to its file and renders as
         *  its shape plus a preview (result-render.ts). */
        scriptResultHistoryLimit: z.number().int().positive().default(30_000),
        /** The share of the model's context window a request may fill before the conversation up
         *  to it is compacted into a summary (processor.ts `#compact`). */
        compactionTriggerFraction: z.number().positive().max(1).default(0.5),
        /** IDLE COMPACTION, off by default (0): this long after a request settles with no activity
         *  since, the history
         *  after the newest summary, when it is at least `idleCompactionMinNewTokens` (estimated
         *  from its characters), is summarized while the provider still holds it in cache (OpenAI
         *  keeps a prefix 30 minutes after its last use), so the next wake-up re-sends short
         *  summaries instead of the whole history uncached. Earlier summaries stay word for word
         *  until together they pass `idleSummariesMaxChars`; the next idle summary then merges
         *  them all into one. */
        idleCompactionAfterMs: z.number().int().nonnegative().default(0),
        idleCompactionMinNewTokens: z.number().int().positive().default(30_000),
        idleSummariesMaxChars: z.number().int().positive().default(40_000),
        /** KEEP-WARM: a long-lived agent (`/agents/<name>`) keeps its history cached this long
         *  after its last request, with a ping every `keepWarmEveryMs` (a cache read refreshes
         *  OpenAI's 30 minutes), and only then has its idle summary: a ping costs a twenty-fifth of
         *  re-sending the history, and a quiet hour stays lossless. Off by default (0); the pings ride
         *  the idle check, so they need `idleCompactionAfterMs` too. A voice call's agent does
         *  neither: its call is over. */
        keepWarmForMs: z.number().int().nonnegative().default(0),
        keepWarmEveryMs: z
          .number()
          .int()
          .positive()
          .default(25 * 60_000),
      })
      .prefault({}),
    /** Every model-visible item, in offset order — the conversation the next request is built from. */
    contextItems: z
      .array(
        z.object({
          offset: z.number().int().positive(),
          role: Role,
          content: z.string(),
          actor: Actor.optional(),
          llmRequestOffset: z.number().int().positive().optional(),
          files: z.array(FileAttachment).optional(),
          /** The context it came from, when another one sent it (processor.ts, the fold): the
           *  model reads it as `[from <context>]`. */
          from: z.string().optional(),
          /** A compaction summary: it replaced every non-system item through this offset. */
          compaction: Compaction.optional(),
          /** An answer's `run` call, and the provider's output items for exact replay. */
          call: RunCall.optional(),
          providerItems: z.array(z.unknown()).optional(),
          providerModel: z.string().optional(),
          /** A standing-instructions item; `snapshot` marks the conversation's head copy. */
          sections: Sections.optional(),
          snapshot: z.boolean().optional(),
          /** A request's stamp, at the request's own offset. */
          stamp: z.boolean().optional(),
        }),
      )
      .default([]),
    /** The standing sections as the model has been shown them (the head snapshot and every update
     *  since), by name: what a fresh read is compared with before each request. */
    sections: z.record(z.string(), z.string()).default({}),
    /** Which call each of this loop's script runs answered: run request offset → call id. */
    runs: z.record(z.string(), z.object({ callId: z.string() })).default({}),
    /** The call of the newest answer whose run has not been requested yet. */
    awaitingRun: z.object({ callId: z.string() }).nullable().default(null),
    /** The script runs this loop asked for and that have not settled, by request offset, with
     *  when they were asked for: only their settlements become the model's input. */
    pendingRuns: z.record(z.string(), z.object({ requestedAt: z.number() })).default({}),
    /** This loop's newest script outcomes, oldest first: every script's `results` (results-preamble.ts). */
    scriptResults: z
      .array(
        z.object({
          offset: z.number().int().positive(),
          requestOffset: z.number().int().positive(),
          kind: z.enum(["data", "large", "error", "done"]),
          json: z.string().optional(),
          path: z.string().optional(),
          text: z.boolean().optional(),
          error: z.string().optional(),
        }),
      )
      .default([]),
    /** What the agent says about itself (`agent/summary-updated`): its own title, what it is doing
     *  now, what it is waiting for, and a sentence on its purpose or conclusions. The Agents app
     *  titles the agent with `title` when set. */
    summary: z
      .object({
        title: z.string().nullable().default(null),
        activity: z.string().nullable().default(null),
        waitingFor: WaitingFor.nullable().default(null),
        description: z.string().nullable().default(null),
      })
      .prefault({}),
    /** Code pinned above every later script (`agent/preamble-entry-set`), in first-set order. */
    preamble: z.array(z.object({ key: z.string(), code: z.string() })).default([]),
    /** The pinned entries the loop took out because they broke scripts, newest last, until their
     *  key is set again (`agent/preamble-entry-quarantined`, or an entry the reduce would not pin
     *  past the ceiling): the PINNED PREAMBLE section names them (results-preamble.ts). */
    preambleQuarantined: z
      .array(z.object({ key: z.string(), error: z.string(), offset: z.number().int().positive() }))
      .default([]),
    /** The ONE trigger the next request answers; null once a request has been recorded for it.
     *  `gate`: every input it stands for came from another agent, and these offsets wait for the
     *  project's gate (`agent/input-gated`) before a request is recorded; absent, nothing waits. */
    pendingLlmRequestTrigger: z
      .object({
        offset: z.number().int().positive(),
        atMs: z.number(),
        source: TriggerSource,
        gate: z.object({ waiting: z.array(z.number().int().positive()) }).optional(),
      })
      .nullable()
      .default(null),
    /** The one recorded request not yet settled: the loop's obligation, whichever incarnation runs it. */
    openRequest: z
      .object({
        requestedAtOffset: z.number().int().positive(),
        expiresAt: z.number(),
        model: z.string(),
        triggerSource: TriggerSource,
      })
      .nullable()
      .default(null),
    consecutiveLlmFailures: z.number().int().nonnegative().default(0),
    autonomousTurnCount: z.number().int().nonnegative().default(0),
    /** When the state last moved: the `createdAt` of the last event the reduce changed it for —
     *  words in, a request opened or settled, a pause. What the agents app's sidebar orders by. */
    lastActivityAt: z.string().nullable().default(null),
    /** Set by `agent/paused` (the breakers, or an operator); cleared by `agent/resumed`. */
    paused: z
      .object({ reason: z.string(), atOffset: z.number().int().positive() })
      .nullable()
      .default(null),
    /** THE ANSWER OWED: the newest input that must be answered (processor.ts `answerOwedFor`: a
     *  job an agent scheduled, or words marked `answerOwed`), described for the reminder, until
     *  the model ends a turn itself (words, or a deliberate empty answer) or a turn ends after its
     *  one reminder. A turn about to end on a script that returned nothing while this is owed is
     *  asked once more (`agent/answer-reminded`, which sets `reminded`). */
    owedAnswer: z
      .object({
        offset: z.number().int().positive(),
        why: z.string(),
        reminded: z.boolean().default(false),
      })
      .nullable()
      .default(null),
  }),
  events: {
    "events.iterate.com/agent/create-requested": {
      description:
        "Someone asked for this agent (`itx.agents.create(path)`). No payload: the context it lands on IS the agent. The collection writes the child's parent link `itx ⇒ itx.cd(creator)` before this request, the creator being the context whose `itx.agents` reached the collection, so the link is part of the birth and nothing re-points a born context. The processor lands created (with the default system prompt beside it) or create-failed; a request after a failure is a new attempt, one after the certificate a harmless fact.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/agent/created": {
      description:
        "The birth certificate: on the agent's path, and cross-posted to / for the project catalog — hence it names the path.",
      payloadSchema: z.object({ path: z.string().min(1) }),
    },
    "events.iterate.com/agent/create-failed": {
      description: "What the birth reported. Terminal until a new request.",
      payloadSchema: z.object({ error: z.string() }),
    },
    "events.iterate.com/agent/delete-requested": {
      description:
        "Someone asked for this agent to go (`itx.agents.delete(path)`). No payload: the context it lands on IS the agent. Nothing to tear down — the processor lands deleted, and the loop runs no more turns from here on; a request after the certificate is a harmless fact.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/agent/deleted": {
      description:
        "The death certificate: on the agent's path, and cross-posted to / for the project catalog, which drops the entry and keeps the death — hence it names the path. Terminal: a deleted agent is not re-creatable, and its facet is never hosted again.",
      payloadSchema: z.object({ path: z.string().min(1) }),
    },
    "events.iterate.com/agent/configured": {
      description:
        "Merges a partial configuration into the agent's config; omitted keys keep their values.",
      payloadSchema: z.object({
        config: z.object({
          llm: z
            .object({
              model: z.string().min(1).optional(),
              reasoningEffort: z.string().min(1).optional(),
              apiKeys: z.array(z.string().min(1)).optional(),
            })
            .optional(),
          maxAutonomousTurns: z.number().int().positive().optional(),
          llmRequestExpiryMs: z.number().int().positive().optional(),
          llmRequestDebounceMs: z.number().int().nonnegative().optional(),
          scriptResultHistoryLimit: z.number().int().positive().optional(),
          compactionTriggerFraction: z.number().positive().max(1).optional(),
          idleCompactionAfterMs: z.number().int().nonnegative().optional(),
          idleCompactionMinNewTokens: z.number().int().positive().optional(),
          idleSummariesMaxChars: z.number().int().positive().optional(),
          keepWarmForMs: z.number().int().nonnegative().optional(),
          keepWarmEveryMs: z.number().int().positive().optional(),
          llmRequestRetryPolicy: z
            .object({
              maxAttempts: z.number().int().positive().optional(),
              backoffBaseMs: z.number().int().nonnegative().optional(),
              backoffMaxMs: z.number().int().nonnegative().optional(),
            })
            .optional(),
        }),
      }),
    },
    "events.iterate.com/agent/context-added": {
      description:
        "Words into the model's context — the everyday event. A user or developer item raises the pending trigger unless its policy says not to; the assistant's own output carries llmRequestOffset.",
      payloadSchema: z.object({
        role: Role,
        content: z.string(),
        actor: Actor.optional(),
        /** What rides with the words: files stored under this agent's path (`message()` stores them). */
        files: z.array(FileAttachment).optional(),
        /** The context that sent the words through `itx.agents.get(path).message(…)`, as the
         *  collection relays it (collection.ts): the agent's own facet appends them, so their
         *  `source.origin` is the agent itself. */
        from: z.string().optional(),
        /** The policies: `dont-trigger-request` (words that raise no turn), `after-current-request`
         *  (the default: the next turn), `interrupt-current-request` (cut the running answer short —
         *  the request settles cancelled with what streamed so far, and these words start the next). */
        llmRequestPolicy: z
          .object({
            behaviour: z.enum([
              "dont-trigger-request",
              "after-current-request",
              "interrupt-current-request",
            ]),
          })
          .optional(),
        /** Words that must be answered (a person's request): a turn that would end on a script
         *  returning nothing, before anything was said, is asked once more (`owedAnswer`). An input
         *  a schedule delivers is owed by default when the schedule was set by a script (a job an
         *  agent scheduled), not by the project's code at `/`; `false` opts it out. */
        answerOwed: z.boolean().optional(),
        llmRequestOffset: z.number().int().positive().optional(),
        /** A compaction summary (processor.ts `#compact`), on a developer item: it replaces every
         *  non-system item through `replacesHistoryThrough`. */
        compaction: Compaction.optional(),
        /** On an answer: its `run` call, and the provider's output items with the model that
         *  wrote them, replayed verbatim on later requests (render.ts). */
        call: RunCall.optional(),
        providerItems: z.array(z.unknown()).optional(),
        providerModel: z.string().optional(),
        /** On a system item the loop wrote: the standing sections it sets, as the content renders
         *  them; `snapshot` for the head copy. */
        sections: Sections.optional(),
        snapshot: z.boolean().optional(),
      }),
    },
    "events.iterate.com/agent/preamble-entry-set": {
      description:
        "Code pinned above every later script of this agent (a script's `setPreamble({ key, code })`), or removed (`code: null`). Entries keep first-set order; setting a key again replaces its code in place.",
      payloadSchema: z.object({ key: z.string().min(1), code: z.string().nullable() }),
    },
    "events.iterate.com/agent/preamble-entry-quarantined": {
      description:
        "A pinned entry the loop took out because it broke scripts: the script envelope would not load with it (found before a run, which then went ahead without it), or it threw before a script began (`requestOffset` names that run). It is removed as `code: null` removes it; its code stays here, and the PINNED PREAMBLE section names it until its key is set again.",
      payloadSchema: z.object({
        key: z.string().min(1),
        code: z.string(),
        error: z.string().min(1),
        requestOffset: z.number().int().positive().optional(),
      }),
    },
    "events.iterate.com/agent/web-message-sent": {
      description:
        "THE assistant-message fact: the markdown outside the tag, what a person is shown; llmRequestOffset names the answer it came from, and besideScript marks prose written beside a script, before its result.",
      payloadSchema: z.object({
        message: z.string().min(1),
        llmRequestOffset: z.number().int().positive().optional(),
        /** The answer also held a script, so these words were written before its result: a reader
         *  that may state only verified results (a voice call) holds them back. */
        besideScript: z.literal(true).optional(),
      }),
    },
    "events.iterate.com/agent/summary-updated": {
      description:
        "What the agent says about itself, each field optional and merged: `activity` (the tag's status attribute, what it is doing now), `title` (its own short title), `waitingFor` (what it handed back waiting on; null clears it — a prose-only answer sets user_input, a person's words clear it) and `description` (its purpose or conclusions). A script sets them with `setSummary`.",
      payloadSchema: z.object({
        activity: z.string().min(1).optional(),
        title: z.string().min(1).max(200).optional(),
        waitingFor: WaitingFor.nullable().optional(),
        description: z.string().min(1).max(1_000).optional(),
      }),
    },
    "events.iterate.com/agent/llm-request-requested": {
      description:
        "The loop recorded its intent to run the model for ONE trigger (the offset it names); the event's offset is the request's identity. An intent whose trigger has moved on is a harmless fact.",
      payloadSchema: z.object({
        model: z.string().min(1),
        expiresAt: z.number(),
        triggerOffset: z.number().int().positive(),
      }),
    },
    "events.iterate.com/agent/llm-response-frame": {
      description:
        "EPHEMERAL, never stored: one coalescing window of the answer being written for the request it names — the text and the thinking it adds, which a feed appends to what it has shown. The settled event carries the durable text.",
      ephemeral: true,
      payloadSchema: z.object({
        llmRequestOffset: z.number().int().positive(),
        /** The answer text this window adds ("" when it adds only thinking). */
        responseDelta: z.string(),
        /** The model's thinking (a reasoning summary) this window adds ("" when it adds only text). */
        thinkingDelta: z.string(),
        /** The window's ordinal within the response — a redelivered window is told from a new one. */
        sequence: z.number().int().nonnegative(),
      }),
    },
    "events.iterate.com/agent/llm-request-settled": {
      description:
        "The request's terminal fact: the model's text (and what it cost), its failure, its expiry, or the person's interruption — the two last with whatever streamed before.",
      payloadSchema: z.object({
        requestOffset: z.number().int().positive(),
        durationMs: z.number().nonnegative().optional(),
        result: z.discriminatedUnion("status", [
          z.object({
            status: z.literal("succeeded"),
            text: z.string(),
            usage: LlmUsage.optional(),
          }),
          z.object({
            status: z.literal("failed"),
            errorMessage: z.string(),
            partialText: z.string().optional(),
          }),
          z.object({
            status: z.literal("cancelled"),
            reason: AgentLlmRequestCancelReason,
            partialText: z.string().optional(),
          }),
        ]),
      }),
    },
    "events.iterate.com/agent/token-usage-reported": {
      description:
        "What the last successful request cost against the model's context window (the platform's vocabulary; a feed shows the context's fullness).",
      payloadSchema: z.object({
        model: z.string().min(1),
        maxContextTokens: z.number().int().positive(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative().optional(),
        cacheWriteInputTokens: z.number().int().nonnegative().optional(),
        costUsd: z.number().nonnegative().optional(),
      }),
    },
    "events.iterate.com/agent/paused": {
      description:
        "New turns stay parked until agent/resumed: a breaker tripped, or an operator paused.",
      payloadSchema: z.object({
        reason: z.string(),
        triggerOffset: z.number().int().positive().optional(),
      }),
    },
    "events.iterate.com/agent/resumed": {
      description: "Turns run again; the breakers' counts start over.",
      payloadSchema: z.object({ reason: z.string().optional() }),
    },
    "events.iterate.com/agent/idle-check": {
      description:
        "The agent's own schedule (`idle-compaction`, set when a request settles) firing: if nothing happened since the request it names, a ping keeps the conversation cached until `keepWarmUntil`, and after that it is compacted while it is still cached.",
      payloadSchema: z.object({
        afterRequestOffset: z.number().int().positive(),
        inputTokens: z.number().int().nonnegative(),
        /** Until when pings keep the history cached (a long-lived agent's): ISO. */
        keepWarmUntil: z.string().optional(),
      }),
    },
    "events.iterate.com/agent/cache-kept-warm": {
      description:
        "A keep-warm ping: the request it names re-read from the provider's prompt cache, so the history stays cached 30 more minutes, and what that cost.",
      payloadSchema: z.object({
        afterRequestOffset: z.number().int().positive(),
        usage: LlmUsage.optional(),
      }),
    },
    "events.iterate.com/agent/input-gated": {
      description:
        "The project's gate (message.ts `AgentInputGate`, set by the config's agents.ts) on words another agent sent without `trigger: false`: `wake` lets the input at `inputOffset` start a turn; otherwise it stays context, read on the next turn. `decision` is the gate's record (the triage decision, its probability and reason). A decision for an input no longer waiting is a harmless fact.",
      payloadSchema: z.object({
        inputOffset: z.number().int().positive(),
        wake: z.boolean(),
        decision: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    "events.iterate.com/agent/answer-reminded": {
      description:
        "A turn that owed an answer (the input at `inputOffset`: a job an agent scheduled, or words marked answerOwed) was about to end on the script at `runRequestOffset` returning nothing, with nothing said: that script's result note, beside this event, asks the model once more, and starts one more request. Once per owed input.",
      payloadSchema: z.object({
        inputOffset: z.number().int().positive(),
        runRequestOffset: z.number().int().positive(),
        why: z.string(),
      }),
    },
  },
  // The script events are the CONTEXT's (`itx/run-requested` / `run-settled`): the agent asks,
  // the context runs, the agent reads the settlement as the next developer item.
  processorDeps: [RunEventCatalog],
  consumes: [
    "events.iterate.com/agent/create-requested",
    "events.iterate.com/agent/created",
    "events.iterate.com/agent/create-failed",
    "events.iterate.com/agent/delete-requested",
    "events.iterate.com/agent/deleted",
    "events.iterate.com/agent/configured",
    "events.iterate.com/agent/context-added",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-settled",
    "events.iterate.com/agent/paused",
    "events.iterate.com/agent/resumed",
    "events.iterate.com/agent/preamble-entry-set",
    "events.iterate.com/agent/preamble-entry-quarantined",
    "events.iterate.com/agent/summary-updated",
    "events.iterate.com/agent/idle-check",
    "events.iterate.com/agent/answer-reminded",
    "events.iterate.com/agent/input-gated",
    "events.iterate.com/itx/run-requested",
    "events.iterate.com/itx/run-settled",
  ],
  emits: [
    "events.iterate.com/agent/created",
    "events.iterate.com/agent/create-failed",
    "events.iterate.com/agent/configured",
    "events.iterate.com/agent/deleted",
    "events.iterate.com/agent/context-added",
    "events.iterate.com/agent/web-message-sent",
    "events.iterate.com/agent/summary-updated",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-response-frame",
    "events.iterate.com/agent/llm-request-settled",
    "events.iterate.com/agent/token-usage-reported",
    "events.iterate.com/agent/cache-kept-warm",
    "events.iterate.com/agent/answer-reminded",
    "events.iterate.com/agent/paused",
    "events.iterate.com/agent/resumed",
    "events.iterate.com/agent/preamble-entry-quarantined",
    "events.iterate.com/agent/input-gated",
    "events.iterate.com/itx/run-requested",
  ],
});

/** The agent's reduced state: where its creation and deletion stand, the conversation, and the
 *  loop's obligations (the contract's `stateSchema`). */
export type AgentState = ProcessorState<typeof AgentContract>;
