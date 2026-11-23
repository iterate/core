// llm-api.ts — THE PROCESSOR THAT MAKES THE LLM REQUESTS OF ONE API SHAPE. It is a stream processor
// in a facet of its own, coupled to the agent by facts in the log and by nothing else. Its contract
// depends on contracts only: the request protocol (llm-request.ts) and the agent's (contract.ts, for
// `agent/configured`). It imports no code of the agent (processor.ts), and the agent none of it.
//
//   it reads   llm-request/requested         what someone asks a model, in a form every API reads
//              llm-request/cancelled         the asker no longer wants the answer
//              llm-request/attempt-started, llm-request/settled, llm-request/deadline-passed,
//              agent/configured
//              the log itself                a request's base that it does not hold (`fromTheLog`)
//              the mind's file store         the bytes of each file it inlines (`withFiles`)
//   it writes  llm-request/attempt-started   one attempt starts, before its bytes leave; in the
//              <api>/request-started         same append, the exact bytes of that attempt
//              llm-request/response-frame-received   (ephemeral) one window of the stream, the same
//              <api>/response-frame-received          for every API; in the same append, the
//                                                     provider's own events, unmodified
//              llm-request/settled           what came back, and what it cost
//              <api>/…                       what its API shape declares (`LlmApi.events`)
//
// EACH REQUEST MAKER OWNS THE NAMESPACE OF ITS API SHAPE: `<api>` is the shape's name
// (`openai-responses/request-started`). Its contract is made from that name at run time, so the
// compiler does not see these types: `apiEventType` makes one, and a small typed function builds each
// fact (`providerFrame`, and `record` for what an API shape declares).
//
// ONE PROCESSOR FOR EACH SHAPE OF API, siblings of each other (llm-apis/): OpenAI Responses,
// Anthropic Messages, Chat Completions, Google generateContent. Which shape a model is asked in is
// configuration: `config.llmProviders.<the first part of the model's name>.api`. So `xai/grok-4.3`
// goes to the Chat Completions processor because `llmProviders.xai.api` says so, and a server in a
// basement that speaks Chat Completions is one `agent/configured` fact with its `baseUrl`. The agent
// does not know which processors are loaded; a request that none takes ends at the agent's
// `llmProviderWaitMs`.
//
// HOW A REQUEST REACHES ITS MODEL is the provider's config: two itx expressions, which this
// processor reads on its context (`route`).
//
//   no `baseUrl`   `cloudflareAiBinding`: anything that has `run(model, body, options)`. By default
//                  `itx.ai`, the mind's AI Gateway (unified billing, no key in the mind).
//   a `baseUrl`    `fetcher`: anything that has `fetch(request)`. With none, the facet's own
//                  `fetch`: the mind's egress, which puts a secret in place of `getSecret("…")`.
//
// An API shape can have a way of its own too (OpenAI's kept WebSocket). That one is never an
// expression: the facet reaches `itx` over Workers RPC, and no RPC answer holds a socket.
//
// An API shape gives three functions, `body`, `read` and `filePart`, and where its requests go on a
// server of its own (`direct`). It may declare facts of its own (`events`) and write them while an attempt runs
// (`record`): OpenAI's kept WebSocket says when it was dialled and when it closed. llm-apis/chat-completions.ts is the shortest whole one. Anything else that can
// read and append the facts above can make the requests too: a fake one in a test, a processor on
// another machine.
//
// FILES ARE REFERENCES, AND THE REQUEST MAKER INLINES THEIR BYTES WHEN IT SENDS. An item names its
// files by path (`FileAttachment`). For each file the API shape's `filePart(file, base64)` gives its
// part for an image or a PDF, or null for a type it does not take. A file of a type it takes, of at
// most `MAX_INLINE_FILE_BYTES`, is read through the context's `itx` (`itx.files.get(path).bytes()`)
// and is IN THE REQUEST AT ONCE, before the item's words. Any other file is one line that says why
// it is not shown, and never how to fetch it. The choice depends on the file alone, so a later
// request sends the same first bytes and the provider's prompt cache holds. The body is built a
// second time with `$file:<path>:<sha256>` in place of each file's base64: that is the body that
// `<api>/request-started` stores (`withFiles`).
//
// A REQUEST OFF ANY EARLIER REQUEST. A request names its base by offset (`extends`). The processor
// keeps the conversations of its open requests and of the newest two of each provider. For any
// other base, the attempt reads the base's request fact from the log, then that one's base, back to
// a request that is whole or that the processor holds, and the base's settled fact for its response.
// Each read has a bound (`MAX_BASE_READS`, `MAX_SETTLED_SCAN_EVENTS`). A base it cannot read settles
// the request as `refused`, with the reason in words.

import { parse, walkStepsOnRpcStub, type ItxExpressionStep } from "iterate/expression";
import { errorCode } from "iterate/lib";
import {
  defineProcessorContract,
  StreamProcessor,
  type ConsumedEvent,
  type EventDefinition,
  type EventInput,
  type ProcessEventArgs,
  type ProcessorState,
  type ReduceArgs,
  type StreamEvent,
} from "iterate/stream/processor";
import { z } from "zod";
import {
  AgentConfig,
  AgentContract,
  CLOUDFLARE_AI_BINDING,
  costUsd,
  mergedConfig,
  ScheduleEventCatalog,
} from "./contract.ts";
import {
  ConversationItem,
  type FileAttachment,
  LlmRequestBase,
  LlmRequestContract,
  LlmRequestRequested,
  LlmRequestResult,
  type LlmUsage,
  placed,
} from "./llm-request.ts";

/** ONE SHAPE OF LLM API: how a request is written in it, and how its stream is read. */
export type LlmApi = {
  /** The name `llmProviders.<provider>.api` gives it: `chat-completions`. */
  name: string;
  /** The request in the API's own format: the conversation apart from the rest of the body, so
   *  that `<api>/request-started` stores a long conversation once. */
  body(request: {
    /** The whole name, `<provider>/<model>`. */
    model: string;
    instructions: string;
    /** The conversation in order, in a form every API can be given, with each file resolved for
     *  this attempt: the parts first, then the words. */
    items: RequestItem[];
    /** The request's `promptCacheKey`: the key the provider groups its cache by. */
    cacheKey: string;
    reasoningEffort: string | null;
    maxOutputTokens: number | null;
  }): LlmRequestBody;
  /** One event of the API's stream, folded into the response so far, in place. It sets
   *  `response.isThinking` while the stream says the model reasons, `response.done` when the answer
   *  is whole, and throws an `LlmRequestFailure` for an error the stream reports. */
  read(response: LlmResponse, event: ProviderEvent): void;
  /** Where a request goes on a server of its own (`baseUrl`), and what the body adds there. */
  direct: {
    path(modelName: string): string;
    /** Through the gateway the model is named by `itx.ai.run`; straight to a server, in the body. */
    modelInBody: boolean;
    headers?: Record<string, string>;
  };
  /** A way of its own to its model for this attempt, or null for the gateway or the `baseUrl`. */
  transport?(attempt: {
    model: string;
    provider: LlmProviderConfig;
    /** The agent's path. */
    path: string;
    /** Aborted when the attempt is cancelled. */
    signal: AbortSignal;
    /** A model that sends nothing for this long has failed the attempt. */
    idleMs: number;
    /** The host's clock. */
    now: () => number;
    /** Writes one of the API shape's own facts (`events`), now, as part of this attempt. */
    record: (event: string, payload: Record<string, unknown>) => void;
  }): Promise<LlmTransport | null>;
  /** THE API SHAPE'S OWN FACTS, by their name in its namespace: `websocket-connected` is
   *  `events.iterate.com/openai-responses/websocket-connected`. Its contract owns them. */
  events?: Record<string, EventDefinition>;
  /** ONE FILE AS THE PROVIDER'S PART: an image or a PDF, with its bytes as `base64`. Null: this API
   *  takes no such type, and the file is a line. It is pure, so the request maker asks it with no
   *  bytes first, and reads a file only when it gives a part. */
  filePart(file: FileAttachment, base64: string): unknown;
};

