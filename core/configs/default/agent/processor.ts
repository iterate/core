// processor.ts — THE AGENT'S PROCESSOR over the facts of contract.ts: one stream processor.
//
//   reduce        folds each fact into the state: one switch, pure. It reads no clock but the events'
//                 own times. Its last line writes down what the agent now OWES: `state.obligations`.
//   processEvent  appends what is owed, in a pass at the head of the log. So a new incarnation after a
//                 crash owes what the dead one owed and writes it, and a backlog is read, never acted
//                 on. It appends facts and does nothing else: no request, no connection, no timer.
//
// Below the class, in this order: the state transitions the switch calls; THE RULES, every `if` of the
// agent as a pure function of the state (when a request is due, when a summary pays, when to wake up);
// what a request asks; small helpers.
//
// It is hosted as the processor `agent` (facet.ts), in ANY context: an agent's context at
// `/agents/<name>`, or any other.
//
// THE AGENT MAKES NO LLM REQUEST. It writes `llm-request/requested`, which says what it asks in a
// form every API reads, and reads `llm-request/settled`, which says what came back. Both are
// facts of the request protocol (llm-request.ts). Whatever makes the request is another processor
// (llm-api.ts and its siblings for each API shape, a fake in a test, a server in a basement). This
// file imports none of them.
//
// A RESPONSE IS ONE `<codemode>` BLOCK AND NOTHING ELSE. No tool is declared. The agent runs the
// block's script and says no words itself: words reach someone only when the script appends them,
// and the model learns how from a prompt fragment (fragments.ts).
//
// THE AGENT KEEPS NO SCRIPT RESULT. The log is the agent's notebook: a result is a fact, its offset
// is its number, and a later script reads it by that number. script-envelope.ts is the code that
// goes around a script and the words the model reads of a result.
//
// NO GATE. An input starts what its policy says, at once. `agent/llm-request-triggered` starts a
// request now, whoever writes it. Every script runs. The next request waits
// for the script of a response. Each of these is one small protected method (`inputStarts`,
// `scriptMayRun`, `wakeTimesMs`): a subclass changes one, to let someone decide first, or to let
// the chain go on past a slow script. The template holds no such subclass.
//
// EVERY WAIT HAS A STATED END, written as a schedule fact in the log: a request's deadline, a retry's
// back-off, the debounce, a request no processor takes. Nothing sleeps.
//
// To change the agent, change a rule.

import { errorCode } from "iterate/lib";
import {
  StreamProcessor,
  type ConsumedEvent,
  type ProcessEventArgs,
  type ReduceArgs,
  type StreamEvent,
} from "iterate/stream/processor";
import {
  AgentContract,
  mergedConfig,
  startsTheAgent,
  type AgentEventInput,
  type AgentState,
  type LlmRequestBehaviour,
  type Obligation,
} from "./contract.ts";
import { placed, type ConversationItem } from "./llm-request.ts";
import { SCRIPT_GUIDE, scriptRunCode, scriptRunOutcome } from "./script-envelope.ts";

export type AgentEvent = ConsumedEvent<typeof AgentContract>;
export type AgentProcessEventArgs = ProcessEventArgs<AgentState, AgentEvent, AgentEventInput>;
type OpenLlmRequest = AgentState["llmRequests"][number];
export type ScriptCall = AgentState["scriptCalls"][number];
/** What an input that starts something does to the open request: wait for it, or interrupt it. */
export type StartingBehaviour = Exclude<LlmRequestBehaviour, "dont-trigger-request">;
type LlmRequestResult = Extract<
  AgentEvent,
  { type: "events.iterate.com/llm-request/settled" }
>["payload"]["result"];

export class Agent extends StreamProcessor<AgentState, AgentEvent> {
  /** A subclass with facts or state of its own puts its own contract here, one that lists this one
   *  in its `processorDeps`. */
  readonly contract = AgentContract;
  /** RUNTIME STATE, gone with the host and never read by a rule: what this incarnation has
   *  appended and not yet read back, so that it writes nothing twice. */
  protected readonly appendedKeys = new Set<string>();

  /** THE FOLD. Each case is one fact; the last line is the convention: the state says what is owed. */
  override reduce({ event, state: previous }: ReduceArgs<AgentState, AgentEvent>): AgentState {
    // NOTHING BEFORE THE START FACT IS THE AGENT'S (contract.ts): another agent's log can stand there
    if (previous.startedAtOffset === null && !startsTheAgent(event)) return previous;
    const nowMs = Math.max(previous.nowMs, Date.parse(event.createdAt));
    const startedAtOffset = previous.startedAtOffset || event.offset;
    let state: AgentState = { ...previous, startedAtOffset, path: event.path, nowMs };
    switch (event.type) {
      case "events.iterate.com/agent/configured":
        state = { ...state, config: mergedConfig(state.config, event.payload.config) };
        break;
      case "events.iterate.com/agent/context-added": {
        const { role, llmRequestPolicy } = event.payload;
        // what was said in the agent's name, and the system's words, start nothing by themselves
        const ofRole =
          role === "user" || role === "developer"
            ? state.config.llmRequestPolicy.behaviour
            : "dont-trigger-request";
        const behaviour = llmRequestPolicy?.behaviour || ofRole;
        state = contextAdded(state, event);
        if (behaviour !== "dont-trigger-request")
          state = this.inputStarts(state, event.offset, behaviour);
        break;
      }
      case "events.iterate.com/agent/context-copied":
        state = contextCopied(state, event.payload);
        break;
      case "events.iterate.com/agent/llm-request-triggered":
        state = llmRequestTriggered(state, event);
        break;
      case "events.iterate.com/llm-request/requested":
        state = llmRequestRequested(state, event);
        break;
      case "events.iterate.com/llm-request/attempt-started":
        state = attemptStarted(state, event.payload.llmRequestOffset, event.payload.attempt);
        break;
      case "events.iterate.com/llm-request/cancelled": {
        const { llmRequestOffset } = event.payload;
        state = withLlmRequest(state, llmRequestOffset, (request) => ({
          ...request,
          cancelledAtMs: request.cancelledAtMs ?? nowMs,
        }));
        break;
      }
      case "events.iterate.com/llm-request/settled": {
        const { llmRequestOffset, result } = event.payload;
        const open = state.llmRequests.some((r) => r.requestOffset === llmRequestOffset);
        const read = open && result.status === "succeeded" ? this.scriptsOf(result) : null;
        state = llmRequestEnded(state, llmRequestOffset, result, read);
        break;
      }
      case "events.iterate.com/llm-request/wait-ended":
        // it brings the time the wait ends: the rule that settles an unsent request reads it
        state = { ...state, nowMs: Math.max(state.nowMs, event.payload.atMs) };
        break;
      case "events.iterate.com/llm-request/deadline-passed": {
        const key = event.payload.llmRequestIdempotencyKey;
        const request = state.llmRequests.find((open) => open.idempotencyKey === key);
        const expired = { status: "cancelled" as const, reason: "expired" as const };
        if (request) state = llmRequestEnded(state, request.requestOffset, expired);
        break;
      }
      case "events.iterate.com/itx/run-requested": {
        const call = state.scriptCalls.find((c) => scriptRunKey(c) === event.idempotencyKey);
        const requested = { runRequestOffset: event.offset, runRequestedAtMs: nowMs };
        if (call) state = withScriptCall(state, call, { ...call, ...requested });
        break;
      }
      case "events.iterate.com/itx/run-settled":
        state = scriptRunSettled(state, event.offset, event.payload);
        break;
      case "events.iterate.com/agent/paused": {
        const { reason, endsAtNextOutsideInput } = event.payload;
        const ends = endsAtNextOutsideInput === true;
        // A pause of the agent's own that an input from outside overtook on its way (nothing is
        // left to pause for) is over as it arrives.
        const endedByOffset = ends && pauseReason(state) === null ? event.offset : null;
        state = { ...state, paused: { reason, endsAtNextOutsideInput: ends, endedByOffset } };
        break;
      }
      case "events.iterate.com/agent/resumed":
        state = { ...state, ...COUNTS_START_OVER, paused: null, contextWindowExceeded: false };
        break;
      case "events.iterate.com/agent/timer-set":
        state = { ...state, timer: { atMs: event.payload.atMs, sets: state.timer.sets + 1 } };
        break;
      case "events.iterate.com/agent/timer-fired":
        // the fact brings the time it was asked for, whatever the clock that wrote it says
        state = {
          ...state,
          nowMs: Math.max(state.nowMs, event.payload.atMs),
          timer: { ...state.timer, atMs: null },
        };
        break;
    }
    return { ...state, obligations: this.obligations(state) };
  }

