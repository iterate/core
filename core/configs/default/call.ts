// call.ts — A CALL ON ANY AGENT'S CONTEXT, as a facet: the processor row `call`, and its Durable
// Object class. Any agent's context can be a meeting: a member's page turns the call on for an
// agent (`itx.cd(agent).processors.enable("call", CALL_FACET)`), and a page then calls its four
// methods over the session it holds; the UI kit's call parts (`@iterate-com/ui`, `CallBar`,
// `CallTiles`, `useCall`) draw it. The rules are call/rules.ts; this file wires them to the
// platform. It is at the config's root because a publication offers a facet's class only from a
// root module (or an app's `backend.ts`).
//
// - THE PROCESSOR folds the context's share links (call/share.ts) into its state, and tells the call
//   when the agent wrote a message (a delegation's answer, maybe), when a page's row is un-set (`itx/subscription-configured` with no target) and when its own
//   look is due (`call/due`, the schedule the call sets). Its live state is what a page draws:
//   the call (call/rules.ts `live`) and the live links, with no secret's hash.
// - THE METHODS read who asked from the kernel (`onBehalfOf()`, iterate/sdk). `join`, `signal`,
//   `leave`, `transcription` and `said` are person methods too: a guest's one-context view may
//   call them, and the call checks the guest's link at each. `voiceAgent` is a member's alone.
// - WHAT IT REACHES: the agent's own context (rows, lent stubs, the quiet notes, its schedule),
//   the audit log `<agent>/call`, and the mind's root for `fetch` and secrets, which fill each
//   placeholder on the way out.
import { type ItxEntrypointService, StreamProcessorDurableObject } from "iterate/sdk";
import {
  defineProcessorContract,
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorState,
  type ReduceArgs,
} from "iterate/stream/processor";
import { z } from "zod";
import { Call, CALL_DUE, type CallData } from "./call/rules.ts";
import { isLive, reduceShare, SHARE_EVENTS, ShareState } from "./call/share.ts";

/** The event that sets or un-sets a row; un-set (`target: null`) for a page means it left. */
const ROW_SET = "events.iterate.com/itx/subscription-configured";
/** A row un-set: its name, and no target. */
const RowUnset = z.object({ name: z.string(), target: z.null() });
/** The agent's message: the answer to the voice agent's request, when it is one. */
const AGENT_SAID = "events.iterate.com/agent/web-message-sent";
const AgentSaid = z.object({ message: z.string() });

/** How a page turns the call on for an agent: `itx.cd(agent).processors.enable("call", CALL_FACET)`.
 *  The class is this file, in the mind's published config. */
const CONSUMES = [...SHARE_EVENTS, ROW_SET, CALL_DUE, AGENT_SAID];
export const CALL_FACET = {
  className: "CallDurableObject",
  mainModule: "call.ts",
  source: ["itx", ["cd", "/"], "config"],
  // the row is pushed these alone, not every event of the agent's busy log
  consumes: CONSUMES,
};

const CallContract = defineProcessorContract({
  slug: "call",
  version: "1",
  description:
    "A call on this agent's context: who is in it, what each page sends over Cloudflare's SFU, the voice agent, and the share links that let guests in.",
  stateSchema: ShareState,
  consumes: CONSUMES,
  emits: [],
});
type State = ProcessorState<typeof CallContract>;

class CallProcessor extends StreamProcessor<State> {
  contract = CallContract;
  readonly #call: Call;
  constructor(call: Call) {
    super();
    this.#call = call;
  }

  override reduce({ event, state }: ReduceArgs<State>): State | undefined {
    const next = reduceShare(state, event);
    if (next === state) return undefined;
    return next;
  }

  /** What a page draws: the call, and the live links (who made each, until when, who came by it),
   *  never a secret's hash. A guest reads it too. */
  override projectLiveState(state: State) {
    const now = Date.now();
    return {
      ...this.#call.live(),
      links: state.links
        .filter((link) => isLive(link, now))
        .map((link) => ({
          link: link.link,
          until: link.until,
          madeBy: link.madeBy.name,
          guests: link.guests.map((guest) => guest.name),
        })),
    };
  }

