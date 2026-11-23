// llm-request.ts — THE LLM REQUEST PROTOCOL: the facts by which one processor asks a model and
// another makes the request. This contract OWNS them, in the namespace `llm-request/`. No processor
// runs it: it is the protocol that the two sides name in their `processorDeps`.
//
//   the agent (processor.ts, contract.ts)   writes  llm-request/requested, llm-request/cancelled
//   a script, for a question on the side    writes  llm-request/requested (purpose `side`)
//   a request maker (llm-api.ts)            writes  llm-request/attempt-started,
//                                                   llm-request/response-frame-received (ephemeral),
//                                                   llm-request/settled
//   the context's scheduler                 writes  llm-request/deadline-passed, llm-request/wait-ended
//
// EACH REQUEST MAKER OWNS A NAMESPACE OF ITS OWN, named after its API shape (`openai-responses/`),
// for what only it knows: the exact bytes of an attempt (`<api>/request-started`), the provider's
// own events (`<api>/response-frame-received`), and what its API shape declares (llm-api.ts). Each
// of the two goes in the same append as its shared fact here.
//
// A contract depends on contracts; an implementation imports no other implementation. So the
// agent's contract and the request maker's contract both list this one, and processor.ts and
// llm-api.ts never import each other.

import { z } from "zod";
import { defineProcessorContract } from "iterate/stream/processor";

/** What one request cost. Production's shape (`LlmUsage`), plus `estimated` for a request the provider
 *  gave no count for: a cancelled request still cost its input. */
export const LlmUsage = z.object({
  /** Every input token, the cached ones included. */
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cacheWriteInputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
  /** US dollars by `config.prices`, when the model has a price there. */
  costUsd: z.number().nonnegative().optional(),
  estimated: z.literal(true).optional(),
});
export type LlmUsage = z.infer<typeof LlmUsage>;

/** A FILE IN THE MIND'S FILE STORE, BY REFERENCE: production's `FileAttachment`
 *  (core/lib/src/agents/contract.ts). The Dash draws a file only when it has all four fields. No
 *  fact holds file bytes: a request maker reads them when it sends (llm-api.ts). */
export const FileAttachment = z.object({
  contentType: z.string().min(1),
  filename: z.string().min(1),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
});
export type FileAttachment = z.infer<typeof FileAttachment>;

/** ONE ITEM OF THE CONVERSATION, in a form every provider can be given. `tag` says what kind of
 *  thing it is, and is the bucket its size is counted in on every request (`inputChars`). */
export const ConversationItem = z.object({
  /** Where the item stands. An input stands at its own offset. A response, its script results and
   *  the notes on it stand at their REQUEST's offset: after all that the request read, before what
   *  arrived while it ran. */
  atOffset: z.number().int().nonnegative(),
  /** The order among the items at one offset: the response, then each script result, then a note. */
  rank: z.number().int().nonnegative(),
  tag: z.enum([
    "words",
    "context",
    "llm-response",
    "script-result",
    "interrupted-llm-response",
    "summary",
  ]),
  role: z.enum(["user", "developer", "assistant"]),
  /** The words only. A file of the item is in `files`, not here. */
  text: z.string(),
  /** On an input: the files it names. The request maker reads their bytes when it sends: a file
   *  the API shape takes is its part, any other is a text line that says why (llm-api.ts). */
  files: z.array(FileAttachment).optional(),
  /** On a response: `text` is what the model wrote, its `<codemode>` block included. The provider's
   *  own output items, with the model that wrote them, are replayed verbatim to that model; any
   *  other model reads the text. (A fact stored when a response could hold tool calls has more
   *  fields: the schema drops them.) */
  providerItems: z.array(z.unknown()).optional(),
  providerModel: z.string().optional(),
});
export type ConversationItem = z.infer<typeof ConversationItem>;

/** THE BASE OF A REQUEST: an earlier `llm-request/requested`, by its offset. */
export const LlmRequestBase = z.object({
  llmRequestOffset: z.number().int().positive(),
  /** How many of the items the base was asked with come first. Null: all of them. */
  itemCount: z.number().int().nonnegative().nullable(),
  /** True: the base's response follows them, as one item (its text, and the provider's own output
   *  items with the model that wrote them), from the base's `llm-request/settled`. */
  response: z.boolean(),
});
export type LlmRequestBase = z.infer<typeof LlmRequestBase>;

/** AN ITEM THAT A REQUEST ADDS. An item with no place (`{ role, text }`) is placed by the reader
 *  after the base: at the request's own offset, in the order given, as `words` (`placed`). */
export const AddedItem = ConversationItem.partial({ atOffset: true, rank: true, tag: true });
export type AddedItem = z.infer<typeof AddedItem>;

