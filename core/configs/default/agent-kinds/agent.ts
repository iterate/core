// agent-kinds/agent.ts — THE AGENT AS A KIND (agent-kinds.md). Its server half is the facets of
// agent/, which agent-start.ts enables on each agent's context. Its chat is iterate's AgentChat.
//
// A person's new chat in the Dash is this agent: the kind says `newAgent: { default: true }`, so
// the Dash's New agent appends `agent-ui/agent-requested` and then the person's first words to
// `/agents/people/<person>/agent/<moment>`, as that member. Every other agent of the mind is the
// platform's.
//
// THE MIND'S SIDE OF THE AGENT (`processEvent`). The agent has one input, `agent/context-added`,
// and knows no channel. This kind acts on four facts, each in ONE append to a context:
//
//   agent-ui/message-received   the Dash's composer (the view below)       → "— Web UI: …"
//   agent/message-received      the platform's `itx.agents.get(path).message()`: other kinds of
//                               agent, a tool, the platform's file upload   → "— Agents API: …"
//       on the context of an agent: its start facts (all keyed: written once) and the transcribed
//       input (agent-ui.ts), under a key that names the raw fact;
//   agent-ui/agent-requested    the start facts alone;
//   agent/subagent-requested    the agent's script: the child's start, and the answer and its note
//                               to the parent (agent-start.ts `startSubagent`).
//
// THE GUARD. The platform's agents run in the same mind and read some of the same facts. So this
// kind acts only on a context under `/agents/people/`, a person's own chats and their subagents,
// and there only on a context that runs this agent: one of its first facts is the start's
// `agent/configured` with `kind: "agent"` (agent/start.ts), or the Dash's request for one
// (agent-start.ts `runsTheAgent`). On every other context it does nothing.
//
// THE CHAT (`view`). AgentChat's reducer (packages/ui agent-ui-reducer.ts) folds the platform
// agent's facts. `chatEventsOf` adapts this agent's log to it, one event at a time: it renames a
// type, moves a field, and draws a person's bubble from the RAW fact, with the sender the platform
// stamped on it. The transcription names its raw fact in `source`, so it is not drawn a second
// time. Words from another agent are drawn from their `agent/context-added`, as they are. The
// Events tab shows the raw log.
//
// THE COMPOSER CREATES `agent-ui/message-received`, through the host's `onAppend`: the words land
// as the person wrote them. The host has no verb that stores a file, so words WITH files go through
// the host's `onMessage` (the platform's `message()`, which stores them first).
//
// The view runs in the Dash's frame, where every import of this file is a stub that throws when
// used (packages/ui agent-kind-view/load.ts). So the view uses nothing it imports.
import type {
  AgentKind,
  AgentKindViewEvent,
  AgentKindViewProps,
} from "@iterate-com/ui/agent-kind-view";
import { PEOPLE, runsTheAgent, startSubagent, toAgent } from "../agent-start.ts";
import {
  agentsApiContext,
  agentUiContext,
  agentUiStartConfig,
  transcriptionKey,
} from "../agent-ui.ts";

const T = "events.iterate.com/";
const UI_MESSAGE = `${T}agent-ui/message-received`;
const UI_AGENT_REQUESTED = `${T}agent-ui/agent-requested`;
const API_MESSAGE = `${T}agent/message-received`;
const CONTEXT_ADDED = `${T}agent/context-added`;
const SUBAGENT_REQUESTED = `${T}agent/subagent-requested`;

/** THE MIND'S SIDE OF THE AGENT: each fact of the four becomes ONE append (the header). */
async function processEvent({ event, itx }: Parameters<NonNullable<AgentKind["processEvent"]>>[0]) {
  if (!event.path.startsWith(PEOPLE)) return;
  switch (event.type) {
    case UI_AGENT_REQUESTED: {
      const config = agentUiStartConfig(event);
      if (config) await toAgent(itx, event.path, [], { config });
      return;
    }
    case SUBAGENT_REQUESTED:
      if (await runsTheAgent(itx, event.path)) await startSubagent(itx, event);
      return;
    case UI_MESSAGE:
    case API_MESSAGE: {
      if (!(await runsTheAgent(itx, event.path))) return;
      const input = (event.type === UI_MESSAGE ? agentUiContext : agentsApiContext)(event);
      if (!input) return; // a payload the schema refuses
      await toAgent(itx, event.path, [
        { type: CONTEXT_ADDED, idempotencyKey: transcriptionKey(event), payload: input },
      ]);
    }
  }
}

