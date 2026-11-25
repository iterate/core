// Pure (binds nothing, calls nobody) and one file, so it can move into the mind whole.
import { emailForwardedKey } from "iterate/email";
import { codedError, MAIL_HOPS_HEADER, mailHopsOf } from "iterate/lib";
import type { AuthService, ReceivedEmail } from "iterate/workers";
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

/** THE TIME LIMITS OF ONE DELIVERY, side by side. Cloudflare's `message.forward()` answers 3 to
 *  10 s after the call, though its copy arrives in 1 to 2.5 s. THE WHOLE HANDLER takes the receipt
 *  (step 1) and the fixed forward (step 2), which no limit here bounds, PLUS the three.
 *
 *  FORWARD_REQUEST_MS: how long after the receipt the handler stays open for the mind's requests
 *  to forward this mail (step 3). Cloudflare's `forward` works only while this handler is open,
 *  so this is the time that the mind's code has to ask. */
const FORWARD_REQUEST_MS = 10_000;
/** How much longer the boundary waits for Cloudflare's answers to the forwards that were asked
 *  for in time. A forward that is unanswered then is `email/forwarded` with `answered: false`. */
const FORWARD_ANSWER_MS = 20_000;
/** How long, at most, the boundary waits for the appends of the mail's facts after the forwards
 *  have ended, all together. An append that has not answered then is its `mail.*-not-recorded`
 *  log line, and the handler returns: no fact holds it open without a bound. */
const FACTS_MS = 5_000;

