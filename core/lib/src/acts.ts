// acts.ts — AN ACT THAT WAITS FOR A MEMBER'S YES (tasks/signed-events.md). A mail, or a call of a
// named verb, that a rule names is held in the vault's gate (core/secrets-worker/src/acts-gate.ts)
// as one exact text. Its SHA-256 is its id. A member reads that text on `/secrets/approvals` and
// signs a statement that names the id. A request sent with a secret is held the same way by its
// secret (core/secrets-worker/src/approval.ts): this module is everything else.
import { z } from "zod";
import { reportIssue } from "./lib.ts";

/** The context that holds the gate's facts. */
export const APPROVALS_CONTEXT = "/approvals";

/** The gate's facts. An approval and a rejection are also the types of the statements a member signs. */
export const ACT_HELD = "events.iterate.com/approval/act-held";
export const ACT_APPROVED = "events.iterate.com/approval/act-approved";
export const ACT_REJECTED = "events.iterate.com/approval/act-rejected";
export const ACT_HOLD_EXPIRED = "events.iterate.com/approval/hold-expired";
/** On the caller's context: what became of an act that a member approved after its caller stopped waiting. */
export const ACT_DONE = "events.iterate.com/approval/act-done";
export const RULE_SET = "events.iterate.com/approval/rule-set";
export const RULE_PROPOSED = "events.iterate.com/approval/rule-proposed";
export const GATE_LOCKED = "events.iterate.com/approval/locked";
export const GATE_UNLOCKED = "events.iterate.com/approval/unlocked";

/** On the vault's answer to an approval, for the boundary alone, which removes it: the ids of the
 *  acts that a member approved after their caller stopped waiting, with commas between. An id is
 *  64 characters, and an act's text may be 1 MiB, which no header carries: the boundary reads each
 *  act from the gate by its id, and hands it to the mind, which does it then. */
export const RUN_ACTS_HEADER = "x-iterate-run-acts";

/** The vault's answer with RUN_ACTS_HEADER read and removed: `run` gets the id of each act it
 *  names. The boundary's, on what the secrets Worker answers. Never rejects. */
export function runApprovedActs(
  answer: Response,
  run: (digest: string) => Promise<unknown>,
): { answer: Response; ran: Promise<void> } {
  const header = answer.headers.get(RUN_ACTS_HEADER);
  if (!header) return { answer, ran: Promise.resolve() };
  const headers = new Headers(answer.headers);
  headers.delete(RUN_ACTS_HEADER);
  const digests = header.split(",").filter((digest) => /^[0-9a-f]{64}$/.test(digest));
  if (digests.length !== header.split(",").length)
    reportIssue("approval.run-unreadable", new Error("the vault named an act by no id"));
  const ran = Promise.all(
    digests.map((digest) =>
      run(digest).catch((error: unknown) => reportIssue("approval.act-not-run", error, { digest })),
    ),
  ).then(() => {});
  return {
    answer: new Response(answer.body, {
      status: answer.status,
      statusText: answer.statusText,
      headers,
    }),
    ran,
  };
}

/** The one verb of the platform's own that a rule may name. Every other is `itx.<name>…`. */
export const EMAIL_SEND = "email.send";

/** A RULE names a verb. `email.send` is a mail; with `to`, only a mail to a recipient that matches
 *  one of its patterns (`*@example.com`, `jo@example.com`, `*`). `itx.whatsapp.sendMessage` is a
 *  call of that verb, and `itx.whatsapp.*` of every verb under it. */
export const ActRule = z
  .object({
    verb: z
      .string()
      .regex(
        /^(?:email\.send|itx(?:\.[a-zA-Z][a-zA-Z0-9]*)+(?:\.\*)?)$/,
        "a rule names email.send, a verb such as itx.whatsapp.sendMessage, or itx.whatsapp.*",
      ),
    to: z
      .array(
        z
          .string()
          .regex(
            /^(?:\*|(?:\*|[^@\s*]+)@[^@\s*]+)$/,
            "a recipient is jo@example.com, *@example.com or *",
          ),
      )
      .min(1)
      .optional(),
  })
  .strict()
  .refine(
    (rule) => !rule.to || rule.verb === EMAIL_SEND,
    "only a rule for email.send names recipients",
  )
  .transform(({ verb, to }) => ({
    verb,
    ...(to && { to: [...new Set(to.map((pattern) => pattern.toLowerCase()))].sort() }),
  }));