  /** THE EFFECTS: every fact owed, in ONE append (one wait for the disk). A settlement the agent
   *  writes for a request no processor took goes alone: the processor may have written its own
   *  first, and then the agent's is refused, which is right. */
  override processEvent({ state, append, blockProcessorWhile, delivery }: AgentProcessEventArgs) {
    if (!delivery.caughtUp) return; // a backlog is read, not acted on
    const owed = state.obligations.filter((o) => !this.appendedKeys.has(o.idempotencyKey));
    const settlements = owed.filter((o) => o.idempotencyKey.startsWith(SETTLED));
    const others = owed.filter((o) => !o.idempotencyKey.startsWith(SETTLED));
    const appended = (obligations: Obligation[]) => async () => {
      await append(...obligations.flatMap((o) => o.events)).catch((error: unknown) => {
        if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error; // its processor was first
      });
      for (const o of obligations) this.appendedKeys.add(o.idempotencyKey);
    };
    if (others.length > 0) blockProcessorWhile(appended(others));
    for (const settlement of settlements) blockProcessorWhile(appended([settlement]));
    return undefined;
  }

  /** WHAT THE AGENT OWES NOW: a pure function of the state, kept in the state. Every append has a
   *  key that names its decision point, so that deciding twice writes once. */
  protected obligations(state: AgentState): Obligation[] {
    return [
      ...state.scriptCalls
        .filter((call) => call.runRequestOffset === null && this.scriptMayRun(state, call))
        .map((call) =>
          owedAppend(scriptRunKey(call), {
            type: "events.iterate.com/itx/run-requested",
            // the model's script in its envelope: the way to earlier results, its appends kept
            payload: {
              code: scriptRunCode({
                script: call.script,
                agentPath: state.path,
                llmRequestOffset: call.llmRequestOffset,
                lineage: state.lineage,
              }),
            },
          }),
        ),
      ...pauseOwed(state),
      ...this.llmRequestsOwed(state),
      ...llmRequestEndsOwed(state),
      ...timerOwed(state, this.wakeTimesMs(state)),
    ];
  }

  /** The requests to make now. A subclass that asks several models at once returns more. */
  protected llmRequestsOwed(state: AgentState): Obligation[] {
    const { model } = state.config.llm;
    const scripts = this.scriptsAsked();
    return [
      ...(answerRequestDue(state) ? [llmRequestOwed(state, "answer", model, scripts)] : []),
      ...(summaryRequestDue(state) ? [llmRequestOwed(state, "summary", model, scripts)] : []),
    ];
  }

  /** WHAT AN INPUT STARTS: what its policy says, at once. A subclass that lets someone decide first
   *  holds the input here, and calls `triggered` when it is decided. */
  protected inputStarts(
    state: AgentState,
    inputOffset: number,
    behaviour: StartingBehaviour,
  ): AgentState {
    return triggered(state, inputOffset, behaviour);
  }

  /** WHETHER A SCRIPT MAY RUN NOW: every script runs. A subclass that lets someone decide first says
   *  no here until it is decided. */
  protected scriptMayRun(_state: AgentState, _call: ScriptCall): boolean {
    return true;
  }

  /** THE TIMES A RULE COULD BECOME TRUE BY TIME ALONE: the debounce or a back-off ends, the cache is
   *  about to be dropped. The agent sets its one timer for the soonest that is still to come. A
   *  subclass that waits for a time of its own adds it here. */
  protected wakeTimesMs(state: AgentState): number[] {
    return wakeTimesMs(state);
  }

  /** HOW THE MODEL IS ASKED TO WRITE ITS SCRIPT: what the instructions add. One `<codemode>` block
   *  that is the whole response. A subclass that asks for another form changes this and `scriptsOf`. */
  protected scriptsAsked(): string {
    return CODEMODE_INSTRUCTIONS;
  }

  /** THE SCRIPT OF A RESPONSE: its one `<codemode>` block, or why it has none that may run. Pure:
   *  the fold calls it. A tool call that comes anyway is not read: the text has no block. */
  protected scriptsOf(result: Extract<LlmRequestResult, { status: "succeeded" }>): ScriptsRead {
    return codemodeBlockOf(result.text);
  }
}

// ── the state transitions ── each is `(state, fact) → state`, pure

type ContextAdded = Extract<AgentEvent, { type: "events.iterate.com/agent/context-added" }>;

/** HOW AN INPUT OF EACH ROLE STANDS IN THE CONVERSATION. `tag` is the bucket its size is counted
 *  in: a person's words and other context are counted apart in every request's `inputChars`. What
 *  was said in the agent's name stands as a response, so every API shape writes it as the
 *  assistant's (an API shape sends no file of a response). The system's words are developer context. */
const ITEM_OF_ROLE = {
  user: { role: "user", tag: "words" },
  developer: { role: "developer", tag: "context" },
  system: { role: "developer", tag: "context" },
  assistant: { role: "assistant", tag: "llm-response" },
} as const;

