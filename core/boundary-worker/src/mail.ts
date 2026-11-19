// Pure (binds nothing, calls nobody) and one file, so it can move into the mind whole.
import { emailForwardedKey, type ForwardableMail } from "iterate/email";
import { codedError, errorCode, MAIL_HOPS_HEADER, mailHopsOf } from "iterate/lib";
import type { AuthService, MindTarget, ReceivedEmail } from "iterate/workers";
import PostalMime, { type Address } from "postal-mime";
import type { MindTransport, PlatformFact } from "./http.ts";

const BODY_MAX_CHARS = 100_000;

/** The mind's email log. */
const EMAIL_PATH = "/integrations/email";

/** What Cloudflare says when it will not forward a mail whose sender nobody proved. */
const NOT_FORWARDABLE = "non-authenticated emails cannot be forwarded";

/** What the fact says of a mail that names the forward address in its `X-Forwarded-To`. */
const FORWARDED_BEFORE =
  "not forwarded: the mail's X-Forwarded-To says it was forwarded to this address before";

/** THE TIME LIMITS OF ONE DELIVERY'S `email` HOOK AND ITS FACTS, side by side. Cloudflare's
 *  `message.forward()` answers 3 to 10 s after the call, though its copy arrives in 1 to 2.5 s.
 *  Cloudflare's own limit for an email handler is not known, so these values are proposed ones.
 *  THE WHOLE HANDLER takes the receipt (step 1) and the fixed forward (step 2), which no limit here
 *  bounds, PLUS the three: 15 + 20 + 5 s.
 *
 *  EMAIL_HOOK_MS bounds THE CONFIG'S OWN TIME: its clock stops while a forward that the config
 *  called waits for Cloudflare's answer, since Cloudflare's time is not the config's fault. */
const EMAIL_HOOK_MS = 15_000;
/** How much longer, in all, the boundary waits for Cloudflare's answers to the forwards that the
 *  config called: the delivery's hook ends at the latest EMAIL_HOOK_MS + FORWARD_ANSWER_MS after
 *  it began. A forward that is unanswered then is `email/forwarded` with `answered: false`. */
const FORWARD_ANSWER_MS = 20_000;
/** How long, at most, the boundary waits for the appends of the mail's facts after the forward has
 *  ended, all together. An append that has not answered then is its `mail.*-not-recorded` log line,
 *  and the handler returns: no fact holds it open without a bound. */
const FACTS_MS = 5_000;