/** AN ITEM AS ONE ATTEMPT SENDS IT: the parts of its files that are shown, and its words with a
 *  line for each file that is not. A response has no parts. */
export type RequestItem = Omit<ConversationItem, "files"> & { parts: unknown[] };

export type LlmProviderConfig = AgentConfig["llmProviders"][string];

export type LlmRequestBody = {
  bodyWithoutInput: Record<string, unknown>;
  /** The field of the body that holds the conversation: `input`, `messages`, `contents`. */
  inputField: string;
  input: unknown[];
};

/** How one attempt reaches the model. */
export type LlmTransport = {
  /** Written into the attempt's facts before the bytes leave: `gateway`, `direct`, `websocket`. */
  name: string;
  /** Sends the body and gives the API's events one by one. It ends when the answer has ended, and
   *  throws when the attempt's signal aborts. */
  events(body: Record<string, unknown>): AsyncIterable<ProviderEvent>;
  /** The attempt failed or was cancelled while on this transport. */
  failed?(): void;
  /** The attempt is over, however it ended. */
  done?(): void;
};

/** One event of an API's stream, as it was sent. */
export type ProviderEvent = Record<string, unknown>;

/** What a stream has said so far. It belongs to one attempt. The agent reads the script out of
 *  `text`: no API is asked for a tool call, and one that comes anyway is not read. */
export type LlmResponse = {
  text: string;
  thinking: string;
  /** The provider reports that the model reasons now, with words or with none. */
  isThinking: boolean;
  /** The API's own output items: given back verbatim to the same model in later requests. */
  providerItems: Record<string, unknown>[];
  usage: LlmUsage | null;
  done: boolean;
};

/** What the processor uses of its context's `itx` (iterate/sdk): whatever the providers'
 *  expressions name there, `itx.ai` by default, and `itx.files` for the bytes of a file. The
 *  providers' roots are walked by expression, so they are not typed. */
export type LlmApiItx = Disposable;
type FilesItx = { files: { get(path: string): { bytes(): Promise<Uint8Array> } } };

export type LlmApiDeps = {
  api: LlmApi;
  /** A scope on the context (iterate/sdk `this.getItx()`), disposed after each use. */
  getItx: () => LlmApiItx;
  /** The facet's own `fetch`, the mind's egress: for a provider with a `baseUrl` and no `fetcher`. */
  fetch: (request: Request) => Promise<Response>;
  /** The clock for how long work took. The reducer never reads it. */
  now: () => number;
  /** Telemetry: one wide event for each attempt. */
  report: (event: Record<string, unknown>) => void;
  /** The context's own log (`itx.readEvents`): for a request whose base the processor does not hold. */
  readEvents: (afterOffset: number, limit: number) => Promise<{ events: StreamEvent[] }>;
};

/** THE LARGEST FILE A REQUEST INLINES, in bytes. An image of this size is under Anthropic's limit
 *  of 10 MB in base64. */
const MAX_INLINE_FILE_BYTES = 7_000_000;

/** The reducer's version. A bump re-reduces the log from offset 0, which starts nothing again:
 *  a request that has its settled fact is not open. */
const LLM_API_VERSION = "5";

const emits = [
  "events.iterate.com/llm-request/attempt-started",
  "events.iterate.com/llm-request/response-frame-received",
  "events.iterate.com/llm-request/settled",
  "events.iterate.com/itx/schedule-cancelled",
] as const;

/** THE TYPE OF A FACT IN THE NAMESPACE OF ONE API SHAPE, made from the shape's name at run time:
 *  `events.iterate.com/openai-responses/request-started`. The brand keeps it apart from the literal
 *  types of the shared protocol, whose payloads the compiler checks. */
export type ApiEventType = string & { readonly apiEventType: true };
const apiEventType = (api: string, event: string) =>
  `events.iterate.com/${api}/${event}` as ApiEventType;

/** One fact of an API shape's own namespace, as it is appended. */
type ApiEventInput = {
  type: ApiEventType;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  ephemeral?: true;
};

/** `<api>/request-started`: THE EXACT BYTES OF ONE ATTEMPT. */
const RequestStarted = z.object({
  llmRequestOffset: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  model: z.string().min(1),
  transport: z.string().min(1),
  /** The provider's body without its conversation, and the field the conversation goes in
   *  (`input`, `messages`, `contents`: the provider's own word). */
  bodyWithoutInput: z.record(z.string(), z.unknown()),
  inputField: z.string().min(1),
  /** Null: the whole conversation is in `inputItemsAdded`. */
  extendsRequestStartedOffset: z.number().int().positive().nullable(),
  inputItemCountBefore: z.number().int().nonnegative(),
  /** Null: too large for one event. The conversation facts before the request still give it. Where
   *  a file's base64 was, the body here has `$file:<path>:<sha256>`. */
  inputItemsAdded: z.array(z.unknown()).nullable(),
  /** The hash of the REAL body's JSON, the files' bytes included. */
  bodySha256: z.string(),
});

/** `<api>/response-frame-received`: the provider's own events of one window, unmodified. */
const ProviderFrame = z.object({
  llmRequestOffset: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  /** The same as the shared frame's of the same window. */
  sequence: z.number().int().nonnegative(),
  providerEvents: z.array(z.unknown()),
});

const providerFrame = (api: string, payload: z.input<typeof ProviderFrame>): ApiEventInput => ({
  type: apiEventType(api, "response-frame-received"),
  ephemeral: true,
  payload,
});

/** The facts of an API shape's namespace: the two every request maker writes, and its own. */
function apiEvents(api: Pick<LlmApi, "name" | "events">): Record<string, EventDefinition> {
  const own: Record<string, EventDefinition> = {
    "request-started": {
      description:
        "Written by this request maker in the same append as `llm-request/attempt-started`, before the bytes leave: THE EXACT BODY of one attempt, in the provider's own form. It is whole here except its conversation, which is the first `inputItemCountBefore` items of the `request-started` fact it extends, then `inputItemsAdded`. No file bytes are here: where a file's base64 was, the body has `$file:<path>:<sha256>`. `bodySha256` is the hash of the real body's JSON.",
      payloadSchema: RequestStarted,
    },
    "response-frame-received": {
      description:
        "EPHEMERAL, never stored: the provider's own events of one window of the stream, unmodified. It goes in the same append as `llm-request/response-frame-received`, with the same `sequence`.",
      ephemeral: true,
      payloadSchema: ProviderFrame,
    },
    ...api.events,
  };
  return Object.fromEntries(
    Object.entries(own).map(([event, definition]) => [apiEventType(api.name, event), definition]),
  );
}

/** WHAT THE PROCESSOR OWES for a request it has open, as part of its state: one more attempt, or
 *  the settlement that ends the request with no further attempt. */
