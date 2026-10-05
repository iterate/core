// message.ts — words one context puts in an agent's log: what `itx.agents.get(path).message(text,
// options)` appends (`messagePayload`), the trust boundary every `agent/context-added` crosses on
// the way into the fold (`trustBoundary`), and the gate a project may put on words
// another agent sent (`AgentInputGate`, the receiving side).
import type { IterateContextApi } from "../api.ts";
import type { FileAttachment } from "./contract.ts";

/** The `context-added` payload a message appends: the words, their files, the sender the
 *  collection relayed, and, with `trigger: false`, context only. */
export function messagePayload(input: {
  message: string;
  files: FileAttachment[];
  from?: string;
  trigger: boolean;
}) {
  const { message, files, from, trigger } = input;
  return {
    role: "user" as const,
    content: message,
    actor: { type: "user" as const },
    ...(files.length > 0 && { files }),
    from,
    ...(!trigger && { llmRequestPolicy: { behaviour: "dont-trigger-request" as const } }),
  };
}

/** Whether `origin` is ANOTHER context than this agent's own: not the agent (its own scripts run
 *  there), not `/` (the project's code and its people). */
export function isOtherContext(path: string, origin: string | undefined): boolean {
  return Boolean(origin) && origin !== path && origin !== "/";
}

/** THE TRUST BOUNDARY. A `context-added` another context appended (`itx.cd(path).append(…)` from
 *  another agent's context: `source.origin` names it) is that agent's words, whatever it claims: a
 *  user item from its origin, never a system or developer item, a script's result, a compaction
 *  summary, standing sections or the agent's own answer. Its words, files, trigger policy and
 *  `answerOwed` stand. Only this agent and `/` write the rest. */
export function trustBoundary<
  P extends {
    role: string;
    content: string;
    files?: unknown;
    llmRequestPolicy?: unknown;
    answerOwed?: boolean;
  },
>(event: { path: string; source: { origin?: string }; payload: P }): P {
  const { origin } = event.source;
  if (!isOtherContext(event.path, origin)) return event.payload;
  const { content, files, llmRequestPolicy, answerOwed } = event.payload;
  // P is the contract's `context-added` payload: "user", a user actor and `from` are values it
  // allows, and every field left out is optional in it. A generic cannot say so, hence the cast.
  return {
    role: "user",
    content,
    actor: { type: "user" },
    from: origin,
    files,
    llmRequestPolicy,
    answerOwed,
  } as unknown as P;
}

/** The agent facts another context may append and have count: its words (`context-added`, which
 *  the trust boundary makes a user item from that context) and the collection's requests and
 *  controls. */
const agentFactsFromOtherContexts = new Set([
  "events.iterate.com/agent/context-added",
  "events.iterate.com/agent/create-requested",
  "events.iterate.com/agent/delete-requested",
  "events.iterate.com/agent/configured",
  "events.iterate.com/agent/paused",
  "events.iterate.com/agent/resumed",
]);

/** THE TRUST BOUNDARY, for every other agent fact: an answer, its settlement, a gate's decision,
 *  pinned code and the loop's own bookkeeping are written by this agent's loop, its scripts or
 *  `/`. Appended by another context, the fold and the loop ignore it: otherwise any agent that
 *  can append here could answer for this one, run a script as it, or skip its gate. */
export function isForeignAgentFact(event: {
  type: string;
  path: string;
  source: { origin?: string };
}): boolean {
  return (
    event.type.startsWith("events.iterate.com/agent/") &&
    !agentFactsFromOtherContexts.has(event.type) &&
    isOtherContext(event.path, event.source.origin)
  );
}

/** A project's gate on words another agent sent without `trigger: false`, on the RECEIVING side
 *  (processor.ts): it holds whether they arrived by `message()` or by a raw
 *  `context-added` append. A config repo's `agents.ts` sets it on the facet class. `applies` says,
 *  at once, whether this sender's words to this agent are gated at all; `decide` whether they wake
 *  it now (`wake`), and what to record (`decision`, on `agent/input-gated`). A `decide` that throws
 *  wakes the agent. */
export type AgentInputGate = {
  applies(input: { path: string; from: string }): boolean;
  decide(input: {
    getItx: () => IterateContextApi & Disposable;
    /** The receiving agent's path. */
    path: string;
    /** The sender: the other agent's context. */
    from: string;
    /** The input's offset on the receiving agent's log, and when it arrived. */
    offset: number;
    at: string;
    content: string;
    /** The receiver's previous inputs, oldest first (at most three). */
    recent: string[];
  }): Promise<{ wake: boolean; decision?: Record<string, unknown> }>;
};
