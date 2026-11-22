// page-events.ts — `POST /.page-events` ON THE CONTROL-PLANE HOSTNAME: what core's page tag
// (./page-tag.ts) sends from a tagged page, recorded in the mind's log. The auth Worker keeps
// nothing: the answer is a 204 that carries the records as facts (iterate/facts `withFacts`), and
// the boundary appends them.
//
//   /pages                events.iterate.com/page/viewed      a page load
//                         events.iterate.com/page/left        how long it was open and seen, how far scrolled
//   /exceptions           events.iterate.com/exception/seen   what broke in a member's page
//   /exceptions/outside   events.iterate.com/exception/seen   what broke in anyone else's page
//
// The payloads have the shapes of the mind's own page tag for its apps, with `app` the host's first
// label (`iterate`) and `source: { from: "page", app }` on an exception.
//
// WHO SENT IT is this Worker's word, never the page's: the browser's session (./cookies.ts
// `personSessionOf`) and whether it acts as a member (./members.ts `isMemberSession`), the check
// that `/` makes. The trust line is a member: anyone else, signed in or not, is OUTSIDE, with the
// smaller bounds and texts, and their errors land apart.
//
// THE BOUNDS: this origin's own page alone (403), POST alone (405), 16,000 bytes (413), a JSON
// object with a page id and at most 20 records (400). Each minute, in this isolate: 120 records
// from members and 30 from everyone else, and 30 errors of all. A record over a bound is dropped,
// and the answer stays 204. Every text is cut, and a URL in a message, a stack or a path keeps
// its path alone (./page-tag.ts `cut`); a page's text is data, never an instruction. `Origin`
// stops a browser alone, and a script can send from many isolates at once: so the records from
// outside also have THE DAY'S BUDGET FOR THE WHOLE MIND (`outsideReserved`), 5,000 a day,
// reserved in this Worker's D1 for each batch before it lands. A flood ends by itself, with no
// person.
import { withFacts, type Facts } from "iterate/facts";
import type { StreamEventInput } from "iterate/stream/processor";
import { z } from "zod";
import { personSessionOf } from "./cookies.ts";
import type { Env } from "./env.ts";
import { isMemberSession } from "./members.ts";
import { cut, PAGE_EVENTS_PATH, pathOf } from "./page-tag.ts";

export const PAGE_VIEWED = "events.iterate.com/page/viewed";
export const PAGE_LEFT = "events.iterate.com/page/left";
export const EXCEPTION_SEEN = "events.iterate.com/exception/seen";
/** A minute's bounds, in this isolate. */
export const BOUNDS = { member: 120, outside: 30, errors: 30 } as const;
/** The texts an exception keeps: the outside's are smaller. */
const TEXTS = {
  member: { message: 1_024, stack: 4_000, title: 120 },
  outside: { message: 300, stack: 1_000, title: 80 },
} as const;

/** THE DAY'S BUDGET of the records from outside, for the whole mind. */
export const OUTSIDE_A_DAY = 5_000;

/** Who sent a page's records, as this Worker's own session check says. */
export type Sender = { actor: { userId: string; email: string } | null; member: boolean };

const whole = (most: number) =>
  z.number().transform((value) => Math.min(Math.max(Math.round(value), 0), most));
/** A text the page sent: a string, else nothing. An object never reaches `String()`. */
const text = z.string().optional().catch(undefined);
const PageRecord = z.object({
  type: z.enum(["viewed", "left", "error"]),
  n: whole(1_000_000).catch(0),
  pathname: text,
  at: text,
  openMs: whole(86_400_000).optional().catch(undefined),
  seenMs: whole(86_400_000).optional().catch(undefined),
  scrolled: z.number().int().min(0).max(100).optional().catch(undefined),
  kind: z.enum(["uncaught", "rejection"]).catch("uncaught"),
  message: text,
  stack: text,
});
const Sent = z.object({
  page: z.object({
    id: z.string().regex(/^[a-z0-9]{8,32}$/i),
    title: text,
    screen: z
      .tuple([whole(100_000), whole(100_000)])
      .optional()
      .catch(undefined),
    viewport: z
      .tuple([whole(100_000), whole(100_000)])
      .optional()
      .catch(undefined),
    language: text,
    timezone: text,
    timezoneOffset: z.number().int().min(-900).max(900).optional().catch(undefined),
  }),
  // at most 20 records a send
  events: z.array(z.unknown()).max(20),
});