type ApiObligation =
  | { type: "attempt"; requestOffset: number }
  | { type: "settle"; requestOffset: number; result: LlmRequestResult };

const llmApiContract = (api: Pick<LlmApi, "name" | "events">) =>
  defineProcessorContract({
    slug: `llm-api-${api.name}`,
    version: LLM_API_VERSION,
    description: `Makes the agent's LLM requests whose provider speaks ${api.name}, and writes what came back. It owns the facts of the namespace \`${api.name}/\`.`,
    stateSchema: z.object({
      /** The agent's config, folded from the same facts the agent folds: the providers, the
       *  gateway, the idle time, the attempts a request gets, the prices. */
      config: AgentConfig.prefault({}),
      path: z.string().default(""),
      /** THE CONVERSATIONS OF THE NEWEST REQUESTS, by request offset. A request says only what is
       *  new since its base, so the processor keeps the likely bases to put the next together: the
       *  newest two of each provider, and those of the requests it has open. `response` is the
       *  request's response as an item, once it succeeded. Any other base is read from the log. */
      conversations: z
        .array(
          z.object({
            llmRequestOffset: z.number().int().positive(),
            provider: z.string(),
            model: z.string(),
            instructions: z.string(),
            items: z.array(ConversationItem),
            promptCacheKey: z.string(),
            reasoningEffort: z.string().nullable(),
            maxOutputTokens: z.number().int().positive().nullable(),
            response: ConversationItem.nullable(),
          }),
        )
        .default([]),
      /** Its requests with no end yet. */
      requests: z
        .array(
          z.object({
            requestOffset: z.number().int().positive(),
            idempotencyKey: z.string(),
            model: z.string(),
            purpose: z.enum(["answer", "summary", "side"]),
            /** How many attempts were started: its `llm-request/attempt-started` facts. */
            attempts: z.number().int().nonnegative(),
            cancelledBecause: z.enum(["interrupted-by-user-input", "superseded"]).nullable(),
            /** What the request fact says, when its base is not held: the attempt reads the base
             *  from the log. Null: its conversation is in `conversations`. */
            unresolved: z
              .object({
                extends: LlmRequestBase.nullable(),
                instructions: z.string().optional(),
                promptCacheKey: z.string().optional(),
                reasoningEffort: z.string().nullable().optional(),
                maxOutputTokens: z.number().int().positive().nullable().optional(),
                /** Each in its place (llm-request.ts `placed`). */
                itemsAdded: z.array(ConversationItem),
              })
              .nullable(),
          }),
        )
        .default([]),
      obligations: z.array(z.custom<ApiObligation>()).default([]),
    }),
    // It owns the facts of its namespace, which it writes and does not read. Their types are made
    // at run time, so the compiler sees no owned type here. The request facts are the protocol's
    // (llm-request.ts); it reads the agent's `agent/configured` (contract.ts) for the providers and
    // prices; it ends schedules.
    events: apiEvents(api) as Record<never, EventDefinition>,
    processorDeps: [LlmRequestContract, AgentContract, ScheduleEventCatalog],
    consumes: [
      "events.iterate.com/agent/configured",
      "events.iterate.com/llm-request/requested",
      "events.iterate.com/llm-request/attempt-started",
      "events.iterate.com/llm-request/cancelled",
      "events.iterate.com/llm-request/settled",
      "events.iterate.com/llm-request/deadline-passed",
    ],
    // the compiler sees the shared types; the namespace's are added at run time
    emits: [...emits, ...Object.keys(apiEvents(api))] as unknown as typeof emits,
  });

type LlmApiContract = ReturnType<typeof llmApiContract>;
export type LlmApiState = ProcessorState<LlmApiContract>;
type LlmApiEvent = ConsumedEvent<LlmApiContract>;
type SharedEventInput = Extract<
  EventInput<typeof LlmRequestContract> | EventInput<typeof ScheduleEventCatalog>,
  { type: (typeof emits)[number] }
>;
type LlmApiEventInput = SharedEventInput | ApiEventInput;
type LlmApiArgs = ProcessEventArgs<LlmApiState, LlmApiEvent, SharedEventInput>;
/** What an attempt appends: the shared facts, typed by their catalogs, and the facts of its API
 *  shape's namespace. The engine checks each type against `emits`, which lists both. */
type Append = (...events: LlmApiEventInput[]) => Promise<StreamEvent[]>;
type OpenRequest = LlmApiState["requests"][number];
type CancelReason = "interrupted-by-user-input" | "superseded" | "expired";
type LiveAttempt = { controller: AbortController; cancelledBecause: CancelReason | null };
/** The newest `<api>/request-started` of this incarnation: the next one says only what it adds. */
type LastStarted = { offset: number; model: string; items: string[] };
/** What a request asks, put together: its conversation, and what it says beside it. */
type Asked = Settings & { items: ConversationItem[] };
/** What a request says beside its conversation. */
type Settings = {
  instructions: string;
  promptCacheKey: string;
  reasoningEffort: string | null;
  maxOutputTokens: number | null;
};
/** What a request fact says beside its conversation: each field that is absent is its base's. */
type Said = Partial<Settings>;

export class LlmApiProcessor extends StreamProcessor<LlmApiState, LlmApiEvent> {
  readonly contract: LlmApiContract;
  protected readonly deps: LlmApiDeps;
  /** RUNTIME STATE, gone with the host and never read by a rule: what this incarnation has in
   *  flight, so that it starts nothing twice. */
  private readonly liveAttempts = new Map<number, LiveAttempt>();
  private readonly settling = new Set<number>();
  private lastStarted: LastStarted | null = null;
  /** This instance's id, made once: it goes in every `llm-request/attempt-started` it writes. */
  private readonly instanceId = crypto.randomUUID();

  constructor(deps: LlmApiDeps) {
    super();
    this.deps = deps;
    this.contract = llmApiContract(deps.api);
  }

  /** THE FOLD: the requests whose provider speaks this API, while they have no end. A fact about
   *  any other request changes nothing, so the state is not written again for it. */
  override reduce({ event, state: previous }: ReduceArgs<LlmApiState, LlmApiEvent>): LlmApiState {
    let state = previous;
    const open = (requestOffset: number) =>
      state.requests.some((request) => request.requestOffset === requestOffset);
    const changed = (requestOffset: number, change: (request: OpenRequest) => OpenRequest) =>
      state.requests.map((request) =>
        request.requestOffset === requestOffset ? change(request) : request,
      );
    switch (event.type) {
      case "events.iterate.com/agent/configured":
        state = { ...state, config: mergedConfig(state.config, event.payload.config) };
        break;
      case "events.iterate.com/llm-request/requested": {
        const provider = state.config.llmProviders[providerNameOf(event.payload.model)];
        // a request for another API's provider is not this processor's business
        if (provider?.api !== this.deps.api.name) return previous;
        state = requested({ ...state, path: event.path }, event);
        break;
      }
      case "events.iterate.com/llm-request/attempt-started": {
        const { llmRequestOffset, attempt } = event.payload;
        if (!open(llmRequestOffset)) return previous;
        const started = (request: OpenRequest) => ({
          ...request,
          attempts: Math.max(request.attempts, attempt + 1),
        });
        state = { ...state, requests: changed(llmRequestOffset, started) };
        break;
      }
      case "events.iterate.com/llm-request/cancelled": {
        const { llmRequestOffset, reason } = event.payload;
        if (!open(llmRequestOffset)) return previous;
        state = {
          ...state,
          requests: changed(llmRequestOffset, (request) => ({
            ...request,
            cancelledBecause: reason,
          })),
        };
        break;
      }
      case "events.iterate.com/llm-request/settled": {
        const { llmRequestOffset, result } = event.payload;
        if (!open(llmRequestOffset)) return previous;
        state = ended(answeredBy(state, llmRequestOffset, result), (request) => {
          return request.requestOffset === llmRequestOffset;
        });
        break;
      }
      case "events.iterate.com/llm-request/deadline-passed": {
        const key = event.payload.llmRequestIdempotencyKey;
        if (!state.requests.some((request) => request.idempotencyKey === key)) return previous;
        state = ended(state, (request) => request.idempotencyKey === key);
        break;
      }
    }
    return { ...state, obligations: obligations(state) };
  }

