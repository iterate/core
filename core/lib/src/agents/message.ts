// message.ts — words one context puts in an agent's log: what `itx.agents.get(path).message(text,
// options)` appends (`appendMessage`: ONE `agent/message-received`, the input every kind of agent
// reads), the `context-added` iterate's loop turns it into (`messagePayload`), and the gate a
// mind may put on words another agent sent (`AgentInputGate`, the receiving side).
import { z } from "zod";
import type { IterateContextApi } from "../api.ts";
import { codedError } from "../lib.ts";
import type { StreamEvent } from "../stream/processor.ts";
import type { AgentMessageInput, AgentMessageOptions } from "./api.ts";
import type { AgentState, FileAttachment, Speaker } from "./contract.ts";

/** A sender's key for one message. */
const MessageKey = z.string().min(1).max(200);

/** The SHA-256 of a text, or of a file's content as the sender gave it, in hex. */
async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  // a view may stand on a shared buffer, which the digest does not take: its bytes are copied
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : Uint8Array.from(data);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** A message to the agent at `path`: its attachments, each stored first under the agent's path
 *  (`itx.files`, `<path>/<8 of a uuid>-<name>`), then ONE `message-received` naming them, appended to
 *  the context `target` picks from a scope (the agent's own facet appends to its own; the collection
 *  to another kind of agent's, collection.ts). The collection's itx is that of `/agents`, which
 *  reaches the mind's files by the `itx.files` and `itx.r2` rows `installAgents` writes there
 *  (install.ts). Answers the event, so a caller can wait for what follows it.
 *
 *  WITH A KEY (`options.key`) THE SAME MESSAGE SENT AGAIN LANDS ONCE: the event's idempotency key
 *  is the sender's key, so the log answers a repeat with the event it already holds, also when
 *  two sends race. The same key with other words is refused (IDEMPOTENCY_CONFLICT).
 *  - A FILE OF A KEYED MESSAGE IS NEVER REPLACED. Its path is made from the key, its place in
 *    the list, its content type and the SHA-256 of its content. The same content of the same type
 *    again writes the same bytes to the same path. Other content, or another type, under the same
 *    key goes to another path, so the event's body differs and the send is refused; the file that the first event names stays as it was. (The refused
 *    send leaves its own file behind, named by nothing.)
 *  - THE KEY IS THE CONTEXT'S, NOT THE SENDER'S: one name space per agent. The log compares an
 *    event's type and payload, never who appended it. So a second sender with the same key and
 *    the same words gets the first sender's event, and the log names the first sender alone. A
 *    sender makes keys that nobody else would make (the kit: a random id of the page, then a
 *    count). */
export async function appendMessage(
  getItx: () => IterateContextApi & Disposable,
  path: string,
  target: (itx: IterateContextApi) => Pick<IterateContextApi, "append">,
  input: AgentMessageInput,
  from: string | undefined,
  options: AgentMessageOptions | undefined,
): Promise<StreamEvent> {
  const { message, files = [] } = typeof input === "string" ? { message: input } : input;
  // The options crossed RPC unchecked. A key that is no string, an empty one and a longer one
  // are refused, never cut or dropped: another key could be another message's, and a sender that
  // gave a key expects the message to land once.
  const parsedKey = MessageKey.optional().safeParse(options?.key);
  if (!parsedKey.success)
    throw codedError(
      "INVALID_INPUT",
      "message(…, { key }): a key is a string of 1 to 200 characters",
    );
  const key = parsedKey.data;
  const attachments: FileAttachment[] = [];
  for (const [index, file] of files.entries()) {
    const filename = file.filename.replace(/[^A-Za-z0-9._-]+/g, "-");
    const stem = key
      ? (
          await sha256Hex(
            `${key}\n${String(index)}\n${file.contentType}\n${await sha256Hex(file.data)}`,
          )
        ).slice(0, 16)
      : crypto.randomUUID().slice(0, 8);
    const storedAt = `${path}/${stem}-${filename}`;
    using itx = getItx();
    const stored = await itx.files
      .get(storedAt)
      .put({ contentType: file.contentType, data: file.data });
    attachments.push({
      contentType: stored.contentType,
      filename: file.filename,
      path: stored.path,
      size: stored.size,
    });
  }
  using itx = getItx();
  const appended = await target(itx).append({
    type: "events.iterate.com/agent/message-received",
    ...(key && { idempotencyKey: `agent-message:${key}` }),
    payload: {
      message,
      ...(attachments.length > 0 && { files: attachments }),
      // oxlint-disable-next-line iterate/simple-truthiness-check -- the stored event has no key for an absent sender, and the log compares a repeat of a keyed event with the stored one key by key: `from: undefined` would be another event
      ...(from && { from }),
      ...(options?.trigger === false && { trigger: false as const }),
    },
  });
  // Over the loopback stub the append's answer types as an RPC result, not the array the context
  // declares (`append(...events): Promise<StreamEvent[]>`, context/built-ins.ts); the wire copied it.
  return (appended as unknown as StreamEvent[])[0]!;
}

