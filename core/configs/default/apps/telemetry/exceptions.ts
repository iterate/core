// exceptions.ts — WHAT BREAKS IN THE MIND, AS EVENTS ON ONE CONTEXT (errors.md). Jonas, 16 Nov
// 2026: the apps' pages and the backend put their errors where a person or an agent opens one
// place and sees what broke. Jonas, 21 Nov 2026: that place is /exceptions, so that a processor
// or an agent can be hung off it.
//
//   /exceptions           events.iterate.com/exception/seen   the backend's, and members' pages'
//   /exceptions/outside   events.iterate.com/exception/seen   the pages' of everyone else, signed in or not
//
// THE ONE RULE OF WHERE, in `exceptionSeen`: a page's error whose sender is no member (the caller
// says it, `member`) lands on /exceptions/outside, cut smaller (`MAX_OUTSIDE`); everything else on
// /exceptions. So /exceptions holds no text from outside: an agent hung off it reads no words of
// anyone. The trust line is a member, never "anyone signed in": anyone can sign in on
// a host that takes people who are not members. The type and the payload are the same on both.
//
// One event type, and `source.from` says who saw it:
//   "page"     the browser, on a page of an app (page-events.ts appends it at once)
//   "handler"  a delivery that failed for good, or a publish that failed (the platform's records)
//   "issue"    what this repo's code reported with `reportIssue`
//   "code"     what this repo's code threw and nothing caught: a throw of its `fetch`, a rejection
//              of a promise handed `this.ctx.waitUntil` (the SDK's `mind/code-failed` on /)
//   "runtime"  what only Cloudflare's runtime saw: a Worker that crashed (crashes.ts, a job each minute)
//
// Two parts are here:
// - `exceptionsEvent`, which worker.ts calls for every event: the two failures the platform
//   records, and what the SDK recorded of this repo's code, become `exception/seen`, and the
//   reported issues that wait are appended. Each of those three is on the context where it
//   happened already; nobody saw it there.
// - `exceptionSeen`: one append to /exceptions or /exceptions/outside, capped. page-events.ts
//   calls it for a page error, crashes.ts for a crash.
//
// THE BOUNDS. A text is cut and scrubbed (`scrub`). A source appends at most 30 events a
// minute, in this isolate, and the outside's page errors of an app are a source apart from the
// members'. A failed append is dropped: nothing here reports its own failure, and
// nothing under /exceptions, /pages or /errors is ever turned into another exception.
import { errorCode, forwardIssues } from "iterate/lib";
import { cut, pathOf } from "./cut.ts";
/* oxlint-disable iterate/simple-truthiness-check -- a payload has no key for what it lacks (errors.md), and a text from a browser or a store may be anything, whatever its declared type */

export const EXCEPTIONS = "/exceptions";
/** The page errors of everyone who is no member: words of anyone. An agent hung off it must be
 *  jailed (errors.md). */
export const OUTSIDE = "/exceptions/outside";
export const EXCEPTION_SEEN = "events.iterate.com/exception/seen";
/** Never a source of an exception: this file's own context and those below it (the crash job's
 *  /exceptions/sweeps), the page events, and the contexts that held errors before 21 Nov 2026
 *  (/errors/pages/<app>, /errors/config, /errors/titler). */
const NEVER_A_SOURCE = [EXCEPTIONS, "/pages", "/errors"];
const DELIVERY_FAILED = "events.iterate.com/itx/subscription-delivery-failed";
export const MAX = { message: 1_024, stack: 4_000, short: 200 } as const;
/** A page error from outside is cut smaller. */
const MAX_OUTSIDE = { message: 300, stack: 1_000 } as const;