  /** THE EFFECTS. Everything here is on `state.obligations`; what differs is only what this
   *  incarnation already has in flight. */
  override processEvent(args: LlmApiArgs): undefined {
    const { state, blockProcessorWhile, runInBackground, delivery } = args;
    // The compiler knows only the shared types: the types of the namespace are made at run time.
    const append = args.append as Append;
    // An attempt whose request ended without it stops (its deadline passed, or someone else
    // settled it). One whose request was cancelled stops and settles it, with what it had written.
    for (const [requestOffset, live] of this.liveAttempts) {
      const request = state.requests.find((open) => open.requestOffset === requestOffset);
      if (!request) cancel(live, "expired");
      else if (request.cancelledBecause) cancel(live, request.cancelledBecause);
    }
    if (!delivery.caughtUp) return; // a backlog is read, not acted on

    for (const owed of state.obligations) {
      const request = state.requests.find((open) => open.requestOffset === owed.requestOffset);
      // a live attempt settles its own request
      if (!request || this.liveAttempts.has(owed.requestOffset)) continue;
      if (owed.type === "settle") {
        if (this.settling.has(owed.requestOffset)) continue; // written, not yet read back
        this.settling.add(owed.requestOffset);
        const lastAttempt = Math.max(0, request.attempts - 1);
        blockProcessorWhile(() => appendSettlement(append, request, lastAttempt, owed.result));
      } else {
        const started: LiveAttempt = { controller: new AbortController(), cancelledBecause: null };
        this.liveAttempts.set(request.requestOffset, started);
        runInBackground(() => this.attempt(state, request, started, append));
      }
    }
  }

  /** ONE ATTEMPT OF ONE REQUEST: its two start facts, the bytes, the frames, the settlement. It reads
   *  the state the request was started from and writes facts. It changes nothing else. */
  protected async attempt(
    state: LlmApiState,
    request: OpenRequest,
    live: LiveAttempt,
    append: Append,
  ): Promise<void> {
    const { api, now } = this.deps;
    const startedAtMs = now();
    const attempt = request.attempts;
    const { config } = state;
    const provider = config.llmProviders[providerNameOf(request.model)];
    const { signal } = live.controller;
    const idleMs = config.llm.streamIdleTimeoutMs;
    const response: LlmResponse = {
      text: "",
      thinking: "",
      isThinking: false,
      providerItems: [],
      usage: null,
      done: false,
    };
    // THE API SHAPE'S OWN FACTS, written in order while the attempt runs, and all of them before
    // its settlement. A fact the shape does not declare is refused at once.
    let recorded: Promise<unknown> = Promise.resolve();
    const record = (event: string, payload: Record<string, unknown>) => {
      const fact = ownFact(api, event, payload);
      recorded = recorded
        .then(() => append(fact))
        .catch((error: unknown) => {
          const failure = { event: "agent.llm-api-fact-not-written", path: state.path };
          this.deps.report({ ...failure, type: fact.type, error: String(error) });
        });
    };
    let transport: LlmTransport | null = null;
    let inputChars: Record<string, number> = {};
    let inputFileBytes = 0;
    let firstEventAtMs: number | null = null;
    let result: LlmRequestResult;
    try {
      // the conversation it holds, or the one it reads from the log
      const asked = heldAsked(state, request) ?? (await this.fromTheLog(state, request));
      const items = await this.withFiles(state, asked.items);
      inputFileBytes = items.fileBytes;
      // the body that is sent, and the same body with the marker where each file's base64 is
      const sent = requestBody(request, asked, items.sent, api);
      const body = { ...sent.bodyWithoutInput, [sent.inputField]: sent.input };
      const stored = requestBody(request, asked, items.stored, api);
      inputChars = charsOf(asked.instructions, items.sent);
      // the API's own way to its model, if it has one for this attempt; else the provider's route
      const attemptOf = {
        model: request.model,
        provider,
        path: state.path,
        signal,
        idleMs,
        now,
        record,
      };
      transport = (await api.transport?.(attemptOf)) ?? this.route(state, request, signal);

      // THE ATTEMPT STARTS, in ONE append before the bytes leave: no request reaches a model without
      // its record. The shared fact's key names the request and the attempt, so that of two
      // processors only one starts it; the exact bytes are in this API shape's own fact.
      const last = this.lastStarted;
      const started = await startFacts({
        api: api.name,
        request,
        attempt,
        transport,
        body,
        stored,
        inputChars,
        inputFileBytes,
        last,
        instanceId: this.instanceId,
      });
      // started: the agent's wait for a processor is over
      const waitEnded = scheduleCancelled(`${request.idempotencyKey}/wait`);
      const appended = await append(...started.events, waitEnded).catch((error: unknown) => {
        if (errorCode(error) === "IDEMPOTENCY_CONFLICT") return null;
        throw error;
      });
      if (!appended) {
        // another processor makes this attempt: this one stays out of it
        transport.done?.();
        await recorded;
        this.liveAttempts.delete(request.requestOffset);
        return;
      }
      const offset = appended[1].offset;
      this.lastStarted = { offset, model: request.model, items: started.items };

      // THE FRAMES, in windows, ephemeral: what every provider says in one shape, and in the same
      // append the API's own events, unmodified. A window ends at once when `thinking` changes, so
      // a reader sees long thinking begin without a wait.
      let frames: Promise<unknown> = Promise.resolve();
      let sequence = 0;
      let windowOpenedAtMs = now();
      const opened = () => ({
        textDelta: "",
        thinkingDelta: "",
        thinking: response.isThinking,
        providerEvents: [] as unknown[],
      });
      let window = opened();
      const flush = () => {
        if (window.providerEvents.length === 0) return;
        const { providerEvents, ...words } = window;
        const ofWindow = { llmRequestOffset: request.requestOffset, attempt, sequence };
        const frame: LlmApiEventInput = {
          type: "events.iterate.com/llm-request/response-frame-received",
          ephemeral: true,
          payload: { ...ofWindow, ...words },
        };
        const own = providerFrame(api.name, { ...ofWindow, providerEvents });
        // a lost frame loses nothing durable: the settled fact carries the answer
        frames = frames.then(() => append(frame, own)).catch(() => {});
        sequence += 1;
        windowOpenedAtMs = now();
        window = opened();
      };
      // The stream is read to its end: an API can send its counts after its last word.
      try {
        for await (const providerEvent of transport.events(body)) {
          firstEventAtMs ??= now();
          const before = { text: response.text.length, thinking: response.thinking.length };
          api.read(response, providerEvent);
          // the window before this event ends with what it said of thinking
          const changed = response.isThinking !== window.thinking;
          if (changed) {
            flush();
            window.thinking = response.isThinking;
          }
          window.providerEvents.push(providerEvent);
          window.textDelta += response.text.slice(before.text);
          window.thinkingDelta += response.thinking.slice(before.thinking);
          // a frame holds at most 50 ms of the stream
          if (changed || now() - windowOpenedAtMs >= 50) flush();
        }
      } catch (error) {
        // a stream that breaks after the API said the answer is whole has lost nothing
        if (!response.done || live.cancelledBecause) throw error;
      }
      flush();
      await frames;
      if (!response.done)
        throw new LlmRequestFailure(
          "transport",
          "the stream ended before the response was complete",
        );
      // what the model said, as it said it: the agent reads its script out of the text
      result = {
        status: "succeeded",
        text: response.text,
        providerItems: response.providerItems,
        ...(response.usage && { usage: priced(config.prices, request.model, response.usage) }),
      };
    } catch (error) {
      transport?.failed?.();
      // Once anything came back, the request reached the model and cost its input: counted, or
      // estimated at four characters a token.
      const spent = response.usage || estimatedUsage(inputChars, response.text);
      const written = {
        partialText: response.text,
        ...(firstEventAtMs !== null && { usage: priced(config.prices, request.model, spent) }),
      };
      result = live.cancelledBecause
        ? { status: "cancelled", reason: live.cancelledBecause, ...written }
        : { status: "failed", ...failureOf(error), ...written };
    }
    transport?.done?.();
    await recorded;
    const times = {
      ...(firstEventAtMs !== null && { firstEventMs: firstEventAtMs - startedAtMs }),
      durationMs: now() - startedAtMs,
    };
    await appendSettlement(append, request, attempt, result, times).finally(() =>
      this.liveAttempts.delete(request.requestOffset),
    );
    this.deps.report({
      event: "agent.llm-request-attempt",
      path: state.path,
      api: api.name,
      llmRequestOffset: request.requestOffset,
      attempt,
      purpose: request.purpose,
      model: request.model,
      transport: transport?.name || null,
      status: result.status,
      inputFileBytes,
      ...times,
      usage: result.usage,
    });
  }

