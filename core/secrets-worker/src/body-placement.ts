// A SECRET IN A JSON BODY (iterate/api `SecretUses.bodyFields`).
//
// WHERE: only in a request with the method and the exact URL of one of the secret's body fields,
// and only at that field. Without that bound, the value could go into any field of any endpoint
// of a pinned host, and a host keeps and shows many of its fields: the mind's code, or a
// stranger's words that became a field, would put the secret where another request reads it.
// The secret's maker names the fields when the value is given, the person who gives it reads
// them (./callback-page.ts `useLines`), and they are sealed with the value
// (./secret-at-rest.ts), so nothing adds one later.
//
// HOW: the body is parsed, the field is set, and the body is written again, under the one JSON
// content type that the caller named. So the value is in no other place of what leaves, and what
// leaves has no key twice and one type: every host reads it the same way. Of a key that the
// caller wrote twice the last one stays, a number that a double does not hold exactly changes,
// and one beyond a double's range leaves as `null`.
//
// WHAT IS FILLED: a field whose whole value is one placeholder of the secret. A request with that
// method to that URL that has none at such a field is refused: it is one that fills. No other
// string of the body is read: a placeholder there is text, as in every body.
//
// WHAT THIS USE DOES NOT PROMISE: a host keeps a field that it is sent, and may show it again, to
// a request with this secret or with another one of the same host. No answer is read for the
// value: a filter would stop the mind's code only until it asked through the other secret, or
// for another spelling. What holds is the bound above, the words that the person reads who
// gives the value, and, where the secret has an approval rule, a member's approval of every
// request whose body is filled (./secret/durable-object.ts `fetch`).
import type { SecretBodyField } from "iterate/api";
import { SECRET_PLACEHOLDER } from "iterate/secret-placeholder";
import { HELD_BODY_LIMIT, type HeldFills, methodsOf } from "./approval.ts";
import { isRecord, SecretRefused, type SecretResolver, secretValueOf } from "./secrets.ts";

/** THE FIELDS OF A REQUEST'S BODY THAT A SECRET FILLS: those of its body fields whose method and
 *  URL are the request's. The URL is compared as written, less a fragment, which is not sent: a
 *  query, or a path that a host may read another way, matches none. Every method that a host may
 *  take the request for is that method (./approval.ts `methodsOf`). Empty: the body is not the
 *  secrets Worker's to read, and leaves as written, with no value in it. */
export const fieldsToFill = (
  bodyFields: readonly SecretBodyField[] | undefined,
  request: { method: string; url: string; headers: Headers },
): string[] =>
  (bodyFields || [])
    .filter(
      ({ method, url }) =>
        request.url.split("#")[0] === url && methodsOf(request).every((taken) => taken === method),
    )
    .map(({ field }) => field);

/** WHETHER A REQUEST CAN LEAVE AS IT WAS READ. `meant`: what its first read found for the secret
 *  to fill in its body, or what it was held with (./approval.ts `HeldRequest.fills`); none for a
 *  request that filled nothing. `version` and `toFill` (`fieldsToFill`) are the secret's now. A
 *  request leaves with those fields from that version of the secret, or with none from a secret
 *  that names none for it. A secret that was given again since has another version and may name
 *  other fields: what would go into the body now is not what was read, or what a member
 *  approved. One rule for the request that is sent and for the request that still waits
 *  (./secret/durable-object.ts `fetch`, `#heldRows`). */
export const leavesAsRead = (
  meant: HeldFills | undefined,
  version: number | undefined,
  toFill: readonly string[],
): boolean => (meant ? meant.version === version : !toFill.length);

