// sdk/code-failed.ts — WHAT A CONFIG'S OWN CODE THREW, AS ONE FACT ON `/`
// (`events.iterate.com/mind/code-failed`): a throw or rejection of its `fetch`, and a rejection of
// a promise that it handed `this.ctx.waitUntil`. index.ts `IterateConfigEntrypoint` catches both
// in the config's own isolate and appends the fact through the config's own `getItx()`. A loaded
// isolate's console never reaches Workers Logs, so this fact is the one record of either. It is
// the config's code that appends it, not the platform: its text is data.
//
// THE PAYLOAD: `{ where, method?, path?, error: { name, message, stack? } }`. A request gives its
// method and its URL's path alone: no host, query string, header or body. Every text is scrubbed
// BEFORE the first append, as the template scrubs its copy on /exceptions: an error can quote a
// URL with a token in it, and the root log keeps what it is given.
//
// THE BOUNDS: one fact for each kind of error in a UTC minute, the kind a fingerprint of `where`,
// the error's name and the first line of its scrubbed message (so a new token in each message is
// no new kind). The idempotency key is the kind and the minute, so all the isolates of a mind
// together write one. One isolate sends at most 30 a minute.

import { errorCode } from "../lib.ts";
import type { StreamEventInput } from "../stream/processor.ts";
import { cut, pathOf } from "./cut.ts";

export type CodeFailedWhere = "fetch" | "waitUntil";

/** The kinds this isolate sent a fact for in `minute`. */
let sent = { minute: -1, kinds: new Set<string>() };

/** The fact of `caught`, or undefined when this isolate sent one of its kind in this minute, or
 *  sent 30, or when `caught` is a refusal at the loop limit: that is an outcome the kernel
 *  records (a 508), no failure of this code, and an append under the same cause only deepens the
 *  chain. It never throws on what `caught` holds. */
export function codeFailedFact(
  where: CodeFailedWhere,
  caught: unknown,
  request?: Request,
): StreamEventInput | undefined {
  if (isLoopLimit(caught)) return undefined;
  const minute = Math.floor(Date.now() / 60_000);
  if (sent.minute !== minute) sent = { minute, kinds: new Set() };
  const error = boundedError(caught);
  const kind = fingerprintOf(`${where}\n${error.name}\n${error.message.split("\n")[0]}`);
  if (sent.kinds.has(kind) || sent.kinds.size >= 30) return undefined;
  sent.kinds.add(kind);
  return {
    type: "events.iterate.com/mind/code-failed",
    // not a platform key (core/itx caller.ts `refusePlatformIdempotencyKeys`): loaded code writes it
    idempotencyKey: `code-failed:${kind}:${minute}`,
    payload: {
      where,
      ...(request && {
        method: request.method.slice(0, 20),
        // a segment that looks like an id or a token is `<id>`, at most 200 characters
        path: pathOf(new URL(request.url).pathname),
      }),
      error,
    },
  };
}

/** The thrown value's name, message and stack, scrubbed and cut; an arbitrary object is never
 *  walked, as in `reportIssue` (../lib.ts). It never throws: a value whose getters throw is
 *  `UnreadableThrown`. */
function boundedError(caught: unknown): { name: string; message: string; stack?: string } {
  try {
    if (caught instanceof Error)
      return {
        name: scrubbed(String(caught.name || "Error"), 100),
        message: scrubbed(String(caught.message), 1_024),
        ...(caught.stack && { stack: scrubbed(String(caught.stack), 4_000) }),
      };
    if (typeof caught === "object" && caught) return { name: "ObjectThrown", message: "" };
    return { name: `${typeof caught}Thrown`, message: scrubbed(String(caught), 1_024) };
  } catch {
    return { name: "UnreadableThrown", message: "" };
  }
}

/** `caught` as an Error whose name, message and stack are the fact's, scrubbed and cut: what a
 *  `reportIssue` line of it may print and forward. It has no `code`: ../lib.ts `ErrorCode` is a
 *  type alone, so nothing at run time can tell a platform code from text that a config's code put
 *  there. It never throws. */
export function scrubbedError(caught: unknown): Error {
  const { name, message, stack } = boundedError(caught);
  return Object.assign(new Error(message), { name, stack: stack || `${name}: ${message}` });
}

/** Whether `caught` is the kernel's refusal at the loop limit; a `code` getter that throws makes
 *  it none. */
function isLoopLimit(caught: unknown): boolean {
  try {
    return errorCode(caught) === "LOOP_LIMIT";
  } catch {
    return false;
  }
}

/** `text` without what must never be kept, at most `max` characters: every URL cut to its path,
 *  and a code, state, token or bearer token out (./cut.ts); then a basic token, a cookie header's
 *  whole value (its cookies are split by `;`), a `key=` or `password:` and its value, and any
 *  long run of letters and digits, as the template's `scrub`
 *  (core/configs/default/apps/telemetry/exceptions.ts). The raw text is cut to twice `max` before
 *  any pattern runs: the URL patterns cost the square of a long run. */
function scrubbed(text: string, max: number): string {
  return cut(text.slice(0, 2 * max))
    .replace(/\b(bearer|basic)\s+[^\s"',;)]+/gi, "$1 [cut]")
    .replace(/\b((?:set-)?cookie)(["']?\s*[:=]\s*["']?)[^\n"']*/gi, "$1$2[cut]")
    .replace(
      /\b(token|key|secret|password|authorization|cookie)(["']?\s*[:=]\s*["']?)(?!bearer\b|basic\b)[^\s"',;)]+/gi,
      "$1$2[cut]",
    )
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[cut]")
    .slice(0, max);
}

/** FNV-1a of `text`, in base 36. */
function fingerprintOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++)
    hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193) >>> 0;
  return hash.toString(36);
}