  /** THE FILES OF AN ATTEMPT. Each item comes twice: as it is sent, with each file's part, and as
   *  `<api>/request-started` stores it, with the marker in place of each file's base64. A file that
   *  is not shown is a line after the item's words. `fileBytes` counts the bytes of the files
   *  inlined. */
  private async withFiles(state: LlmApiState, items: ConversationItem[]) {
    const sent: RequestItem[] = [];
    const stored: RequestItem[] = [];
    let fileBytes = 0;
    for (const { files = [], ...item } of items) {
      const [parts, marked, lines]: unknown[][] = [[], [], []];
      for (const file of files) {
        const shown = await this.fileOf(state, file);
        if (typeof shown === "string") {
          lines.push(
            `[file ${file.filename} (${file.contentType}, ${file.size} bytes) is not shown: ${shown}]`,
          );
          continue;
        }
        parts.push(shown.part);
        marked.push(shown.marked);
        fileBytes += shown.bytes;
      }
      const text = [item.text, ...lines].join("\n");
      sent.push({ ...item, text, parts });
      stored.push({ ...item, text, parts: marked });
    }
    return { sent, stored, fileBytes };
  }

  /** ONE FILE as the API shape's part, and as the part with `$file:<path>:<sha256>` in place of its
   *  base64; or why it is not shown. Its bytes are read from the mind's file store through the
   *  context's `itx` only when the shape takes its type and its size is within the limit. */
  private async fileOf(
    state: LlmApiState,
    file: FileAttachment,
  ): Promise<{ part: unknown; marked: unknown; bytes: number } | string> {
    const { filePart } = this.deps.api;
    if (filePart(file, "") === null) return "this model's API takes no such type";
    const tooLarge = `it is larger than the limit of ${MAX_INLINE_FILE_BYTES} bytes`;
    if (file.size > MAX_INLINE_FILE_BYTES) return tooLarge;
    let bytes: Uint8Array;
    try {
      using itx = this.deps.getItx() as LlmApiItx & FilesItx;
      bytes = await itx.files.get(file.path).bytes();
      if (!(bytes instanceof Uint8Array)) throw new Error("`bytes()` gave no Uint8Array");
    } catch (error) {
      const failure = { event: "agent.llm-file-not-read", path: state.path, file: file.path };
      this.deps.report({ ...failure, error: String(error) });
      return "it could not be read";
    }
    if (bytes.length > MAX_INLINE_FILE_BYTES) return tooLarge;
    const marker = `$file:${file.path}:${await digestHex(bytes)}`;
    return {
      part: filePart(file, base64Of(bytes)),
      marked: filePart(file, marker),
      bytes: bytes.length,
    };
  }

  /** A REQUEST WHOSE BASE IS NOT HELD, PUT TOGETHER FROM THE LOG: its base's request fact, then that
   *  one's base, back to a request that is whole or held, at most `MAX_BASE_READS` reads; and for
   *  each base whose response is asked for, its settled fact. It throws a refusal, in words, for a
   *  base that is not a request, beyond a bound, or with no response when one is asked for. */
  private async fromTheLog(state: LlmApiState, request: OpenRequest): Promise<Asked> {
    const { readEvents } = this.deps;
    if (!request.unresolved)
      throw new LlmRequestFailure("refused", "its base is not held, and its request names none");
    // the requests of the chain, newest first, each with what it says
    const chain = [{ offset: request.requestOffset, model: request.model, ...request.unresolved }];
    let bottom: Held | null = null;
    while (!bottom) {
      const { extends: base } = chain[chain.length - 1];
      if (!base) {
        const whole = chain.pop()!;
        const settings = wholeSettings(whole);
        if (!settings)
          throw refusal(
            `the request ${whole.offset} has no base and names no instructions or no cache key`,
          );
        bottom = { ...whole, ...settings, items: whole.itemsAdded, response: null };
        break;
      }
      const held = state.conversations.find((c) => c.llmRequestOffset === base.llmRequestOffset);
      if (held) {
        bottom = { ...held, offset: held.llmRequestOffset };
        break;
      }
      if (chain.length > MAX_BASE_READS)
        throw refusal(`its chain of bases is longer than ${MAX_BASE_READS} requests`);
      const [fact] = (await readEvents(base.llmRequestOffset - 1, 1)).events;
      const parsed =
        fact?.offset === base.llmRequestOffset &&
        fact.type === "events.iterate.com/llm-request/requested"
          ? LlmRequestRequested.safeParse(fact.payload)
          : null;
      if (!parsed?.success)
        throw refusal(
          `its base, the fact at offset ${base.llmRequestOffset}, is not an LLM request`,
        );
      const { itemsAdded, ...said } = parsed.data;
      const items = placed(itemsAdded, base.llmRequestOffset);
      chain.push({ offset: base.llmRequestOffset, ...said, itemsAdded: items });
    }
    let asked = bottom;
    for (const layer of chain.reverse()) {
      const base = layer.extends!;
      const count = base.itemCount ?? asked.items.length;
      if (count > asked.items.length)
        throw refusal(
          `the request ${layer.offset} reads ${count} items of the request ${asked.offset}, which was asked ${asked.items.length}`,
        );
      const response = base.response ? [asked.response || (await this.responseOf(asked))] : [];
      asked = {
        offset: layer.offset,
        model: layer.model,
        ...overBase(asked, layer),
        items: [...asked.items.slice(0, count), ...response, ...layer.itemsAdded],
        response: null,
      };
    }
    return asked;
  }