/** WHAT A REQUEST ASKS: the payload of `llm-request/requested`. A request that names a base may
 *  leave out what the base has: each field that is absent is the base's. A whole request
 *  (`extends: null`) names its instructions and its cache key, or a request maker refuses it. */
export const LlmRequestRequested = z.object({
  model: z.string().min(1),
  /** The deadline, in epoch milliseconds. Absent: the request has no deadline of its own, and the
   *  request maker's idle time and attempts end it. The agent's own requests always have one. */
  expiresAtMs: z.number().optional(),
  /** The fact that made the request due: an input, or the last result of a response's scripts.
   *  The agent's own requests always name it. */
  triggerOffset: z.number().int().nonnegative().optional(),
  /** `answer`: its response is read for its script. `summary`: its response replaces the
   *  history through `replacesHistoryThroughOffset`, and it reads no further. `side`: someone
   *  else asked it for its own use (a script's append): the agent does not adopt it. */
  purpose: z.enum(["answer", "summary", "side"]),
  replacesHistoryThroughOffset: z.number().int().nonnegative().optional(),
  /** What the model is told before the conversation. Absent: the base's instructions. */
  instructions: z.string().optional(),
  /** THE BASE, by its offset. Null: the whole conversation is in `itemsAdded`. */
  extends: LlmRequestBase.nullable(),
  itemsAdded: z.array(AddedItem),
  /** The key a provider groups its prompt cache by (OpenAI's `prompt_cache_key`). Absent: the
   *  base's. */
  promptCacheKey: z.string().min(1).optional(),
  /** Absent: the base's; null: none. On a whole request, absent is null. */
  reasoningEffort: z.string().nullable().optional(),
  /** Absent: the base's; null: none. On a whole request, absent is null. */
  maxOutputTokens: z.number().int().positive().nullable().optional(),
});
export type LlmRequestRequested = z.infer<typeof LlmRequestRequested>;

/** The items a request adds, each in its place: an item with no place stands at the request's
 *  offset, after the base, in the order given, as `words`. An item with its place keeps it. */
export const placed = (items: AddedItem[], requestOffset: number): ConversationItem[] =>
  items.map((item, index) => ({
    ...item,
    atOffset: item.atOffset ?? requestOffset,
    rank: item.rank ?? index,
    tag: item.tag || "words",
  }));

/** WHAT CAME BACK: the result of `llm-request/settled`. */
export const LlmRequestResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    /** The model's text, as it wrote it. The asker reads its script out of it. */
    text: z.string(),
    providerItems: z.array(z.unknown()),
    usage: LlmUsage.optional(),
  }),
  z.object({
    status: z.literal("failed"),
    errorMessage: z.string(),
    /** `context-window`: the conversation no longer fits, so a summary is owed first.
     *  `refused`: the same request would be refused again, so the agent pauses at once. */
    failureKind: z.enum(["transport", "provider", "context-window", "refused"]),
    partialText: z.string().optional(),
    usage: LlmUsage.optional(),
  }),
  z.object({
    status: z.literal("cancelled"),
    /** `superseded`: another response answered its inputs first. */
    reason: z.enum(["interrupted-by-user-input", "superseded", "expired"]),
    partialText: z.string().optional(),
    usage: LlmUsage.optional(),
  }),
]);
export type LlmRequestResult = z.infer<typeof LlmRequestResult>;

