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
      .optional()
      // A string of marks that are not seen compares as nothing, and nothing is inside every
      // string: such a rule would read as one that holds more, and would hold a body with no
      // string in it not at all.
      .refine((strings) => (strings || []).every((string) => comparable(string)), {
        error: "a string of the body has a letter, a digit or a sign that is seen",
      }),
    /** A request to a path under one of these never waits, whatever its body (`pathIsFree`). For
     *  a host that takes files at an address of its own: JMAP's upload, whose body is no JSON
     *  and would else always wait. Each starts and ends with `/` and names a folder at least. */
    freePaths: z
      .array(
        z
          .string()
          .regex(
            /^\/(?:(?!\.{1,2}\/)[A-Za-z0-9._~-]+\/)+$/,
            "a path that never waits starts and ends with /, in letters, digits and . _ ~ -, such as /jmap/upload/",
          ),
      )
      .max(10, "name 10 paths that never wait at most")
      .optional(),
  })
  .strict()
  .transform(({ methods, hosts, jsonStrings, freePaths }) => ({
    methods: [...new Set(methods.map((method) => method.toUpperCase()))].sort(),
    hosts: [...new Set(hosts.map((host) => host.toLowerCase()))].sort(),
    // an empty list is no list: the form sends one when its field is empty
    ...(!!jsonStrings?.length && { jsonStrings: [...new Set(jsonStrings)].sort() }),
    ...(!!freePaths?.length && { freePaths: [...new Set(freePaths)].sort() }),
  }));
export type ApprovalRule = z.infer<typeof ApprovalRule>;

/** EVERY METHOD A HOST MAY TAKE THE REQUEST FOR: its own, and one that a header names. Some hosts
 *  (Google's APIs among them) run a POST with `X-HTTP-Method-Override: DELETE` as a DELETE. A rule
 *  that names DELETE holds that POST too. */
export function methodsOf(request: { method: string; headers: Headers }): string[] {
  const named = ["x-http-method-override", "x-http-method", "x-method-override"].flatMap(
    (header) => request.headers.get(header) || [],
  );
  return [request.method, ...named].map((method) => method.trim().toUpperCase());
}

/** Whether the rule's methods and hosts name the request, at a path the rule does not free: all
 *  that a rule with no `jsonStrings` asks, and what is asked before a body is read. `method` is
 *  the request's own, or every method it may be taken for (`methodsOf`). */
export function ruleNames(rule: ApprovalRule, method: string | string[], url: string): boolean {
  return (
    [method].flat().some((one) => rule.methods.includes(one.toUpperCase())) &&
    rule.hosts.includes(new URL(url).hostname) &&
    !pathIsFree(rule.freePaths, url)
  );
}

/** WHETHER A REQUEST GOES TO A PATH THAT NEVER WAITS. Only a path that is written plainly counts,
 *  with no query: letters, digits and `. _ ~ -` between single slashes. The URL's own parser has
 *  resolved `..` by then. A `%`, which a host may read as a `/` or a `.`, and so take the request
 *  to another address than the one read here, makes the path one that waits. */
function pathIsFree(freePaths: readonly string[] | undefined, url: string): boolean {
  if (!freePaths) return false;
  const { pathname, search } = new URL(url);
  if (search || !/^(?:\/[A-Za-z0-9._~-]+)+\/?$/.test(pathname)) return false;
  return freePaths.some((prefix) => pathname.startsWith(prefix));
}

/** WHETHER A REQUEST WAITS. `body` is its body as text (`bodyTextOf`), or null when that is not
 *  known. A rule with `jsonStrings` lets a request go only when this can show that the body names
 *  none of them: the body is JSON, and no string in it, key or value, holds one of them. Every
 *  other body waits, since the host may read a body in a way this does not. */
export function ruleMatches(
  rule: ApprovalRule,
  method: string | string[],
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
 *  seen (controls, zero-width marks) do not make another string of it. A letter written once more
 *  as `\uXXXX` inside the string is that letter: a host that reads the string as a language of its
 *  own (GraphQL in JSON) reads it so. */
const comparable = (string: string) =>
  string
    .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})/gi, (written, braced, plain) => {
      const code = Number.parseInt(braced || plain, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : written;
    })
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
  // A path frees no more than a path above it frees.
  const paths = (after.freePaths || []).every((now) =>
    before.freePaths?.some((was) => now.startsWith(was)),
  );
  return (
    before.methods.every((method) => after.methods.includes(method)) &&
    before.hosts.every((host) => after.hosts.includes(host)) &&
    strings &&
    paths
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
