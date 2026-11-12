// THE STACK'S ONE QUEUE OF CLOUDFLARE EVENTS: each event subscription of the stack
// (core/alchemy/src/stack.ts) puts its messages here, and each message becomes at most one event on
// one context of the mind. Which event, and where, is a table: a row for each message `type`.
// Pure (binds nothing), like ./mail.ts.
import type { MindTarget } from "iterate/workers";
import { z } from "zod";

/** Every Cloudflare event names its kind in `type`. */
const Typed = z.object({ type: z.string() });

/** What a message becomes: one event on one context of the mind, or nothing (null). The event
 *  carries its own `idempotencyKey`, made from the message, so a redelivery adds nothing. */
export type CloudflareEventRow = (
  body: unknown,
) => { path: string; event: Parameters<MindTarget["append"]>[1][number] } | null;

/** THE BOUNDARY'S QUEUE HANDLER: each message is looked up by its `type` in `rows` and goes
 *  through its row on its own. A message with no row, or one its row makes nothing of, is acked:
 *  an unknown shape never blocks the queue. One the mind took is acked. One it did not take is
 *  retried, after the consumer's `retryDelay`, until the consumer's `maxRetries`
 *  (core/alchemy/src/stack.ts); then Cloudflare drops it. Each failure is logged with its attempt. */
export async function cloudflareEvents(
  batch: MessageBatch,
  mind: Pick<MindTarget, "append">,
  rows: Record<string, CloudflareEventRow>,
) {
  for (const message of batch.messages) {
    const { body } = message;
    const type = Typed.safeParse(body).data?.type;
    try {
      const made = type && Object.hasOwn(rows, type) ? rows[type]!(body) : null;
      if (made) await mind.append(made.path, [made.event]);
      message.ack();
    } catch (error) {
      console.error({
        event: "cloudflare-event.not-recorded",
        namespace: "boundary",
        message: "the mind did not take a Cloudflare event: the queue retries it",
        queue: batch.queue,
        type,
        queueMessageId: message.id,
        attempts: message.attempts,
        error: String(error),
      });
      message.retry();
    }
  }
}