/** THE INPUT enters the conversation at its own offset, with the files it names. What it starts is
 *  decided apart from this (`Agent.inputStarts`). */
function contextAdded(state: AgentState, event: ContextAdded): AgentState {
  const { role, content, files } = event.payload;
  const from = role === "user" ? senderOf(event) : null;
  const text = from ? `[from ${from}]\n${content}` : content;
  const item = { atOffset: event.offset, rank: 0, ...ITEM_OF_ROLE[role], text, files };
  return fromOutside(withItem(state, item), event);
}

type ContextCopied = Extract<
  AgentEvent,
  { type: "events.iterate.com/agent/context-copied" }
>["payload"];

/** A FORKED SUBAGENT'S COPY OF ITS PARENT'S CONVERSATION: its items stand first, in their order,
 *  with every field as it was, so the first request begins with the parent's bytes. The parts
 *  arrive in order, in one append. It starts nothing. */
function contextCopied(state: AgentState, copied: ContextCopied): AgentState {
  const copiedItems = copied.part === 0 ? copied.items : [...state.copiedItems, ...copied.items];
  return { ...state, copiedItems, lineage: copied.lineage };
}

/** WHO SENT AN INPUT: the context whose code wrote the fact. The platform stamps it as
 *  `source.origin`, also when a script of one context appends to another. No sender when the
 *  agent's own context wrote it, or the root `/`, or the agents API at `/agents`, or when the fact
 *  has no origin. */
function senderOf(event: ContextAdded): string | null {
  const { origin } = event.source;
  return origin && ![event.path, "/", "/agents"].includes(origin) ? origin : null;
}

/** FROM OUTSIDE: the input's chain of causes began later than every chain that counted before. Only
 *  that starts the agent's own counts over, so nothing the agent causes can keep itself going. */
function fromOutside(state: AgentState, event: StreamEvent): AgentState {
  const causeAtMs = causeBeganAtMs(event);
  if (causeAtMs <= state.newestOutsideCauseAtMs) return state;
  return {
    ...state,
    ...COUNTS_START_OVER,
    newestOutsideCauseAtMs: causeAtMs,
    // a pause the agent set itself ends here: the agent owes the fact that says so
    paused: state.paused?.endsAtNextOutsideInput
      ? { ...state.paused, endedByOffset: state.paused.endedByOffset ?? event.offset }
      : state.paused,
  };
}

type LlmRequestTriggered = Extract<
  AgentEvent,
  { type: "events.iterate.com/agent/llm-request-triggered" }
>;

/** MAKE A REQUEST NOW: an input that interrupts, with no debounce. It is a trigger of its own, so a
 *  request is due though every input before it was context only, and the request names it as its
 *  `triggerOffset`. It goes past `Agent.inputStarts`: it is the decision. A pause still holds. */
function llmRequestTriggered(state: AgentState, event: LlmRequestTriggered): AgentState {
  const next = triggered(fromOutside(state, event), event.offset, "interrupt-current-request");
  return { ...next, debounceUntilMs: Math.min(next.debounceUntilMs, next.nowMs) };
}

const COUNTS_START_OVER = {
  llmRequestsWithoutOutsideInput: 0,
  failedLlmRequestsInARow: { answer: 0, summary: 0 },
  retryNotBeforeMs: { answer: 0, summary: 0 },
  lastLlmRequestError: null,
};

/** Something wants a request: an input, or the result of a response's script. An interrupting
 *  one marks every open answer request, whose response then no longer counts. */
function triggered(
  state: AgentState,
  triggerOffset: number,
  behaviour: StartingBehaviour,
): AgentState {
  const firstToWait = state.pendingTriggerOffsets.length === 0;
  return {
    ...state,
    pendingTriggerOffsets: [...state.pendingTriggerOffsets, triggerOffset],
    debounceUntilMs: firstToWait
      ? state.nowMs + state.config.llmRequestDebounceMs
      : state.debounceUntilMs,
    llmRequests:
      behaviour !== "interrupt-current-request"
        ? state.llmRequests
        : state.llmRequests.map((request) =>
            request.purpose === "answer" && request.interruptedByOffset === null
              ? { ...request, interruptedByOffset: triggerOffset }
              : request,
          ),
  };
}

type LlmRequestRequested = Extract<
  AgentEvent,
  { type: "events.iterate.com/llm-request/requested" }
>;

/** A REQUEST OF THE AGENT IS OPEN. What it asked a provider is that provider's newest conversation
 *  now, so the next request to it says only what is new. */
function llmRequestRequested(state: AgentState, event: LlmRequestRequested): AgentState {
  const { purpose, model, expiresAtMs, replacesHistoryThroughOffset } = event.payload;
  // a `side` request is someone else's (a script's own append): no state, no script, no count
  if (purpose === "side") return state;
  const idempotencyKey = event.idempotencyKey || `llm-request/requested:${event.offset}`;
  const request: OpenLlmRequest = {
    requestOffset: event.offset,
    idempotencyKey,
    purpose,
    model,
    // an answer or a summary that someone else asked with no deadline has the agent's own
    expiresAtMs: expiresAtMs ?? state.nowMs + state.config.llmRequestExpiryMs,
    triggerOffsets: purpose === "answer" ? state.pendingTriggerOffsets : [],
    replacesHistoryThroughOffset: replacesHistoryThroughOffset ?? null,
    requestedAtMs: state.nowMs,
    attempts: 0,
    interruptedByOffset: null,
    cancelledAtMs: null,
  };
  const provider = providerNameOf(model);
  const { extends: base, itemsAdded } = event.payload;
  // the agent's own requests extend its newest request to the same provider, with no response
  const before = base
    ? (state.llmRequestBases[provider]?.itemKeys.slice(0, base.itemCount ?? undefined) ?? [])
    : [];
  const asked = {
    llmRequestOffset: event.offset,
    itemKeys: [...before, ...placed(itemsAdded, event.offset).map(itemKey)],
  };
  return {
    ...state,
    llmRequests: [...state.llmRequests, request],
    llmRequestBases: { ...state.llmRequestBases, [provider]: asked },
    llmRequestCounts: { ...state.llmRequestCounts, [purpose]: state.llmRequestCounts[purpose] + 1 },
    llmRequestsWithoutOutsideInput:
      state.llmRequestsWithoutOutsideInput + (purpose === "answer" ? 1 : 0),
    totals: { ...state.totals, llmRequests: state.totals.llmRequests + 1 },
  };
}

function attemptStarted(state: AgentState, requestOffset: number, attempt: number): AgentState {
  const { totals } = state;
  if (!state.llmRequests.some((request) => request.requestOffset === requestOffset)) return state;
  return {
    ...withLlmRequest(state, requestOffset, (request) => ({
      ...request,
      attempts: Math.max(request.attempts, attempt + 1),
    })),
    // an attempt after the first: the one before it died with its host
    totals:
      attempt > 0
        ? { ...totals, deadLlmRequestAttempts: totals.deadLlmRequestAttempts + 1 }
        : totals,
  };
}