/** THE BOUNDARY'S MAIL HANDLER: a mail that Cloudflare delivers, for an address at any zone of the
 *  mind, goes on the mind's log, with what the boundary knows of its sender. No code of the mind's
 *  config runs here: the config gets the mail as the event `email/received`, in `processEvent`.
 *  ONE DELIVERY, IN THIS ORDER (check the code against it):
 *
 *  1. `mind.receiveEmail`: the mind stores the raw `.eml` and each attachment under `/email/`, and
 *     then appends `email/received` on `/integrations/email` as the platform. A failure here
 *     fails the delivery, so Cloudflare delivers the mail again; the mind stores each file once
 *     and takes the same `email/received` once, however often the mail is delivered.
 *  2. With `MAIL_FORWARD_TO` (the stack's `mail.forwardTo`, the older way), the stack's fixed
 *     forward, below, is started. It is not awaited before step 3: Cloudflare takes 3 to 10 s to
 *     answer a forward, and that time must not cost the mind's requests theirs.
 *  3. THE MIND'S REQUESTS TO FORWARD THIS MAIL. Until FORWARD_REQUEST_MS after the receipt, the
 *     handler waits for each `email/forward-requested` on `/integrations/email` that names this
 *     mail's raw file (`mind.emailForwardRequest`), and forwards the original to its address
 *     through Cloudflare's live `message.forward`. WHICH REQUEST COUNTS:
 *      - one that names THIS delivery's mail: its `raw` is the raw path of step 1, and it is on
 *        the log after this mail's `email/received`;
 *      - one that the mind's config wrote, or a member at the root: its stamp's origin is `/`,
 *        which the kernel writes and no writer chooses (core/itx/src/caller.ts `stampCaller`). An
 *        agent's request has its own path there, and gets `email/forward-failed`;
 *      - ONE ATTEMPT for each mail and address, over every delivery of the mail: the mind
 *        claims the pair before it hands the request over, and hands over no request whose pair
 *        is claimed (core/mind-worker/src/integrations/email.ts). So two deliveries of one mail
 *        cannot both forward it, and a request that is read again at a redelivery is not tried
 *        again: its first attempt's fact is its answer. A claim whose handler died before it
 *        called Cloudflare leaves the mail not forwarded, with no fact: at most once, never twice.
 *      - A DELIVERY THAT REUSES A MESSAGE-ID with another message is served no earlier request:
 *        the mind answers the receipt's offset only for the message that the log holds, and a
 *        request authorizes the message that the config read.
 *     A forward is started and not awaited here, so a second request is taken while Cloudflare
 *     answers the first. WHEN THE TIME IS UP, the mind closes the mail's requests with a fact,
 *     `email/forward-requests-closed`, and hands over the requests that are on the log before
 *     it: a request before that fact is served, and one after it never is. So a writer reads on
 *     the log whether its request was in time. A mind that cannot be asked is asked again
 *     while the time lasts; one that could not be asked to the end closed nothing, and that
 *     fails the delivery (below), but for a mind of an older build, which has no such call.
 *  4. The forwards that were started are waited for, up to FORWARD_ANSWER_MS. Each that Cloudflare
 *     answers is `email/forwarded`; each unanswered then is `email/forwarded` with `answered:
 *     false`; each that Cloudflare refuses is `email/forward-failed`, with its words.
 *  5. THE BOOKKEEPING: every append of a fact that this delivery started is awaited, all
 *     together, for at most FACTS_MS. One that has not answered then is its `mail.*-not-recorded`
 *     log line.
 *
 *  THE DELIVERY FAILS ONLY when step 1 fails, when the fixed forward is refused (below), or when
 *  the mind could not be asked for its requests to the end. The last two are said after step 4:
 *  the requests of that delivery are served first, each once, and the next delivery serves the
 *  rest.
 *  Nothing that the mind's code asks for, or fails to ask for, fails a delivery.
 *
 *  ONE `email/received` FOR EACH MAIL holds by the mail's key: its Message-ID and the address it
 *  reached. A mail with no Message-ID is keyed by its bytes (`parseEmail`): delivered again with
 *  another transit header, it is a second mail, with a second raw file.
 *
 *  THE MAIL'S FACTS (`email/forwarded`, `email/forward-failed`) each carry an idempotency key.
 *  For a mind that runs elsewhere and is away, or whose link breaks under the append, the
 *  boundary's `ProvidedMind` keeps each and appends it when the mind is back
 *  (./provided-mind.ts). A fact that the mind refuses, or that the stack's own mind Worker does
 *  not take, is a `mail.*-not-recorded` log line, and changes nothing of the delivery.
 *
 *  THE STACK'S FIXED FORWARD goes through the same `MailForward`, so it records `email/forwarded`,
 *  and a request for the same address then forwards nothing more. It takes the same claim as a
 *  request's forward (`fixedForward`): once for the mail, over every delivery, and a forward
 *  that Cloudflare refused gives the claim back, so the next delivery tries again. Its answer is
 *  waited for as a request's is (step 4): one that Cloudflare has not answered by then fails no
 *  delivery. A forward that fails is
 *  `email/forward-failed`, with Cloudflare's words. A mail whose sender is not proven is kept and
 *  not forwarded, and the delivery stands. Any other failure (an address that is not a verified
 *  destination, or that refuses) fails the delivery too, so its sender gets it back: while it
 *  lasts, every mail to the mind fails for its sender. */
export async function receivedMail(
  message: ForwardableEmailMessage,
  env: { AUTH: Pick<AuthService, "isMember">; MAIL_FORWARD_TO?: string },
  mind: Pick<
    MindTransport,
    "receiveEmail" | "append" | "appendOrKeep" | "emailForwardRequest" | "emailForwardClaim"
  >,
  limits: { requestMs: number; forwardAnswerMs: number; factsMs: number } = {
    requestMs: FORWARD_REQUEST_MS,
    forwardAnswerMs: FORWARD_ANSWER_MS,
    factsMs: FACTS_MS,
  },
) {
  const { received, rawPath, messageId } = await parseEmail({
    from: message.from,
    to: message.to,
    raw: message.raw,
    isMember: (address) => env.AUTH.isMember(address),
  });
  // step 1
  const kept = await mind.receiveEmail(received);
  const requestsUntil = Date.now() + limits.requestMs;
  // `canBeForwarded` is on Cloudflare's message, and not yet in its types (workerd#8290); absent
  // (a local runtime), the forward finds out.
  const { canBeForwarded } = message as ForwardableEmailMessage & { canBeForwarded?: boolean };
  const forwarding = new MailForward(
    message,
    mind,
    { rawPath, messageId, received: kept?.offset },
    canBeForwarded !== false,
  );
  try {
    // step 2
    const fixed = env.MAIL_FORWARD_TO
      ? fixedForward(forwarding, mind, rawPath, env.MAIL_FORWARD_TO, !kept, limits.factsMs)
      : undefined;
    // step 3
    const notAsked = await forwardRequests(forwarding, mind, rawPath, kept?.offset, requestsUntil);
    // step 4
    const answersUntil = Date.now() + limits.forwardAnswerMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refused = await Promise.race([
      fixed,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), limits.forwardAnswerMs);
      }),
    ]).finally(() => clearTimeout(timer));
    await forwarding.answered(answersUntil);
    if (refused) throw refused;
    // A mind of this build (it answered the mail's offset) that could not be asked to the end
    // has not closed the mail's requests: the delivery fails, so that Cloudflare delivers the
    // mail again and that delivery serves them. A mind of an older build has no such call, and
    // its mail must not fail for that.
    if (notAsked && kept) throw notAsked.error;
  } finally {
    forwarding.end();
    // step 5
    await forwarding.recorded(limits.factsMs);
  }
}