export type ActRule = z.infer<typeof ActRule>;

/** A mail as its approver reads it. Attachments are named by their bytes' hash, never carried.
 *  `inReplyTo` and `references` are the headers as they are sent; an attachment's `path` is where
 *  the file is in the mind's files, when the mind said. */
const MailAct = z.strictObject({
  act: z.literal(EMAIL_SEND),
  from: z.string(),
  fromName: z.string(),
  replyTo: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  text: z.string().nullable(),
  html: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.string().nullable(),
  attachments: z.array(
    z.strictObject({
      filename: z.string(),
      contentType: z.string(),
      size: z.number(),
      sha256: z.string(),
      path: z.string().nullable(),
    }),
  ),
});
export type MailAct = z.infer<typeof MailAct>;

/** A call of a verb: its name and its arguments, which are plain JSON. `resolved` is the kernel's
 *  mark of what the name was when the act was held (a hash): the same name on another function is
 *  another act. */
const VerbAct = z.strictObject({
  act: z.string().startsWith("itx."),
  args: z.array(z.unknown()),
  resolved: z.string().optional(),
});
export type VerbAct = z.infer<typeof VerbAct>;

const Act = z.union([MailAct, VerbAct]);
export type Act = z.infer<typeof Act>;

/** Whether the act is a mail: the one verb that is no `itx.` name. */
export const isMailAct = (act: Act): act is MailAct => act.act === EMAIL_SEND;