// ── the chat: this agent's log as AgentChat reads it ──

type ViewEvent = AgentKindViewEvent & { idempotencyKey?: string };
/** A payload of the log, read loosely: the adapter reads each field it needs. */
type Payload = Record<string, any>;

/** THE ADAPTER. The same event gives the same objects, so the chat folds only what is new and a
 *  settled row keeps its identity (packages/ui agent-events.ts `foldAgentLog`). */
function chatEventsOf(events: readonly ViewEvent[], agentPath: string): ViewEvent[] {
  return events.flatMap((event) => {
    const held = adaptedCache.get(event);
    if (held?.agentPath === agentPath) return held.adapted;
    const adapted = adaptEvent(event, agentPath);
    adaptedCache.set(event, { agentPath, adapted });
    return adapted;
  });
}
const adaptedCache = new WeakMap<object, { agentPath: string; adapted: ViewEvent[] }>();

/** One event of this agent as the events of the platform's agent that the reducer reads. */
function adaptEvent(event: ViewEvent, agentPath: string): ViewEvent[] {
  const p: Payload = event.payload ?? {};
  const origin = event.source?.origin;
  switch (event.type) {
    // A PERSON'S BUBBLE, from the raw fact and its stamp: the reducer reads who said it from
    // `source`, the sending context from `from`, and the policy
    case UI_MESSAGE:
    case API_MESSAGE:
      return [
        {
          ...event,
          type: CONTEXT_ADDED,
          payload: {
            role: "user",
            content: typeof p.message === "string" ? p.message : "",
            files: p.files,
            ...(typeof p.from === "string" && { from: p.from }),
            ...(p.trigger === false && {
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            }),
          },
        },
      ];
    case CONTEXT_ADDED:
      // a transcription: its raw fact on this context is the bubble
      if (p.source?.path === agentPath) return [];
      // words another context appended: the stamp names it, the reducer reads `from`
      if (
        p.role === "user" &&
        typeof origin === "string" &&
        ![agentPath, "/", "/agents"].includes(origin)
      )
        return [{ ...event, payload: { ...p, from: origin } }];
      return [event];
    case `${T}llm-request/requested`:
      // a summary and a script's side request are no turn. Every request of this agent opens: its own
      // offset is the trigger the reducer orders requests by
      if (p.purpose !== "answer") return [];
      return [
        {
          ...event,
          type: `${T}agent/llm-request-requested`,
          payload: { ...p, triggerOffset: event.offset },
        },
      ];
    case `${T}llm-request/response-frame-received`:
      return [
        {
          ...event,
          type: `${T}agent/llm-response-frame`,
          payload: {
            llmRequestOffset: p.llmRequestOffset,
            attempt: p.attempt,
            sequence: p.sequence,
            responseDelta: p.textDelta ?? "",
            // the model thinks and gives no words for it: the chat shows that it thinks
            thinkingDelta:
              p.thinking && !p.textDelta && !p.thinkingDelta ? "…" : (p.thinkingDelta ?? ""),
          },
        },
      ];
    case `${T}llm-request/settled`: {
      // the platform's settled fact names its request `requestOffset`
      const settled = {
        ...event,
        type: `${T}agent/llm-request-settled`,
        payload: { ...p, requestOffset: p.llmRequestOffset },
      };
      if (p.result?.status !== "succeeded") return [settled];
      // the answer whole, at the request's offset: a script asked while it is read is its script
      const answer = {
        type: CONTEXT_ADDED,
        offset: p.llmRequestOffset,
        createdAt: event.createdAt,
        payload: {
          role: "assistant",
          content: p.result.text,
          llmRequestOffset: p.llmRequestOffset,
        },
      };
      return [answer, settled];
    }
    case `${T}itx/run-requested`: {
      // the agent's key names the request whose answer holds the script
      const request = /^agent\/script-run:(\d+)\//.exec(event.idempotencyKey || "")?.[1];
      if (!request) return [event];
      const processor = (event.source?.processor as Payload | undefined) ?? {
        slug: "agent",
        version: "",
      };
      const whileProcessing = { offset: Number(request), type: CONTEXT_ADDED };
      return [
        { ...event, source: { ...event.source, processor: { ...processor, whileProcessing } } },
      ];
    }
    case `${T}agent-ui/message-sent`:
      // the agent's words: a Dash that does not know this fact yet draws the platform's
      return [{ ...event, type: `${T}agent/web-message-sent` }];
    default:
      return [event];
  }
}