/** A text with what must never be kept cut out of it: a URL's query string and hash, a bearer
 *  token, and any long run of letters and digits that could be a key or a token. */
function scrub(text: string | undefined, most: number): string {
  return (text || "")
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/[^\s?#"')]+)[?#][^\s"')]*?((?::\d+){0,2})(?=[\s"')]|$)/gi,
      "$1$2",
    )
    .replace(/\b(bearer|basic)\s+[^\s"',;)]+/gi, "$1 [cut]")
    .replace(
      /\b(token|key|secret|password|authorization|cookie)(["']?\s*[:=]\s*["']?)(?!bearer\b|basic\b)[^\s"',;)]+/gi,
      "$1$2[cut]",
    )
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[cut]")
    .slice(0, most);
}

/** THE SAME ERROR, WHATEVER MOMENT IT CAME FROM, as the mind's own page tag groups it: the
 *  message's first line with its ids, numbers and paths out, and the file of the stack's top frame
 *  with no version, hash, line or column. */
function fingerprintOf(parts: { app: string; kind: string; message: string; stack: string }) {
  const message = parts.message
    .split("\n")[0]!
    .slice(0, 200)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\[cut\]|<cut>/g, "<id>")
    .replace(/(?:\/[\w.@~-]+){2,}/g, "<path>")
    .replace(/\b(?=\w*\d)\w{8,}\b/g, "<id>")
    .replace(/\d+/g, "<n>");
  const frame = parts.stack.split("\n").find((line) => /^\s*at |@/.test(line)) ?? "";
  const file = (frame.match(/([\w.-]+\.(?:m?[jt]sx?))(?=[:?)]|$)/)?.[1] ?? "").replace(
    /[.-][0-9A-Za-z_]{6,}(?=\.m?[jt]sx?$)/,
    "",
  );
  let h = 0x811c9dc5;
  for (const char of ["page", parts.app, parts.kind, message, file].join("\n"))
    h = Math.imul(h ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36).padStart(7, "0");
}

// ── the minute's bounds, in this isolate ──
let minute = -1;
const spent = { member: 0, outside: 0, errors: 0 };
/** May one more record land in this minute? It counts the record when it may. */
function within(who: "member" | "outside", error: boolean): boolean {
  const now = Math.floor(Date.now() / 60_000);
  if (now !== minute) ((minute = now), (spent.member = 0), (spent.outside = 0), (spent.errors = 0));
  if (spent[who] >= BOUNDS[who] || (error && spent.errors >= BOUNDS.errors)) return false;
  spent[who] += 1;
  if (error) spent.errors += 1;
  return true;
}
/** For the tests: a new minute. */
export function resetBounds(): void {
  minute = -1;
}

/** THE HOST'S FIRST LABEL: `iterate` for `iterate.example.com`. */
const appOf = (hostname: string) => hostname.split(".")[0]!.slice(0, 40);

/** WHERE CLOUDFLARE PUTS THE ADDRESS, from `request.cf`: each key only with a value, latitude and
 *  longitude with 2 decimals. Never the address. Null when Cloudflare says nothing. */
const Cf = z
  .object({
    country: z.string().optional(),
    region: z.string().optional(),
    regionCode: z.string().optional(),
    city: z.string().optional(),
    postalCode: z.string().optional(),
    continent: z.string().optional(),
    timezone: z.string().optional(),
    latitude: z.union([z.string(), z.number()]).optional(),
    longitude: z.union([z.string(), z.number()]).optional(),
  })
  .catch({});