/** A REQUEST ENDS, by its settled fact or by its deadline. What it cost is always counted. What it
 *  said counts only if it succeeded and nothing overtook it. */
function llmRequestEnded(
  state: AgentState,
  requestOffset: number,
  result: LlmRequestResult,
  read: ScriptsRead | null = null,
): AgentState {
  const request = state.llmRequests.find((open) => open.requestOffset === requestOffset);
  const costUsd = state.totals.costUsd + (result.usage?.costUsd ?? 0);
  const spent: AgentState = { ...state, totals: { ...state.totals, costUsd } };
  if (!request) return spent; // it had ended already: only its cost is new
  const overtaken = overtakenBy(spent, request);
  const next = { ...spent, llmRequests: spent.llmRequests.filter((open) => open !== request) };
  if (request.purpose === "summary")
    return result.status === "succeeded" && result.text.trim()
      ? summarised(next, request, result.text)
      : llmRequestFailed(next, "summary", result);
  if (overtaken === "superseded") return next; // the response that won is in the conversation
  if (overtaken === "interrupted-by-user-input") {
    // the next request sees what was written so far, and that it was interrupted
    const partial = result.status === "succeeded" ? result.text : result.partialText || "";
    const text = partial
      ? `${INTERRUPTED_NOTE}\nWhat you had written so far:\n${partial}`
      : INTERRUPTED_NOTE;
    const tag = "interrupted-llm-response";
    return withItem(next, { atOffset: requestOffset, rank: 0, tag, role: "developer", text });
  }
  return result.status === "succeeded" && read
    ? answered(next, request, result, read)
    : llmRequestFailed(next, "answer", result);
}

const INTERRUPTED_NOTE =
  "Your previous response was interrupted by a newer input before it finished. Nothing of it was said or run.";

/** A RESPONSE THAT COUNTS: it enters the conversation at its request's offset, its script waits to
 *  run, and the inputs it read are answered. `read` is its script, read out of it by the class
 *  (`Agent.scriptsOf`), with a note on it or the reason it may not run.
 *
 *  A RESPONSE THAT BREAKS THE RULE (`read.refused`) is a FAILED ANSWER, by the rules that already
 *  hold for a failed request: it counts in `failedLlmRequestsInARow.answer`, its inputs stay
 *  pending so the next request is due, and `maxAttempts` in a row pause the agent (`pauseReason`).
 *  So no new count, no new rule and no new fact. Unlike a failed request it waits for no back-off:
 *  the provider is fine, the model is told what was wrong (a developer item after its response)
 *  and asked again at once. A good response starts the count over, as any success does. */
function answered(
  state: AgentState,
  request: OpenLlmRequest,
  result: Extract<LlmRequestResult, { status: "succeeded" }>,
  read: ScriptsRead,
): AgentState {
  const { usage, providerItems } = result;
  const { scripts, refused, note } = read;
  const llmRequestOffset = request.requestOffset;
  const price = state.config.prices[request.model];
  const silent = scripts.length === 0 && !refused;
  let next = withItem(state, {
    atOffset: llmRequestOffset,
    rank: 0,
    tag: "llm-response",
    role: "assistant",
    // what the model wrote, as it wrote it: another model reads it so
    text: result.text,
    providerItems,
    providerModel: request.model,
  });
  // what the model is told of this response next time: why nothing ran, or a note on it. A note
  // stands after the script's result, and asks for no request itself.
  const told = refused || note;
  if (told) {
    const rank = refused ? 1 : 1 + scripts.length;
    next = withItem(next, {
      atOffset: llmRequestOffset,
      rank,
      tag: "context",
      role: "developer",
      text: told,
    });
  }
  // the rent: what reading the history AGAIN cost this time, at this model's prices. Only tokens
  // the provider had read before are rent (it says which: the cached ones). New tokens are read
  // once whatever the agent does, and the first read after a summary is the summary's own price:
  // counted as rent, it would make every summary pay for the next one.
  const rentUsd = price ? ((usage?.cachedInputTokens ?? 0) * price.cachedInput) / 1e6 : 0;
  const history = usage
    ? {
        inputTokens: usage.inputTokens + usage.outputTokens,
        lastReadAtMs: state.nowMs,
        rentUsd: next.history.rentUsd + rentUsd,
      }
    : next.history;
  if (refused) {
    const inARow = next.failedLlmRequestsInARow.answer + 1;
    return {
      ...next,
      history,
      failedLlmRequestsInARow: { ...next.failedLlmRequestsInARow, answer: inARow },
      lastLlmRequestError: `a response broke the one-block rule: ${refused.split("\n")[0]}`,
    };
  }
  const scriptCalls = scripts.map((script, callIndex): ScriptCall => ({
    llmRequestOffset,
    callIndex,
    script,
    askedAtMs: state.nowMs,
    runRequestOffset: null,
    runRequestedAtMs: null,
    answered: false,
    wantsLlmRequest: false,
  }));
  const { totals } = next;
  return {
    ...next,
    pendingTriggerOffsets: next.pendingTriggerOffsets.filter(
      (offset) => !request.triggerOffsets.includes(offset),
    ),
    scriptCalls: [...next.scriptCalls, ...scriptCalls],
    failedLlmRequestsInARow: { ...next.failedLlmRequestsInARow, answer: 0 },
    history,
    // a response with no script: the agent chose silence
    totals: silent
      ? {
          ...totals,
          silentLlmResponses: totals.silentLlmResponses + 1,
          silentLlmResponsesCostUsd: totals.silentLlmResponsesCostUsd + (usage?.costUsd ?? 0),
        }
      : totals,
  };
}

/** A summary replaces everything through its barrier. The rent starts over, and there is no cache
 *  to lose until a provider has read the new history. */
function summarised(state: AgentState, request: OpenLlmRequest, text: string): AgentState {
  const atOffset = request.replacesHistoryThroughOffset ?? 0;
  const summary: ConversationItem = {
    atOffset,
    rank: 0,
    tag: "summary",
    role: "developer",
    text: `Summary of the conversation before this point:\n${text}`,
  };
  // the copied items stand before every own item: a summary replaces them all
  const items = [summary, ...state.items.filter((item) => item.atOffset > atOffset)];
  const chars = items.reduce((sum, item) => sum + item.text.length, 0);
  return {
    ...state,
    items,
    copiedItems: [],
    contextWindowExceeded: false,
    failedLlmRequestsInARow: { ...state.failedLlmRequestsInARow, summary: 0 },
    history: { inputTokens: Math.ceil(chars / 4), lastReadAtMs: 0, rentUsd: 0 },
  };
}

/** A request ended with no response. The next one of its purpose waits for the back-off; after
 *  `maxAttempts` in a row the agent owes a pause (`pauseOwed`). */
