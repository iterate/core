// contract.ts — AN AGENT IN ONE CONTRACT: every fact the agent reads or writes, its configuration and
// its reduced state. processor.ts is the agent's processor over these facts. Read this file first.
//
// THE AGENT HAS ONE INPUT: `agent/context-added`, something the model should know, with what it
// starts. It is loosely typed on purpose: words, a role, and the files it names. It is the ONLY way
// words reach the agent. A person, a script (an `itx.append` on the agent's path), another agent and
// a schedule write it. What HAPPENED in another domain (a Slack message, a GitHub webhook) is a typed
// fact of that domain, and that domain's processor appends `agent/context-added` with `source`, the
// raw fact the words were made from. So the log keeps both: what happened, and what the model was
// told. WHO SENT AN INPUT is the platform's stamp on it (`source.origin`): the agent words it for the
// model when it folds the input (processor.ts, `senderOf`). No payload names its sender.
//
// THE AGENT AND THE LLM REQUESTS ARE COUPLED BY FACTS AND BY NOTHING ELSE. The request facts are
// owned by their own contract (llm-request.ts), which this one lists in its `processorDeps`, as the
// request maker's contract (llm-api.ts) does. The agent (processor.ts) writes that it asks a model,
// and what it asks. A stream processor of an API shape (llm-api.ts: OpenAI Responses, Anthropic
// Messages, Chat Completions, Google generateContent), in a facet of its own, reads that fact, sends
// the request and writes what came back. Which processor takes a model is configuration
// (`llmProviders`), so a server in a basement that speaks Chat Completions is one
// `agent/configured` fact, and a test that fakes every model is one processor that writes
// `llm-request/settled`. The agent's code and host do not change for either.
//
// ANY CONTEXT CAN RUN AN AGENT: enable the processor `agent` (facet.ts) on it. `/agents/<name>` is
// where `itx.agents.create` puts one, not the only place.
//
// THE FACTS OF ONE EXCHANGE, IN THE ORDER THEY HAPPEN (and who writes each)
//
//   agent/context-added                THE INPUT. Anyone writes it: a person, a script, a processor
//                                      for its domain's facts, another agent, a schedule.
//   agent/context-copied               a forked subagent's copy of its parent's conversation
//                                      (start.ts): it stands first, and starts nothing.
//   llm-request/*                      THE REQUEST PROTOCOL (llm-request.ts): the agent asks, a request
//                                      maker starts each attempt, streams and settles. The request
//                                      fact's offset IS the request. (`agent/llm-request-triggered`:
//                                      anyone says a request must start now, and why.)
//   itx/run-requested, itx/run-settled the script of a response. The platform runs it. The offset of
//                                      the settled fact is the result's NUMBER: a later script reads
//                                      it from the log with `await result(n)` (script-envelope.ts).
//   agent-ui/message-sent, …           words: THE SCRIPT appends them, each a fact of its channel.
//                                      The agent itself never writes words.
//   agent/summary-updated              what the agent does now: the script appends it.
//   agent/subagent-requested           the script asks for a subagent, forked or not. The mind's
//                                      worker answers: agent/subagent-started or -failed.
//
// In the base nobody decides first: an input starts what its policy says, at once, and every script
// runs. A subclass lets someone decide first (agent-with-decision-models.ts).
//
// A request ENDS at the first of `llm-request/settled` and `llm-request/deadline-passed`. A response
// COUNTS (its script runs) only when the request succeeded and nothing overtook it: no input came to
// interrupt it, and no other response answered its inputs first.
//
// The agent's own facts keep production's names wherever production has the fact
// (core/lib/src/agents/contract.ts). The request facts do not: they are in their own namespace,
// `llm-request/`, and a fresh mind gets them so. A type is spelled out in full wherever it is used
// (docs/coding-style.md): search for one, and you find every producer and every consumer.