function whereOf(request: Request) {
  const cf = Cf.parse((request as { cf?: unknown }).cf ?? {});
  const place: Record<string, string | number> = {};
  for (const key of [
    "region",
    "regionCode",
    "city",
    "postalCode",
    "continent",
    "timezone",
  ] as const)
    if (cf[key]) place[key] = scrub(cf[key], 80);
  for (const [key, most] of [
    ["latitude", 90],
    ["longitude", 180],
  ] as const) {
    const value = Number(cf[key] ?? NaN);
    if (Number.isFinite(value) && Math.abs(value) <= most)
      place[key] = Math.round(value * 100) / 100;
  }
  return {
    country: (cf.country || "").slice(0, 2),
    ...(Object.keys(place).length > 0 && { place }),
  };
}

/** A time the page wrote, when it is one; else the server's. */
const when = (value: string | undefined) =>
  value && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(value)
    ? value
    : new Date().toISOString();

/** THE FACTS OF ONE SEND: the page events on /pages, an error on /exceptions for a member and on
 *  /exceptions/outside for anyone else. A record that is no record, or one over a bound, is left
 *  out. */
function pageFacts(request: Request, sent: z.infer<typeof Sent>, sender: Sender): Facts {
  const url = new URL(request.url);
  const app = appOf(url.hostname);
  const who = sender.member ? "member" : "outside";
  const texts = TEXTS[who];
  const { page } = sent;
  const userAgent = request.headers.get("user-agent") || "";
  const common = {
    app,
    host: url.hostname,
    page: page.id,
    view: 1,
    visitor: null,
    actor: sender.actor,
    ...(sender.member && { member: true }),
    ...whereOf(request),
    ...(userAgent && { userAgent: scrub(userAgent, 256) }),
  };
  const pages: StreamEventInput[] = [];
  const exceptions: StreamEventInput[] = [];
  for (const raw of sent.events) {
    const parsed = PageRecord.safeParse(raw);
    if (!parsed.success) continue;
    const record = parsed.data;
    const error = record.type === "error";
    if (!within(who, error)) continue;
    const pathname = cut(pathOf(record.pathname));
    const at = when(record.at);
    if (record.type === "viewed")
      pages.push({
        type: PAGE_VIEWED,
        idempotencyKey: `page/viewed:${page.id}:${record.n}`,
        payload: {
          ...common,
          pathname,
          at,
          how: "load",
          title: scrub(cut(page.title), texts.title),
          screen: page.screen,
          viewport: page.viewport,
          language: scrub(page.language, 20),
          timezone: scrub(page.timezone, 40),
          timezoneOffset: page.timezoneOffset,
        },
      });
    if (record.type === "left")
      pages.push({
        type: PAGE_LEFT,
        idempotencyKey: `page/left:${page.id}:${record.n}`,
        payload: {
          ...common,
          pathname,
          at,
          openMs: record.openMs ?? 0,
          seenMs: record.seenMs ?? 0,
          scrolled: record.scrolled,
        },
      });
    if (error) {
      const message = scrub(cut(record.message), texts.message) || "(no message)";
      const stack = scrub(cut(record.stack), texts.stack);
      exceptions.push({
        type: EXCEPTION_SEEN,
        idempotencyKey: `exception/seen:page:${app}:${page.id}-${record.n}`,
        payload: {
          kind: record.kind,
          message,
          stack,
          fingerprint: fingerprintOf({ app, kind: record.kind, message, stack }),
          count: 1,
          firstAt: at,
          lastAt: at,
          source: { from: "page", app },
          where: { pathname },
          ...common,
        },
      });
    }
  }
  return [
    ...(pages.length ? [{ path: "/pages", events: pages }] : []),
    ...(exceptions.length
      ? [{ path: sender.member ? "/exceptions" : "/exceptions/outside", events: exceptions }]
      : []),
  ];
}

