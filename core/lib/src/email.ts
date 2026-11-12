// email.ts — EMAIL's events and threads: a mind's mail, every message in or out on one context,
// `/integrations/email`, inbound as `email/received` and each
// `itx.email.send` as `email/sent` (`email/send-failed` when the provider refuses it), all appended
// by the platform (core/mind-worker/src/integrations/email.ts). Two are a mind's own: its config
// holds another mind's mail at a hop limit (`email/mind-mail-held`), which a member may set
// (`email/mind-hop-limit-configured`).
// The first-party `email` facet there folds them into threads (core/mind-worker/src/email/processor.ts); a config
// repo reads its state and parses a message with this contract (core/configs/default/worker.ts). An
// inbound message's bytes, as it arrived, and each attachment's are mind files under `/email/`.
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "./stream/processor.ts";

/** One message as both directions record it. Message ids are bare (no angle brackets). */
const EmailMessage = z.object({
  /** Its RFC 5322 Message-ID; null when an inbound message carried none. */
  messageId: z.string().nullable(),
  /** The author's address. */
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  /** The bodies, each cut at 100,000 characters (integrations/email.ts); null when absent — a
   *  stored event keeps no undefined key, and a redelivery's body must equal it. */
  text: z.string().nullable(),
  html: z.string().nullable(),
  /** The message it answers, and its thread's ids oldest first: what threads it (processor.ts). */
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  /** Each attachment's bytes are the mind file at `path`. */
  attachments: z.array(
    z.object({
      filename: z.string(),
      contentType: z.string(),
      size: z.number(),
      path: z.string(),
    }),
  ),
});

