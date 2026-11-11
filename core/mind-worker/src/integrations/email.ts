import {
  causeHeader,
  type Caller,
  type ItxHostRootContext,
  type ReachableContext,
  refuseActPastLimit,
  sha256Hex,
} from "core-itx";
import type { EmailSendInput, StreamPage } from "iterate/api";
import { EmailContract } from "iterate/email";
import { codedError, errorCode, ITERATE_CAUSE_HEADER } from "iterate/lib";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import type { Door, ReceivedEmail } from "iterate/workers";
import { z } from "zod";
import { hopCaller } from "../context/hop-caller.ts";

export const EMAIL_PATH = "/integrations/email";

/** Files first, so the fact never names a file that is not there. A redelivery's fact differs in
 *  the fields Cloudflare stamps anew (Received, ARC): IDEMPOTENCY_CONFLICT means recorded. */
export async function receiveEmail(
  files: R2Bucket,
  emailContext: ReachableContext,
  mail: ReceivedEmail,
) {
  for (const file of mail.files) {
    const key = file.path.replace(/^\/+/, "");
    // Written once: anyone can send a known Message-ID, and must not replace the first one's files.
    if (await files.head(key)) {
      await file.data.cancel();
      continue;
    }
    await files.put(key, file.data.pipeThrough(new FixedLengthStream(file.size)), {
      httpMetadata: { contentType: file.contentType },
      onlyIf: { etagDoesNotMatch: "*" },
    });
  }
  for (const event of mail.events) {
    if (event.type !== "events.iterate.com/email/received")
      throw codedError("INVALID_INPUT", `receiveEmail: ${event.type} is no inbound message`);
    await recordEmail(emailContext, { principal: null }, event).catch((error: unknown) => {
      if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
      console.info({ event: "email.redelivered", idempotencyKey: event.idempotencyKey });
    });
  }
}

/** It arrives over the wire. */
const SendInput = z.object({
  from: z.string().optional(),
  to: z.union([z.string(), z.array(z.string())]).optional(),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  inReplyToOffset: z.number().int().positive().optional(),
  attachments: z.array(z.object({ path: z.string(), filename: z.string().optional() })).optional(),
});

export function emailRoot(
  context: ItxHostRootContext,
  scope: {
    files: R2Bucket;
    egress: () => Pick<Door, "sendEmail">;
    name: string;
    domain: string;
  },
) {
  return {
    send: (input: EmailSendInput) =>
      sendEmail(
        {
          ...scope,
          address: `${scope.name}@${scope.domain}`.toLowerCase(),
          emailContext: context.context(EMAIL_PATH),
          caller: hopCaller(context),
        },
        input,
      ),
  };
}