export type Itx = {
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/** A text with what must never be kept cut out of it: first every URL-like run cut to its path,
 *  and a `code=`, `state=`, `token=` or bearer token out (./cut.ts, the platform's own rule); then
 *  a basic token, a cookie header's whole value, a `key=` or `password:` and its value, and any
 *  long run of letters and digits that could be a key or a token. The SDK scrubs a
 *  `mind/code-failed` by the same rule (iterate/lib sdk/code-failed.ts). The route of the
 *  platform's own tag does the same but for the cookie header
 *  (core/auth-worker/src/page-events.ts: `scrub(cut(text))`). */
export function scrub(text: unknown, max: number): string {
  // The raw text is cut to twice its bound BEFORE any pattern runs: the URL patterns cost the
  // square of a long run, and a sender chooses the length (64,000 characters cost seconds of CPU;
  // 2,000 cost 5 ms, measured 22 Nov 2026). Text past the bound is never kept anyway.
  // A number is written as text; an object is no text (its `String()` may throw).
  const raw = typeof text === "string" ? text : typeof text === "number" ? String(text) : "";
  return (
    cut(raw.slice(0, 2 * max))
      .replace(/\b(bearer|basic)\s+[^\s"',;)]+/gi, "$1 [cut]")
      // a cookie header's whole value: its cookies are split by `;`, where the next pattern stops
      .replace(/\b((?:set-)?cookie)(["']?\s*[:=]\s*["']?)[^\n"']*/gi, "$1$2[cut]")
      .replace(
        /\b(token|key|secret|password|authorization|cookie)(["']?\s*[:=]\s*["']?)(?!bearer\b|basic\b)[^\s"',;)]+/gi,
        "$1$2[cut]",
      )
      .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[cut]")
      .slice(0, max)
  );
}

/** How many events each source appended in the running minute, in this isolate. */
const spent = new Map<string, { minute: number; count: number }>();
export function allowed(source: string, perMinute = 30): boolean {
  const minute = Math.floor(Date.now() / 60_000);
  const row = spent.get(source);
  if (!row || row.minute !== minute) {
    spent.set(source, { minute, count: 1 });
    return true;
  }
  return (row.count += 1) <= perMinute;
}

/** THE SAME ERROR, WHATEVER BUILD OR MOMENT IT CAME FROM: what an issue is grouped by. A message
 *  loses what changes from one occurrence to the next (an id, a number, a path), and a stack gives
 *  only the file of its top frame, with no version, hash, line or column. */
export function fingerprintOf(parts: {
  from: string;
  site: string;
  kind: string;
  message: string;
  stack?: string;
}): string {
  const message = parts.message
    .split("\n")[0]!
    .slice(0, 200)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\[cut\]|<cut>/g, "<id>")
    .replace(/(?:\/[\w.@~-]+){2,}/g, "<path>")
    .replace(/\b(?=\w*\d)\w{8,}\b/g, "<id>")
    .replace(/\d+/g, "<n>");
  const frame = (parts.stack ?? "").split("\n").find((line) => /^\s*at |@/.test(line)) ?? "";
  const file = (frame.match(/([\w.-]+\.(?:m?[jt]sx?))(?=[:?)]|$)/)?.[1] ?? "").replace(
    /[.-][0-9A-Za-z_]{6,}(?=\.m?[jt]sx?$)/,
    "",
  );
  let h = 0x811c9dc5;
  for (const char of [parts.from, parts.site, parts.kind, message, file].join("\n"))
    h = Math.imul(h ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36).padStart(7, "0");
}

export type Seen = {
  /** What kind of failure: "uncaught", "rejection", "render", "module-load" for a page;
   *  "dead-letter", "publish" for a handler; "issue" for a reported issue; "uncaught" (a throw
   *  of `fetch`), "rejection" (in `waitUntil`) for the code; "uncaught", "cpu-limit",
   *  "memory-limit", "hung", "internal" for the runtime. */
  kind: string;
  message: string;
  stack?: string;
  count?: number;
  firstAt?: string;
  lastAt?: string;
  /** Who saw it, and the code it ran: `from`, then the app or the failure site, then the build. */
  source: {
    from: "page" | "handler" | "issue" | "code" | "runtime";
    app?: string;
    failureSite?: string;
    build?: string;
  };
  where?: Record<string, unknown>;
  actor?: { userId: string; email: string } | null;
  /** A page's error alone: is its sender a member (page-events.ts `memberOf`)? Not a member, or
   *  not said: it lands on /exceptions/outside. */
  member?: boolean;
  /** More of the same shape for one source: the page's visitor, browser and country. */
  more?: Record<string, unknown>;
};

/** Where `exceptionSeen` puts an exception, and how short it cuts its texts. */
function placeOf(seen: Pick<Seen, "source" | "member">) {
  const outside = seen.source.from === "page" && !seen.member;
  return { path: outside ? OUTSIDE : EXCEPTIONS, max: outside ? MAX_OUTSIDE : MAX };
}

/** The fingerprint that `exceptionSeen` gives an exception: of its texts as they are stored. */
export function fingerprintOfSeen(
  seen: Pick<Seen, "kind" | "message" | "stack" | "source" | "member">,
): string {
  const { max } = placeOf(seen);
  const site = seen.source.app ?? seen.source.failureSite ?? "";
  const message = scrub(seen.message, max.message) || "(no message)";
  return fingerprintOf({
    from: seen.source.from,
    site,
    kind: seen.kind,
    message,
    stack: scrub(seen.stack ?? "", max.stack),
  });
}

/** ONE EXCEPTION: a page's error whose sender is no member on /exceptions/outside, cut to
 *  `MAX_OUTSIDE`; everything else on /exceptions. `key` names the occurrence: the same one, sent
 *  again, lands once. It may be a function of the fingerprint (the crash job's key is the kind and
 *  the hour). It answers true when the event is on the log, and false when it is not: the source's
 *  minute is spent, or the append failed. A key that is on the log already counts as on the log,
 *  whatever its event holds: the platform refuses the same key with another body
 *  (IDEMPOTENCY_CONFLICT), and the first one stands. It never throws. */
export async function exceptionSeen(
  itx: Itx,
  key: string | ((fingerprint: string) => string) | undefined,
  seen: Seen,
): Promise<boolean> {
  try {
    const site = seen.source.app ?? seen.source.failureSite ?? "";
    const { path, max } = placeOf(seen);
    // the outside's errors have a minute of their own: a flood from outside never spends the
    // allowance of a member's errors
    if (!allowed(`${seen.source.from}/${site}${path === OUTSIDE ? "/outside" : ""}`)) return false;
    const message = scrub(seen.message, max.message) || "(no message)";
    const stack = scrub(seen.stack ?? "", max.stack);
    const fingerprint = fingerprintOf({
      from: seen.source.from,
      site,
      kind: seen.kind,
      message,
      stack,
    });
    const named = typeof key === "function" ? key(fingerprint) : key;
    await itx.cd(path).append({
      type: EXCEPTION_SEEN,
      ...(named && { idempotencyKey: `exception/seen:${named}` }),
      payload: {
        kind: seen.kind,
        message,
        stack,
        fingerprint,
        count: seen.count ?? 1,
        ...(seen.firstAt && { firstAt: seen.firstAt }),
        ...(seen.lastAt && { lastAt: seen.lastAt }),
        source: seen.source,
        ...(seen.where && { where: seen.where }),
        ...(seen.actor !== undefined && { actor: seen.actor }),
        ...seen.more,
      },
    });
    return true;
  } catch (error) {
    // the key is on the log with another body (a later count of the same hour, say): the first stands
    if (errorCode(error) === "IDEMPOTENCY_CONFLICT") return true;
    // a failed append is dropped: nothing here reports its own failure
    return false;
  }
}

/** What this repo's code reported with `reportIssue`, waiting for the next event's `itx`. */
const reported: {
  failureSite: string;
  message: string;
  stack: string;
  attributes: Record<string, unknown>;
}[] = [];
forwardIssues((issue) => {
  // the SDK's line for a caught rejection in `waitUntil`: its `mind/code-failed` is the exception
  if (reported.length >= 20 || issue.failureSite === "config.wait-until") return;
  const error = issue.caught instanceof Error ? issue.caught : undefined;
  reported.push({
    failureSite: scrub(issue.failureSite, MAX.short),
    message: error?.message ?? String(issue.caught),
    stack: error?.stack ?? "",
    attributes: Object.fromEntries(
      Object.entries(issue.attributes)
        .slice(0, 12)
        .map(([key, value]) => [
          scrub(key, 60),
          typeof value === "string" ? scrub(value, MAX.short) : value,
        ]),
    ),
  });
});

/** For every event of the mind (worker.ts): the two failures the platform records, and what the
 *  SDK recorded of this repo's code on /, become `exception/seen` on /exceptions, and the reported
 *  issues that wait are appended. It never throws, and never acts on an event of a context that
 *  holds exceptions or page events: an exception about an exception would feed itself. */
export async function exceptionsEvent(
  itx: Itx,
  event: { type: string; path: string; offset: number; payload?: unknown },
): Promise<void> {
  try {
    if (NEVER_A_SOURCE.some((path) => event.path === path || event.path.startsWith(`${path}/`)))
      return;
    const failed =
      event.type === DELIVERY_FAILED ||
      event.type === "events.iterate.com/mind/worker-update-failed";
    const codeFailed = event.type === "events.iterate.com/mind/code-failed" && event.path === "/";
    // every other event, with nothing waiting: no call at all
    if (!failed && !codeFailed && reported.length === 0) return;
    for (const issue of reported.splice(0)) {
      const sent = await exceptionSeen(itx, undefined, {
        kind: "issue",
        message: issue.message,
        stack: issue.stack,
        source: { from: "issue", failureSite: issue.failureSite },
        more: { attributes: issue.attributes },
      });
      if (!sent) break;
    }
    // the cast: a payload is JSON, so an object's keys are text; each value is checked where it is read
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (codeFailed) {
      // the config's own code wrote it, through the SDK (iterate/sdk code-failed.ts): its text is
      // data, and a throw of `fetch` can quote what anyone sent. The cast, as the payload's: an
      // object in JSON has text keys, and each value is checked where it is read.
      const error = (payload.error ?? {}) as Record<string, unknown>;
      const where = scrub(payload.where, 20);
      await exceptionSeen(itx, `code:${event.path}@${event.offset}`, {
        kind: where === "waitUntil" ? "rejection" : "uncaught",
        message: String(error.message ?? ""),
        stack: String(error.stack ?? ""),
        source: { from: "code", failureSite: where },
        where: {
          path: event.path,
          type: event.type,
          offset: event.offset,
          errorName: scrub(error.name, MAX.short),
          ...(typeof payload.method === "string" && { method: scrub(payload.method, 20) }),
          ...(typeof payload.path === "string" && { pathname: pathOf(payload.path) }),
        },
      });
      return;
    }
    if (!failed) return;
    const delivery = event.type === DELIVERY_FAILED;
    // the platform's own record, named: a redelivery of it appends nothing
    await exceptionSeen(itx, `handler:${event.path}@${event.offset}`, {
      kind: delivery ? "dead-letter" : "publish",
      message: String(payload.error ?? payload.message ?? ""),
      source: {
        from: "handler",
        failureSite: delivery ? `subscription ${scrub(payload.name, 80)}` : "publish",
        ...(typeof payload.commitOid === "string" && { build: payload.commitOid.slice(0, 40) }),
      },
      // the record itself, and the event whose handling failed
      where: {
        path: event.path,
        type: event.type,
        offset: event.offset,
        ...(typeof payload.offset === "number" && { failedOffset: payload.offset }),
        ...(typeof payload.attempts === "number" && { attempts: payload.attempts }),
      },
    });
  } catch {
    // never the cause of a failed event
  }
}