import { z } from "zod";
import { parse } from "iterate/expression";
import {
  defineProcessorContract,
  type EventInput,
  type ProcessorState,
} from "iterate/stream/processor";
import { RunEventCatalog } from "iterate/stream/run";
import {
  ConversationItem,
  FileAttachment,
  LlmRequestContract,
  type LlmUsage,
} from "./llm-request.ts";

/** The reducer's version. A bump re-reduces every agent's log from offset 0. That starts nothing a
 *  second time: everything the agent writes has an idempotency key that names its decision point
 *  (request n, the script of request r), and those follow from the log. */
const AGENT_VERSION = "3";

/** What an input does to the agent's requests. Production's three behaviours. */
export const LlmRequestPolicy = z.object({
  behaviour: z.enum(["dont-trigger-request", "after-current-request", "interrupt-current-request"]),
});
export type LlmRequestBehaviour = z.infer<typeof LlmRequestPolicy>["behaviour"];

/** The AI binding of a provider that names none: the mind's AI Gateway. */
export const CLOUDFLARE_AI_BINDING = "itx.ai";

/** AN ITX EXPRESSION AS TEXT, such as `itx.ai` or `itx.minds.get("llm.example")`. A request maker
 *  reads it on the agent's context. Text that the platform's parser refuses is refused here, so a
 *  config patch with such text changes nothing. */
const ItxExpressionText = z.string().refine(isItxExpression, {
  message: "an itx expression: it starts with `itx`",
});

function isItxExpression(text: string): boolean {
  try {
    return parse(text)[0] === "itx";
  } catch {
    return false;
  }
}