async function sendEmail(
  scope: {
    files: R2Bucket;
    egress: () => Pick<Door, "sendEmail">;
    address: string;
    name: string;
    domain: string;
    emailContext: ReachableContext;
    caller: Caller;
  },
  input: EmailSendInput,
) {
  // Past the loop limit, nothing is mailed (core-itx cause.ts).
  refuseActPastLimit(scope.caller.cause, "itx.email.send");
  const parsed = SendInput.safeParse(input);
  if (!parsed.success) throw codedError("INVALID_INPUT", `itx.email.send: ${parsed.error.message}`);
  const request = parsed.data;
  const answered = request.inReplyToOffset
    ? await answeredMessageOf(scope.emailContext, request.inReplyToOffset, scope.caller)
    : null;
  const to = request.to ? [request.to].flat() : answered?.to || [];
  const cc = request.cc ? [request.cc].flat() : answered?.cc || [];
  const subject = request.subject || answered?.subject || "";
  const mayUse = (address: string) =>
    /^[^@\s<>]+@[^@\s<>]+$/.test(address) && address.endsWith(`@${scope.domain}`);
  const answeredAt = answered?.receivedAt.toLowerCase();
  const from =
    request.from?.trim().toLowerCase() ||
    (answeredAt && mayUse(answeredAt) ? answeredAt : scope.address);
  if (!mayUse(from))
    throw codedError(
      "FORBIDDEN",
      `itx.email.send: this mind sends from any address @${scope.domain}, not ${from}`,
    );
  if (to.length + cc.length === 0 || !(request.text || request.html))
    throw codedError(
      "INVALID_INPUT",
      "itx.email.send: name a recipient (`to`, `cc`, or `inReplyToOffset`) and a `text` or `html` body",
    );
  const attachments = await Promise.all(
    (request.attachments || []).map(async ({ path, filename }) => {
      const object = await scope.files.get(path.replace(/^\/+/, ""));
      if (!object) throw codedError("INVALID_INPUT", `itx.email.send: no file at ${path}`);
      return {
        filename: filename || path.split("/").pop()!,
        contentType: object.httpMetadata?.contentType || "application/octet-stream",
        size: object.size,
        path,
        content: new Uint8Array(await object.arrayBuffer()),
      };
    }),
  );
  // At most once a delivery (core-itx cause.ts): a send keyed by the delivery is reserved before it
  // goes. A send that may have gone out with nothing recorded is never sent again.
  const writeKey = scope.caller.cause?.writeKey;
  const key =
    writeKey &&
    `${writeKey}:email.send:${(await sha256Hex(JSON.stringify([to, cc, subject, request.text, request.html]))).slice(0, 16)}`;
  if (key) {
    const { recorded, reserved } = await scope.emailContext.reserveSend(key);
    if (recorded) return recorded;
    if (!reserved)
      throw codedError(
        "PERMANENT_FAILURE",
        "itx.email.send: an earlier attempt of this delivery sent this message or may have, and recorded nothing — it is not sent again",
      );
  }
  const references = answered?.references || [];
  const outcome = await scope
    .egress()
    .sendEmail({
      from: { email: from, name: scope.name },
      to,
      cc,
      subject,
      text: request.text,
      html: request.html,
      headers: {
        "Auto-Submitted": "auto-generated",
        ...(scope.caller.cause && { [ITERATE_CAUSE_HEADER]: causeHeader(scope.caller.cause) }),
        ...(answered?.inReplyTo && {
          "In-Reply-To": `<${answered.inReplyTo}>`,
          References: referencesHeaderOf(references),
        }),
      },
      attachments: attachments.map(({ filename, contentType, content }) => ({
        filename,
        contentType,
        content,
      })),
    })
    .catch(async (error: unknown) => {
      if (key) await scope.emailContext.releaseSend(key);
      throw error;
    });
  if (!outcome.sent) {
    if (key) await scope.emailContext.releaseSend(key);
    throw codedError("UNAVAILABLE", `itx.email.send: the door refused it: ${outcome.error}`);
  }
  return recordEmail(scope.emailContext, scope.caller, {
    type: "events.iterate.com/email/sent",
    idempotencyKey: key || undefined,
    payload: {
      messageId: bareMessageIdsOf(outcome.messageId)[0] ?? null,
      from,
      to,
      cc,
      subject,
      text: request.text || null,
      html: request.html || null,
      inReplyTo: answered?.inReplyTo || null,
      references,
      attachments: attachments.map(({ content: _bytes, ...attachment }) => attachment),
    },
  });
}

/** The `email` facet folds only the platform's facts, so its row is enabled first (a no-op once it is). */
async function recordEmail(
  emailContext: ReachableContext,
  caller: Caller,
  event: StreamEventInput,
) {
  const asPlatform: Caller = { ...caller, platform: true };
  await emailContext.invoke(["itx", "builtins", "processors", ["enable", "email"]], [], asPlatform);
  const [recorded] = (await emailContext.invoke(
    ["itx", "builtins", ["append", event]],
    [],
    asPlatform,
  )) as StreamEvent[];
  return recorded!;
}

/** For a received message, replies go to its author (or Reply-To) from the address it reached; for
 *  our own message, to the same people from the same address. */
async function answeredMessageOf(emailContext: ReachableContext, offset: number, caller: Caller) {
  // read under the sender's caller, so a wake of /integrations/email is caused by its chain
  const page = (await emailContext.invoke(
    ["itx", "builtins", ["readEvents", offset - 1, 1]],
    [],
    caller,
  )) as StreamPage;
  const [event] = page.events;
  const found = event?.offset === offset ? event : undefined;
  const { events } = EmailContract;
  const received =
    found?.type === "events.iterate.com/email/received"
      ? events["events.iterate.com/email/received"].payloadSchema.safeParse(found.payload).data
      : undefined;
  const message =
    received ||
    (found?.type === "events.iterate.com/email/sent"
      ? events["events.iterate.com/email/sent"].payloadSchema.safeParse(found.payload).data
      : undefined);
  if (!message)
    throw codedError(
      "INVALID_INPUT",
      `itx.email.send: ${EMAIL_PATH} has no message at offset ${offset}`,
    );
  return {
    to: received ? [received.replyTo || received.from] : message.to,
    cc: received ? [] : message.cc,
    receivedAt: received ? received.envelope.to : message.from,
    subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
    inReplyTo: message.messageId,
    references: [...message.references, ...(message.messageId ? [message.messageId] : [])],
  };
}

/** Under Email Service's 2,048-byte header limit; RFC 5322 3.6.4 keeps the first id. */
function referencesHeaderOf(references: string[]) {
  const bracketed = references.map((id) => `<${id}>`);
  while (bracketed.length > 2 && bracketed.join(" ").length > 2000) bracketed.splice(1, 1);
  return bracketed.join(" ");
}

function bareMessageIdsOf(value: string | undefined) {
  const bracketed = [...(value || "").matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]!);
  return bracketed.length > 0 || !value?.trim() ? bracketed : [value.trim()];
}
