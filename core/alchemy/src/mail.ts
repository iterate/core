// THE STACK'S MAIL ON ITS OWN ZONE: mail to the domain reaches the boundary, the boundary sends mail
// from the domain, and what became of each sent mail comes back on the stack's queue of Cloudflare
// events (stack.ts).
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";

/** Email Routing with a catch-all to the boundary Worker, and Email Sending on the apex. Answers
 *  Email Sending, which the mail events subscription waits for (`mailEvents`). */
export const mailOnZone = (zone: { id: string; name: string }, boundaryWorker: Input<string>) =>
  Effect.gen(function* () {
    const routing = yield* Cloudflare.Email.Routing("EmailRouting", { zone: zone.id });
    yield* Cloudflare.Email.CatchAll("EmailCatchAll", {
      zone: routing.zoneId,
      actions: [{ type: "worker", value: [boundaryWorker] }],
    });
    // Email Sending on the apex adds the bounce and DKIM records the boundary's `send_email` needs.
    return yield* Cloudflare.Email.SendingSubdomain("EmailSending", {
      zoneId: zone.id,
      name: zone.name,
    });
  });

/** What became of each sent mail, on the queue `queueId`. Each failure becomes a fact on the
 *  mind's email log (core/boundary-worker/src/mail-outcomes.ts). Delivered and deferred mail is not
 *  asked for.
 *
 *  The zone and the domain are Email Sending's outputs, so Alchemy makes the subscription after
 *  Email Sending: Cloudflare refuses it until the domain is a sending subdomain ("domain is not an
 *  enabled sending subdomain"). */
export const mailEvents = (input: {
  sending: Cloudflare.Email.SendingSubdomain;
  queueId: Cloudflare.Queues.Queue["queueId"];
  name: string;
}) =>
  Cloudflare.Queues.Subscription("MailEventsSubscription", {
    name: input.name,
    source: { type: "email.sending", zoneId: input.sending.zoneId, domain: input.sending.name },
    events: ["message.bounced", "message.failed", "message.rejected", "message.complained"],
    queueId: input.queueId,
  });
