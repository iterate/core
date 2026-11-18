// Pure (binds nothing, calls nobody) and one file, so it can move into the mind whole.
import { MAIL_HOPS_HEADER, mailHopsOf } from "iterate/lib";
import type { AuthService, MindTarget, ReceivedEmail } from "iterate/workers";
import PostalMime, { type Address } from "postal-mime";

const BODY_MAX_CHARS = 100_000;

/** THE BOUNDARY'S MAIL HANDLER: a mail that Cloudflare delivers, for an address at any zone of the
 *  mind, goes to the mind, with what the boundary knows of its sender. A failure throws, so
 *  Cloudflare delivers the mail again; the mind takes the same mail once, however often it is
 *  delivered. */
export async function receivedMail(
  message: ForwardableEmailMessage,
  env: { AUTH: Pick<AuthService, "isMember"> },
  mind: Pick<MindTarget, "receiveEmail">,
) {
  await mind.receiveEmail(
    await parseEmail({
      from: message.from,
      to: message.to,
      raw: message.raw,
      isMember: (address) => env.AUTH.isMember(address),
    }),
  );
}

async function parseEmail(input: {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array> | ArrayBuffer;
  isMember: (address: string) => Promise<boolean>;
}): Promise<ReceivedEmail> {
  const raw = new Uint8Array(await new Response(input.raw).arrayBuffer());
  const email = await PostalMime.parse(raw);
  const messageId = bareMessageIdsOf(email.messageId)[0] ?? null;
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
  return {
    events: [
      {
        type: "events.iterate.com/email/received",
        idempotencyKey: `email/received:${messageKey}:${input.to.toLowerCase()}`,
        payload: {
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
        },
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