  /** The response of the request at `base.offset`, from its settled fact: the first one after it,
   *  within `MAX_SETTLED_SCAN_EVENTS` events. */
  private async responseOf(base: Held): Promise<ConversationItem> {
    const { readEvents } = this.deps;
    for (let after = base.offset; after < base.offset + MAX_SETTLED_SCAN_EVENTS;) {
      const { events } = await readEvents(after, 500);
      const settled = events.find(
        (event) =>
          event.type === "events.iterate.com/llm-request/settled" &&
          event.payload?.llmRequestOffset === base.offset,
      );
      if (settled) {
        const result = LlmRequestResult.safeParse(settled.payload?.result);
        if (!result.success || result.data.status !== "succeeded")
          throw refusal(
            `its base, the request ${base.offset}, has no response: it did not succeed`,
          );
        return responseItem(base.offset, base.model, result.data);
      }
      if (events.length === 0) break;
      after = events[events.length - 1].offset;
    }
    throw refusal(
      `its base, the request ${base.offset}, has no settled fact within ${MAX_SETTLED_SCAN_EVENTS} events after it`,
    );
  }

  /** THE PROVIDER'S ROUTE, from its config. With a `baseUrl`: HTTP straight to that address,
   *  through its fetcher. With none: through its AI binding. */
  private route(state: LlmApiState, request: OpenRequest, signal: AbortSignal): LlmTransport {
    const provider = state.config.llmProviders[providerNameOf(request.model)];
    // the provider's fetcher, else the facet's own `fetch`; with neither, the AI binding
    const through = provider?.fetcher || this.deps.fetch;
    if (provider?.baseUrl && through) {
      const { direct } = this.deps.api;
      const name = modelNameOf(request.model);
      const url = `${provider.baseUrl.replace(/\/$/, "")}${direct.path(name)}`;
      const headers = {
        "content-type": "application/json",
        ...direct.headers,
        ...provider.headers,
      };
      return {
        name: "direct",
        events: (body) => {
          const sent = direct.modelInBody ? { model: name, ...body } : body;
          const init = { method: "POST", headers, body: JSON.stringify(sent) };
          return this.directEvents(state, through, url, init, signal);
        },
      };
    }
    // a state that was written before the field existed names no binding
    const ai = provider?.cloudflareAiBinding || CLOUDFLARE_AI_BINDING;
    return { name: "gateway", events: (body) => this.aiEvents(state, request, ai, body, signal) };
  }

  /** THE WAY STRAIGHT TO A SERVER: one HTTP request to the provider's `baseUrl`. `through` is the
   *  provider's fetcher, an itx expression: the request goes through its `fetch`, and the `itx`
   *  scope stays open until the last byte is read. Or `through` is the facet's own `fetch`. */
  private async *directEvents(
    state: LlmApiState,
    through: string | ((request: Request) => Promise<Response>),
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    const idleMs = state.config.llm.streamIdleTimeoutMs;
    if (typeof through === "function") {
      const answer = through(new Request(url, { ...init, signal }));
      yield* httpEvents(await unlessIdleOrAborted(answer, idleMs, signal), idleMs, signal);
      return;
    }
    using itx = this.deps.getItx();
    // The Request crosses RPC, so it carries no signal: the wait and the reader stop on it.
    const answer = await unlessIdleOrAborted(
      called(itx, through, ["fetch", new Request(url, init)]),
      idleMs,
      signal,
    );
    if (!(answer instanceof Response))
      throw new LlmRequestFailure("transport", `\`${through}\`: its fetch gave no response`);
    yield* httpEvents(answer, idleMs, signal);
  }

  /** THE WAY THROUGH AN AI BINDING: `run` of the expression `ai`, with the API's own body. With
   *  `itx.ai` the mind's gateway pays (unified billing), so the mind holds no provider key. The
   *  `itx` scope stays open until the last byte is read. */
  private async *aiEvents(
    state: LlmApiState,
    request: OpenRequest,
    ai: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    using itx = this.deps.getItx();
    const idleMs = state.config.llm.streamIdleTimeoutMs;
    const options = {
      returnRawResponse: true,
      gateway: {
        id: state.config.aiGateway.id,
        skipCache: true,
        // what the gateway's spend rules and its log split on: which agent, which request of it.
        // Three keys: iterate Cloud adds `mindId` and `mindSlug`, and five is the gateway's limit
        metadata: {
          streamPath: state.path,
          context: "agent-turn",
          llmRequestOffset: request.requestOffset,
        },
      },
    };
    const raw = await unlessIdleOrAborted(
      called(itx, ai, ["run", request.model, body, options]),
      idleMs,
      signal,
    );
    if (!(raw instanceof Response))
      throw new LlmRequestFailure("transport", `${request.model}: \`${ai}\` gave no raw response`);
    yield* httpEvents(raw, idleMs, signal);
  }
}

/** ONE CALL ON AN ITX EXPRESSION: the expression's steps after its root, then `call`, walked on
 *  the context's scope as one pipelined chain (iterate/expression). With `itx.ai` and a `run`
 *  step, it is `itx.ai.run(…)`. */
function called(itx: LlmApiItx, expression: string, call: ItxExpressionStep): Promise<unknown> {
  return Promise.resolve(walkStepsOnRpcStub(itx, [...parse(expression).slice(1), call]));
}

// ── the state transitions ── each is `(state, fact) → state`, pure

type Requested = Extract<LlmApiEvent, { type: "events.iterate.com/llm-request/requested" }>;

/** A REQUEST THIS PROCESSOR TAKES. Its conversation is what its base was asked (and the base's
 *  response, if it asks for it), then what the fact adds. With no base held, the fact's words wait
 *  in `unresolved` for the attempt, which reads the base from the log. */
function requested(state: LlmApiState, event: Requested): LlmApiState {
  const { extends: base, model, purpose } = event.payload;
  const { instructions, promptCacheKey, reasoningEffort, maxOutputTokens } = event.payload;
  const said: Said = { instructions, promptCacheKey, reasoningEffort, maxOutputTokens };
  const itemsAdded = placed(event.payload.itemsAdded, event.offset);
  const idempotencyKey = event.idempotencyKey || `llm-request/requested:${event.offset}`;
  const held =
    base && state.conversations.find((c) => c.llmRequestOffset === base.llmRequestOffset);
  const count = base?.itemCount ?? held?.items.length ?? 0;
  const settings = base ? null : wholeSettings(said);
  const resolved: Asked | null = base
    ? held && (!base.response || held.response) && count <= held.items.length
      ? {
          ...overBase(held, said),
          items: [
            ...held.items.slice(0, count),
            ...(base.response && held.response ? [held.response] : []),
            ...itemsAdded,
          ],
        }
      : null
    : settings && { ...settings, items: itemsAdded };
  const request: OpenRequest = {
    requestOffset: event.offset,
    idempotencyKey,
    model,
    purpose,
    attempts: 0,
    cancelledBecause: null,
    // (a whole request with no instructions or no cache key goes to the attempt too, which
    // refuses it)
    unresolved: resolved ? null : { extends: base, ...defined(said), itemsAdded },
  };
  const provider = providerNameOf(model);
  const conversation = resolved && {
    llmRequestOffset: event.offset,
    provider,
    model,
    ...resolved,
    response: null,
  };
  return kept({
    ...state,
    requests: [...state.requests, request],
    conversations: conversation ? [...state.conversations, conversation] : state.conversations,
  });
}