/** THE BOUNDARY'S MAIL HANDLER: a mail that Cloudflare delivers, for an address at any zone of the
 *  mind, goes to the mind, with what the boundary knows of its sender. ONE DELIVERY, IN THIS ORDER
 *  (check the code against it):
 *
 *  1. `mind.receiveEmail`: the mind stores the mail. This is the one step whose failure fails the
 *     delivery, so Cloudflare delivers the mail again; the mind takes the same mail once, however
 *     often it is delivered.
 *  2. With `MAIL_FORWARD_TO` (the stack's `mail.forwardTo`, the older way, which goes once the
 *     minds forward in their own `email`), the stack's fixed forward, below.
 *  3. `mind.email`: the config's `email` hook, with the mail and the delivery's forward
 *     (`MailForward`), under the limits above and caught: from here on nothing fails the delivery.
 *  4. THE FORWARD ENDS at the instant the hook returns or throws, its own time runs out, or the
 *     last deadline passes: one synchronous flag (`MailForward.end`), set in the callback that
 *     sees it, before any await. The last statement before Cloudflare's call checks the flag and
 *     both limits BY THE CLOCK, with nothing awaited between. A forward after the end throws
 *     EXPIRED, and Cloudflare is not asked. The mind ends its own side the instant the config's
 *     function settles (core/mind-worker/src/integrations/email-hook.ts).
 *  5. The forwards that the config called before the end are waited for, up to the last deadline.
 *     Each that Cloudflare answers is `email/forwarded`; each unanswered then is `email/forwarded`
 *     with `answered: false`.
 *  6. A hook that ran past its own time is `email/hook-failed` `timeout`, and a mind that could not
 *     be reached for it `unreachable`. The mind records a throw and a config with no `email`
 *     itself.
 *  7. THE BOOKKEEPING: every append of a fact that this delivery started (steps 2, 5 and 6) is
 *     awaited, all together, for at most FACTS_MS. One that has not answered then is its
 *     `mail.*-not-recorded` log line. Then the handler returns. An append may start while the hook
 *     runs, but none is awaited before this step: none keeps the forward live, or the handler
 *     open past FACTS_MS.
 *
 *  THE MAIL'S FACTS (`email/forwarded`, `email/forward-failed`, `email/hook-failed`) each carry an
 *  idempotency key. For a mind that runs elsewhere and is away, or whose link breaks under the
 *  append, the boundary's `ProvidedMind` keeps each and appends it when the mind is back
 *  (./provided-mind.ts). A fact that the mind refuses, or that the stack's own mind Worker does
 *  not take, is a `mail.*-not-recorded` log line, and changes nothing of the delivery.
 *
 *  THE STACK'S FIXED FORWARD goes through the same `MailForward`, so it records `email/forwarded`
 *  and a hook's forward of the same mail to the same address then throws FORWARDED_BEFORE. It
 *  reads no fact and no mark itself: AT ANY REDELIVERY that passes the `X-Forwarded-To` guard, it
 *  forwards again, as on main. What it does to the delivery is as it was: a forward that fails is
 *  a fact on the mind's email log, `email/forward-failed`, with Cloudflare's words. A mail whose
 *  sender is not proven is kept and not forwarded, and the delivery stands. Any other failure (an
 *  address that is not a verified destination, or that refuses) fails the delivery too, so its
 *  sender gets it back: while it lasts, every mail to the mind fails for its sender, and no hook
 *  runs. */
export async function receivedMail(
  message: ForwardableEmailMessage,
  env: { AUTH: Pick<AuthService, "isMember">; MAIL_FORWARD_TO?: string },
  mind: Pick<MindTransport, "receiveEmail" | "append" | "email" | "appendOrKeep">,
  limits: HookLimits = { hookMs: EMAIL_HOOK_MS, forwardAnswerMs: FORWARD_ANSWER_MS },
) {
  // step 1
  const { received, mail } = await parseEmail({
    from: message.from,
    to: message.to,
    raw: message.raw,
    isMember: (address) => env.AUTH.isMember(address),
  });
  await mind.receiveEmail(received);
  // `canBeForwarded` is on Cloudflare's message, and not yet in its types (workerd#8290); absent
  // (a local runtime), the forward finds out.
  const { canBeForwarded } = message as ForwardableEmailMessage & { canBeForwarded?: boolean };
  const forwarding = new MailForward(message, mind, mail, canBeForwarded !== false);
  try {
    // step 2
    if (env.MAIL_FORWARD_TO)
      await fixedForward(forwarding, message, mail.raw.path, env.MAIL_FORWARD_TO);
    // steps 3 to 6
    await hook(mind, forwarding, mail.raw.path, limits, {
      mail: { ...mail, canBeForwarded: canBeForwarded !== false },
      // A function of this invocation's: Workers RPC and capnweb each pass it as a stub.
      forward: (to) => forwarding.forward(to),
    });
  } finally {
    // step 4 once more, for a fixed forward that failed the delivery; then step 7
    forwarding.end();
    await forwarding.recorded(limits.factsMs ?? FACTS_MS);
  }
}

/** THE FORWARD OF ONE DELIVERY, Cloudflare's live `message.forward`, wrapped: it forwards the
 *  original as it arrived, records `email/forwarded`, or throws a coded error (iterate/email
 *  `EmailHookArgs`). It refuses an address that it forwarded this mail to already in this
 *  delivery, or that the mail's `X-Forwarded-To` names: an address that leads back here ends at
 *  its second visit. Cloudflare writes one such header line for each forward, the address bare,
 *  and keeps the earlier lines and one that the sender wrote. The mind refuses an address that an
 *  earlier delivery's SENT mark names (core/mind-worker/src/integrations/email-hook.ts). */