  override processEvent({ event, state, delivery, runInBackground }: ProcessEventArgs<State>) {
    if (event?.type === AGENT_SAID) {
      const said = AgentSaid.safeParse(event.payload);
      const offset = event.offset;
      if (said.success) runInBackground(() => this.#call.agentSaid(said.data.message, offset));
    }
    const unset = event?.type === ROW_SET ? RowUnset.safeParse(event.payload) : null;
    if (unset?.success) {
      const page = unset.data.name;
      runInBackground(() => this.#call.pageGone(page));
    }
    // its own look, and the pass at the head after a start: who is out, the voice agent's bounds
    if (event?.type === CALL_DUE || (!event && delivery.caughtUp))
      runInBackground(() => this.#call.sweep(state));
    return undefined;
  }
}

/** One fact for the agent: a quiet message, with the fact as data under `callNote`. The agent's
 *  contract keeps `call` for a `run` call, and drops a whole payload that fails it. */
export const noteEvent = (content: string, callNote: Record<string, unknown>) => ({
  type: "events.iterate.com/agent/context-added",
  payload: {
    role: "user",
    actor: { type: "user" },
    content,
    callNote,
    llmRequestPolicy: { behaviour: "dont-trigger-request" },
  },
});

export class CallDurableObject extends StreamProcessorDurableObject<State> {
  static override publicMethods = [
    ...super.publicMethods,
    "join",
    "signal",
    "leave",
    "voiceAgent",
    "transcription",
    "said",
    "delegate",
  ];
  static override personMethods = ["join", "signal", "leave", "transcription", "said"];

  readonly #call = new Call({
    path: String(this.ctx.props.iterateContextName),
    now: Date.now,
    load: () => this.ctx.storage.get<CallData>("call"),
    save: (data) => this.ctx.storage.put("call", data),
    share: async () => (await this.snapshot()).state,
    holds: async (page, actor) => {
      using itx = this.getItx();
      const row = await itx.subscriptions.get(page);
      if (row?.heldBy?.principal.actor !== actor) return false;
      return (await itx.rpcStubs.list()).includes(`subscription:${page}`);
    },
    note: async (content, callNote) => {
      using itx = this.getItx();
      await itx.append(noteEvent(content, callNote));
    },
    audit: async (type, payload) => {
      using itx = this.getItx();
      await itx.cd(`${this.ctx.props.iterateContextName}/call`).append({ type, payload });
    },
    schedule: async (at) => {
      using itx = this.getItx();
      await itx.schedules.set({
        key: "call-due",
        when: { at: new Date(at).toISOString() },
        events: [{ type: CALL_DUE }],
      });
    },
    ask: async (content, idempotencyKey) => {
      using itx = this.getItx();
      const [event] = await itx.append({
        type: "events.iterate.com/agent/context-added",
        idempotencyKey,
        payload: {
          role: "user",
          actor: { type: "user" },
          content,
          answerOwed: true,
          callNote: { kind: "asked" },
        },
      });
      return Number(event?.offset) || 0;
    },
    outbound: () => ({
      // each call in its own scope, and the answer read whole inside it: no stub outlives a block
      fetch: async (request) => {
        using itx = this.getItx();
        const answer = await itx.cd("/").fetch(request);
        return new Response(await answer.arrayBuffer(), answer);
      },
      secrets: {
        describe: async (path) => {
          using itx = this.getItx();
          return await itx.cd("/").secrets.describe(path);
        },
      },
    }),
    publish: () => this.publishLiveState(),
  });

  processor = new CallProcessor(this.#call);

  constructor(ctx: DurableObjectState, env: { ITX: ItxEntrypointService }) {
    super(ctx, env);
    // the stored call is read before any event or method: the first live state after a wake
    // shows who is in the call, so no page takes itself for out and joins again
    void ctx.blockConcurrencyWhile(() => this.#call.ready());
  }

  /** Come in (again: fresh TURN credentials). `page`: this page's own row on the context. */
  join(page: unknown, input?: unknown) {
    return this.#call.join(this.onBehalfOf(), page, input);
  }
  /** One step of the SFU's signalling for this page. */
  signal(page: unknown, step: unknown, admission?: unknown) {
    return this.#call.signal(this.onBehalfOf(), page, step, admission);
  }
  /** Out of the call. */
  leave(page: unknown, admission?: unknown) {
    return this.#call.leave(this.onBehalfOf(), page, admission);
  }
  /** A short-lived key for one transcription session of this page's own microphone. */
  transcription(page: unknown, admission?: unknown) {
    return this.#call.transcription(this.onBehalfOf(), page, admission);
  }
  /** A finished line said: `{ id, text }`, or `{ id, text, ai: true }` from the voice agent's host. */
  said(page: unknown, line: unknown, admission?: unknown) {
    return this.#call.said(this.onBehalfOf(), page, line, admission);
  }
  /** The voice agent's request for the agent: `{ delegation, transcript }`, from its host page. */
  delegate(page: unknown, request: unknown, admission?: unknown) {
    return this.#call.delegate(this.onBehalfOf(), page, request, admission);
  }
  /** The voice agent: `{ start: sdpOffer }` (a member, from the host page), or `{ stop: why }`. */
  voiceAgent(page: unknown, act: unknown, admission?: unknown) {
    return this.#call.voiceAgent(this.onBehalfOf(), page, act, admission);
  }
}