/** A REQUEST SUCCEEDED: its response is kept with its conversation, for a request off it. */
function answeredBy(
  state: LlmApiState,
  requestOffset: number,
  result: LlmRequestResult,
): LlmApiState {
  if (result.status !== "succeeded") return state;
  const conversations = state.conversations.map((c) =>
    c.llmRequestOffset === requestOffset
      ? { ...c, response: responseItem(requestOffset, c.model, result) }
      : c,
  );
  return { ...state, conversations };
}

/** A response as one item of a conversation: the same item the agent puts in its own. */
function responseItem(
  requestOffset: number,
  model: string,
  result: Extract<LlmRequestResult, { status: "succeeded" }>,
): ConversationItem {
  return {
    atOffset: requestOffset,
    rank: 0,
    tag: "llm-response",
    role: "assistant",
    text: result.text,
    providerItems: result.providerItems,
    providerModel: model,
  };
}

/** Requests end; the conversations no open request needs, but for the newest two, go. */
function ended(state: LlmApiState, isEnded: (request: OpenRequest) => boolean): LlmApiState {
  return kept({ ...state, requests: state.requests.filter((request) => !isEnded(request)) });
}

function kept(state: LlmApiState): LlmApiState {
  const needed = new Set(state.requests.map((request) => request.requestOffset));
  const providers = new Set(state.conversations.map((c) => c.provider));
  for (const provider of providers)
    for (const newest of state.conversations.filter((c) => c.provider === provider).slice(-2))
      needed.add(newest.llmRequestOffset);
  const conversations = state.conversations.filter((c) => needed.has(c.llmRequestOffset));
  return { ...state, conversations };
}

/** WHAT THE PROCESSOR OWES NOW: for each open request, one more attempt, or the settlement that
 *  ends it. A pure function of the state, kept in the state. */
function obligations(state: LlmApiState): ApiObligation[] {
  const { maxAttempts } = state.config.llmRequestRetryPolicy;
  return state.requests.map(({ requestOffset, attempts, cancelledBecause }) => {
    const settle = (result: LlmRequestResult) => ({
      type: "settle" as const,
      requestOffset,
      result,
    });
    // (a live attempt settles a cancelled request itself, with what it had written)
    if (cancelledBecause) return settle({ status: "cancelled", reason: cancelledBecause });
    if (attempts >= maxAttempts)
      return settle({
        status: "failed",
        failureKind: "transport",
        errorMessage: `its host died ${attempts} times before the model answered`,
      });
    return { type: "attempt", requestOffset };
  });
}

// ── the bytes of an attempt ──

/** What a request asks, when the processor holds its conversation. */
function heldAsked(state: LlmApiState, request: OpenRequest): Asked | null {
  if (request.unresolved) return null;
  return state.conversations.find((c) => c.llmRequestOffset === request.requestOffset) ?? null;
}

/** A REQUEST'S SETTINGS OVER ITS BASE'S: each that the request leaves out is the base's. */
function overBase(base: Settings, said: Said): Settings {
  return {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- llm-request.ts: absent instructions are the base's, and "" is a request's own empty instructions
    instructions: said.instructions ?? base.instructions,
    promptCacheKey: said.promptCacheKey || base.promptCacheKey,
    reasoningEffort:
      // oxlint-disable-next-line iterate/simple-truthiness-check -- llm-request.ts: an absent effort is the base's, and null is none
      said.reasoningEffort === undefined ? base.reasoningEffort : said.reasoningEffort,
    maxOutputTokens:
      said.maxOutputTokens === undefined ? base.maxOutputTokens : said.maxOutputTokens,
  };
}

/** A WHOLE REQUEST'S SETTINGS: it must name its instructions and its cache key. An absent effort
 *  or output limit is none. Null when it names too little. */
function wholeSettings(said: Said): Settings | null {
  const { instructions, promptCacheKey } = said;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- llm-request.ts: "" is instructions a whole request names, and only absent ones are too little
  if (instructions === undefined || !promptCacheKey) return null;
  return {
    instructions,
    promptCacheKey,
    reasoningEffort: said.reasoningEffort || null,
    maxOutputTokens: said.maxOutputTokens ?? null,
  };
}

/** The fields of `said` that are there: the state holds no `undefined`. */
const defined = (said: Said): Said =>
  Object.fromEntries(Object.entries(said).filter(([, value]) => value !== undefined));

/** The request in the API's own format. */
function requestBody(
  request: OpenRequest,
  settings: Settings,
  items: RequestItem[],
  api: LlmApi,
): LlmRequestBody {
  return api.body({
    model: request.model,
    instructions: settings.instructions,
    items,
    cacheKey: settings.promptCacheKey,
    reasoningEffort: settings.reasoningEffort,
    maxOutputTokens: settings.maxOutputTokens,
  });
}

/** The size of each kind of item, with the instructions. */
function charsOf(instructions: string, items: RequestItem[]): Record<string, number> {
  const chars: Record<string, number> = { instructions: instructions.length };
  for (const item of items) chars[item.tag] = (chars[item.tag] ?? 0) + item.text.length;
  return chars;
}

/** THE TWO FACTS THAT START ONE ATTEMPT: the shared `llm-request/attempt-started`, which holds no
 *  bytes, and this API shape's `<api>/request-started`, which holds them. The conversation is stored
 *  as what it adds to the `request-started` fact before it, so that a long history is written to
 *  the log once, not once for each request. */
async function startFacts(start: {
  api: string;
  request: OpenRequest;
  attempt: number;
  transport: LlmTransport;
  /** The body that is sent. */
  body: Record<string, unknown>;
  /** The same body with `$file:<path>:<sha256>` in place of each file's base64: what is stored. */
  stored: LlmRequestBody;
  inputChars: Record<string, number>;
  inputFileBytes: number;
  last: LastStarted | null;
  /** The instance's id: a second instance's body differs, so the log refuses it. */
  instanceId: string;
}): Promise<{ events: [LlmApiEventInput, LlmApiEventInput]; items: string[] }> {
  const { api, request, attempt, transport, body, inputChars, instanceId } = start;
  const { bodyWithoutInput, inputField, input: inputItems } = start.stored;
  // the items as the fact stores them: equal stored items are equal real ones, by the files' hashes
  const items = inputItems.map((item) => JSON.stringify(item));
  const last = start.last?.model === request.model ? start.last : null;
  let shared = 0;
  while (last && shared < last.items.length && last.items[shared] === items[shared]) shared += 1;
  const added = inputItems.slice(shared);
  const addedChars = items.slice(shared).reduce((sum, item) => sum + item.length, 0);
  const ofAttempt = { llmRequestOffset: request.requestOffset, attempt, model: request.model };
  const attemptStarted: LlmApiEventInput = {
    type: "events.iterate.com/llm-request/attempt-started",
    idempotencyKey: `llm-request/attempt-started:${request.requestOffset}/${attempt}`,
    payload: {
      ...ofAttempt,
      api,
      instanceId,
      transport: transport.name,
      inputChars,
      inputFileBytes: start.inputFileBytes,
    },
  };
  const bytes: ApiEventInput = {
    type: apiEventType(api, "request-started"),
    idempotencyKey: `${api}/request-started:${request.requestOffset}/${attempt}`,
    payload: {
      ...ofAttempt,
      transport: transport.name,
      bodyWithoutInput,
      inputField,
      extendsRequestStartedOffset: last && shared > 0 ? last.offset : null,
      inputItemCountBefore: shared,
      inputItemsAdded: addedChars > MAX_INPUT_ITEMS_CHARS ? null : added,
      bodySha256: await digestHex(new TextEncoder().encode(JSON.stringify(body))),
    } satisfies z.input<typeof RequestStarted>,
  };
  return { events: [attemptStarted, bytes], items };
}

