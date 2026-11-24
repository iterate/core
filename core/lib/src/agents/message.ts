// message.ts — words one context puts in an agent's log: what `itx.agents.get(path).message(text,
// options)` appends (`appendMessage`): ONE `agent/message-received`, the input every kind of agent
// reads (contract.ts).
import { z } from "zod";
import type { IterateContextApi } from "../api.ts";
import { codedError } from "../lib.ts";
import type { StreamEvent, StreamEventInput } from "../stream/processor.ts";
import type { AgentMessageInput, AgentMessageOptions } from "./api.ts";
import type { FileAttachment } from "./contract.ts";

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
 *  the context `target` picks from a scope: the collection picks the agent's from its own scope
 *  (collection.ts), and an agent's own facet appends to its own (a person's view of one context
 *  calls it, core/itx/src/person-context.ts). The collection's itx is that of `/agents`, which
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
  /** Facts that go into the same append, before the message: the start facts of a mind's own
   *  agent (collection.ts `ownStart`). The log refuses the whole append when one of their keys
   *  comes back with another body, so the words never land without them. */
  first: StreamEventInput[] = [],
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
  const appended = await target(itx).append(...first, {
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
  // The message is the last event of the append: the facts in `first` stand before it.
  return (appended as unknown as StreamEvent[]).at(-1)!;
}