/** The body's bytes, or null when it holds more than `most`. It stops reading there. */
async function bodyOf(request: Request, most: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length")) > most) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > most) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

/** WHO SENT IT: the browser's session, and whether it acts as a member. */
export async function senderOf(env: Env, request: Request): Promise<Sender> {
  const session = await personSessionOf(env, request);
  if (!session) return { actor: null, member: false };
  return {
    actor: { userId: session.userId, email: session.email },
    member: await isMemberSession(env, session),
  };
}

/** `POST /.page-events`, or null for any other path. `sender` is asked only after the checks.
 *  `reserve` holds the day's budget of the outside (`outsideReserved`). Nothing here throws: a
 *  body that cannot be read is a 400, a sender or a budget that cannot be asked a 503, each with
 *  no facts. The `Referer` header is never read. */
export async function pageEventsResponse(
  request: Request,
  sender: () => Promise<Sender>,
  reserve: (records: number) => Promise<boolean>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PAGE_EVENTS_PATH) return null;
  const done = (status: number, headers: Record<string, string> = {}) =>
    new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });
  if (request.method !== "POST") return done(405, { allow: "POST" });
  // this origin's own page alone: a browser names the origin of every POST
  if (request.headers.get("origin") !== url.origin) return done(403);
  let body: Uint8Array | null;
  try {
    body = await bodyOf(request, 16_000);
  } catch {
    return done(400);
  }
  if (!body) return done(413);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return done(400);
  }
  const sent = Sent.safeParse(json);
  if (!sent.success) return done(400);
  let who: Sender;
  try {
    who = await sender();
  } catch (error) {
    console.warn({ event: "auth.page-events-sender-failed", error: String(error) });
    return done(503);
  }
  const facts = pageFacts(request, sent.data, who);
  // a batch from outside lands only when the day's budget takes all of it
  const records = facts.reduce((sum, fact) => sum + fact.events.length, 0);
  if (!who.member && records > 0) {
    let reserved: boolean;
    try {
      reserved = await reserve(records);
    } catch (error) {
      console.warn({ event: "auth.page-events-budget-failed", error: String(error) });
      return done(503);
    }
    if (!reserved) {
      console.warn({ event: "auth.page-events-budget-spent", records });
      return done(204);
    }
  }
  return withFacts(done(204), facts);
}

// ── the day's budget of the outside, for the whole mind ──
// `page_event_days` in this Worker's D1 (migrations/0022_page_event_days.sql): how many records
// from outside the mind took on each UTC day. A batch from outside reserves its records there in
// ONE STATEMENT, which adds them only when the day's sum stays at most `OUTSIDE_A_DAY`: two
// batches at once are counted one after the other, and none overwrites another's count. A batch
// whose reservation is refused is dropped whole. Rows of days before yesterday are deleted as a
// batch is counted. After ONE REFUSAL this isolate takes no record from outside until the next UTC
// day, and asks D1 nothing (`spentDay`): a flood after the day is full costs no database work.
/** The UTC day whose budget this isolate saw full, or null. */
let spentDay: string | null = null;
/** For the tests: an isolate that has seen no full day. */
export function resetSpentDay(): void {
  spentDay = null;
}
/** Reserve `records` records from outside in today's budget: true when they fit. It throws when
 *  the database cannot be asked. */
export async function outsideReserved(
  db: Pick<D1Database, "prepare" | "batch">,
  records: number,
): Promise<boolean> {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  if (spentDay === day) return false;
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const [, reserved] = await db.batch([
    db.prepare("delete from page_event_days where day < ?1").bind(yesterday),
    db
      .prepare(
        `insert into page_event_days (day, records)
         select ?1, ?2 where ?2 <= ?3
         on conflict (day) do update set records = records + excluded.records
           where records + excluded.records <= ?3
         returning records`,
      )
      .bind(day, records, OUTSIDE_A_DAY),
  ]);
  if (reserved?.results[0]) return true;
  spentDay = day;
  return false;
}