export const AgentConfig = z.object({
  /** What the model is told before the conversation. A change starts a new prompt cache. The
   *  default names no channel: the mind's `worker.ts` adds the fragments of the channels the agent
   *  may use (fragments.ts). */
  instructions: z
    .string()
    .default(
      "You are an agent on the iterate platform. Everything you do, you do by a script: " +
        "JavaScript with this context's `itx`.",
    ),
  llm: z
    .object({
      /** The model as the AI Gateway names it, `<provider>/<model>`: what `itx.ai.run` takes. The
       *  first part names its provider in `llmProviders`. It can change between two requests: the
       *  conversation is kept in a form every provider reads. */
      model: z
        .string()
        .regex(/^[a-z0-9-]+\/.+$/)
        .default("openai/gpt-6.2-sol"),
      reasoningEffort: z.string().min(1).nullable().default(null),
      /** Null: the provider's own limit. (Anthropic refuses a request with none, so it gets 8,192.) */
      maxOutputTokens: z.number().int().positive().nullable().default(null),
      /** A provider that sends nothing for this long has failed the attempt. */
      streamIdleTimeoutMs: z.number().int().positive().default(60_000),
      /** The key a provider groups its prompt cache by, on every request. Null: the agent's path.
       *  A forked subagent gets its parent's key, so that its first request reads the parent's
       *  cache. */
      promptCacheKey: z.string().min(1).nullable().default(null),
    })
    .prefault({}),
  /** THE LLM PROVIDERS, by the first part of a model's name: the shape of each one's API, and how
   *  it is reached. The processor of that API shape (llm-api.ts) sends the requests for its models;
   *  the agent reads none of this. Any server that speaks one of the shapes is one entry:
   *    agent/configured { config: { llmProviders: { basement: { api: "chat-completions",
   *      baseUrl: "https://llm.example/v1", headers: { authorization: 'Bearer getSecret("/secrets/basement")' } } } } }
   *  makes `basement/llama-5` a model the agent can ask.
   *
   *  HOW A PROVIDER IS REACHED is two itx expressions, read on the agent's context. With no
   *  `baseUrl`, the requests go through `cloudflareAiBinding`. With a `baseUrl`, they go there through `fetcher`. */
  llmProviders: z
    .record(
      z.string(),
      z.object({
        /** `openai-responses`, `anthropic-messages`, `chat-completions`, `google-generate-content`. */
        api: z.string().min(1),
        /** A CLOUDFLARE AI BINDING, or anything of its shape: `run(model, body, options)`. `itx.ai` is the mind's
         *  AI Gateway (unified billing, no key in the mind). `itx.iterateCloud.ai` is the binding
         *  that iterate Cloud lends. It is used when the provider has no `baseUrl`. */
        cloudflareAiBinding: ItxExpressionText.default(CLOUDFLARE_AI_BINDING),
        /** Set: the requests go straight to this address, as HTTP, through `fetcher`. */
        baseUrl: z.string().min(1).nullable().default(null),
        /** THE FETCHER of a provider with a `baseUrl`: anything that has `fetch(request)`. `itx`
         *  is the context's own `itx.fetch`. `itx.minds.get("llm.example")` sends the request
         *  signed as this mind. A lent stub is a server on someone's machine. Null: the facet's own
         *  `fetch`, which is the mind's egress. A header's `getSecret("…")` becomes the secret
         *  only where the request leaves through the mind's egress. */
        fetcher: ItxExpressionText.nullable().default(null),
        headers: z.record(z.string(), z.string()).default({}),
        /** `openai-responses` only: a WebSocket that stays open between requests. */
        webSocket: z
          .object({ url: z.string().min(1), authorization: z.string().min(1) })
          .nullable()
          .default(null),
      }),
    )
    .prefault({
      openai: { api: "openai-responses" },
      anthropic: { api: "anthropic-messages" },
      google: { api: "google-generate-content" },
      xai: { api: "chat-completions" },
    }),
  /** The AI Gateway of a provider with no `baseUrl`. (A mind enrolled in iterate Cloud gets the
   *  Cloud's gateway whatever it names.) */
  aiGateway: z.object({ id: z.string().min(1).default("default") }).prefault({}),
  /** What an input that names no policy of its own does to a request that is open: wait for it,
   *  or interrupt it. */
  llmRequestPolicy: z
    .object({ behaviour: z.enum(["after-current-request", "interrupt-current-request"]) })
    .default({ behaviour: "after-current-request" }),
  /** How long the agent waits between wanting a request and asking, so that more context can be
   *  added to the same request. 0 asks at once. */
  llmRequestDebounceMs: z.number().int().nonnegative().default(0),
  /** A request's deadline, from its request fact. */
  llmRequestExpiryMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60_000),
  /** HOW LONG THE AGENT WAITS FOR A PROCESSOR TO ACT ON A REQUEST. They meet only in the log, so
   *  the agent cannot know whether any processor is there. A request that no processor has sent
   *  after this long, and a cancelled request that none has settled after this long, the agent
   *  settles itself, and says so (`llm-request/wait-ended`). */
  llmProviderWaitMs: z.number().int().positive().default(10_000),
  /** `maxAttempts` bounds two things: how often one request is sent (a host that dies mid-request
   *  sends again), and how many requests fail in a row before the agent pauses. */
  llmRequestRetryPolicy: z
    .object({
      maxAttempts: z.number().int().positive().default(3),
      backoffBaseMs: z.number().int().nonnegative().default(2_000),
      backoffMaxMs: z.number().int().nonnegative().default(60_000),
    })
    .prefault({}),
  /** The agent pauses after this many requests of its own with no input from outside in between. */
  maxLlmRequestsWithoutOutsideInput: z.number().int().positive().default(50),
  /** A script result up to this many characters is shown to the model whole. A longer one is shown
   *  as its shape, and a later script reads it whole from the log with `await result(n)`. */
  scriptResultHistoryLimit: z.number().int().positive().default(30_000),
  /** WHEN A SUMMARY REPLACES THE HISTORY. Every request reads the whole history again, and a cached
   *  token still costs a tenth: that is rent. A summary is a purchase. The agent summarises when the
   *  rent paid since the last summary reaches `rentFactor` summaries' cost, or in the last minutes
   *  before the provider drops its cache, when reading the history cold would cost more than a
   *  summary. `rentFactor` is what detail is worth: 1 is cheapest, a larger one keeps detail longer. */
  summary: z
    .object({
      rentFactor: z.number().positive().default(1),
      /** A history smaller than this is never summarised. */
      minInputTokens: z.number().int().positive().default(20_000),
      maxOutputTokens: z.number().int().positive().default(2_000),
      /** How long a provider keeps a prompt cached after its last use. */
      cacheLifetimeMs: z
        .number()
        .int()
        .positive()
        .default(30 * 60_000),
      /** The newest items stay as they are. */
      keepNewestItems: z.number().int().nonnegative().default(6),
    })
    .prefault({}),
  /** US dollars for a million tokens, by model. OpenAI's are production's
   *  (core/lib/src/agents/pricing.ts, OpenAI's price page on 18 November 2026). Anthropic's and
   *  Google's are this repository's lab values of 20 November 2026, not checked against a price page.
   *  A model with no price here is counted in tokens and not in dollars: a new provider's models get
   *  theirs by `agent/configured`. */
  prices: z
    .record(
      z.string(),
      z.object({
        input: z.number(),
        cachedInput: z.number(),
        cacheWriteInput: z.number(),
        output: z.number(),
      }),
    )
    .default({
      "openai/gpt-6.2-sol": { input: 2, cachedInput: 0.1, cacheWriteInput: 2.5, output: 10 },
      "openai/gpt-6.2-astra": { input: 8, cachedInput: 0.4, cacheWriteInput: 10, output: 40 },
      "openai/gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWriteInput: 0.125, output: 0.5 },
      "xai/grok-4.3": { input: 1.25, cachedInput: 0.2, cacheWriteInput: 1.25, output: 2.5 },
      "anthropic/claude-opus-5.5": {
        input: 3,
        cachedInput: 0.3,
        cacheWriteInput: 3.75,
        output: 15,
      },
      "google/gemini-3.8-flash": {
        input: 0.3,
        cachedInput: 0.03,
        cacheWriteInput: 0.3,
        output: 2.5,
      },
    }),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

/** THE AGENT'S ONE INPUT, as a payload: words, a role, the files it names, and what they start. */
const ContextAdded = z.object({
  role: z.enum(["user", "developer"]),
  content: z.string(),
  llmRequestPolicy: LlmRequestPolicy.optional(),
  /** Files in the mind's file store, by reference. The request maker inlines the bytes of the
   *  types its API shape takes, and names every other file in a text line (llm-api.ts). */
  files: z.array(FileAttachment).optional(),
  /** The raw fact these words were made from, such as a Slack or GitHub delivery: a script reads it
   *  whole with `itx.cd(path).readEvents(offset - 1, 1)`. */
  source: z.object({ path: z.string().min(1), offset: z.number().int().positive() }).optional(),
});

/** One ancestor of a forked subagent, and the offset of its log through which the conversation was
 *  copied. */
const Ancestor = z.object({
  path: z.string().min(1),
  throughOffset: z.number().int().nonnegative(),
});

const events = {
  "events.iterate.com/agent/configured": {
    description:
      "Merges a partial configuration into the agent's config: omitted keys keep their values, and a patch the schema refuses changes nothing. `kind: \"agent\"` marks the fact that the agent's start writes (start.ts): by it the mind's code knows that the context runs this agent.",
    payloadSchema: z.object({
      config: z.record(z.string(), z.unknown()),
      kind: z.literal("agent").optional(),
    }),
  },
  "events.iterate.com/agent/context-added": {
    description:
      "THE AGENT'S ONE INPUT: something the model should know, from anyone, in words. `llmRequestPolicy` says whether it starts a request, interrupts the open one, or is only read by the next; with none, the agent's own `llmRequestPolicy` decides. `files` names files in the mind's file store, by reference. The sender is the platform's stamp `source.origin`: an input of role `user` that another context wrote reads `[from <origin>]` first. An integration writes `source`, the raw fact the words were made from.",
    payloadSchema: ContextAdded,
  },
  "events.iterate.com/agent/context-copied": {
    description:
      "THE CONVERSATION OF ANOTHER AGENT, COPIED: a forked subagent starts with it (start.ts `contextCopiedEvents`). `items` are the parent's conversation items, unchanged, part `part` of `parts`, in order. They stand before everything else in the conversation, so the subagent's first request begins with the bytes of the parent's last request. `lineage` is oldest first: each ancestor's path and the offset of its log through which it was copied. A script result number up to the sum of their offsets names an ancestor's result (script-envelope.ts). It starts no request.",
    payloadSchema: z.object({
      lineage: z.array(Ancestor).min(1),
      part: z.number().int().nonnegative(),
      parts: z.number().int().positive(),
      items: z.array(ConversationItem),
    }),
  },
  "events.iterate.com/agent/llm-request-triggered": {
    description:
      "MAKE A REQUEST NOW. Anyone appends it: a person, a script, a processor that decides when the agent answers. `reason` says in plain words why the request must start now; `inputOffset` names the input the decision was about, if there was one. It acts as an input that interrupts, with no debounce: every open answer request is cancelled, and a request is due at once, also when every input before it was context only. A pause still holds. The request it starts names it as its `triggerOffset`.",
    payloadSchema: z.object({
      reason: z.string().min(1),
      inputOffset: z.number().int().positive().optional(),
    }),
  },
  "events.iterate.com/agent/subagent-requested": {
    description:
      "START A SUBAGENT on the context at `path`. The agent's script appends it to its own context, and does nothing else. The mind's worker writes the child's start facts, `model` if it names one, and `brief` as the child's first input, in ONE append to the child. `copyContext: true` makes a FORK: the child also gets this agent's instructions, model and cache key, and a copy of its conversation (`agent/context-copied`), so its first request reads this agent's cache. The answer is `agent/subagent-started` or `agent/subagent-failed`.",
    payloadSchema: z.object({
      path: z.string(),
      brief: z.string().optional(),
      model: z
        .string()
        .regex(/^[a-z0-9-]+\/.+$/)
        .optional(),
      copyContext: z.boolean().optional(),
    }),
  },
  "events.iterate.com/agent/subagent-started": {
    description:
      "The subagent of the request at `requestOffset` has its start facts, `copiedItems` copied items (0 with no copy) and its brief, at `path`. The mind's worker writes it, with a developer note to the model in the same append.",
    payloadSchema: z.object({
      requestOffset: z.number().int().positive(),
      path: z.string(),
      copiedItems: z.number().int().nonnegative(),
    }),
  },
  "events.iterate.com/agent/subagent-failed": {
    description:
      "The subagent of the request at `requestOffset` was not started, and `error` says why. Nothing was written to any child. The mind's worker writes it, with a developer note to the model in the same append.",
    payloadSchema: z.object({ requestOffset: z.number().int().positive(), error: z.string() }),
  },
  "events.iterate.com/agent/summary-updated": {
    description:
      "What the agent says about itself, each field merged: `activity` is what it does now, `title` and `description` what it is. Production's fact: the chat's round headers, the agent list and a call read it. The agent's script appends it, its activity as its first line, with no await.",
    payloadSchema: z.object({
      activity: z.string().min(1).optional(),
      title: z.string().min(1).max(200).optional(),
      waitingFor: z.string().nullable().optional(),
      description: z.string().min(1).max(1_000).optional(),
    }),
  },
  "events.iterate.com/agent/paused": {
    description:
      "No new request until `agent/resumed`. The agent writes it itself when requests failed in a row, and at its limit of requests with no input from outside. Its own pause says `endsAtNextOutsideInput`: at the next input from outside the agent writes `agent/resumed` itself. A pause that anyone else writes, with no such mark, stays until someone resumes it.",
    payloadSchema: z.object({
      reason: z.string(),
      endsAtNextOutsideInput: z.literal(true).optional(),
    }),
  },
  "events.iterate.com/agent/resumed": {
    description:
      "Requests run again: the counts of failures and of own requests start over. Anyone writes it; the agent writes it when an input from outside ends its own pause.",
    payloadSchema: z.object({ reason: z.string().optional() }),
  },
  "events.iterate.com/agent/timer-set": {
    description:
      "The agent set its one timer for `atMs`: the schedule fact that will fire it is in the same append. The agent reads this fact and never the schedule's own (see `ScheduleEventCatalog`).",
    payloadSchema: z.object({ atMs: z.number() }),
  },
  "events.iterate.com/agent/timer-fired": {
    description:
      "The time the agent asked to be woken at has come: a retry's wait, the debounce, a slow script, the cache about to be dropped. It decides nothing itself. The reducer reads time from events, and this one brings the time.",
    payloadSchema: z.object({ atMs: z.number() }),
  },
} as const;

/** The two schedule facts the agent appends itself, so that a request and its deadline are ONE
 *  append. The context's scheduler owns them (core/itx/src/stream/scheduled-appends.ts). The platform
 *  exports no catalog for them as it does for the run facts, so their shape is restated here.
 *
 *  THE AGENT APPENDS THEM AND NEVER CONSUMES THEM. On the platform, work that a facet starts in the
 *  background while it processes an `itx/schedule-set` fact makes no progress, with no error
 *  (measured on two minds, 22 November 2026: README.md). So no schedule fact is ever the event of
 *  one of this agent's passes; what the agent must know of its own timer it writes as `agent/timer-set`. */
export const ScheduleEventCatalog = {
  events: {
    "events.iterate.com/itx/schedule-set": {
      description:
        "At `when`, the scheduler appends `events` to this context. A key set again is replaced.",
      payloadSchema: z.object({
        key: z.string().min(1),
        when: z.union([z.object({ at: z.string() }), z.object({ afterMs: z.number() })]),
        events: z.array(z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) })),
      }),
    },
    "events.iterate.com/itx/schedule-cancelled": {
      description: "The schedule under `key` will not fire.",
      payloadSchema: z.object({ key: z.string().min(1) }),
    },
  },
};