/** WHO SAID AN EVENT'S WORDS, by the platform's stamp alone. Nothing of the payload is read.
 *  - The principal that appended it (`source.principal`), or the principal that code appended it
 *    for (`source.onBehalfOf`: their call into the agent's facet, which is `message()`, or their
 *    script's run, marked `script`). `impersonatedBy` is kept: an administrator signed in as them.
 *  - Another mind, when its key signed the event (`source.signer` with `kind: "mind"`).
 *  - Nobody for every other event. One with no stamp was written by code: the mind's config, a
 *    row's delivery, or an agent's own script. One that a schedule fired, that a row copied here,
 *    or that the platform wrote as its own fact names no speaker either, whatever else its
 *    source holds: who set the schedule or wrote the original did not say these words now. A
 *    statement signed by a key that is no mind's names nobody here.
 *
 *  A relay of the config (mail, Slack, a phone line) therefore gets no speaker. It writes who it
 *  believes wrote into the words themselves, which the model reads as unverified. */
export function speakerOf(source: StreamEvent["source"]): Speaker | undefined {
  if (source.schedule || source.copiedFrom || source.platform) return undefined;
  if (source.signer) {
    const { actor, kind, hostname } = source.signer.principal;
    return kind === "mind" ? { actor, kind, hostname } : undefined;
  }
  const principal = source.principal || source.onBehalfOf?.principal;
  if (!principal) return undefined;
  // Only a signer is a mind. A person who is no member is named by `onBehalfOf` alone, with the
  // name they gave: the model is told it as their claim, and that a guest proved nothing
  // (render.ts), so an agent can call them by it and still knows what it is worth. A verified
  // principal never has a name here.
  const { actor, email, impersonatedBy } = principal;
  const script = !source.principal && Boolean(source.onBehalfOf?.run);
  const claimed = source.principal ? undefined : source.onBehalfOf?.principal;
  return {
    actor,
    email,
    // a person with no address (an empty one too) is named by what they gave
    name: email ? undefined : claimed?.name || undefined,
    guest: claimed?.kind === "guest" || undefined,
    script: script || undefined,
    impersonatedBy,
  };
}

/** The `context-added` iterate's loop appends for a `message-received` (processor.ts): the words,
 *  their files, the sender, the message's own offset, and the policy. With `trigger: false` the words are
 *  context only, whatever the agent is set to. Otherwise words sent from the base `/` (no `from`:
 *  the Dash chat, or any script at `/`) get `llmRequestPolicy`, the agent's own setting for them
 *  (its config's, undefined when it set none). Another agent's words never get it, so a helper's
 *  report cannot cut short the answer a person is reading. `messageOffset` goes with a person's
 *  words alone: the fold finds who sent that message by it (contract.ts). Another agent's words
 *  name their context in `from`. */
export function messagePayload(input: {
  message: string;
  files: FileAttachment[];
  from?: string;
  messageOffset?: number;
  trigger: boolean;
  llmRequestPolicy: AgentState["config"]["llmRequestPolicy"];
}) {
  const { message, files, from, messageOffset, trigger, llmRequestPolicy } = input;
  return {
    role: "user" as const,
    content: message,
    actor: { type: "user" as const },
    ...(files.length > 0 && { files }),
    // oxlint-disable-next-line iterate/simple-truthiness-check -- as in `appendMessage`: the loop appends this under a key, and a repeat must equal the stored event key by key
    ...(from && { from }),
    ...(!from && messageOffset && { messageOffset }),
    ...(!trigger && { llmRequestPolicy: { behaviour: "dont-trigger-request" as const } }),
    ...(trigger && !from && llmRequestPolicy && { llmRequestPolicy }),
  };
}

/** Whether `origin` is ANOTHER context than this agent's own: not the agent (its own scripts run
 *  there), not `/` (the mind's code and its people). */
export function isOtherContext(path: string, origin: string | undefined): boolean {
  return Boolean(origin) && origin !== path && origin !== "/";
}

/** A mind's gate on words another agent sent without `trigger: false`, on the RECEIVING side
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
