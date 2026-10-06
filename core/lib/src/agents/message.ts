// message.ts — words one context puts in an agent's log: what `itx.agents.get(path).message(text,
// options)` appends (`messagePayload`), and the gate a project may put on words another agent sent
// (`AgentInputGate`, the receiving side).
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