/** THE BODY OF A REQUEST THAT FILLS, parsed, and the places in it that are filled: those of
 *  `fields` (`fieldsToFill`) whose whole value is one placeholder. `headers` are the request's as
 *  written. `text` is its body: "" for none, null for one that is too large or is no UTF-8
 *  (`textOf`). Throws `SecretRefused` for a request with no place to fill: no body, a body that
 *  is no JSON by its type or by its text, and none of the fields with a placeholder. The same
 *  check runs when the request arrives, before a member is asked about it
 *  (./secret/durable-object.ts `fetch`), and when it leaves (`withBodyFilled`). It does not ask
 *  what the placeholder names: another secret's, or a field that the secret does not give out,
 *  is refused when the value is read, as the request leaves. */
export function bodyToFill(headers: Headers, text: string | null, fields: readonly string[]) {
  const refused = (reason: string) =>
    new SecretRefused(
      `itx.fetch: ${reason}. A request with this method to this URL puts the secret into its body: the body is JSON (content-type: application/json, UTF-8, at most ${HELD_BODY_LIMIT / 1024 / 1024} MiB) with the placeholder as the whole string value of ${fields.join(" or ")}.`,
    );
  // oxlint-disable-next-line iterate/simple-truthiness-check -- null is a body that could not be read, and "" is no body: each has its own refusal
  if (text === null) throw refused("this body is too large, or is no UTF-8 text");
  if (!text) throw refused("this request has no body");
  const type = headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!/^application\/(?:[\w.-]+\+)?json$/i.test(type))
    throw refused("the content type of this body is not JSON");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw refused("this body is no JSON");
  }
  const places = fields.flatMap((field) => {
    const keys = field.split(".");
    const key = keys.pop() ?? "";
    // Own keys of objects alone: no place in a list, and nothing that an object inherits. A key
    // named `__proto__` or `constructor` is a key like any other: the parse made it the body's
    // own, and what is set below is that own key.
    let parent = json;
    for (const step of keys)
      parent = isRecord(parent) && Object.hasOwn(parent, step) ? parent[step] : undefined;
    const value = isRecord(parent) && Object.hasOwn(parent, key) ? parent[key] : undefined;
    if (!isRecord(parent) || typeof value !== "string") return [];
    const [match, ...more] = value.matchAll(SECRET_PLACEHOLDER);
    return match && !more.length && match[0].length === value.length
      ? [{ field, parent, key, match }]
      : [];
  });
  if (!places.length) throw refused("this body has no placeholder there");
  return { type, json, places };
}

/** `request` AS IT LEAVES, WITH `fields` OF ITS JSON BODY FILLED (`fieldsToFill`). A request that
 *  cannot be filled is refused (`bodyToFill`), and nothing leaves. `request` is used up: the
 *  answer is what to send. */
export async function withBodyFilled(
  request: Request,
  fields: readonly string[],
  resolve: SecretResolver,
): Promise<Request> {
  const { type, json, places } = bodyToFill(request.headers, await textOf(request.body), fields);
  for (const { parent, key, match } of places)
    parent[key] = await secretValueOf(match, "the request body", request.url, resolve);
  const headers = new Headers(request.headers);
  // it counted the body as the caller wrote it
  headers.delete("content-length");
  // The body is this Worker's text, so its type is this Worker's word: the one JSON type that the
  // caller named, with no parameter and no second type. A host cannot be told to read these
  // bytes as a form, or in another charset.
  headers.set("content-type", type);
  // A request whose body was read gives a new one its URL, method and headers, and the body is
  // the one named here: workerd and the Fetch standard both take it so.
  return new Request(request, { headers, body: JSON.stringify(json) });
}

/** A body as text: "" for none, and null for one that is larger than a held request may be or is
 *  no UTF-8. The read stops at the limit, so a body with no end is never kept in the object's
 *  memory. */
export async function textOf(body: ReadableStream<Uint8Array> | null): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  // leaving the loop cancels the body
  for await (const chunk of body || []) {
    size += chunk.byteLength;
    if (size > HELD_BODY_LIMIT) return null;
    chunks.push(chunk);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await new Blob(chunks).arrayBuffer(),
    );
  } catch {
    return null;
  }
}
