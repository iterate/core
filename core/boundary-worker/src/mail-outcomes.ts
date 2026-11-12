// Pure (binds nothing, calls nobody) and one file, like ./mail.ts.
import { z } from "zod";
import type { CloudflareEventRow } from "./cloudflare-events.ts";

/** The mind's email log. */
const EMAIL_PATH = "/integrations/email";

const Reason = z.string().optional().catch(undefined);

/** One Email Sending event as Cloudflare puts it on the queue (Email Service docs, "Event
 *  subscriptions"). Only what the fact needs is read; a field the docs show in one example only, or
 *  not at all, is optional. */
const SendingEvent = z.object({
  type: z.enum([
    "cf.email.sending.message.bounced",
    "cf.email.sending.message.failed",
    "cf.email.sending.message.rejected",
    "cf.email.sending.message.complained",
  ]),
  payload: z.object({
    eventId: z.string().optional().catch(undefined),
    messageId: z.string().optional().catch(undefined),
    recipient: z.string(),
    delivery: z.object({ smtpResponse: Reason }).optional().catch(undefined),
    bounce: z
      .object({ type: Reason, classification: Reason, reason: Reason })
      .optional()
      .catch(undefined),
    failure: z.object({ reason: Reason }).optional().catch(undefined),
    rejection: z.object({ reason: Reason, detail: Reason }).optional().catch(undefined),
    complaint: z.object({ type: Reason }).optional().catch(undefined),
  }),
});

/** The fact's `kind` for each event type. */
const KIND_OF = {
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.failed": "failed",
  "cf.email.sending.message.rejected": "rejected",
  "cf.email.sending.message.complained": "complained",
} as const;

/** One message of the stack's Email Sending events: a mail that the provider took and could not
 *  deliver (bounced, failed, rejected) or that its recipient called spam (complained) becomes an
 *  `email/delivery-failed` fact on the mind's email log. A body of any other shape makes nothing.
 *  The fact's idempotency key keeps a redelivery from landing twice. */
const mailFact: CloudflareEventRow = (body) => {
  const parsed = SendingEvent.safeParse(body);
  if (!parsed.success) return null;
  const { type, payload } = parsed.data;
  const kind = KIND_OF[type];
  // Bare, as `email/sent` stores it, so a reader finds the mail that was sent.
  const messageId = payload.messageId?.trim().replace(/^<(.*)>$/, "$1") || null;
  const bounceType = payload.bounce?.type;
  const { cause, detail } = {
    bounced: {
      cause: payload.bounce?.classification,
      detail: payload.bounce?.reason || payload.delivery?.smtpResponse,
    },
    failed: { cause: payload.failure?.reason, detail: payload.delivery?.smtpResponse },
    rejected: { cause: payload.rejection?.reason, detail: payload.rejection?.detail },
    complained: { cause: payload.complaint?.type, detail: undefined },
  }[kind];
  return {
    path: EMAIL_PATH,
    event: {
      type: "events.iterate.com/email/delivery-failed",
      idempotencyKey: `email/delivery-failed:${
        payload.eventId || `${messageId}:${kind}:${payload.recipient.toLowerCase()}`
      }`,
      payload: {
        messageId,
        to: payload.recipient,
        kind,
        permanent: bounceType === "hard" ? true : bounceType === "soft" ? false : null,
        cause: cause || null,
        detail: detail || null,
      },
    },
  };
};

/** The table's rows for the stack's Email Sending events (./cloudflare-events.ts). Delivered and
 *  deferred mail has no row: the stack does not ask for those events. */
export const mailRows: Record<string, CloudflareEventRow> = Object.fromEntries(
  SendingEvent.shape.type.options.map((type) => [type, mailFact]),
);