type LiveState = { status: string; value: unknown; rev?: number | null; error?: string };
type AgentState = {
  paused?: { reason: string; endedByOffset: number | null } | null;
  llmRequests?: { purpose: string; model: string }[];
  pendingTriggerOffsets?: number[];
  scriptCalls?: { runRequestOffset: number | null }[];
};

/** The facet `agent`'s live state in the shape AgentChat reads (agent-chat.tsx `AgentLive`).
 *  With none yet, it says the state is loading, not missing. */
function agentLiveOf(live: LiveState | undefined, hosted: boolean): LiveState | undefined {
  if (!live) return hosted ? { status: "loading", value: undefined } : undefined;
  const state = live.value as AgentState | undefined;
  if (!state) return live;
  const open =
    state.llmRequests?.find((request) => request.purpose === "answer") ?? state.llmRequests?.[0];
  const paused = state.paused && state.paused.endedByOffset === null ? state.paused : null;
  return {
    ...live,
    value: {
      paused: paused ? { reason: paused.reason } : null,
      openRequest: open ? { model: open.model } : null,
      pendingLlmRequestTrigger: state.pendingTriggerOffsets?.length ? {} : null,
      awaitingRun: state.scriptCalls?.some((call) => call.runRequestOffset === null) ? {} : null,
      unnotedRun: null,
    },
  };
}

type ComposerInput = Parameters<AgentKindViewProps["onMessage"]>[0];

/** THE COMPOSER: words become ONE `agent-ui/message-received` through the host's `onAppend`, under
 *  the composer's key, so a send tried again lands once. Words with files go through the host's
 *  `onMessage`: only `message()` stores a file. */
async function sendFromComposer(
  input: ComposerInput,
  host: Pick<AgentKindViewProps, "onAppend" | "onMessage">,
  client: "web" | "mobile",
) {
  if (input.files.length > 0 || !host.onAppend) return await host.onMessage(input);
  await host.onAppend([
    {
      type: UI_MESSAGE,
      ...(!!input.key && { idempotencyKey: `agent-ui/message-received:${input.key}` }),
      payload: { message: input.message, client },
    },
  ]);
}

/** What the browser says of itself. */
const clientOf = () => (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "mobile" : "web");

export default {
  kind: "agent",
  processEvent,
  // THE MIND'S DEFAULT KIND: the Dash's New agent starts this one. The Dash appends the fact of
  // `start` and then the person's first words (`agent-ui/message-received`) to the new agent's
  // path, AS THE MEMBER WHO TYPED: no method of the mind stands between, so each fact carries that
  // person's own stamp. To make new chats iterate's own agent again, take `default: true` away.
  newAgent: {
    default: true,
    choices: [{ id: "agent", label: "Agent", byPerson: true }],
    start: ({ path }) => [
      {
        type: UI_AGENT_REQUESTED,
        idempotencyKey: `agent-ui/agent-requested:${path}`,
        payload: {},
      },
    ],
  },
  // the streamed windows of the answer being written, in one shape for every provider
  ephemeralEvents: [`${T}llm-request/response-frame-received`],
  view:
    ({ html, useMemo, ui }) =>
    (props) => {
      const { context, path, state, onAppend, onMessage } = props;
      const chat = state.view !== "events";
      const adapted = useMemo(() => {
        const hosted = context.processors.rows.some((row) => row?.hostedFacet?.name === "agent");
        const agent = agentLiveOf(context.liveState.agent, hosted);
        const liveState = agent ? { ...context.liveState, agent } : context.liveState;
        // the Events tab shows the raw log
        return {
          ...context,
          liveState,
          events: chat ? chatEventsOf(context.events, path) : context.events,
        };
      }, [context, path, chat]);
      const send = useMemo(
        () => (input: ComposerInput) =>
          sendFromComposer(input, { onAppend, onMessage }, clientOf()),
        [onAppend, onMessage],
      );
      return html`<${ui.AgentChat} ...${props} context=${adapted} onMessage=${send} />`;
    },
} satisfies AgentKind;
