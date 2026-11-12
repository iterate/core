import { type ConsumedEvent, type ReduceArgs, StreamProcessor } from "iterate/stream/processor";
import { EmailContract, type EmailState } from "iterate/email";

export class EmailProcessor extends StreamProcessor<
  EmailState,
  ConsumedEvent<typeof EmailContract>
> {
  readonly contract = EmailContract;

  override reduce({
    event,
    state,
  }: ReduceArgs<EmailState, ConsumedEvent<typeof EmailContract>>): EmailState | undefined {
    // Only the platform records mail (core-itx caller.ts `PLATFORM_FACT_TYPES`).
    switch (event.type) {
      case "events.iterate.com/email/received":
      case "events.iterate.com/email/sent": {
        const { messageId, inReplyTo, references, subject } = event.payload;
        // A known message's copy joins its thread; a reply joins the thread of its nearest known
        // ancestor (References lists them oldest first).
        const threadOffset =
          [messageId, inReplyTo, ...references.toReversed()]
            .map((id) => (id ? state.threadOffsetByMessageId[id] : undefined))
            .find((offset) => offset !== undefined) ?? event.offset;
        const thread = state.threads[threadOffset] ?? { subject, messageOffsets: [] };
        // another mind's mail: the thread keeps its most hops, which an answer goes one past
        const hops = event.type === "events.iterate.com/email/received" && event.payload.mind?.hops;
        return {
          threads: {
            ...state.threads,
            [threadOffset]: {
              ...thread,
              messageOffsets: [...thread.messageOffsets, event.offset],
              ...(hops && { mindHops: Math.max(thread.mindHops ?? 0, hops) }),
            },
          },
          threadOffsetByMessageId: messageId
            ? { ...state.threadOffsetByMessageId, [messageId]: threadOffset }
            : state.threadOffsetByMessageId,
        };
      }
      default:
        return undefined;
    }
  }
}