function llmRequestFailed(
  state: AgentState,
  purpose: "answer" | "summary",
  result: LlmRequestResult,
): AgentState {
  const { backoffBaseMs, backoffMaxMs, maxAttempts } = state.config.llmRequestRetryPolicy;
  const failed = result.status === "failed" ? result : null;
  const inARow = state.failedLlmRequestsInARow[purpose] + 1;
  const error =
    failed?.errorMessage ||
    (result.status === "cancelled" ? `it was cancelled: ${result.reason}` : "an empty summary");
  const backoffMs = Math.min(backoffBaseMs * 2 ** (inARow - 1), backoffMaxMs);
  return {
    ...state,
    failedLlmRequestsInARow: {
      ...state.failedLlmRequestsInARow,
      // a refusal would be refused again: no retry
      [purpose]: failed?.failureKind === "refused" ? Math.max(inARow, maxAttempts) : inARow,
    },
    retryNotBeforeMs: { ...state.retryNotBeforeMs, [purpose]: state.nowMs + backoffMs },
    lastLlmRequestError: error,
    contextWindowExceeded: state.contextWindowExceeded || failed?.failureKind === "context-window",
  };
}

type RunSettled = Extract<AgentEvent, { type: "events.iterate.com/itx/run-settled" }>["payload"];

function scriptRunSettled(state: AgentState, atOffset: number, run: RunSettled): AgentState {
  const call = state.scriptCalls.find(
    (c) => c.runRequestOffset === run.requestOffset && !c.answered,
  );
  if (!call) return state; // not a script of this agent, or one a subclass answered already
  // THE RESULT'S NUMBER IS THIS FACT'S OFFSET: the model reads it at the head of the result, and a
  // later script reads the value from the log by it (script-envelope.ts). The state keeps no result.
  const text = scriptRunOutcome({
    settlement: run.settlement,
    resultNumber: atOffset + resultNumberBase(state),
    ranMs: state.nowMs - (call.runRequestedAtMs ?? state.nowMs),
    historyLimit: state.config.scriptResultHistoryLimit,
  });
  // a script that returned nothing asks for no further request
  return scriptAnswered(state, atOffset, call, {
    text: text || "",
    // oxlint-disable-next-line iterate/simple-truthiness-check -- script-envelope.ts: null is a script that returned nothing, and any text, "" too, is a result to read
    wantsLlmRequest: text !== null,
  });
}

/** A SCRIPT IS ANSWERED: its result (or a subclass's note on it) enters the conversation beside its
 *  response. When the last script of a response is answered, the next request can read the
 *  response whole, and starts if any result is worth reading. `atOffset` is the fact that answered
 *  it: the trigger of that request. */
function scriptAnswered(
  state: AgentState,
  atOffset: number,
  call: ScriptCall,
  answer: { text: string; wantsLlmRequest: boolean },
): AgentState {
  const text = answer.text || "(it returned nothing)";
  const answeredCall = { ...call, wantsLlmRequest: answer.wantsLlmRequest, answered: true };
  const next = withItem(withScriptCall(state, call, answeredCall), {
    atOffset: call.llmRequestOffset,
    rank: 1 + call.callIndex,
    tag: "script-result",
    role: "developer",
    text: `Result of script ${call.callIndex + 1}:\n${text}`,
  });
  const ofResponse = next.scriptCalls.filter((c) => c.llmRequestOffset === call.llmRequestOffset);
  if (ofResponse.some((c) => !c.answered)) return next;
  // the response is whole: its scripts are done with
  const left = next.scriptCalls.filter((c) => c.llmRequestOffset !== call.llmRequestOffset);
  const whole = { ...next, scriptCalls: left };
  return ofResponse.some((c) => c.wantsLlmRequest)
    ? triggered(whole, atOffset, "after-current-request")
    : whole;
}

// ── THE RULES ── every `if` of the agent, each a pure function of the state

/** AN ANSWER REQUEST IS DUE when something waits to be read and nothing stands in the way. */
function answerRequestDue(state: AgentState): boolean {
  const { llmRequestRetryPolicy, maxLlmRequestsWithoutOutsideInput } = state.config;
  return (
    state.pendingTriggerOffsets.length > 0 &&
    !state.paused &&
    !state.contextWindowExceeded && // a summary first
    !state.llmRequests.some((request) => request.purpose === "answer") && // one at a time
    state.scriptCalls.every((call) => call.answered) && // a response is read whole
    state.nowMs >= Math.max(state.debounceUntilMs, state.retryNotBeforeMs.answer) &&
    state.failedLlmRequestsInARow.answer < llmRequestRetryPolicy.maxAttempts &&
    state.llmRequestsWithoutOutsideInput < maxLlmRequestsWithoutOutsideInput
  );
}

/** A SUMMARY REQUEST IS DUE, beside whatever else runs, when it pays and there is history to replace. */
function summaryRequestDue(state: AgentState): boolean {
  return (
    !state.paused &&
    !state.llmRequests.some((request) => request.purpose === "summary") &&
    state.nowMs >= state.retryNotBeforeMs.summary &&
    state.failedLlmRequestsInARow.summary < state.config.llmRequestRetryPolicy.maxAttempts &&
    summaryBarrier(state) !== null &&
    summaryPays(state)
  );
}

/** RENT OR PURCHASE. Every request pays rent on the history: a cached token costs a tenth, not
 *  nothing. A summary is a purchase: one more read of the history, and the summary's words. It pays
 *  when the rent paid since the last summary reaches `rentFactor` purchases, or in the last minutes of
 *  the provider's cache, when the next read would be cold and cost more than the purchase. */
function summaryPays(state: AgentState): boolean {
  if (state.contextWindowExceeded) return true;
  const { summary, llm, prices } = state.config;
  const { inputTokens, rentUsd } = state.history;
  const price = prices[llm.model];
  if (!price || replaceableTokens(state) < summary.minInputTokens) return false;
  const purchaseUsd =
    (inputTokens * price.cachedInput + summary.maxOutputTokens * price.output) / 1e6;
  const coldReadUsd = (inputTokens * price.input) / 1e6;
  const cacheEndsAtMs = cacheEndsAtMsOf(state);
  const cacheEndsSoon =
    state.nowMs >= cacheEndsAtMs - SUMMARY_BEFORE_CACHE_ENDS_MS && state.nowMs < cacheEndsAtMs;
  return (
    rentUsd >= summary.rentFactor * purchaseUsd || (cacheEndsSoon && coldReadUsd > purchaseUsd)
  );
}

/** The part of the history a summary can replace: all but the instructions, which every request
 *  reads whatever is summarised (a long system prompt must not make a short conversation look long). */
const replaceableTokens = (state: AgentState) =>
  state.history.inputTokens - Math.ceil(state.config.instructions.length / 4);

