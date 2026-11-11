// Pure (binds nothing, calls nobody) and one file, so it can move into the project whole.
import type { ReceivedEmail } from "iterate/workers";
import PostalMime, { type Address } from "postal-mime";

const BODY_MAX_CHARS = 100_000;

export async function parseEmail(input: {
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
  const { authentication, verified, direct } = authenticationOf(email.headers, from);
  const member = verified && (await input.isMember(from));
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

// `verified`: an aligned DMARC pass, DKIM signature or SPF pass in every record. `direct`: an SPF pass
// in every record, since only SPF says the server that handed it over is the From domain's own.
function authenticationOf(headers: Header[], from: string) {
  const fromDomain = from.slice(from.lastIndexOf("@") + 1).toLowerCase();
  const records = headers
    .filter((header) => header.key === "authentication-results")
    .map((header) => header.value.replace(/\([^()]*\)/g, " ").split(";"))
    .filter(([authservId]) => /^\s*mx\.cloudflare\.net(?:\s+\d+)?\s*$/i.test(authservId!))
    .map(([, ...results]) =>
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
  const alignedSpfPass = ({ method, value, properties }: (typeof records)[number][number]) =>
    method === "spf" && value === "pass" && aligned(properties["smtp.mailfrom"]?.split("@").pop());
  const proves = (record: (typeof records)[number]) =>
    record.some(
      (result) =>
        alignedSpfPass(result) ||
        (result.value === "pass" &&
          ((result.method === "dmarc" && aligned(result.properties["header.from"] || fromDomain)) ||
            (result.method === "dkim" && aligned(result.properties["header.d"])))),
    );
  const verdictOf = (method: string) => {
    const verdicts = (records[0] ?? []).filter((result) => result.method === method);
    return verdicts.some((result) => result.value === "pass")
      ? "pass"
      : (verdicts[0]?.value ?? null);
  };
  return {
    authentication: { spf: verdictOf("spf"), dkim: verdictOf("dkim"), dmarc: verdictOf("dmarc") },
    verified: !!fromDomain && records.length > 0 && records.every(proves),
    direct: !!fromDomain && records.length > 0 && records.every((r) => r.some(alignedSpfPass)),
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
