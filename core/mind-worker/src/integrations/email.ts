import {
  causeHeader,
  type Caller,
  type ItxHostRootContext,
  type ReachableContext,
  refuseActPastLimit,
  sha256Hex,
} from "core-itx";
import {
  ACT_DONE,
  type GateAnswer,
  type MailAct,
  mailHeaderRefusal,
  recipientsRefusal,
} from "iterate/acts";
import type { EmailSendInput, StreamPage } from "iterate/api";
import { EmailContract, type EmailState, nextMailHops } from "iterate/email";
import type { ItxExpression } from "iterate/expression";
import {
  codedError,
  errorCode,
  ITERATE_CAUSE_HEADER,
  MAIL_HOPS_HEADER,
  reportIssue,
} from "iterate/lib";
import { type MindConfig, controlPlaneOriginOf, zoneOfMailAddress } from "iterate/mind-config";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import type { Door, MindTarget, ReceivedEmail } from "iterate/workers";
import { z } from "zod";
import { hopCaller } from "../context/hop-caller.ts";

export const EMAIL_PATH = "/integrations/email";

/** Files first, so the fact never names a file that is not there. A redelivery's fact differs in
 *  the fields Cloudflare stamps anew (Received, ARC): IDEMPOTENCY_CONFLICT means recorded, and
 *  names the offset of the first delivery's fact. It answers the offset of the mail's
 *  `email/received`, and for a delivery under a key that the log holds only when it is the same
 *  message (`sameMessage`): anyone can send another message under a known Message-ID, and the
 *  requests to forward the first one are not for it. */
export async function receiveEmail(
  files: R2Bucket,
  emailContext: ReachableContext,
  mail: ReceivedEmail,
): Promise<{ offset: number } | undefined> {
  let offset: number | undefined;
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
    const recorded = await recordEmail(emailContext, { principal: null }, event).catch(
      async (error: unknown) => {
        if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
        console.info({ event: "email.redelivered", idempotencyKey: event.idempotencyKey });
        // the cast: the conflict's data names the event that holds the key (core-itx stream.ts)
        const existing = (error as { data?: { existingOffset?: number } }).data?.existingOffset;
        return {
          offset:
            existing && (await sameMessage(emailContext, existing, event)) ? existing : undefined,
        };
      },
    );
    offset = recorded.offset;
  }
  return offset === undefined ? undefined : { offset };
}

/** The parts of a received message that its sender wrote, as `email/received` holds them: what a
 *  redelivery keeps, and another message under the same Message-ID does not. */
const WRITTEN_BY_THE_SENDER = [
  "messageId",
  "from",
  "to",
  "cc",
  "subject",
  "text",
  "html",
  "inReplyTo",
  "references",
  "attachments",
  "envelope",
] as const;

/** Whether the `email/received` at `offset` holds the message that `event` is of. */
async function sameMessage(
  emailContext: ReachableContext,
  offset: number,
  event: StreamEventInput,
) {
  // The casts: `invoke` answers `unknown`, and `readEvents` answers a page; a stored event's
  // payload and this one's are objects, read here field by field and compared as JSON.
  const page = (await emailContext.invoke(["itx", "builtins", ["readEvents", offset - 1, 1]], [], {
    principal: null,
  })) as StreamPage;
  const held = page.events.find((each) => each.offset === offset)?.payload as
    | Record<string, unknown>
    | undefined;
  const delivered = event.payload as Record<string, unknown>;
  return (
    !!held &&
    WRITTEN_BY_THE_SENDER.every(
      (field) => JSON.stringify(held[field]) === JSON.stringify(delivered[field]),
    )
  );
}

/** THE MIND'S NEXT REQUEST TO FORWARD ONE RECEIVED MAIL (iterate/workers
 *  `MindTarget.emailForwardRequest`): the next `email/forward-requested` after `afterOffset`
 *  that names the mail's raw file, waited for up to `timeoutMs`.
 *
 *  WHEN THE TIME IS UP, THE MAIL'S REQUESTS ARE CLOSED BY A FACT, `email/forward-requests-closed`,
 *  once for each mail. Its place on the log is the rule: a request before it is served, and one
 *  after it never is, by this delivery or a later one. So the log says of every request whether
 *  it was in time, with no clock. After the fact is appended, the requests that landed before it
 *  are still handed over, in their order; then the answer is null.
 *
 *  ONE ATTEMPT FOR EACH MAIL AND ADDRESS: a request written at the root, the only kind that the
 *  boundary serves, is claimed here before it is handed over (a `reserveSend` row, put once and
 *  never released), and a request whose pair is claimed is passed over. So two deliveries of one
 *  mail, at the same time or one after the other, cannot both forward it to one address. A
 *  request from another context claims nothing: it could keep the config's own request from
 *  being served. */