/** One of the API shape's own facts (`LlmApi.events`), its payload checked by its schema. */
function ownFact(api: LlmApi, event: string, payload: Record<string, unknown>): ApiEventInput {
  const definition = api.events?.[event];
  if (!definition) throw new Error(`${api.name} declares no fact "${event}"`);
  definition.payloadSchema.parse(payload);
  return { type: apiEventType(api.name, event), payload };
}

/** THE BOUNDS OF A READ OF A BASE FROM THE LOG: request facts in one chain of bases, and the events
 *  after a base that are searched for its settled fact (in pages of 500). */
const MAX_BASE_READS = 64;
const MAX_SETTLED_SCAN_EVENTS = 10_000;

/** A request of a chain of bases, with what it was asked. */
type Held = Asked & { offset: number; model: string; response: ConversationItem | null };

const refusal = (reason: string) => new LlmRequestFailure("refused", reason);

/** An event row holds two megabytes: a conversation larger than this is not repeated in the fact. */
const MAX_INPUT_ITEMS_CHARS = 1_000_000;

/** The request's one terminal fact, under one key whoever writes it, and the end of its deadline. */
async function appendSettlement(
  append: Append,
  request: OpenRequest,
  attempt: number,
  result: LlmRequestResult,
  times: { firstEventMs?: number; durationMs?: number } = {},
): Promise<void> {
  const settled: LlmApiEventInput = {
    type: "events.iterate.com/llm-request/settled",
    idempotencyKey: `llm-request/settled:${request.requestOffset}`,
    payload: { llmRequestOffset: request.requestOffset, attempt, ...times, result },
  };
  const { idempotencyKey: key } = request;
  const schedules = [scheduleCancelled(`${key}/deadline`), scheduleCancelled(`${key}/wait`)];
  await append(settled, ...schedules).catch((error: unknown) => {
    if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error; // it has its terminal fact
  });
}

/** The end of one of the request's schedules: its deadline, or the agent's wait for a processor. */
const scheduleCancelled = (key: string): LlmApiEventInput => ({
  type: "events.iterate.com/itx/schedule-cancelled",
  payload: { key },
});

function cancel(live: LiveAttempt, reason: CancelReason): void {
  live.cancelledBecause ||= reason;
  live.controller.abort();
}

function priced(prices: AgentConfig["prices"], model: string, usage: LlmUsage): LlmUsage {
  const price = prices[model];
  return price ? { ...usage, costUsd: costUsd(price, usage) } : usage;
}

function estimatedUsage(inputChars: Record<string, number>, text: string): LlmUsage {
  const chars = Object.values(inputChars).reduce((sum, count) => sum + count, 0);
  return {
    inputTokens: Math.ceil(chars / 4),
    outputTokens: Math.ceil(text.length / 4),
    estimated: true,
  };
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ── the bytes of a file ──

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

// ── an HTTP answer, as the API's events ──

/** Server-sent events, or one JSON body, as the API's events, one by one. */
async function* httpEvents(
  response: Response,
  idleMs: number,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  if (!response.ok) throw httpFailure(response.status, await response.text());
  const reader = response.body?.getReader();
  if (!reader) throw new LlmRequestFailure("transport", "the answer has no body");
  const decoder = new TextDecoder();
  const eventStream = response.headers.get("content-type")?.includes("text/event-stream");
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await unlessIdleOrAborted(reader.read(), idleMs, signal);
      buffered += decoder.decode(value, { stream: !done });
      if (!eventStream && !done) continue; // one JSON body: read it whole
      const lines = eventStream ? buffered.split("\n") : [];
      if (eventStream) buffered = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice("data:".length).trim() : "";
        if (data && data !== "[DONE]") yield JSON.parse(data);
      }
      if (!done) continue;
      const json = eventStream ? [] : JSON.parse(buffered);
      yield* Array.isArray(json) ? json : [json];
      return;
    }
  } finally {
    void reader.cancel().catch(() => {}); // the stream is no longer wanted
  }
}

/** An HTTP status as a failure. 408, 429 and 5xx pass; a 429 with the gateway's code 2045 is a
 *  spend rule (docs/api-keys.md) and every other 4xx a refusal: the same request fails the same. */
function httpFailure(status: number, text: string): LlmRequestFailure {
  const spendRule = status === 429 && /"code":\s*2045\b/.test(text);
  const passes = !spendRule && (status === 408 || status === 429 || status >= 500);
  const kind = CONTEXT_WINDOW.test(text) ? "context-window" : passes ? "provider" : "refused";
  // (the gateway's refusal of a field lists the fields the model takes: kept whole)
  return new LlmRequestFailure(kind, `HTTP ${status}: ${text.slice(0, 1_500)}`);
}

function failureOf(error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const failureKind =
    error instanceof LlmRequestFailure ? error.failureKind : ("transport" as const);
  return { failureKind, errorMessage };
}

// ── what every API shape needs, so that no API file imports another ──

/** A model reads its own output items verbatim (its reasoning, its signatures); any other model
 *  reads the same response as the text it wrote. That is all a change of model takes. */
export const ownItemsOf = (
  item: Pick<ConversationItem, "providerItems" | "providerModel">,
  model: string,
) => (item.providerModel === model && item.providerItems?.length ? item.providerItems : null);

/** `xai/grok-4.3` is the provider `xai` and the model name `grok-4.3`. */
const providerNameOf = (model: string) => model.slice(0, Math.max(0, model.indexOf("/")));
export const modelNameOf = (model: string) => model.slice(model.indexOf("/") + 1);

/** How a request failed, for the agent's rules: `context-window` owes a summary, `refused` pauses
 *  at once, `provider` and `transport` are tried again after the back-off. */
export class LlmRequestFailure extends Error {
  readonly failureKind: "transport" | "provider" | "context-window" | "refused";
  constructor(failureKind: LlmRequestFailure["failureKind"], message: string) {
    super(message);
    this.failureKind = failureKind;
  }
}

const CONTEXT_WINDOW =
  /context_length_exceeded|context window|prompt is too long|too many tokens|maximum number of tokens/i;

/** An error that a stream reports inside itself. */
export function streamFailure(message = "the model reported an error"): LlmRequestFailure {
  return new LlmRequestFailure(
    CONTEXT_WINDOW.test(message) ? "context-window" : "provider",
    message,
  );
}

/** `work`, unless nothing comes for `idleMs`, or the attempt is cancelled. */
export function unlessIdleOrAborted<T>(
  work: Promise<T>,
  idleMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new LlmRequestFailure("transport", "the attempt was cancelled"));
    if (signal.aborted) return aborted();
    const timer = setTimeout(
      () => reject(new LlmRequestFailure("transport", `nothing came for ${idleMs} ms`)),
      idleMs,
    );
    signal.addEventListener("abort", aborted, { once: true });
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    });
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && !!value && !Array.isArray(value);

export function parsedJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null; // not JSON: the caller says what that means
  }
}