const events = {
  "events.iterate.com/llm-request/requested": {
    description:
      "Someone decided to ask a model, and THIS IS WHAT IT ASKS, in a form every LLM provider reads: the instructions and the conversation. No tool is declared: the model writes its script as a `<codemode>` block in its text. The event's offset is the request's identity. The request maker whose API the provider (the first part of `model`) speaks makes it. The conversation is not repeated in every request: it is what the request at `extends.llmRequestOffset` was asked (its first `itemCount` items, or all of them), then that request's response if `extends.response`, then `itemsAdded`. Any request can be a base, so a request off any earlier request is one append: the provider's cache serves it when it begins with the same bytes and carries the same `promptCacheKey`. A request that names a base may leave out what the base has (its instructions, cache key, reasoning effort and output limit), and an added item may be only `{ role, text }`. With no `expiresAtMs`, the request has no deadline of its own. Whoever asked reads the answer as the `llm-request/settled` whose `llmRequestOffset` is this fact's offset.",
    payloadSchema: LlmRequestRequested,
  },
  "events.iterate.com/llm-request/attempt-started": {
    description:
      "Written by a request maker. One attempt starts: what the agent, the request maker's own reducer and a feed read of it. It holds no bytes: the request maker's own `<api>/request-started`, in the same append, holds them. Its key names the request and the attempt, and `instanceId` names the instance that writes it, so that of two request makers only one starts an attempt: the log refuses the second body under the same key.",
    payloadSchema: z.object({
      llmRequestOffset: z.number().int().positive(),
      /** From 0. A host that died mid-request starts the next one. */
      attempt: z.number().int().nonnegative(),
      /** The API shape of the request maker: `openai-responses`. Its own facts are in that
       *  namespace. */
      api: z.string().min(1),
      /** A random id that one instance of a request maker makes once. Two instances that start the
       *  same attempt write two bodies under one key: the log refuses the second. */
      instanceId: z.string().min(1),
      /** `gateway`: through the AI Gateway. Any other: the name of the API's own transport. */
      transport: z.string().min(1),
      model: z.string().min(1),
      /** Characters of the conversation by kind of item, with the instructions: where the context
       *  goes ("half of it is script results"). */
      inputChars: z.record(z.string(), z.number()),
      /** The bytes of the files that the attempt inlined, beside `inputChars`. */
      inputFileBytes: z.number().int().nonnegative(),
    }),
  },
  "events.iterate.com/llm-request/response-frame-received": {
    description:
      "Written by a request maker. EPHEMERAL, never stored: one window of the answer as it streams, in ONE SHAPE FOR EVERY PROVIDER. The two deltas are the words the window adds. `thinking` is true while the provider reports that the model reasons, also when it gives no words for it. The provider's own events are in the request maker's `<api>/response-frame-received`, in the same append and with the same `sequence`. The settled fact carries the durable answer.",
    ephemeral: true,
    payloadSchema: z.object({
      llmRequestOffset: z.number().int().positive(),
      attempt: z.number().int().nonnegative(),
      /** The window's ordinal within the attempt. */
      sequence: z.number().int().nonnegative(),
      textDelta: z.string(),
      thinkingDelta: z.string(),
      thinking: z.boolean(),
    }),
  },
  "events.iterate.com/llm-request/settled": {
    description:
      "The request's terminal fact, written by the request maker that started it: what the model answered (its text and the provider's own output items), how it failed, or why it was cancelled, each with what had streamed and what it cost. The asker writes it itself only for a request that no request maker acted on in time. One key for whoever writes it: the first one stands.",
    payloadSchema: z.object({
      llmRequestOffset: z.number().int().positive(),
      attempt: z.number().int().nonnegative(),
      /** From the attempt's start: to the provider's first event, and to the settlement. */
      firstEventMs: z.number().nonnegative().optional(),
      durationMs: z.number().nonnegative().optional(),
      result: LlmRequestResult,
    }),
  },
  "events.iterate.com/llm-request/wait-ended": {
    description:
      "Written by the context's scheduler from the schedule `<request key>/wait`: the time the asker gives a request maker to start an attempt of a request, or to settle a request the asker cancelled, is over. The asker sets it in the request's own append, and again in the cancellation's; a request maker cancels it as it starts an attempt and as it settles, so it fires only when none acted. Then the asker settles the request itself.",
    payloadSchema: z.object({
      llmRequestIdempotencyKey: z.string().min(1),
      /** The time the wait ends: the fact brings it, whatever the clock that writes it says. */
      atMs: z.number(),
    }),
  },
  "events.iterate.com/llm-request/cancelled": {
    description:
      "Written by the asker: the request can no longer count, because an input came to interrupt it (words, or `agent/llm-request-triggered`) or another response answered its inputs first. The request maker that started it stops and settles it as cancelled, with what had streamed and what it cost.",
    payloadSchema: z.object({
      llmRequestOffset: z.number().int().positive(),
      reason: z.enum(["interrupted-by-user-input", "superseded"]),
    }),
  },
  "events.iterate.com/llm-request/deadline-passed": {
    description:
      "Written by the context's scheduler at a request's deadline, from the schedule that was set in the request's own append: the request is over even if no processor is alive. It names the request by its idempotency key, because the request had no offset yet when the schedule was written. A request that already ended is not changed by it.",
    payloadSchema: z.object({ llmRequestIdempotencyKey: z.string().min(1) }),
  },
} as const;

/** THE PROTOCOL'S OWNER. It consumes and emits nothing: the agent and the request makers name it
 *  in their `processorDeps`, and read and write its facts there. */
export const LlmRequestContract = defineProcessorContract({
  slug: "llm-request",
  version: "3",
  description:
    "The LLM request protocol: one side asks a model (`llm-request/requested`), a request maker starts each attempt and writes what came back (`llm-request/attempt-started`, `llm-request/response-frame-received`, `llm-request/settled`). It owns these facts; no processor runs it.",
  stateSchema: z.object({}),
  events,
  consumes: [],
  emits: [],
});