export async function emailForwardRequest(
  emailContext: ReachableContext,
  wait: Parameters<MindTarget["emailForwardRequest"]>[0],
): ReturnType<MindTarget["emailForwardRequest"]> {
  const until = Date.now() + wait.timeoutMs;
  let afterOffset = wait.afterOffset;
  let closed = false;
  for (;;) {
    const filter = {
      type: [
        "events.iterate.com/email/forward-requested",
        "events.iterate.com/email/forward-requests-closed",
      ],
      payload: { raw: wait.raw },
      afterOffset,
      // once the requests are closed, the search of the log up to that fact is all that is left
      timeoutMs: closed ? 5_000 : Math.max(0, until - Date.now()),
    };
    // the cast: `invoke` answers `unknown`, and `waitForEvent` answers the event it found
    const next = (await emailContext
      .invoke(["itx", "builtins", ["waitForEvent", filter]], [], { principal: null })
      .catch((error: unknown) => {
        if (errorCode(error) !== "WAIT_TIMEOUT") throw error;
        return null;
      })) as StreamEvent | null;
    if (!next) {
      if (closed) return null;
      // one wait is at most 120 s long (core-itx stream.ts): a longer time takes another
      if (Date.now() < until) continue;
      await recordEmail(
        emailContext,
        { principal: null },
        {
          type: "events.iterate.com/email/forward-requests-closed",
          idempotencyKey: `email/forward-requests-closed:${wait.raw}`,
          payload: { raw: wait.raw },
        },
      );
      closed = true;
      continue;
    }
    if (next.type === "events.iterate.com/email/forward-requests-closed") return null;
    afterOffset = next.offset;
    // the cast: a request's payload is its writer's, so `to` is read as unknown and checked
    const { to } = next.payload as { to?: unknown };
    if (typeof to === "string" && to.trim() && next.source.origin === "/") {
      if (!(await emailContext.reserveSend(forwardAttemptKey(wait.raw, to))).reserved) continue;
    }
    return { offset: next.offset, to, origin: next.source.origin };
  }
}

/** The key of the one attempt to forward a mail to an address (`reserveSend`). */
const forwardAttemptKey = (raw: string, to: string) =>
  `email/forward-attempt:${raw}:${to.trim().toLowerCase()}`;

/** THE CLAIM OF ONE ATTEMPT, for the stack's fixed forward (iterate/workers
 *  `MindTarget.emailForwardClaim`). A claim that is taken gets a second row that names its owner,
 *  and a release gives the claim back only when that row is there: a delivery that never took
 *  the claim cannot take another's away. A claim whose owner row did not land is never given
 *  back. */
export async function emailForwardClaim(
  emailContext: ReachableContext,
  claim: Parameters<MindTarget["emailForwardClaim"]>[0],
) {
  const key = forwardAttemptKey(claim.raw, claim.to);
  const owned = `${key}:by:${claim.owner}`;
  if (!claim.release) {
    if (!(await emailContext.reserveSend(key)).reserved) return false;
    await emailContext.reserveSend(owned);
    return true;
  }
  // The owner's row goes first: a second release of this owner that comes after it finds no
  // row and changes nothing. A delivery sends its releases one after the other (the boundary's
  // `fixedForward`), so two never run here at once.
  if (await emailContext.sentBefore(owned)) {
    await emailContext.releaseSend(owned);
    await emailContext.releaseSend(key);
  }
  return true;
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
    config: Pick<MindConfig, "controlPlaneHostname" | "zones">;
  },
) {
  return {
    send: (input: EmailSendInput) =>
      sendEmail(
        {
          ...scope,
          emailContext: context.context(EMAIL_PATH),
          contextOf: (path) => context.context(path),
          caller: hopCaller(context),
        },
        input,
      ),
  };
}

/** THE ADDRESS A MAIL LEAVES FROM: the one that `from` names, at one of the mind's zones. A mind
 *  has no default sender, so a call that names none is refused, an answer to a mail too. */
export function senderOf(from: string | undefined, config: Pick<MindConfig, "zones">): string {
  const zones = config.zones.join(", ");
  const address = from?.trim().toLowerCase();
  if (!address)
    throw codedError(
      "INVALID_INPUT",
      `itx.email.send: give the sender, \`from\`: an address at one of this mind's zones (${zones}), like agent@${config.zones[0]}`,
    );
  // one valid mailbox, as the boundary's door takes it: a sender that it would refuse is refused
  // here, before anything is reserved
  if (!z.email().safeParse(address).success || !zoneOfMailAddress(config, address))
    throw codedError(
      "FORBIDDEN",
      `itx.email.send: this mind sends from an address at one of its zones (${zones}), not ${address}`,
    );
  return address;
}