const emits = [
  "events.iterate.com/llm-request/requested",
  "events.iterate.com/llm-request/cancelled",
  // only for a request that no request maker acted on in time: a request maker writes every other one
  "events.iterate.com/llm-request/settled",
  "events.iterate.com/agent/paused",
  "events.iterate.com/agent/resumed",
  "events.iterate.com/agent/timer-set",
  "events.iterate.com/itx/run-requested",
  "events.iterate.com/itx/schedule-set",
  "events.iterate.com/itx/schedule-cancelled",
] as const;

/** What the agent can append: its own facts, a request's, a script run, a schedule. */
export type AgentEventInput = Extract<
  | EventInput<{ events: typeof events }>
  | EventInput<typeof LlmRequestContract>
  | EventInput<typeof RunEventCatalog>
  | EventInput<typeof ScheduleEventCatalog>,
  { type: (typeof emits)[number] }
>;

/** WHAT THE AGENT OWES, as part of its state. `reduce` writes the list; `processEvent` appends
 *  what is on it and does nothing else. So a new incarnation after a crash owes the same things,
 *  and a page that shows the state shows what the agent is about to do.
 *
 *  THE AGENT OWES ONLY FACTS: facts under a key, so that writing twice writes once. It makes no
 *  request and holds no connection. Everything it wants done in the world it writes as a fact that
 *  another processor acts on: an LLM provider, the platform's script runner, the scheduler. */