/** Step 2: the stack's fixed forward, once for the mail over every delivery of it. It takes the
 *  claim of the mail and the address first, as a request's forward does; a claim that an earlier
 *  delivery or a request holds means that the mail went there, or is going. A forward that
 *  Cloudflare refuses gives the claim back, so that the next delivery tries again, and answers
 *  Cloudflare's error. A claim that cannot be asked for is no claim: Cloudflare is not called,
 *  and the error is answered, which fails the delivery, so that the next one asks again. Only
 *  for a mind of an older build (`olderMind`: it answered no offset for the mail), which has no
 *  such call, the forward goes as it always did. The claim is waited for `claimMs` at most. */
async function fixedForward(
  forwarding: MailForward,
  mind: Pick<MindTransport, "emailForwardClaim">,
  raw: string,
  to: string,
  olderMind: boolean,
  claimMs: number,
): Promise<unknown> {
  // THE CLAIM HAS A BOUND OF ITS OWN, so that a claim call that hangs is never taken for a
  // forward that Cloudflare has not answered yet: no answer in time is an error of the claim,
  // which fails the delivery.
  // this delivery's own word: only the delivery that took a claim gives it back
  const owner = crypto.randomUUID();
  const asked = mind.emailForwardClaim({ raw, to, owner });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let claimed: boolean;
  try {
    claimed = await Promise.race([
      asked,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              codedError(
                "TIMEOUT",
                `the mind did not answer the claim of the forward to ${to} within ${claimMs} ms`,
              ),
            ),
          claimMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (error) {
    // THE CLAIM MAY HAVE LANDED ALL THE SAME (its answer was lost, or comes after the bound), and
    // Cloudflare was not called: so it is given back, at once and again when a late answer
    // comes. The mind gives back only a claim that this delivery took: a claim of another
    // delivery, which may have forwarded, stays. A claim that stays held after that (the release failed too) keeps the mail from
    // this address at the next delivery: at most once, never twice.
    const release = () => mind.emailForwardClaim({ raw, to, owner, release: true });
    // ONE RELEASE AT A TIME: the second starts only when the first has ended, and then finds
    // the owner's row gone or there, never half gone.
    const first = release().catch(() => {});
    void asked
      .then(
        (late) => late,
        () => false,
      )
      .then(async (late) => {
        await first;
        if (late) await release();
      })
      .catch(() => {});
    if (!olderMind) return error;
    claimed = true;
  }
  if (!claimed) return;
  const refused = await forwarding.forward(to);
  if (refused)
    await mind.emailForwardClaim({ raw, to, owner, release: true }).catch((error: unknown) =>
      console.error({
        event: "mail.forward-claim-not-released",
        namespace: "boundary",
        message: "a refused forward keeps its claim, so the next delivery does not try it again",
        raw,
        to,
        error: String(error),
      }),
    );
  return refused;
}

/** Step 3: each request of the mind to forward this mail, until `until`. Nothing here throws. An
 *  ask that fails is made again while the time lasts, half a second later, and once more when it
 *  is up; it answers the last error when the mind could not be asked to the end. */
async function forwardRequests(
  forwarding: MailForward,
  mind: Pick<MindTransport, "emailForwardRequest">,
  raw: string,
  receivedOffset: number | undefined,
  until: number,
) {
  let afterOffset = receivedOffset;
  for (;;) {
    // Asked also when the time is up: the mind then closes the mail's requests on its log, and
    // answers null after the last request that came before that (`emailForwardRequest`).
    const timeoutMs = Math.max(0, until - Date.now());
    let request: Awaited<ReturnType<MindTransport["emailForwardRequest"]>>;
    try {
      request = await mind.emailForwardRequest({ raw, afterOffset, timeoutMs });
    } catch (error) {
      if (timeoutMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, timeoutMs)));
        continue;
      }
      console.error({
        event: "mail.forward-requests-not-read",
        namespace: "boundary",
        message: "the mind could not be asked for its requests to forward a mail",
        raw,
        error: String(error),
      });
      return { error };
    }
    if (!request) return;
    afterOffset = request.offset;
    const to = typeof request.to === "string" ? request.to.trim() : "";
    if (!to) continue;
    if (request.origin !== "/") {
      // Under a key of the request's own: this refusal must not take the place of the fact that
      // answers the config's own request for the same address.
      forwarding.failed(
        to,
        `not forwarded: only the mind's config, at /, asks for a forward, and ${request.origin} asked`,
        `request-${request.offset}`,
      );
      continue;
    }
    // Not awaited: Cloudflare answers in 3 to 10 s, and the next request is taken meanwhile.
    void forwarding.forward(to);
  }
}