async function sendEmail(
  scope: {
    files: R2Bucket;
    egress: () => Pick<Door, "sendEmail">;
    config: Pick<MindConfig, "controlPlaneHostname" | "zones">;
    emailContext: ReachableContext;
    contextOf: (path: string) => ReachableContext;
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
  const hops = request.inReplyToOffset
    ? await hopsOfAnswer(scope.emailContext, request.inReplyToOffset, scope.caller)
    : 1;
  const to = request.to ? [request.to].flat() : answered?.to || [];
  const cc = request.cc ? [request.cc].flat() : answered?.cc || [];
  const subject = request.subject || answered?.subject || "";
  const from = senderOf(request.from, scope.config);
  // A mind has no name of its own: the name a mail shows is the sender's own, before the `@`.
  const fromName = from.slice(0, from.indexOf("@"));
  if (to.length + cc.length === 0 || !(request.text || request.html))
    throw codedError(
      "INVALID_INPUT",
      "itx.email.send: name a recipient (`to`, `cc`, or `inReplyToOffset`) and a `text` or `html` body",
    );
  // as the boundary asks, said here in the caller's own words
  const odd =
    recipientsRefusal([...to, ...cc]) ||
    mailHeaderRefusal({
      subject,
      fromName,
      replyTo: null,
      inReplyTo: null,
      references: null,
    });
  if (odd) throw codedError("INVALID_INPUT", `itx.email.send: ${odd}`);
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
    `${writeKey}:email.send:${(await sha256Hex(JSON.stringify([from, to, cc, subject, request.text, request.html]))).slice(0, 16)}`;
  let reserved = false;
  if (key) {
    const reservation = await scope.emailContext.reserveSend(key);
    if (reservation.recorded) return reservation.recorded;
    if (!reservation.reserved)
      throw codedError(
        "PERMANENT_FAILURE",
        "itx.email.send: an earlier attempt of this delivery sent this message or may have, and recorded nothing — it is not sent again",
      );
    reserved = true;
  }
  // Only the attempt that holds the reservation gives it up.
  const release = async () => {
    if (key && reserved) await scope.emailContext.releaseSend(key);
    reserved = false;
  };
  const references = answered?.references || [];
  const message = {
    from: { email: from, name: fromName },
    to,
    cc,
    subject,
    text: request.text,
    html: request.html,
    headers: {
      "Auto-Submitted": "auto-generated",
      [MAIL_HOPS_HEADER]: String(hops),
      ...(scope.caller.cause && { [ITERATE_CAUSE_HEADER]: causeHeader(scope.caller.cause) }),
      ...(answered?.inReplyTo && {
        "In-Reply-To": `<${answered.inReplyTo}>`,
        References: referencesHeaderOf(references),
      }),
    },
    attachments: attachments.map(({ filename, contentType, content, path }) => ({
      filename,
      contentType,
      content,
      path,
    })),
  };
  // A MAIL AN APPROVAL RULE NAMES WAITS (iterate/acts). The boundary answers `held` at once, so the
  // log says it waits before anyone decides; the second call waits for the member's answer.
  const sent = (wait: boolean) =>
    scope
      .egress()
      .sendEmail(message, { from: scope.caller.path, wait })
      .catch(async (error: unknown) => {
        await release();
        throw error;
      });
  let outcome = await sent(false);
  if (!outcome.sent && outcome.gate?.state === "held") {
    // A HELD MAIL KEEPS NO RESERVATION WHILE IT WAITS. Nothing went, so the reservation is given
    // up before the wait: a retry of the delivery in that time waits beside this one, and an
    // attempt that dies in the wait leaves nothing behind. The gate lets an approved mail go
    // once, so it is the at-most-once of a held mail.
    await release();
    await recordGateFacts(scope.contextOf, scope.caller, outcome.gate.facts);
    outcome = await sent(true);
  }
  if (!outcome.sent) {
    await release();
    if (!outcome.gate) {
      // The log says it too, so the refusal is not known to this caller alone. A fact that does not
      // land is reported, and the caller still gets the refusal.
      await recordEmail(scope.emailContext, scope.caller, {
        type: "events.iterate.com/email/send-failed",
        payload: { from, to, cc, subject, error: outcome.error, code: outcome.code || null },
      }).catch((error: unknown) => reportIssue("email.send-failed-not-recorded", error));
      throw codedError("UNAVAILABLE", `itx.email.send: the boundary refused it: ${outcome.error}`);
    }
    await recordGateFacts(scope.contextOf, scope.caller, outcome.gate.facts);
    const at = `${controlPlaneOriginOf(scope.config)}/secrets/approvals?digest=${outcome.gate.digest}`;
    throw codedError(
      "FORBIDDEN",
      outcome.gate.state === "waiting" || outcome.gate.state === "held"
        ? `itx.email.send: this mail waits for a member's approval, at ${at}. It can be approved for a day. When it is, it is sent then, and this context gets an event that says so (${ACT_DONE}): do not send it again.`
        : `itx.email.send: ${outcome.error} (${at})`,
      { digest: outcome.gate.digest, state: outcome.gate.state },
    );
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

/** The gate's facts, on the context it names. One that does not land is reported: the gate's own
 *  log holds the act. */
async function recordGateFacts(
  contextOf: (path: string) => ReachableContext,
  caller: Caller,
  facts: GateAnswer["facts"],
) {
  for (const { path, events } of facts)
    await contextOf(path)
      .invoke(["itx", "builtins", ["append", ...events]], [], { ...caller, platform: true })
      .catch((error: unknown) => reportIssue("approval.facts-not-recorded", error, { path }));
}

/** A MAIL A MEMBER APPROVED AFTER ITS CALLER STOPPED WAITING: made again from the act's own text
 *  and the files it names, and sent through the boundary, where the gate lets it go once. The boundary
 *  makes the act's text again from what it is given: a file that changed since is another mail,
 *  which nobody approved, and it is not sent. */
export async function sendApprovedMail(
  scope: {
    files: R2Bucket;
    egress: () => Pick<Door, "sendEmail">;
    emailContext: ReachableContext;
  },
  act: MailAct,
  from: string | undefined,
) {
  const attachments = await Promise.all(
    act.attachments.map(async ({ filename, contentType, path }) => {
      const object = path ? await scope.files.get(path.replace(/^\/+/, "")) : null;
      if (!object) throw new Error(`the attached file ${path || filename} is gone`);
      return {
        filename,
        contentType,
        path: path!,
        content: new Uint8Array(await object.arrayBuffer()),
      };
    }),
  );
  const outcome = await scope.egress().sendEmail(
    {
      from: { email: act.from, name: act.fromName },
      to: act.to,
      cc: act.cc,
      subject: act.subject,
      text: act.text || undefined,
      html: act.html || undefined,
      // the headers the act itself names, and none that it does not
      headers: Object.fromEntries(
        Object.entries({
          "Auto-Submitted": "auto-generated",
          "Reply-To": act.replyTo,
          "In-Reply-To": act.inReplyTo,
          References: act.references,
        }).filter((header): header is [string, string] => Boolean(header[1])),
      ),
      attachments,
    },
    { from },
  );
  if (!outcome.sent) throw new Error(outcome.error);
  return recordEmail(
    scope.emailContext,
    { principal: null },
    {
      type: "events.iterate.com/email/sent",
      payload: {
        messageId: bareMessageIdsOf(outcome.messageId)[0] ?? null,
        from: act.from,
        to: act.to,
        cc: act.cc,
        subject: act.subject,
        text: act.text,
        html: act.html,
        inReplyTo: bareMessageIdsOf(act.inReplyTo || undefined)[0] ?? null,
        references: bareMessageIdsOf(act.references || undefined),
        attachments: act.attachments.map(({ sha256: _hash, ...attachment }) => attachment),
      },
    },
  );
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
    // A mail may arrive with a subject of two lines, and a header that goes is one line
    // (iterate/acts `mailHeaderRefusal`): the answer's subject is that subject on one line.
    subject: (/^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`).replace(
      /\s*[\r\n]+\s*/g,
      " ",
    ),
    inReplyTo: message.messageId,
    references: [...message.references, ...(message.messageId ? [message.messageId] : [])],
  };
}

/** THE HOP COUNT OF AN ANSWER: one past the most hops of another mind's mail in the thread of the
 *  message at `offset`, as the `email` facet folded it (iterate/email `nextMailHops`). */
async function hopsOfAnswer(emailContext: ReachableContext, offset: number, caller: Caller) {
  const asPlatform: Caller = { ...caller, platform: true };
  const facet: ItxExpression = ["itx", "builtins", "facets", ["get", "email"]];
  await emailContext.invoke([...facet, ["waitUntilProcessed", { offset }]], [], asPlatform);
  // The cast: `invoke` answers `unknown`, and the `email` facet's snapshot is its contract's state
  // (iterate/email `EmailContract`), as recordEmail and answeredMessageOf above read it.
  const { state } = (await emailContext.invoke([...facet, ["snapshot"]], [], asPlatform)) as {
    state: EmailState;
  };
  const thread = Object.values(state.threads).find((candidate) =>
    candidate.messageOffsets.includes(offset),
  );
  return nextMailHops(thread?.mindHops ? [thread.mindHops] : []);
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