class MailForward {
  #live = true;
  /** Step 4 by the clock: a limit of the hook has passed, whether or not its timer has run. */
  pastLimits: () => boolean = () => false;
  readonly #sent = new Set<string>();
  /** Each forward that Cloudflare has not answered yet, by address. */
  readonly #inFlight = new Map<string, Promise<unknown>>();
  /** The forwards that the boundary gave up on and recorded as unanswered. */
  readonly #unanswered = new Set<string>();
  /** The appends of the mail's facts that this delivery started and that have not answered: each
   *  with the log line that says that it did not land. */
  readonly #facts = new Set<PendingFact>();
  /** Told whether a forward waits for Cloudflare: the hook's clock stops while one does. */
  onWaiting: (waiting: boolean) => void = () => {};
  readonly #forwardedBefore: string[];
  readonly #message: ForwardableEmailMessage;
  readonly #mind: FactsMind;
  readonly #mail: { raw: { path: string }; messageId: string | null };
  readonly #canBeForwarded: boolean;

  constructor(
    message: ForwardableEmailMessage,
    mind: FactsMind,
    mail: { raw: { path: string }; messageId: string | null },
    canBeForwarded: boolean,
  ) {
    this.#message = message;
    this.#mind = mind;
    this.#mail = mail;
    this.#canBeForwarded = canBeForwarded;
    this.#forwardedBefore = (message.headers.get("x-forwarded-to") ?? "")
      .toLowerCase()
      .split(",")
      .map((address) => address.trim());
  }