export type Obligation = { idempotencyKey: string; events: AgentEventInput[] };

export const AgentContract = defineProcessorContract({
  slug: "agent",
  version: AGENT_VERSION,
  description:
    "An agent, in any context: reads inputs from anyone, writes what it asks a model, runs the script of the response, and keeps its history affordable. It appends facts and does nothing else.",
  stateSchema: z.object({
    config: AgentConfig.prefault({}),
    /** The agent's context path, from its own events: the prompt cache key of its requests, unless
     *  `config.llm.promptCacheKey` names another. */
    path: z.string().default(""),
    /** The time of the newest event. The reducer reads no other clock. */
    nowMs: z.number().default(0),
    /** The conversation the next request reads, in order: the copied items first, then `items`. */
    items: z.array(ConversationItem).default([]),
    /** A FORKED SUBAGENT'S COPY OF ITS PARENT'S CONVERSATION (`agent/context-copied`), every field
     *  as it was. Its offsets are the parent's, so it stands apart from `items` and before them. */
    copiedItems: z.array(ConversationItem).default([]),
    /** A forked subagent's lineage, oldest first; empty for an agent that is no fork. A script
     *  result number up to the sum of the offsets names an ancestor's result; the agent's own
     *  numbers come after. */
    lineage: z.array(Ancestor).default([]),
    /** Inputs and script results that want a request and that no response which counts has read. */
    pendingTriggerOffsets: z.array(z.number().int().nonnegative()).default([]),
    /** Requests with no end yet. */
    llmRequests: z
      .array(
        z.object({
          requestOffset: z.number().int().positive(),
          idempotencyKey: z.string(),
          purpose: z.enum(["answer", "summary"]),
          model: z.string(),
          expiresAtMs: z.number(),
          /** The pending triggers this request reads: answered if its response counts. */
          triggerOffsets: z.array(z.number().int().nonnegative()),
          replacesHistoryThroughOffset: z.number().int().nonnegative().nullable(),
          requestedAtMs: z.number(),
          /** How many attempts a request maker started: its `llm-request/attempt-started` facts. */
          attempts: z.number().int().nonnegative(),
          /** The input that came to interrupt it, if any: its response no longer counts. */
          interruptedByOffset: z.number().int().positive().nullable(),
          /** When the agent wrote that it is cancelled: a provider settles it soon after. */
          cancelledAtMs: z.number().nullable(),
        }),
      )
      .default([]),
    /** WHAT EACH PROVIDER WAS LAST ASKED, by the provider's name: the request's offset and the
     *  identity of each item it read. The next request to that provider says only what is new. */
    llmRequestBases: z
      .record(
        z.string(),
        z.object({
          llmRequestOffset: z.number().int().positive(),
          itemKeys: z.array(z.string()),
        }),
      )
      .default({}),
    /** The script of each response that counts, until the conversation holds its result and the
     *  next request can read the response whole. (A response has one script; `callIndex` is 0, and
     *  is kept because it names the run in the run's idempotency key.) */
    scriptCalls: z
      .array(
        z.object({
          llmRequestOffset: z.number().int().positive(),
          callIndex: z.number().int().nonnegative(),
          script: z.string(),
          askedAtMs: z.number(),
          runRequestOffset: z.number().int().positive().nullable(),
          runRequestedAtMs: z.number().nullable(),
          /** The conversation holds its result (or a subclass's note on it). */
          answered: z.boolean(),
          /** Its result is something the model must read: a value, a failure, a refusal. */
          wantsLlmRequest: z.boolean(),
        }),
      )
      .default([]),
    /** `endedByOffset`: the input from outside that ended the agent's own pause; `agent/resumed`
     *  is owed until it is written. */
    paused: z
      .object({
        reason: z.string(),
        endsAtNextOutsideInput: z.boolean(),
        endedByOffset: z.number().int().positive().nullable(),
      })
      .nullable()
      .default(null),
    /** The agent's requests are numbered: request n of a purpose has the idempotency key
     *  `llm-request/requested:<purpose>/<n>`. */
    llmRequestCounts: z
      .object({
        answer: z.number().int().nonnegative().default(0),
        summary: z.number().int().nonnegative().default(0),
      })
      .prefault({}),
    /** THE BOUND ON THE AGENT'S OWN CHAIN OF REQUESTS. Answer requests since the newest input from outside. An
     *  input is from outside when the chain of causes it belongs to began later than every chain
     *  that counted before, so nothing the agent causes itself, a script or another agent's reply,
     *  starts the count over. */
    llmRequestsWithoutOutsideInput: z.number().int().nonnegative().default(0),
    newestOutsideCauseAtMs: z.number().default(-1),
    /** Requests of each purpose that failed in a row, the newest error, and the back-off. */
    failedLlmRequestsInARow: z
      .object({
        answer: z.number().int().nonnegative().default(0),
        summary: z.number().int().nonnegative().default(0),
      })
      .prefault({}),
    lastLlmRequestError: z.string().nullable().default(null),
    retryNotBeforeMs: z
      .object({ answer: z.number().default(0), summary: z.number().default(0) })
      .prefault({}),
    /** No answer request before this: the debounce, counted from the first input that waits. */
    debounceUntilMs: z.number().default(0),
    /** The time the agent's one timer is set for, and how many times it was set. */
    timer: z
      .object({ atMs: z.number().nullable().default(null), sets: z.number().int().default(0) })
      .prefault({}),
    /** The provider refused a request for its size: a summary is owed before the next answer. */
    contextWindowExceeded: z.boolean().default(false),
    /** What the history costs: its size at the newest response, when a provider last read it, and
     *  the rent paid for reading it again since the last summary. */
    history: z
      .object({
        inputTokens: z.number().int().nonnegative().default(0),
        lastReadAtMs: z.number().default(0),
        rentUsd: z.number().nonnegative().default(0),
      })
      .prefault({}),
    /** What the agent has spent, and how much of it on responses with no words and no script, and
     *  on attempts that died with their host. */
    totals: z
      .object({
        llmRequests: z.number().int().nonnegative().default(0),
        costUsd: z.number().nonnegative().default(0),
        silentLlmResponses: z.number().int().nonnegative().default(0),
        silentLlmResponsesCostUsd: z.number().nonnegative().default(0),
        deadLlmRequestAttempts: z.number().int().nonnegative().default(0),
      })
      .prefault({}),
    obligations: z.array(z.custom<Obligation>()).default([]),
  }),
  events,
  // the request protocol is a contract of its own: the agent reads and writes its facts, and does
  // not own them. The agent depends on no channel's contract.
  processorDeps: [LlmRequestContract, RunEventCatalog, ScheduleEventCatalog],
  consumes: [
    "events.iterate.com/agent/configured",
    "events.iterate.com/agent/context-added",
    "events.iterate.com/agent/context-copied",
    "events.iterate.com/agent/llm-request-triggered",
    "events.iterate.com/llm-request/requested",
    "events.iterate.com/llm-request/attempt-started",
    "events.iterate.com/llm-request/cancelled",
    "events.iterate.com/llm-request/settled",
    "events.iterate.com/llm-request/deadline-passed",
    "events.iterate.com/llm-request/wait-ended",
    "events.iterate.com/agent/paused",
    "events.iterate.com/agent/resumed",
    "events.iterate.com/agent/timer-set",
    "events.iterate.com/agent/timer-fired",
    "events.iterate.com/itx/run-requested",
    "events.iterate.com/itx/run-settled",
  ],
  emits,
});

export type AgentState = ProcessorState<typeof AgentContract>;

// ── two pure rules on the vocabulary, which the agent and every request maker share ──

/** A partial config merged into the config, one level deep; a result the schema refuses changes
 *  nothing. Every processor that reads `agent/configured` folds it by this rule. */
export function mergedConfig(config: AgentConfig, patch: Record<string, unknown>): AgentConfig {
  const merged: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    merged[key] = isRecord(value) && isRecord(current) ? { ...current, ...value } : value;
  }
  const parsed = AgentConfig.safeParse(merged);
  return parsed.success ? parsed.data : config;
}

/** What a request cost, by a model's prices for a million tokens. */
export function costUsd(price: AgentConfig["prices"][string], usage: LlmUsage): number {
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteInputTokens ?? 0;
  const fresh = usage.inputTokens - cached - written;
  const micros =
    fresh * price.input +
    cached * price.cachedInput +
    written * price.cacheWriteInput +
    usage.outputTokens * price.output;
  return micros / 1e6;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && !!value && !Array.isArray(value);
