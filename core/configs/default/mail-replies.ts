// mail-replies.ts — WHO GETS A RECEIVED MAIL. worker.ts's `email/received` case asks here.
//
// Two rules, in this order:
// 1. A REPLY GOES BACK TO THE AGENT THAT WROTE. When the mail's thread holds a mail that an agent
//    of this mind sent, the newest such agent gets the reply: from a member, and from an outside
//    person too, whose text is then marked as an outside person's. The agent wrote to that person
//    first, so their answer is expected; it is still not a member's word.
// 2. A MEMBER'S MAIL THAT STARTS A THREAD, or answers one no agent wrote in, goes to the thread's
//    own agent, `/agents/email/t<thread>`. An outside person's mail that no agent's mail came
//    before reaches no agent: anyone can write to this mind, and only a member may ask it things.
//
// Never: an automated mail (a bounce, a list, an auto-reply), and a mail whose sender Cloudflare
// could not prove, unless it is a member's proven and direct one.
//
// And a mail an agent sent that was not delivered: the agent learns it (`deliveryFailureNote`).
import { z } from "zod";

/** What the platform says of the mail's sender (iterate/email, `email/received`). */
export type MailSender = { verified: boolean; member: boolean; direct: boolean };

export type MailTarget =
  | { agent: string; from: "member" | "outside" }
  /** the thread's own agent, which worker.ts names from the thread */
  | { agent: null; from: "member" }
  | null;

/**
 * `sentFrom`: the contexts that sent the thread's earlier mails from this mind, oldest first
 * (each `email/sent` event's `source.origin`).
 */
export function whoGetsTheMail(mail: {
  sender: MailSender;
  automated: boolean;
  sentFrom: string[];
}): MailTarget {
  if (mail.automated) return null;
  const member = mail.sender.member && mail.sender.direct;
  if (!member && !mail.sender.verified) return null;
  const agent = mail.sentFrom.findLast((path) => path.startsWith("/agents/"));
  if (agent) return { agent, from: member ? "member" : "outside" };
  return member ? { agent: null, from: "member" } : null;
}

/** `events.iterate.com/email/delivery-failed`: a mail the mind sent bounced or was refused. */
export const DeliveryFailure = z.object({
  messageId: z.string().nullable(),
  to: z.string(),
  kind: z.enum(["bounced", "failed", "rejected", "complained"]),
  permanent: z.boolean().nullable(),
  cause: z.string().nullable(),
  detail: z.string().nullable(),
});

/**
 * What the agent that sent the mail is told, or null when no agent sent it. `sent`: the mail's
 * `email/sent` event, its `source.origin` and subject.
 */
export function deliveryFailureNote(
  failure: z.infer<typeof DeliveryFailure>,
  sent: { origin: string; subject: string },
): { agent: string; content: string } | null {
  if (!sent.origin.startsWith("/agents/")) return null;
  // a complaint is no failure to deliver: the mail arrived, and its recipient called it spam
  const complained = failure.kind === "complained";
  return {
    agent: sent.origin,
    content: [
      complained
        ? `Your mail to ${failure.to} was delivered, and its recipient reported it as spam (${failure.cause || failure.detail || "no reason given"}).`
        : `Your mail to ${failure.to} was not delivered (${failure.kind}${failure.permanent ? ", permanent" : ""}): ${failure.cause || failure.detail || "no reason given"}.`,
      `Its subject: ${sent.subject}`,
      complained
        ? "Do not write to that address again unless a member says so."
        : "Do not send it again to the same address unless a member says so.",
    ].join("\n\n"),
  };
}