/** THE FORWARDS OF ONE DELIVERY, through Cloudflare's live `message.forward`: each sends the
 *  original as it arrived, and ends as a fact on the mind's email log, `email/forwarded` or
 *  `email/forward-failed`. It forwards to an address once: a second call for an address that this
 *  delivery forwarded to, or is forwarding to, does nothing. It refuses an address that the mail's
 *  `X-Forwarded-To` names: an address that leads back here ends at its second visit. Cloudflare
 *  writes one such header line for each forward, the address bare, and keeps the earlier lines
 *  and one that the sender wrote. */
class MailForward {
  #live = true;
  readonly #sent = new Set<string>();
  /** Each forward that Cloudflare has not answered yet, by address. */
  readonly #inFlight = new Map<string, Promise<unknown>>();
  /** The forwards that the boundary gave up on and recorded as unanswered. */
  readonly #unanswered = new Set<string>();
  /** The appends of the mail's facts that this delivery started and that have not answered: each
   *  with the log line that says that it did not land. */
  readonly #facts = new Set<PendingFact>();
  readonly #forwardedBefore: string[];
  readonly #message: ForwardableEmailMessage;
  readonly #mind: FactsMind;
  /** `received`: the offset of the mail's `email/received`, which each fact names. */
  readonly #mail: { rawPath: string; messageId: string | null; received?: number };
  readonly #canBeForwarded: boolean;