const SUMMARY_BEFORE_CACHE_ENDS_MS = 2 * 60_000;
const cacheEndsAtMsOf = (state: AgentState) =>
  state.history.lastReadAtMs + state.config.summary.cacheLifetimeMs;

/** THE OFFSET THROUGH WHICH A SUMMARY REPLACES THE HISTORY, or null when there is nothing to replace.
 *  Only what is finished: before every answer request that is open, every script that is not
 *  answered and every input that waits. (A subclass that holds inputs makes no summary while it
 *  holds one.) The newest items stay as they are; when the conversation no
 *  longer fits the model, the older half goes. */
function summaryBarrier(state: AgentState): number | null {
  const unfinishedFromOffset = Math.min(
    Infinity,
    ...state.llmRequests.filter((r) => r.purpose === "answer").map((r) => r.requestOffset),
    ...state.scriptCalls.map((call) => call.llmRequestOffset),
    ...state.pendingTriggerOffsets,
  );
  const finished = state.items.filter((item) => item.atOffset < unfinishedFromOffset);
  // a forked subagent's copied items stand first; a barrier among them is 0, before every own item
  const all = [...state.copiedItems.map(() => null), ...finished];
  const keep = state.contextWindowExceeded
    ? Math.floor(all.length / 2)
    : state.config.summary.keepNewestItems;
  const replaced = all.slice(0, Math.max(0, all.length - keep));
  if (replaced.length < 2) return null;
  return replaced[replaced.length - 1]?.atOffset ?? 0;
}

/** WHY A REQUEST CAN NO LONGER COUNT: an input came to interrupt it, or another response has answered
 *  every input it read. */
function overtakenBy(
  state: AgentState,
  request: OpenLlmRequest,
): "interrupted-by-user-input" | "superseded" | null {
  if (request.interruptedByOffset !== null) return "interrupted-by-user-input";
  const stillWaiting = request.triggerOffsets.some((t) => state.pendingTriggerOffsets.includes(t));
  return request.triggerOffsets.length > 0 && !stillWaiting ? "superseded" : null;
}

/** A REQUEST FACT, ITS DEADLINE AND ITS WAIT, in ONE append: from the instant the request exists,
 *  the scheduler will end it, whoever is alive, and will say if no processor took it. The fact says
 *  everything a processor needs to make the request (`whatIsAsked`). `scripts` is what the
 *  instructions add on how to write a script (`Agent.scriptsAsked`). `ahead` numbers a second
 *  request of the same pass. */
function llmRequestOwed(
  state: AgentState,
  purpose: "answer" | "summary",
  model: string,
  scripts: string,
  ahead = 1,
): Obligation {
  const key = `llm-request/requested:${purpose}/${state.llmRequestCounts[purpose] + ahead}`;
  const expiresAtMs = state.nowMs + state.config.llmRequestExpiryMs;
  const barrier = summaryBarrier(state) ?? 0;
  const asked = whatIsAsked(state, purpose, model, barrier, scripts);
  return owedAppend(
    key,
    {
      type: "events.iterate.com/llm-request/requested",
      payload:
        purpose === "answer"
          ? {
              model,
              expiresAtMs,
              purpose,
              triggerOffset: state.pendingTriggerOffsets.at(-1) ?? 0,
              ...asked,
            }
          : {
              model,
              expiresAtMs,
              purpose,
              triggerOffset: barrier,
              replacesHistoryThroughOffset: barrier,
              ...asked,
            },
    },
    {
      type: "events.iterate.com/itx/schedule-set",
      payload: {
        key: `${key}/deadline`,
        when: { at: new Date(expiresAtMs).toISOString() },
        events: [
          {
            type: "events.iterate.com/llm-request/deadline-passed",
            payload: { llmRequestIdempotencyKey: key },
          },
        ],
      },
    },
    waitOwed(state, key),
  );
}

/** The schedule of the wait for a processor: `<request key>/wait`, set again by a cancellation. A
 *  processor cancels it as it starts an attempt, and as it settles. */
function waitOwed(state: AgentState, requestKey: string): AgentEventInput {
  const atMs = state.nowMs + state.config.llmProviderWaitMs;
  return {
    type: "events.iterate.com/itx/schedule-set",
    payload: {
      key: `${requestKey}/wait`,
      when: { at: new Date(atMs).toISOString() },
      events: [
        {
          type: "events.iterate.com/llm-request/wait-ended",
          payload: { llmRequestIdempotencyKey: requestKey, atMs },
        },
      ],
    },
  };
}

/** THE AGENT'S SIDE OF A REQUEST'S END. The agent cannot know whether any processor makes its
 *  requests, so each wait for one has a stated end. A request that should no longer count is
 *  cancelled as a fact. One that no processor has started after `llmProviderWaitMs`, and one cancelled
 *  that no processor has settled after the same wait, the agent settles itself, under the key every
 *  settlement of it has: whichever is written first stands. */
function llmRequestEndsOwed(state: AgentState): Obligation[] {
  const waitMs = state.config.llmProviderWaitMs;
  return state.llmRequests.flatMap((request): Obligation[] => {
    const { requestOffset, model, attempts, cancelledAtMs, requestedAtMs } = request;
    const reason = overtakenBy(state, request);
    if (reason && cancelledAtMs === null)
      return [
        owedAppend(
          `llm-request/cancelled:${requestOffset}`,
          {
            type: "events.iterate.com/llm-request/cancelled",
            payload: { llmRequestOffset: requestOffset, reason },
          },
          waitOwed(state, request.idempotencyKey),
        ),
      ];
    if (reason && cancelledAtMs !== null && state.nowMs >= cancelledAtMs + waitMs)
      return [settledByTheAgent(request, { status: "cancelled", reason })];
    if (!reason && attempts === 0 && state.nowMs >= requestedAtMs + waitMs) {
      const provider = providerNameOf(model);
      const errorMessage =
        `no processor made the request for ${model} within ${waitMs / 1_000} s. Is a processor for ` +
        `the API of the provider "${provider}" (config.llmProviders.${provider}.api) loaded in this context?`;
      return [
        settledByTheAgent(request, { status: "failed", failureKind: "refused", errorMessage }),
      ];
    }
    return [];
  });
}

const SETTLED = "llm-request/settled:";

function settledByTheAgent(request: OpenLlmRequest, result: LlmRequestResult): Obligation {
  const attempt = Math.max(0, request.attempts - 1);
  return owedAppend(
    `${SETTLED}${request.requestOffset}`,
    {
      type: "events.iterate.com/llm-request/settled",
      payload: { llmRequestOffset: request.requestOffset, attempt, result },
    },
    {
      type: "events.iterate.com/itx/schedule-cancelled",
      payload: { key: `${request.idempotencyKey}/deadline` },
    },
    {
      type: "events.iterate.com/itx/schedule-cancelled",
      payload: { key: `${request.idempotencyKey}/wait` },
    },
  );
}