export const EmailContract = defineProcessorContract({
  slug: "email",
  version: "1",
  description: "A mind's email, both directions, folded into threads.",
  stateSchema: z.object({
    /** Every thread, keyed by the offset of its first message: that message's subject and the
     *  offset of every message in it, oldest first. */
    threads: z
      .record(
        z.string(),
        z.object({
          subject: z.string(),
          messageOffsets: z.array(z.number()),
          /** The most hops of another mind's mail received in the thread (`mind.hops` of
           *  `email/received`); absent when the thread holds none. `itx.email.send` sends an
           *  answer in the thread one hop further. */
          mindHops: z.number().optional(),
        }),
      )
      .default({}),
    /** Each message's Message-ID → the offset of its thread's first message: how a reply finds
     *  its thread. */
    threadOffsetByMessageId: z.record(z.string(), z.number()).default({}),
  }),
  events: {
    "events.iterate.com/email/received": {
      description:
        "A message arrived at one of the mind's addresses (platform fact, keyed by its Message-ID).",
      payloadSchema: EmailMessage.extend({
        /** Where the author asks for replies (Reply-To), when it is not `from`. */
        replyTo: z.string().optional(),
        /** The SMTP envelope: the sending server's MAIL FROM, and the address it was delivered to
         *  (`<slug>@…`, or `<slug>+<tag>@…`). */
        envelope: z.object({ from: z.string(), to: z.string() }),
        /** The whole message as Cloudflare delivered it to `envelope.to`, its RFC 5322 bytes: the
         *  mind file at `path` (`/email/<message key>/<address>.eml`, `message/rfc822`), `size`
         *  bytes long (what Cloudflare's `rawSize` counts). A redelivery keeps the first delivery's
         *  file, and the event describes that one. Absent on a message recorded before the
         *  platform kept it. */
        raw: z.object({ path: z.string(), contentType: z.string(), size: z.number() }).optional(),
        /** Every header field of `raw` in order, duplicates kept (each Received,
         *  Authentication-Results, DKIM-Signature and ARC set): `name` as written, `value` in
         *  JMAP's Raw form (RFC 8621 4.1.2.1), everything after the colon to the field's end, folds
         *  included, nothing decoded. `value.replace(/\r?\n(?=[ \t])/g, "")` unfolds it. Whole
         *  fields from the top, the newest, up to 256 KiB of JSON (core/boundary-worker/src/mail.ts
         *  `rawHeadersOf`). Absent when `raw` is. */
        headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
        /** `headers` stops before the message's last field: the rest are only in `raw`. */
        headersTruncated: z.boolean().optional(),
        /** Who sent it, as far as the platform can tell (email/sender.ts). */
        sender: z.object({
          /** The From address is proven by Cloudflare's checks as it received the message: an
           *  aligned DMARC pass, DKIM signature or SPF pass. A forged From is false. */
          verified: z.boolean(),
          /** The From address is verified and belongs to a member of this mind. */
          member: z.boolean(),
          /** The From domain's own server handed the message over: every Cloudflare record has an
           *  SPF pass for an aligned envelope domain (email/sender.ts). Anyone can re-send a
           *  message a member once sent, DKIM signature intact, so only a direct message is the
           *  member speaking now; a forward or a list's copy is not direct. */
          direct: z.boolean(),
        }),
        /** An auto-reply, a bulk or list message, or a bounce: nothing should answer it
         *  automatically. */
        automated: z.boolean(),
        /** Cloudflare's SPF, DKIM and DMARC verdicts as it received the message (`pass`, `fail`,
         *  `none`, …), null where it gave none. */
        authentication: z.object({
          spf: z.string().nullable(),
          dkim: z.string().nullable(),
          dmarc: z.string().nullable(),
        }),
        /** Another mind's mail: its `X-Iterate-Mail-Hops` header, read only when `sender.verified`
         *  (iterate/lib `MAIL_HOPS_HEADER`). `hops` counts the mails between minds in its thread up to this
         *  one. Null for every other mail; absent on a mail recorded before the platform read it.
         *  Such a mail is `automated` too: what answers it decides. */
        mind: z.object({ hops: z.number().int().positive() }).nullable().optional(),
      }),
    },
    "events.iterate.com/email/sent": {
      description: "The mind sent a message through `itx.email.send` (platform fact).",
      payloadSchema: EmailMessage,
    },
    "events.iterate.com/email/forward-failed": {
      description:
        "The stack could not forward a received message to its `mail.forwardTo` address (platform fact). The mind has the message.",
      payloadSchema: z.object({
        /** The address the message was delivered to. */
        to: z.string(),
        /** The stack's forward address. */
        forwardTo: z.string(),
        /** The message's Message-ID header as written, null when it has none. */
        messageId: z.string().nullable(),
        /** Why: Cloudflare's words, or the stack's own, which start "not forwarded:"
         *  (core/boundary-worker/src/mail.ts `receivedMail` says what each does to the delivery). */
        error: z.string(),
      }),
    },
    "events.iterate.com/email/send-failed": {
      description:
        "The mail provider refused a message from `itx.email.send`; nothing was sent (platform fact).",
      payloadSchema: z.object({
        from: z.string(),
        to: z.array(z.string()),
        cc: z.array(z.string()),
        subject: z.string(),
        /** The provider's words, as the boundary gave them. */
        error: z.string(),
        /** The provider's error code (such as `E_RECIPIENT_SUPPRESSED`), null when it gave none. */
        code: z.string().nullable(),
      }),
    },
    "events.iterate.com/email/delivery-failed": {
      description:
        "Cloudflare took a sent message and could not deliver it to one recipient, or the recipient marked it as spam (platform fact).",
      payloadSchema: z.object({
        /** The sent message's id, bare, as `email/sent` stores it; null when Cloudflare gave none. */
        messageId: z.string().nullable(),
        /** The recipient it did not reach. */
        to: z.string(),
        /** Cloudflare's event: `bounced` (a permanent bounce, or retries ran out), `failed` (an
         *  error that is not SMTP's), `rejected` (refused before delivery, e.g. a suppressed
         *  recipient), `complained` (delivered, then marked as spam). */
        kind: z.enum(["bounced", "failed", "rejected", "complained"]),
        /** For a bounce, whether Cloudflare calls it hard (true) or soft (false); else null. */
        permanent: z.boolean().nullable(),
        /** Cloudflare's short reason (`permanent_failure`, `suppressed`, `abuse`, …), null when it
         *  gave none. */
        cause: z.string().nullable(),
        /** Cloudflare's words, such as the receiving server's SMTP reply; null when it gave none. */
        detail: z.string().nullable(),
      }),
    },
    "events.iterate.com/email/mind-mail-held": {
      description:
        "A received mail of another mind's agent reached its hop limit and woke no agent (the mind's config appends it).",
      payloadSchema: z.object({
        /** The `email/received` event's offset. */
        offset: z.number(),
        hops: z.number(),
        /** The limit it met: `email/mind-hop-limit-configured`, or the config's default. */
        limit: z.number(),
      }),
    },
    "events.iterate.com/email/mind-hop-limit-configured": {
      description:
        "The hop count at which a received mail of another mind's agent wakes no agent (a person appends it; the config counts no other).",
      payloadSchema: z.object({ limit: z.number().int().positive() }),
    },
    "events.iterate.com/email/mind-peer-allowed": {
      description:
        "Another mind's agent at this address, or anywhere in this domain, may start an agent here by mail (a person appends it; the config counts no other).",
      payloadSchema: z.union([z.object({ address: z.email() }), z.object({ domain: z.string() })]),
    },
    "events.iterate.com/email/mind-peer-removed": {
      description:
        "Takes back an `email/mind-peer-allowed` of the same address or domain (a person appends it).",
      payloadSchema: z.union([z.object({ address: z.email() }), z.object({ domain: z.string() })]),
    },
  },
  consumes: ["events.iterate.com/email/received", "events.iterate.com/email/sent"],
  emits: [],
});

/** The hop count of a mail that answers a thread: one more than the most hops of another mind's
 *  mail received in it, and 1 when it holds none. */
export function nextMailHops(receivedHops: readonly number[]): number {
  return Math.max(0, ...receivedHops) + 1;
}

/** The reduced threads (the contract's `stateSchema`). */
export type EmailState = ProcessorState<typeof EmailContract>;