  constructor(
    message: ForwardableEmailMessage,
    mind: FactsMind,
    mail: { rawPath: string; messageId: string | null; received?: number },
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

  /** It never throws. It answers Cloudflare's error when Cloudflare refused the forward for
   *  another reason than an unproven sender: the one failure that the stack's fixed forward fails
   *  the delivery for. */
  async forward(to: string): Promise<unknown> {
    const address = to.trim().toLowerCase();
    if (this.#sent.has(address) || this.#inFlight.has(address)) return;
    if (!this.#canBeForwarded)
      return this.failed(
        to,
        "not forwarded: Cloudflare forwards no mail whose sender it did not prove",
      );
    if (this.#forwardedBefore.includes(address)) return this.failed(to, FORWARDED_BEFORE);
    // THE LAST CHECK BEFORE CLOUDFLARE'S CALL, with nothing awaited between them.
    if (!this.#live)
      return this.failed(
        to,
        "not forwarded: the mail's delivery has ended, and with it the message to forward",
      );
    const answer = (async () => this.#message.forward(to))();
    this.#inFlight.set(
      address,
      answer.catch(() => {}),
    );
    try {
      await answer;
    } catch (error) {
      // The fact gives Cloudflare's own words, whole: a reader matches on them.
      const words = String(error);
      if (!this.#unanswered.has(address)) this.failed(to, words);
      return words.includes(NOT_FORWARDABLE) ? undefined : error;
    } finally {
      this.#inFlight.delete(address);
    }
    this.#sent.add(address);
    // The boundary gave up on this answer and recorded that it did not come.
    if (this.#unanswered.has(address)) return;
    this.#recordForwarded(to);
  }

  /** Step 4: waits until Cloudflare has answered every forward in flight, or until `deadline`.
   *  THEN THE BOUNDARY GIVES UP ON THE FORWARDS STILL IN FLIGHT: each is `email/forwarded` with
   *  `answered: false`, under the same key, so that no reader takes the mail for not sent. */
  async answered(deadline: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(this.#inFlight.values()),
      new Promise((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now())))),
    ]).finally(() => clearTimeout(timer));
    for (const [address] of this.#inFlight) {
      this.#unanswered.add(address);
      this.#recordForwarded(address, { answered: false });
    }
  }

  /** `email/forward-failed` for one address, with why. One for each mail and address, and one
   *  more for each `keyed`. */
  failed(forwardTo: string, error: string, keyed?: string): undefined {
    const payload = {
      to: this.#message.to,
      forwardTo,
      messageId: this.#message.headers.get("message-id"),
      raw: this.#mail.rawPath,
      ...(this.#mail.received !== undefined && { received: this.#mail.received }),
    };
    this.#record(
      {
        type: "events.iterate.com/email/forward-failed",
        idempotencyKey: `email/forward-failed:${this.#mail.rawPath}:${forwardTo.trim().toLowerCase()}${keyed ? `:${keyed}` : ""}`,
        payload: { ...payload, error },
      },
      {
        event: "mail.forward-failed-not-recorded",
        message: "a forward failed, and the mind did not take the fact that says so",
        ...payload,
        error,
      },
    );
  }

  #recordForwarded(to: string, unanswered?: { answered: false }) {
    const payload = {
      to,
      raw: this.#mail.rawPath,
      messageId: this.#mail.messageId,
      ...(this.#mail.received !== undefined && { received: this.#mail.received }),
      ...unanswered,
    };
    this.#record(
      {
        type: "events.iterate.com/email/forwarded",
        idempotencyKey: emailForwardedKey(this.#mail.rawPath, to),
        payload,
      },
      {
        event: "mail.forwarded-not-recorded",
        message: "a mail was forwarded, and the mind did not take the fact that says so",
        ...payload,
      },
    );
  }

  /** STARTS ONE APPEND OF A FACT OF THE MAIL, awaited in step 5 (`recorded`). A fact that the mind
   *  does not take, or does not answer for in time, is `notRecorded`, logged once. */
  #record(
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

  /** Step 5: waits for every append that `#record` started, for at most `ms` in all; each one
   *  that has not answered then is its log line. */
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

  /** From now on a forward is `email/forward-failed`: the delivery has ended. */
  end() {
    this.#live = false;
  }
}

/** One append of a fact of the mail that has not answered yet. */
type PendingFact = { landed: Promise<void>; notRecorded(appendError: string): void };

/** Where the boundary appends the mail's facts: the mind, and the object that keeps them for a
 *  mind that runs elsewhere and is away. */
type FactsMind = Pick<MindTransport, "append" | "appendOrKeep">;

/** ONE OF THE MAIL'S FACTS, to the mind's email log. Where the mind runs elsewhere, a mind that is
 *  away gets it when it is back (./provided-mind.ts `appendOrKeep`); in the stack's own mind
 *  Worker, an append that fails throws, and its caller logs it. */
function appendFact(mind: FactsMind, fact: PlatformFact) {
  return mind.appendOrKeep ? mind.appendOrKeep(EMAIL_PATH, fact) : mind.append(EMAIL_PATH, [fact]);
}

async function parseEmail(input: {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array> | ArrayBuffer;
  isMember: (address: string) => Promise<boolean>;
}): Promise<{ received: ReceivedEmail; rawPath: string; messageId: string | null }> {
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
  return { received, rawPath, messageId };
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