/** WHY THE AGENT PAUSES ITSELF, or null: requests fail in a row, or it has made its limit of
 *  requests with no input from outside. */
function pauseReason(state: AgentState): string | null {
  const { llmRequestRetryPolicy, maxLlmRequestsWithoutOutsideInput: limit } = state.config;
  const failed = state.failedLlmRequestsInARow;
  const noSummaryPossible =
    failed.summary >= llmRequestRetryPolicy.maxAttempts || summaryBarrier(state) === null;
  if (
    failed.answer >= llmRequestRetryPolicy.maxAttempts ||
    (state.contextWindowExceeded && noSummaryPossible)
  )
    return `LLM requests failed: ${state.lastLlmRequestError || "the conversation does not fit the model"}`;
  const answerOpen = state.llmRequests.some((request) => request.purpose === "answer");
  const waiting = state.pendingTriggerOffsets.length > 0;
  return waiting && !answerOpen && state.llmRequestsWithoutOutsideInput >= limit
    ? `${limit} LLM requests with no input from outside`
    : null;
}

/** The pause and its end are facts. An input from outside ends a pause the agent set itself: a
 *  person is there again, and the counts start over. A pause that someone else wrote stays until
 *  someone writes `agent/resumed`. */
function pauseOwed(state: AgentState): Obligation[] {
  const type = "events.iterate.com/agent/resumed";
  const endedByOffset = state.paused?.endedByOffset ?? null;
  if (endedByOffset !== null)
    return [
      owedAppend(`agent/resumed:${endedByOffset}`, {
        type,
        payload: { reason: "an input from outside" },
      }),
    ];
  const reason = state.paused ? null : pauseReason(state);
  if (!reason) return [];
  const key = `agent/paused:${state.llmRequestCounts.answer}/${state.llmRequestCounts.summary}`;
  const payload = { reason, endsAtNextOutsideInput: true as const };
  return [owedAppend(key, { type: "events.iterate.com/agent/paused", payload })];
}

/** THE TIMES A RULE COULD BECOME TRUE BY TIME ALONE: the debounce or a back-off ends, the cache is
 *  about to be dropped. (A request's own waits ride in its own append: `llmRequestOwed`.) */
function wakeTimesMs(state: AgentState): number[] {
  const { summary, prices, llm, llmRequestRetryPolicy } = state.config;
  const failed = state.failedLlmRequestsInARow;
  // a wait matters only while the request it holds back can still be made
  const canRetry = (purpose: "answer" | "summary") =>
    !state.paused && failed[purpose] < llmRequestRetryPolicy.maxAttempts;
  const waiting = state.pendingTriggerOffsets.length > 0 && canRetry("answer");
  const worthSummarising = prices[llm.model] && replaceableTokens(state) >= summary.minInputTokens;
  return [
    ...(waiting ? [Math.max(state.debounceUntilMs, state.retryNotBeforeMs.answer)] : []),
    ...(failed.summary > 0 && canRetry("summary") ? [state.retryNotBeforeMs.summary] : []),
    ...(worthSummarising ? [cacheEndsAtMsOf(state) - SUMMARY_BEFORE_CACHE_ENDS_MS] : []),
  ];
}

/** THE AGENT KEEPS ONE TIMER, set for the soonest of `times` that is still to come. */
function timerOwed(state: AgentState, times: number[]): Obligation[] {
  const coming = times.filter((atMs) => atMs > state.nowMs);
  const atMs = coming.length > 0 ? Math.min(...coming) : null;
  if (atMs === null || atMs === state.timer.atMs) return [];
  const events = [{ type: "events.iterate.com/agent/timer-fired", payload: { atMs } }];
  const when = { at: new Date(atMs).toISOString() };
  // One schedule key: a new time replaces the old one. The idempotency key counts the sets, so the
  // same time can be asked for again later. `agent/timer-set` is what the agent itself reads.
  return [
    owedAppend(
      `agent/timer:${atMs}/${state.timer.sets}`,
      { type: "events.iterate.com/agent/timer-set", payload: { atMs } },
      {
        type: "events.iterate.com/itx/schedule-set",
        payload: { key: "agent/timer", when, events },
      },
    ),
  ];
}

/** Facts owed under one key. The first carries the key; the others ride with it in the same append. */
function owedAppend(idempotencyKey: string, ...events: AgentEventInput[]): Obligation {
  const keyed = events.map((event, index) => ({
    ...event,
    idempotencyKey: index === 0 ? idempotencyKey : `${idempotencyKey}#${index}`,
  }));
  return { idempotencyKey, events: keyed };
}

const scriptRunKey = (call: ScriptCall) =>
  `agent/script-run:${call.llmRequestOffset}/${call.callIndex}`;

// ── what a request asks ── a pure function of the state, in a form every API reads

/** What a summary request is asked, after the history it replaces. The list is what a summary
 *  loses first, measured on real conversations (tasks/agent-harness/night/replay). */
const SUMMARY_ASK =
  "Write the summary that will replace everything above in your memory. Keep: who asked for what; " +
  "what is still open and who owes it; decisions and permissions already given; identifiers, paths, " +
  "addresses and numbers exactly as written; the number of each script result you may need again " +
  "(`await result(n)` still reads it); what was learned. Leave out pleasantries. THE ONE-SCRIPT " +
  "RULE DOES NOT APPLY TO THIS ANSWER: write no `<codemode>` block and no code. Answer with the " +
  "summary only, in plain words.";

/** HOW TO WRITE A SCRIPT: production's `<codemode>` tag (core/lib/src/agents/codemode-format.ts),
 *  stricter. The block is the whole response: no words around it, no attributes on it. It says
 *  nothing of how words reach a person: a prompt fragment says that (fragments.ts). */
const CODEMODE_INSTRUCTIONS = [
  "YOUR RESPONSE IS ONE SCRIPT AND NOTHING ELSE: exactly one `<codemode>` block. Its first line is",
  "`<codemode>`, with no attributes, and its last line is `</codemode>`. Write no words before or",
  "after it:",
  "",
  "<codemode>",
  'itx.append({ type: "events.iterate.com/agent/summary-updated", payload: { activity: "Counting the apps" } });',
  'const files = await itx.repos.get("/repos/config").files();',
  'return Object.keys(files).filter((path) => path.startsWith("apps/")).length;',
  "</codemode>",
  "",
  "Text outside the block reaches nobody. To do nothing, answer with nothing at all.",
  SCRIPT_GUIDE,
].join("\n");

/** The rule, as the model is told it when a response breaks it. */
const ONE_BLOCK_RULE =
  "A response is exactly one `<codemode>` block and nothing else: its first line is `<codemode>`, " +
  "with no attributes, and its last line is `</codemode>`. To do nothing, answer with nothing.";

