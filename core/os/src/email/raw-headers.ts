// src/email/raw-headers.ts — AN INBOUND MESSAGE'S HEADER FIELDS AS IT CARRIES THEM: the pure read of
// its bytes behind `email/received`'s `headers`, which iterate/email describes (each field's name as
// written and its value in JMAP's Raw form, RFC 8621 4.1.2.1:
// https://www.rfc-editor.org/rfc/rfc8621#section-4.1.2.1). Bytes that are not UTF-8 read as U+FFFD,
// as JMAP's do; the message's project file keeps the bytes themselves.

/** The most of `headers` one event carries, in serialized JSON characters. Ordinary header sections
 *  run to tens of KB, so they stay whole; with both bodies at their 100,000-character cut the event
 *  stays far under the stream's 8 MiB append ceiling (stream.ts `EVENT_BODY_MAX_CHARS`). */
export const HEADERS_MAX_CHARS = 256 * 1024;

/** `raw`'s header fields in order, duplicates kept: whole fields from the top while they fit in
 *  HEADERS_MAX_CHARS, and `headersTruncated` when some did not. The top fields are the newest:
 *  each server that handles a message prepends its trace fields (RFC 5321 4.4), its
 *  Authentication-Results (RFC 8601 5) and its ARC set (RFC 8617 4.1), so the ones Cloudflare
 *  added as it received the message come first. */
export function rawHeadersOf(raw: Uint8Array) {
  const fields: { name: string; value: string }[] = [];
  // [line, line break, line, …]: a line that starts with a space or tab continues the field above
  // it (RFC 5322 2.2.3), and the value keeps that fold as it is.
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
  // the kept fields' JSON array: each field and a comma, and the brackets less the last comma
  let chars = 1;
  for (const field of fields) {
    chars += JSON.stringify(field).length + 1;
    if (chars > HEADERS_MAX_CHARS) break;
    headers.push(field);
  }
  return { headers, headersTruncated: headers.length < fields.length };
}

/** Where the header section ends: at the line break before the first empty line (RFC 5322 2.1), or
 *  at the end of a message with no body. A bare LF counts as a line break. */
function headerSectionEnd(raw: Uint8Array) {
  if (raw[0] === 0x0a || (raw[0] === 0x0d && raw[1] === 0x0a)) return 0;
  for (let lf = raw.indexOf(0x0a); lf >= 0; lf = raw.indexOf(0x0a, lf + 1)) {
    const next = raw[lf + 1] === 0x0d ? lf + 2 : lf + 1;
    if (raw[next] === 0x0a) return raw[lf - 1] === 0x0d ? lf - 1 : lf;
  }
  return raw.length;
}
