import type { VaultAnswerKind } from "iterate/secret-placeholder";
import { z } from "zod";

export const ApprovalRule = z
  .object({
    methods: z
      .array(z.string().regex(/^[A-Za-z]+$/, "a method is a word, such as POST"))
      .min(1, "name the methods that wait"),
    hosts: z
      .array(
        z.string().regex(/^[A-Za-z0-9.-]+$/, "a host is a hostname, such as gmail.googleapis.com"),
      )
      .min(1, "name the hosts that wait"),
    /** With these, a request to those methods and hosts waits only when its JSON body names one
     *  of them (`ruleMatches`). An API that reads and acts through one address needs it: JMAP
     *  sends a mail with the method `EmailSubmission/set`, and reads with a POST too. */
    jsonStrings: z
      .array(
        z
          .string()
          .regex(
            /^[^\s,]{1,200}$/,
            "a string of the body is 1 to 200 characters with no space or comma, such as EmailSubmission/set",
          ),
      )
      .max(20, "name 20 strings of the body at most")
      .optional(),
  })
  .strict()
  .transform(({ methods, hosts, jsonStrings }) => ({
    methods: [...new Set(methods.map((method) => method.toUpperCase()))].sort(),
    hosts: [...new Set(hosts.map((host) => host.toLowerCase()))].sort(),
    // an empty list is no list: the form sends one when its field is empty
    ...(!!jsonStrings?.length && { jsonStrings: [...new Set(jsonStrings)].sort() }),
  }));
export type ApprovalRule = z.infer<typeof ApprovalRule>;

/** Whether the rule's methods and hosts name the request: all that a rule with no `jsonStrings`
 *  asks, and what is asked before a body is read. */
export function ruleNames(rule: ApprovalRule, method: string, url: string): boolean {
  return rule.methods.includes(method.toUpperCase()) && rule.hosts.includes(new URL(url).hostname);
}

/** WHETHER A REQUEST WAITS. `body` is its body as text (`bodyTextOf`), or null when that is not
 *  known. A rule with `jsonStrings` lets a request go only when this can show that the body names
 *  none of them: the body is JSON, and no string in it, key or value, holds one of them. Every
 *  other body waits, since the host may read a body in a way this does not. */
export function ruleMatches(
  rule: ApprovalRule,
  method: string,
  url: string,
  body: string | null,
): boolean {
  if (!ruleNames(rule, method, url)) return false;
  if (!rule.jsonStrings) return true;
  // an empty body is no JSON either
  if (!body || !isJson(body)) return true;
  const named = rule.jsonStrings.map(comparable);
  // Each string as the text writes it, not as a parser keeps it: of a key written twice a parser
  // keeps one, and the host's may keep the other.
  for (const [written] of body.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    const string = comparable(String(JSON.parse(written)));
    if (named.some((name) => string.includes(name))) return true;
  }
  return false;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** A string as it is compared: letter case, compatibility forms, and characters that are not
 *  seen (controls, zero-width marks) do not make another string of it. */
const comparable = (string: string) =>
  string
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .toLowerCase();

/** A request's body as text for `ruleMatches`: null when it is larger than a held request may be,
 *  or is not UTF-8. Reads a copy, so the request can still be sent. */
export async function bodyTextOf(request: {
  headers: Headers;
  clone(): { arrayBuffer(): Promise<ArrayBuffer> };
}): Promise<string | null> {
  if (Number(request.headers.get("content-length") || 0) > HELD_BODY_LIMIT) return null;
  const bytes = new Uint8Array(await request.clone().arrayBuffer());
  if (bytes.length > HELD_BODY_LIMIT) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Whether `after` holds every request that `before` holds. */
export function isTightening(before: ApprovalRule | null, after: ApprovalRule | null): boolean {
  if (!after) return false;
  if (!before) return true;
  // A string holds every body that a longer string with it inside holds.
  const strings =
    !after.jsonStrings ||
    Boolean(
      before.jsonStrings?.every((was) =>
        after.jsonStrings?.some((now) => comparable(was).includes(comparable(now))),
      ),
    );
  return (
    before.methods.every((method) => after.methods.includes(method)) &&
    before.hosts.every((host) => after.hosts.includes(host)) &&
    strings
  );
}

export const HELD_BODY_LIMIT = 1024 * 1024;

// Headers that change between two tries of one request: left out of the text, and so not sent.
const HOP_HEADER = /^(?:cf-|x-iterate-|x-itx-)|^(?:traceparent|tracestate|content-length)$/;

// The placeholder of the secret stays in it.
export type HeldRequest = {
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
};

export function requestText(request: {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}): string {
  const headers = [...request.headers]
    .filter(([name]) => !HOP_HEADER.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    method: request.method.toUpperCase(),
    url: request.url,
    headers,
    body: request.body,
  } satisfies HeldRequest);
}

export function requestOfText(text: string): Request {
  const held = JSON.parse(text) as HeldRequest;
  const bodyless = held.method === "GET" || held.method === "HEAD";
  return new Request(held.url, {
    method: held.method,
    headers: held.headers,
    ...(!bodyless && held.body && { body: held.body }),
  });
}

export class HeldAnswer extends Error {
  readonly status: number;
  readonly kind: VaultAnswerKind;
  constructor(status: number, kind: VaultAnswerKind, message: string) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}