const TEXT_AFTER_NOTE =
  "Your last response had text after its closing `</codemode>` line. Only a single `<codemode>` " +
  "block is allowed per response, with nothing before or after it: its script ran, and that text " +
  "reached nobody.";

/** A line that opens a block (`<codemode>`, with attributes or none, or after a closing tag on the
 *  same line), and one that closes it. Line-anchored: a mention inside a line opens nothing. */
const OPEN_LINE = /^[ \t]*(<\/codemode>[ \t]*)?<codemode(\s[^>]*)?>[ \t]*$/;
const CLOSE_LINE = /^[ \t]*<\/codemode>[ \t]*$/;

/** THE ONE `<codemode>` BLOCK OF A RESPONSE. The script is everything between the first line and
 *  the LAST `</codemode>` line, so a `</codemode>` inside a template literal does not cut it short.
 *  An empty response is silence. A response that is not one block runs nothing: `refused` says
 *  why. Text after the block: the block runs, and `note` tells the model next time. */
function codemodeBlockOf(text: string): ScriptsRead {
  const trimmed = text.trim();
  if (!trimmed) return { scripts: [] };
  const lines = trimmed.split("\n");
  const refused = (problem: string) => ({
    scripts: [],
    refused: `Nothing of your last response ran: ${problem}.\n${ONE_BLOCK_RULE}`,
  });
  if (lines[0].trim() !== "<codemode>") {
    if (OPEN_LINE.test(lines[0])) return refused("its `<codemode>` tag had attributes");
    return lines.some((line) => OPEN_LINE.test(line))
      ? refused("it began with words, not with the line `<codemode>`")
      : refused("it held no `<codemode>` block");
  }
  const close = lines.findLastIndex((line) => CLOSE_LINE.test(line));
  if (close < 1) return refused("its `<codemode>` block was never closed");
  const body = lines.slice(1, close);
  if (body.some((line) => OPEN_LINE.test(line)))
    return refused("it held a second `<codemode>` block");
  const script = body.join("\n").trim();
  if (!script) return refused("its `<codemode>` block was empty");
  const after = lines
    .slice(close + 1)
    .join("\n")
    .trim();
  return after ? { scripts: [script], note: TEXT_AFTER_NOTE } : { scripts: [script] };
}

/** EVERYTHING A PROCESSOR NEEDS TO MAKE THE REQUEST. An answer reads every item there is; a summary
 *  reads the same history through its barrier, with the same instructions and tools (so the
 *  provider's cache serves it), and then the ask. The conversation is said as what it adds to the
 *  last request to the same provider, so a long history is written to the log once. */
function whatIsAsked(
  state: AgentState,
  purpose: "answer" | "summary",
  model: string,
  barrier: number,
  scripts: string,
) {
  const { config } = state;
  const summary = purpose === "summary";
  const own = summary ? state.items.filter((item) => item.atOffset <= barrier) : state.items;
  const read = [...state.copiedItems, ...own];
  const ask: ConversationItem = {
    atOffset: barrier,
    rank: 0,
    tag: "context",
    role: "developer",
    text: SUMMARY_ASK,
  };
  const items = summary ? [...read, ask] : read;
  // the instructions, and how to write a script
  const instructions = [config.instructions, scripts].filter(Boolean).join("\n\n");
  const base = state.llmRequestBases[providerNameOf(model)] ?? null;
  const keys = items.map(itemKey);
  let shared = 0;
  while (base && shared < base.itemKeys.length && base.itemKeys[shared] === keys[shared])
    shared += 1;
  return {
    instructions,
    extends:
      base && shared > 0
        ? { llmRequestOffset: base.llmRequestOffset, itemCount: shared, response: false }
        : null,
    itemsAdded: base && shared > 0 ? items.slice(shared) : items,
    promptCacheKey: config.llm.promptCacheKey || state.path,
    reasoningEffort: config.llm.reasoningEffort,
    maxOutputTokens: summary ? config.summary.maxOutputTokens : config.llm.maxOutputTokens,
  };
}

/** THE NUMBER OF A FORKED SUBAGENT'S OWN FIRST RESULT, LESS ONE: the sum of its ancestors' offsets.
 *  Numbers up to it name an ancestor's results (script-envelope.ts). 0 for an agent that is no
 *  fork. */
const resultNumberBase = (state: AgentState) =>
  state.lineage.reduce((sum, ancestor) => sum + ancestor.throughOffset, 0);

/** An item's identity, to tell what a request adds to the one before it. */
const itemKey = (item: ConversationItem) =>
  `${item.atOffset}/${item.rank}/${item.tag}/${item.text.length}`;

/** THE SCRIPT OF A RESPONSE, as `Agent.scriptsOf` reads it: the one `<codemode>` block, or none
 *  (the agent chose silence, or broke the rule). */
export type ScriptsRead = {
  scripts: string[];
  /** The response broke the rule: nothing runs, the model is told this, and is asked again. It
   *  counts as a failed answer. */
  refused?: string;
  /** A note for the model's next request, which starts no request by itself. */
  note?: string;
};

// ── small helpers ──

/** `xai/grok-4.3` is asked of the provider `xai`. */
const providerNameOf = (model: string) => model.slice(0, Math.max(0, model.indexOf("/")));

/** When the chain of causes an event belongs to began. The platform stamps every event with its
 *  chain, named `<ISO time> with <what began it>` (core/itx/src/cause.ts); a tick of a schedule that
 *  no processor set is a cause of its own. An event with no stamp is its own cause. */
function causeBeganAtMs(event: StreamEvent): number {
  const { schedule, cause } = event.source;
  if (schedule && !schedule.definedBy?.processor) return Date.parse(schedule.at);
  const beganAtMs = cause ? Date.parse(cause.chain.split(" with ")[0]) : Number.NaN;
  return Number.isFinite(beganAtMs) ? beganAtMs : Date.parse(event.createdAt);
}

/** An item enters the conversation in order: by offset, then by rank. */
function withItem(state: AgentState, item: ConversationItem): AgentState {
  const after = state.items.findIndex(
    (other) =>
      other.atOffset > item.atOffset ||
      (other.atOffset === item.atOffset && other.rank > item.rank),
  );
  const at = after === -1 ? state.items.length : after;
  return { ...state, items: state.items.toSpliced(at, 0, item) };
}

function withScriptCall(state: AgentState, call: ScriptCall, changed: ScriptCall): AgentState {
  return { ...state, scriptCalls: state.scriptCalls.map((c) => (c === call ? changed : c)) };
}

function withLlmRequest(
  state: AgentState,
  requestOffset: number,
  change: (request: OpenLlmRequest) => OpenLlmRequest,
): AgentState {
  const llmRequests = state.llmRequests.map((request) =>
    request.requestOffset === requestOffset ? change(request) : request,
  );
  return { ...state, llmRequests };
}