/** The act a text is, or null when it is none: the gate keeps, and the mind does, only this. */
export function actOfText(text: string): Act | null {
  try {
    return Act.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The exact text of an act: what the gate keeps, the approver hashes and the statement names. */
export const actText = (act: Act): string => JSON.stringify(act);

/** A mail as the boundary is asked to send it: the shape of ./workers.ts `OutboundEmail`. Written
 *  again here because ./api.ts names a rule's type from this module, and must not bring the
 *  Workers' own types into a program that has none (a script, a client). */
type MailToSend = {
  from: { email: string; name: string };
  to: string[];
  cc: string[];
  subject: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
  attachments: { filename: string; contentType: string; content: Uint8Array; path?: string }[];
};

/** The mail the boundary is asked to send, as an act. Headers that differ between two tries of one
 *  mail (our mark) are left out, so a retry is the same act. */
export async function mailActOf(message: MailToSend): Promise<MailAct> {
  const header = (name: string) =>
    Object.entries(message.headers).find(([key]) => key.toLowerCase() === name)?.[1] || null;
  return {
    act: EMAIL_SEND,
    from: message.from.email.toLowerCase(),
    fromName: message.from.name,
    replyTo: header("reply-to"),
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    text: message.text || null,
    html: message.html || null,
    inReplyTo: header("in-reply-to"),
    references: header("references"),
    attachments: await Promise.all(
      message.attachments.map(async ({ filename, contentType, content, path }) => ({
        filename,
        contentType,
        size: content.byteLength,
        sha256: await sha256Hex(content),
        path: path || null,
      })),
    ),
  };
}

/** One address and nothing else: no name before it, no angle brackets, no second address. */
const BARE_ADDRESS = /^[^\s<>",;:()[\]\\@]+@[A-Za-z0-9.-]+$/;

/** WHY THE BOUNDARY DOES NOT SEND TO THESE RECIPIENTS, or null. A recipient is one address alone.
 *  A name before the address can hold another address in angle brackets
 *  (`"<safe@x>" <leak@evil>`): a rule and an approver would read the first, and the mail service
 *  sends to the last. */
export function recipientsRefusal(recipients: readonly string[]): string | null {
  // by its place: an empty recipient is odd too
  const at = recipients.findIndex((recipient) => !BARE_ADDRESS.test(recipient));
  if (at < 0) return null;
  return `name each recipient by its address alone, as jo@example.com: ${JSON.stringify(recipients[at]!.slice(0, 80))} is not one`;
}

/** THE HEADERS OF THE MAIL THAT GOES: the three that the act holds, made again from the act, and
 *  whether the mail says that a program wrote it. Every other header that the sender gave is left
 *  out, since no approver saw it: a Bcc, or a second Reply-To in another letter case. */
export function mailHeadersOf(act: MailAct, given: Record<string, string>): Record<string, string> {
  const automatic = Object.entries(given).find(
    ([name]) => name.toLowerCase() === "auto-submitted",
  )?.[1];
  return Object.fromEntries(
    Object.entries({
      "Reply-To": act.replyTo,
      "In-Reply-To": act.inReplyTo,
      References: act.references,
      "Auto-Submitted": automatic && /^auto-(?:generated|replied)$/.test(automatic) && automatic,
    }).filter((header): header is [string, string] => Boolean(header[1])),
  );
}

/** A call of `verb` as an act, or why it cannot wait: only plain JSON can be shown and signed. */
export function verbActOf(verb: string, args: unknown[]): VerbAct | { refused: string } {
  if (args.every(isPlainJson)) return { act: verb, args };
  return {
    refused: `${verb} waits for a member's approval, and its arguments must be plain JSON to be shown and signed: no stub, stream, bytes, date or function`,
  };
}

function isPlainJson(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  // JSON's null
  if (!value) return true;
  if (Array.isArray(value)) return value.every(isPlainJson);
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every(isPlainJson)
  );
}

/** Whether a rule holds the act. */
export function ruleHolds(rule: ActRule, act: Act): boolean {
  if (isMailAct(act)) {
    if (rule.verb !== EMAIL_SEND) return false;
    if (!rule.to) return true;
    return [...act.to, ...act.cc].some((address) =>
      rule.to!.some((pattern) => addressMatches(pattern, address)),
    );
  }
  if (rule.verb.endsWith(".*")) return act.act.startsWith(rule.verb.slice(0, -1));
  return rule.verb === act.act;
}

/** Whether a rule's pattern names the recipient. The boundary sends to one address alone
 *  (`recipientsRefusal`); a recipient that is anything else is held by every pattern. */
function addressMatches(pattern: string, recipient: string): boolean {
  if (pattern === "*" || !BARE_ADDRESS.test(recipient)) return true;
  const address = recipient.toLowerCase();
  if (pattern.startsWith("*@")) return address.endsWith(pattern.slice(1));
  return address === pattern;
}

/** Whether `after` holds everything `before` held: a change that needs no signature once locked. */
export function rulesTighten(before: readonly ActRule[], after: readonly ActRule[]): boolean {
  return before.every((old) =>
    after.some(
      (now) =>
        (now.verb === old.verb ||
          (now.verb.endsWith(".*") && old.verb.startsWith(now.verb.slice(0, -1)))) &&
        (!now.to ||
          (old.to &&
            old.to.every((pattern) => now.to!.includes(pattern) || now.to!.includes("*")))),
    ),
  );
}

/** What the gate says of an act.
 *  - `free`: no rule names it. Do it.
 *  - `held`: it waits from now. Record the facts, then ask again with `wait`.
 *  - `go`: a member approved it and the gate has marked it done: do it now, once.
 *  - `rejected`: a member said no.
 *  - `waiting`: nobody answered within the wait. It stays approvable for a day.
 *  - `done`: it was done before. The same act is done once for one approval. */
export type GateAnswer = (
  | { state: "free" }
  | { state: "held" | "go" | "waiting" | "done"; digest: string }
  | { state: "rejected"; digest: string; reason: string; by: string }
) & { facts: { path: string; events: { type: string; payload: Record<string, unknown> }[] }[] };

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  // WebCrypto's types ask for a view on an ArrayBuffer; a view made by TextEncoder, R2 or a mail's
  // attachment is one, and the general `Uint8Array` type cannot say so
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