  async forward(to: string) {
    const address = to.trim().toLowerCase();
    if (!this.#canBeForwarded)
      throw codedError(
        "NOT_FORWARDABLE",
        "not forwarded: Cloudflare forwards no mail whose sender it did not prove",
      );
    if (this.#forwardedBefore.includes(address))
      throw codedError("FORWARDED_BEFORE", FORWARDED_BEFORE);
    if (this.#sent.has(address) || this.#inFlight.has(address))
      throw codedError("FORWARDED_BEFORE", `not forwarded: this mail went to ${to} before`);
    // THE LAST CHECK BEFORE CLOUDFLARE'S CALL, with nothing awaited between them.
    if (!this.#live || this.pastLimits())
      throw codedError(
        "EXPIRED",
        "not forwarded: the mail's delivery has ended, and with it the message to forward",
      );
    const answer = (async () => this.#message.forward(to))();
    this.#inFlight.set(
      address,
      answer.catch(() => {}),
    );
    this.onWaiting(true);
    try {
      await answer;
    } catch (error) {
      const words = error instanceof Error ? error.message : String(error);
      throw codedError(words.includes(NOT_FORWARDABLE) ? "NOT_FORWARDABLE" : "REFUSED", words);
    } finally {
      this.#inFlight.delete(address);
      this.onWaiting(this.#inFlight.size > 0);
    }
    this.#sent.add(address);
    // The boundary gave up on this answer and recorded that it did not come.
    if (this.#unanswered.has(address)) return;
    // Cloudflare accepted the forward, and its caller is told at once (the mind writes its SENT
    // mark on that answer). The fact's append is bookkeeping, awaited in step 7.
    this.#recordForwarded(to);
  }

  /** Waits until Cloudflare has answered every forward in flight, or until `deadline`. */
  async answered(deadline: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(this.#inFlight.values()),
      new Promise((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now())))),
    ]).finally(() => clearTimeout(timer));
  }

  /** THE BOUNDARY GIVES UP ON THE FORWARDS IN FLIGHT: each is `email/forwarded` with `answered:
   *  false`, under the same key, so that no reader takes the mail for not sent. It is no SENT
   *  mark: Cloudflare may still reject, and then a later delivery forwards there again. */
  giveUp() {
    for (const [address] of this.#inFlight) {
      this.#unanswered.add(address);
      this.#recordForwarded(address, { answered: false });
    }
    return this.#unanswered.size;
  }

  #recordForwarded(to: string, unanswered?: { answered: false }) {
    const payload = {
      to,
      raw: this.#mail.raw.path,
      messageId: this.#mail.messageId,
      ...unanswered,
    };
    // The forward happened, or was handed to Cloudflare: a fact that the mind does not take is
    // logged, and changes nothing.
    this.record(
      {
        type: "events.iterate.com/email/forwarded",
        idempotencyKey: emailForwardedKey(this.#mail.raw.path, to),
        payload,
      },
      {
        event: "mail.forwarded-not-recorded",
        message: "a mail was forwarded, and the mind did not take the fact that says so",
        ...payload,
      },
    );
  }

  /** STARTS ONE APPEND OF A FACT OF THE MAIL, awaited in step 7 (`recorded`). A fact that the mind
   *  does not take, or does not answer for in time, is `notRecorded`, logged once. */
  record(
    fact: PlatformFact,
    notRecorded: { event: string; message: string; [field: string]: unknown },
  ) {
    const pending: PendingFact = {
      landed: Promise.resolve()
        .then(() => appendFact(this.#mind, fact))
        .then(
          () => void this.#facts.delete(pending),
          (appendError: unknown) => pending.notRecorded(String(appendError)),
        ),
      notRecorded: (appendError) => {
        if (!this.#facts.delete(pending)) return;
        console.error({ ...notRecorded, namespace: "boundary", appendError });
      },
    };
    this.#facts.add(pending);
  }

  /** Step 7: waits for every append that `record` started, for at most `ms` in all; each one that
   *  has not answered then is its log line. */
  async recorded(ms: number) {
    const until = Date.now() + ms;
    while (this.#facts.size > 0 && Date.now() < until) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([...this.#facts].map((pending) => pending.landed)),
        new Promise((resolve) => (timer = setTimeout(resolve, until - Date.now()))),
      ]).finally(() => clearTimeout(timer));
    }
    for (const pending of [...this.#facts])
      pending.notRecorded(`the mind did not answer within ${ms} ms`);
  }

  /** Step 4: from now on `forward` throws EXPIRED. */
  end() {
    this.#live = false;
  }
}

/** One append of a fact of the mail that has not answered yet. */
type PendingFact = { landed: Promise<void>; notRecorded(appendError: string): void };

/** The stack's `mail.forwardTo`, through the delivery's forward. Its failure is an
 *  `email/forward-failed` fact; only a refusal for another reason than an unproven sender or an
 *  earlier forward fails the delivery. */
async function fixedForward(
  forwarding: MailForward,
  message: ForwardableEmailMessage,
  raw: string,
  forwardTo: string,
) {
  try {
    await forwarding.forward(forwardTo);
  } catch (error) {
    const code = errorCode(error);
    const payload = { to: message.to, forwardTo, messageId: message.headers.get("message-id") };
    // Cloudflare's words as the fact has always given them; the guard's own words bare.
    const words =
      code === "FORWARDED_BEFORE" && error instanceof Error ? error.message : String(error);
    // The fact never changes what becomes of the delivery: an append that the mind refuses is
    // logged. Awaited in step 7, also when the delivery fails.
    forwarding.record(
      {
        type: "events.iterate.com/email/forward-failed",
        idempotencyKey: `email/forward-failed:${raw}:${forwardTo.trim().toLowerCase()}`,
        payload: { ...payload, error: words },
      },
      {
        event: "mail.forward-failed-not-recorded",
        message: "a forward failed, and the mind did not take the fact that says so",
        ...payload,
        error: words,
      },
    );
    if (code === "REFUSED") throw error;
  }
}

/** The hook's two limits (`EMAIL_HOOK_MS`, `FORWARD_ANSWER_MS`) and the facts' (`FACTS_MS`, when
 *  absent); a test passes its own. */
type HookLimits = { hookMs: number; forwardAnswerMs: number; factsMs?: number };

/** The config's `email` hook, under its limits. Nothing it does fails the delivery: a hook that
 *  runs past its own time, or a mind that could not be reached for it, is an `email/hook-failed`
 *  fact, logged when the mind does not take it. The config's clock runs only while no forward
 *  waits for Cloudflare. A forward still in flight when the hook ends (it returned, threw or ran
 *  out of time) is waited for, up to the last deadline; one unanswered then is ONE fact, the
 *  forward's own (`MailForward.giveUp`), and no `timeout`: the config did not overrun. */
async function hook(
  mind: Pick<MindTarget, "email">,
  forwarding: MailForward,
  raw: string,
  { hookMs, forwardAnswerMs }: HookLimits,
  args: Parameters<MindTarget["email"]>[0],
) {
  const deadline = Date.now() + hookMs + forwardAnswerMs;
  type Ended = { why: "timeout" | "unreachable"; error: string } | "gave-up" | null;
  // Step 4: whichever of the three comes first ends the forward in its own callback, before any
  // await of this function's runs again.
  let finish!: (ended: Ended) => void;
  const ending = new Promise<Ended>((resolve) => {
    finish = (ended) => {
      forwarding.end();
      resolve(ended);
    };
  });
  const clock = new HookClock(hookMs, () =>
    finish({ why: "timeout", error: `the hook did not end within ${hookMs} ms of its own` }),
  );
  forwarding.onWaiting = (waiting) => (waiting ? clock.stop() : clock.start());
  forwarding.pastLimits = () => Date.now() >= deadline || clock.spent();
  const last = setTimeout(() => finish("gave-up"), Math.max(0, deadline - Date.now()));
  // step 3
  mind.email(args).then(
    () => finish(null),
    (error: unknown) => finish({ why: "unreachable", error: String(error) }),
  );
  const ended = await ending;
  forwarding.onWaiting = () => {};
  clock.stop();
  clearTimeout(last);
  // step 5
  await forwarding.answered(deadline);
  const unanswered = forwarding.giveUp();
  // step 6
  const failed =
    ended === "gave-up"
      ? unanswered > 0
        ? null
        : {
            why: "timeout" as const,
            error: `the hook and its forwards did not end within ${hookMs + forwardAnswerMs} ms`,
          }
      : ended;
  if (!failed) return;
  const payload = { ...failed, raw };
  forwarding.record(
    {
      type: "events.iterate.com/email/hook-failed",
      idempotencyKey: `email/hook-failed:${failed.why}:${raw}`,
      payload,
    },
    {
      event: "mail.hook-failed-not-recorded",
      message: "the config's email hook failed, and the mind did not take the fact that says so",
      ...payload,
    },
  );
}

/** Where the boundary appends the mail's facts: the mind, and the object that keeps them for a
 *  mind that runs elsewhere and is away. */
type FactsMind = Pick<MindTransport, "append" | "appendOrKeep">;

/** ONE OF THE MAIL'S FACTS, to the mind's email log. Where the mind runs elsewhere, a mind that is
 *  away gets it when it is back (./provided-mind.ts `appendOrKeep`); in the stack's own mind
 *  Worker, an append that fails throws, and its caller logs it. */
function appendFact(mind: FactsMind, fact: PlatformFact) {
  return mind.appendOrKeep ? mind.appendOrKeep(EMAIL_PATH, fact) : mind.append(EMAIL_PATH, [fact]);
}

/** THE CONFIG'S OWN CLOCK: `ranOut` is called when it has run `ms` in all; `stop` and `start`
 *  pause it while a forward waits for Cloudflare. */
class HookClock {
  #left: number;
  #since: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #ranOut: () => void;

  constructor(ms: number, ranOut: () => void) {
    this.#left = ms;
    this.#ranOut = ranOut;
    this.start();
  }

  start() {
    if (this.#since !== undefined) return;
    this.#since = Date.now();
    this.#timer = setTimeout(this.#ranOut, this.#left);
  }

  /** The config's own time has run out by the clock, whether or not the timer has run. */
  spent() {
    return this.#left <= (this.#since === undefined ? 0 : Date.now() - this.#since);
  }

  stop() {
    if (this.#since === undefined) return;
    clearTimeout(this.#timer);
    this.#left = Math.max(0, this.#left - (Date.now() - this.#since));
    this.#since = undefined;
  }
}

async function parseEmail(input: {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array> | ArrayBuffer;
  isMember: (address: string) => Promise<boolean>;
}): Promise<{
  received: ReceivedEmail;
  mail: Omit<ForwardableMail, "canBeForwarded"> & { raw: { path: string } };
}> {
  const raw = new Uint8Array(await new Response(input.raw).arrayBuffer());
  const email = await PostalMime.parse(raw);
  const messageId = bareMessageIdsOf(email.messageId)[0] ?? null;
  // With no Message-ID, the key is the bytes': a redelivery whose bytes changed is another mail.
  const messageKey = (await sha256Hex(messageId || new TextDecoder().decode(raw))).slice(0, 16);
  // The address it reached, percent-encoded but for `@` and `+`: no two addresses share a file, as no
  // two share the fact's idempotency key.
  const recipientName = encodeURIComponent(input.to.toLowerCase())
    .replace(/%40/g, "@")
    .replace(/%2B/g, "+");
  const rawPath = `/email/${messageKey}/${recipientName}.eml`;
  const attachments = email.attachments.map((attachment, index) => {
    const filename = attachment.filename || `attachment-${index + 1}`;
    const content =
      typeof attachment.content === "string"
        ? new TextEncoder().encode(attachment.content)
        : new Uint8Array(attachment.content);
    return {
      filename,
      contentType: attachment.mimeType || "application/octet-stream",
      path: `/email/${messageKey}/${index + 1}-${filename.replace(/[^\w.-]+/g, "_")}`,
      content,
    };
  });
  const { headers, headersTruncated } = rawHeadersOf(raw);
  const replyTo = addressesOf(email.replyTo)[0];
  const from = addressesOf(email.from && [email.from])[0] ?? input.from;
  const { authentication, verified, direct } = authenticationOf(email.headers, from, input.from);
  const member = verified && (await input.isMember(from));
  // Another mind's mail says how many hops its thread has gone between minds. Anyone can write the
  // header, so it counts only on a mail whose sender is proven.
  const hops = verified
    ? mailHopsOf(
        email.headers.find((header) => header.key === MAIL_HOPS_HEADER.toLowerCase())?.value,
      )
    : null;
  const mail = {
    messageId,
    from,
    ...(replyTo && replyTo !== from && { replyTo }),
    to: addressesOf(email.to),
    cc: addressesOf(email.cc),
    subject: email.subject || "",
    text: email.text ? cutBody(email.text) : null,
    html: email.html ? cutBody(email.html) : null,
    inReplyTo: bareMessageIdsOf(email.inReplyTo)[0] ?? null,
    references: bareMessageIdsOf(email.references),
    attachments: attachments.map(({ filename, contentType, path, content }) => ({
      filename,
      contentType,
      size: content.byteLength,
      path,
    })),
    envelope: { from: input.from, to: input.to },
    raw: { path: rawPath, contentType: "message/rfc822", size: raw.byteLength },
    headers,
    headersTruncated,
    sender: { verified, member, direct },
    automated: isAutomated(email.headers, input.from),
    authentication,
    mind: hops ? { hops } : null,
  };
  const received: ReceivedEmail = {
    events: [
      {
        type: "events.iterate.com/email/received",
        idempotencyKey: `email/received:${messageKey}:${input.to.toLowerCase()}`,
        payload: mail,
      },
    ],
    files: [
      { path: rawPath, contentType: "message/rfc822", size: raw.byteLength, data: streamOf(raw) },
      ...attachments.map(({ path, contentType, content }) => ({
        path,
        contentType,
        size: content.byteLength,
        data: streamOf(content),
      })),
    ],
  };
  return { received, mail };
}

// Chunks of at most 1 MiB: over capnweb each chunk is one WebSocket message, in base64, and a message
// is at most 32 MiB.
function streamOf(bytes: Uint8Array) {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(at, (at += 1 << 20)));
    },
  });
}

function bareMessageIdsOf(value: string | undefined) {
  const bracketed = [...(value || "").matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]!);
  return bracketed.length > 0 || !value?.trim() ? bracketed : [value.trim()];
}

function addressesOf(list: Address[] | undefined) {
  return (list || []).flatMap((entry) =>
    (entry.group || [entry]).map((mailbox) => mailbox.address),
  );
}

function cutBody(body: string) {
  return body.length > BODY_MAX_CHARS ? `${body.slice(0, BODY_MAX_CHARS)}\n[truncated]` : body;
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Each field's name as written and its value in JMAP's Raw form (RFC 8621 §4.1.2.1); bytes that are
// not UTF-8 read as U+FFFD.

// With both bodies cut at BODY_MAX_CHARS, an event stays far under the stream's 8 MiB append ceiling.
const HEADERS_MAX_CHARS = 256 * 1024;

// The top fields are the newest: each server prepends its trace fields (RFC 5321 §4.4), its
// Authentication-Results (RFC 8601 §5) and ARC set (RFC 8617 §4.1).
function rawHeadersOf(raw: Uint8Array) {
  const fields: { name: string; value: string }[] = [];
  // A line that starts with a space or tab continues the field above (RFC 5322 §2.2.3).
  const parts = new TextDecoder().decode(raw.subarray(0, headerSectionEnd(raw))).split(/(\r?\n)/);
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    const field = fields.at(-1);
    if (field && /^[ \t]/.test(line)) field.value += parts[index - 1]! + line;
    else if (line) {
      const colon = line.indexOf(":");
      fields.push(
        colon < 0
          ? { name: line, value: "" }
          : { name: line.slice(0, colon).replace(/[ \t]+$/, ""), value: line.slice(colon + 1) },
      );
    }
  }
  const headers: typeof fields = [];
  let chars = 1;
  for (const field of fields) {
    chars += JSON.stringify(field).length + 1;
    if (chars > HEADERS_MAX_CHARS) break;
    headers.push(field);
  }
  return { headers, headersTruncated: headers.length < fields.length };
}

// The header section ends before the first empty line (RFC 5322 §2.1). A bare LF counts.
function headerSectionEnd(raw: Uint8Array) {
  if (raw[0] === 0x0a || (raw[0] === 0x0d && raw[1] === 0x0a)) return 0;
  for (let lf = raw.indexOf(0x0a); lf >= 0; lf = raw.indexOf(0x0a, lf + 1)) {
    const next = raw[lf + 1] === 0x0d ? lf + 2 : lf + 1;
    if (raw[next] === 0x0a) return raw[lf - 1] === 0x0d ? lf - 1 : lf;
  }
  return raw.length;
}

// A sender can forge a record with Cloudflare's authserv-id, so From counts as verified only if every
// such record proves it: a forged pass never outvotes the real verdict.

type Header = { key: string; value: string };

// `verified`: in every record an aligned DKIM or DMARC pass, and one DMARC verdict that is not a
// fail. An SPF pass proves only the envelope's domain, never the From. `direct`: in every record the
// one SPF verdict on the envelope sender is a pass and the envelope domain is aligned, since only
// SPF says the server that handed it over is the From domain's own.
function authenticationOf(headers: Header[], from: string, envelopeFrom: string) {
  const fromDomain = from.slice(from.lastIndexOf("@") + 1).toLowerCase();
  const envelopeDomain = envelopeFrom.slice(envelopeFrom.lastIndexOf("@") + 1).toLowerCase();
  const records = headers
    .filter((header) => header.key === "authentication-results")
    // Each quoted string goes (Cloudflare quotes an IPv6 address), then each comment (RFC 8601 §2.2),
    // so a `)` in a quoted string ends no comment. One that holds a `;` stays: it would span results.
    .map((header) =>
      header.value
        .replace(/"[^"\\;]*"/g, "")
        .replace(/\([^();]*\)/g, " ")
        .split(";"),
    )
    .filter(([authservId]) => /^\s*mx\.cloudflare\.net(?:\s+\d+)?\s*$/i.test(authservId!))
    // A quote, escape or parenthesis left over is text that the sender chose (an envelope address, a
    // HELO name, a DKIM tag) and that is not one whole quoted string or comment. It can end a result
    // or start one, so the record says nothing.
    .map(([, ...results]) => (/["\\()]/.test(results.join(";")) ? [] : results))
    .map((results) =>
      results.flatMap((result) => {
        const [verdict, ...properties] = result.trim().toLowerCase().split(/\s+/);
        const [method, value] = verdict!.split("=");
        if (!method || !value) return [];
        return [
          { method, value, properties: Object.fromEntries(properties.map((p) => p.split("="))) },
        ];
      }),
    );
  const aligned = (domain: string | undefined) =>
    !!domain &&
    (domain === fromDomain ||
      domain.endsWith(`.${fromDomain}`) ||
      fromDomain.endsWith(`.${domain}`));
  // A DKIM verdict for each signature; one DMARC verdict, and one SPF verdict on the envelope sender
  // beside the one on the HELO name. Two where Cloudflare writes one are not its record.
  const proves = (record: (typeof records)[number]) => {
    const dmarc = record.filter((result) => result.method === "dmarc");
    if (dmarc.length > 1 || dmarc[0]?.value === "fail") return false;
    return record.some(
      (result) =>
        result.value === "pass" &&
        ((result.method === "dmarc" && aligned(result.properties["header.from"] || fromDomain)) ||
          (result.method === "dkim" && aligned(result.properties["header.d"]))),
    );
  };
  const isDirect = (record: (typeof records)[number]) => {
    const spf = record.filter(
      (result) => result.method === "spf" && result.properties["smtp.mailfrom"] !== undefined,
    );
    return spf.length === 1 && spf[0]!.value === "pass" && aligned(envelopeDomain);
  };
  const verdictOf = (method: string) => {
    const verdicts = (records[0] ?? []).filter((result) => result.method === method);
    return verdicts.some((result) => result.value === "pass")
      ? "pass"
      : (verdicts[0]?.value ?? null);
  };
  return {
    authentication: { spf: verdictOf("spf"), dkim: verdictOf("dkim"), dmarc: verdictOf("dmarc") },
    verified: !!fromDomain && records.length > 0 && records.every(proves),
    direct: !!fromDomain && records.length > 0 && records.every(isDirect),
  };
}

// Auto-Submitted other than `no` (RFC 3834), bulk or list Precedence, a report, or a bounce.
function isAutomated(headers: Header[], envelopeFrom: string) {
  const valueOf = (key: string) =>
    headers
      .find((header) => header.key === key)
      ?.value.trim()
      .toLowerCase();
  const autoSubmitted = valueOf("auto-submitted");
  return (
    (!!autoSubmitted && autoSubmitted !== "no") ||
    ["bulk", "list", "junk"].includes(valueOf("precedence") ?? "") ||
    !!valueOf("content-type")?.startsWith("multipart/report") ||
    ["", "<>"].includes(envelopeFrom.trim()) ||
    [envelopeFrom, valueOf("from") ?? ""].some((address) =>
      /\b(mailer-daemon|postmaster)@/i.test(address),
    )
  );
}
