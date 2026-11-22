// page-events.ts — THE PAGE TAG OF THIS MIND (page-events.md). Jonas, 21 Nov 2026: one script in
// every page of every app, which says what people did there and what broke there.
//
// worker.ts calls these parts for every request of every host:
// - `pageEventsRoute`: `GET /.page.js` is the tag's script (public/page.js), and
//   `POST /.page-events` takes what a page sends and appends it:
//
//   /pages        events.iterate.com/page/viewed           a page load, or a new path in one page
//                 events.iterate.com/page/left             how long, how far, how fast (page-speed.ts reads it)
//                 events.iterate.com/page/event-captured   what the page's own code reported
//   /exceptions   events.iterate.com/exception/seen        what broke in a member's page
//   /exceptions/outside                                    what broke in anyone else's page (exceptions.ts)
//
// ONE CONTEXT FOR ALL PAGE EVENTS, and `app` in each payload: the sender chooses the hostname, so
// nothing a sender writes ever names a context, or anyone could make one for each label.
//
// - `documentRequest`: a request for a page loses its `if-none-match`, so the app answers the
//   page itself and never "not modified": a tag is put into a page, not into a 304.
// - `tagFormFor` and `withPageTag`: the tag goes first into the `<head>` of every HTML answer, in
//   the form that the page's own content security policy allows (`tagFormOf`). No app adds it, and
//   no app can forget it.
// - `pageRequested`: a page whose policy allows no form of the tag is counted from its request.
//
// WHO SENT IT is the platform's word, never the page's: the signed-in person (`host.auth.person`),
// whether they are a member (`memberOf`, `host.auth.principal`), and for anyone a visitor id that this file makes from the day's secret (`saltOf`), the day, the
// sender's address and its browser. The address itself is never kept, the id is another one each
// day, and two days later its secret is deleted. The country and the place (`placeOf`) are
// Cloudflare's word about the address. The app is the host's first label. Nothing is kept in the
// browser. What PostHog would keep about a visitor, and where it is here: page-events.md.
//
// A PAGE OF ANYONE REPORTS: the route asks for no sign-in, so a public page says what broke for
// anyone too. So every text here is words from outside: cut, scrubbed and never an instruction.
// Every URL in a text keeps its path alone, by the platform's own rule (./cut.ts, which page.js
// runs before it sends, and `scrub` after it). Nothing here wakes an agent. THE BOUNDS:
// - A HOST REPORTS ONLY AFTER THE MIND SERVED IT A PAGE WITH THE TAG (`hostTagged`, `hostKnown`):
//   the list `page-events/hosts` in kv, at most 200, and as many in an isolate. Any label under
//   the domain reaches this Worker; worker.ts serves the homepage of a label that is no app with
//   `x-page-events: off`, so it gets no tag, and its report gets what the host answers.
// - This host's own page alone, 64,000 bytes and 20 records a send.
// - The minute's counts of `within`, in this isolate. THE TRUST LINE IS A MEMBER, never "anyone
//   signed in": anyone can sign in on a host that takes people who are not members. So everyone
//   who is no member, signed in or not, is OUTSIDE: far smaller bounds and smaller texts than a
//   member (`BOUNDS`, `TEXTS`).
// - THE DAY'S BUDGET OF THE OUTSIDE FOR THE WHOLE MIND (`outsideReserved`): 20,000 records a day,
//   reserved in the facet `outside-days` on /pages (./backend.ts) BEFORE any record from
//   outside is appended, then none until the next day: a HARD limit, whatever the number of
//   isolates. A batch that does not fit, or a reservation that fails, appends nothing. A flood
//   ends by itself, with no person. One person outside can spend it on purpose and blind the
//   outside page views for that day: accepted (page-events.md).
// - THE SWITCH OF THE OUTSIDE HALF (`audience`, `pageTagFor`): with "members", nobody who is no
//   member gets the tag or may report.
import type { IterateConfigEntrypoint } from "iterate/sdk";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";
import { cut as cutUrls, pathOf } from "./cut.ts";
import { exceptionSeen, scrub, MAX, type Seen } from "./exceptions.ts";
/* oxlint-disable iterate/simple-truthiness-check -- every value here comes from a browser of anyone, whatever its declared type, and an event's payload has no key for what it lacks (page-events.md): a missing key and an empty value are not the same */

export const PAGES = "/pages";
const PAGE_VIEWED = "events.iterate.com/page/viewed";
export const PAGE_LEFT = "events.iterate.com/page/left";
const SCRIPT_PATH = "/.page.js";
/** A minute's bounds, in this isolate: each app for each kind (anyone), and for each visitor and
 *  for all senders together, a member's and the outside's apart. An error has its own
 *  bound for each app in exceptions.ts (30). */
export const BOUNDS = {
  app: { viewed: 120, left: 120, captured: 120 },
  member: { visitor: 60, all: 600 },
  outside: { visitor: 20, all: 60 },
} as const;
/** The texts a send keeps: the outside's are smaller. An error's message and stack are cut in
 *  exceptions.ts (`MAX`, `MAX_OUTSIDE`). */
const TEXTS = {
  member: { title: 120, values: 12 },
  outside: { title: 80, values: 6 },
} as const;
/** THE FACET THAT HOLDS THE DAY'S BUDGET of the outside's records, for the whole mind
 *  (./backend.ts, the one file of an app that a publication offers a facet's class from): one at
 *  a fixed context, loaded from this repo's own files. */
export const OUTSIDE_DAYS = {
  path: "/pages",
  name: "outside-days",
  spec: {
    className: "OutsideDaysDurableObject",
    mainModule: "apps/telemetry/backend.ts",
    source: ["itx", ["cd", "/"], "config"],
  },
};
const HOSTS_KEY = "page-events/hosts";
const MOST_HOSTS = 200;
const ERROR_KINDS = new Set(["uncaught", "rejection", "render", "module-load"]);
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CAMPAIGN_TAG = /^(utm_(source|medium|campaign|term|content)|ref)$/;
/** The ad click ids that PostHog keeps beside the `utm_*` tags. */
const CLICK_ID =
  /^(gclid|gad_source|gclsrc|dclid|gbraid|wbraid|fbclid|msclkid|twclid|li_fat_id|mc_cid|igshid|ttclid|rdt_cid|irclid|_kx)$/;
/** The search engines a referrer may be, by the host's registrable name. */
const SEARCH_ENGINES = new Set([
  "google",
  "bing",
  "duckduckgo",
  "yahoo",
  "baidu",
  "yandex",
  "ecosia",
  "brave",
  "kagi",
  "startpage",
]);
/** Second labels of a country's suffix (`co.uk`, `com.au`): the name is the label before them. */
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "ne", "or", "go"]);
const SALT_KEY = "page-events/salt/";

type Host = Pick<IterateConfigEntrypoint, "auth" | "getItx">;
type PageEvent = { type: string; idempotencyKey?: string; payload: Record<string, unknown> };
/** What this file reaches of the mind: a context's appends (exceptions.ts's `Itx` and more), the
 *  budget's facet, and kv. */
type Itx = {
  cd(path: string): {
    append(event: PageEvent): Promise<unknown>;
    appendOffsets(...events: PageEvent[]): Promise<number[]>;
    facets: {
      get(
        name: string,
        spec: typeof OUTSIDE_DAYS.spec,
      ): { reserve(records: number): Promise<unknown> };
    };
  };
  /** The mind's URL: its hostname is the zone, and an app's hostname is `<label>.<zone>`. */
  url(): Promise<string>;
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
};

/** IS THE SENDER A MEMBER? The platform's word (`host.auth.principal`): a principal that is no
 *  other mind (`kind: "mind"`). Signed in is not enough: anyone can sign in on a host that takes
 *  people who are not members. A read that throws (a malformed stamp) is no member. */
export function memberOf(host: Pick<Host, "auth">, request: Request): boolean {
  try {
    const principal = host.auth.principal(request);
    return principal !== null && principal !== undefined && principal.kind !== "mind";
  } catch {
    return false;
  }
}

/** WHO GETS THE TAG AND MAY REPORT. "everyone": every page, with the outside bounds below.
 *  "members": a member's pages alone, and for anyone else every answer of every host is as it
 *  was before the tag. THE SWITCH THAT CLOSES THE OUTSIDE HALF: one line, and the next publish
 *  serves no tag and takes no report from anyone who is no member. */
let audience: "members" | "everyone" = "everyone";
/** For tests alone. */
export function setAudience(next: "members" | "everyone"): void {
  audience = next;
}
/** Is the page tag for this request at all? */
export function pageTagFor(host: Pick<Host, "auth">, request: Request): boolean {
  return audience === "everyone" || memberOf(host, request);
}

const SOURCE = (() => {
  // the cast: the loader hands over a folder as its files by path, each as text or bytes
  const content = (files as Record<string, string | Uint8Array>)["page.js"];
  return typeof content === "string" ? content : content ? new TextDecoder().decode(content) : "";
})();
/** The script's own version: its address changes when its text does, so a browser may keep it. */
const VERSION = (() => {
  let h = 0x811c9dc5;
  for (let i = 0; i < SOURCE.length; i++) h = Math.imul(h ^ SOURCE.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
})();
/** The script as it is served, with its version in it (`TAG` of page.js): each event says which
 *  script sent it (`tag`), in every form of the tag. */
const SCRIPT = SOURCE.replace('"%TAG%"', JSON.stringify(VERSION));
const TAG_VERSION = /^[a-z0-9]{1,16}$/;

/** THE THREE FORMS OF THE TAG. The script is `async` with `fetchpriority="low"`: it holds back
 *  neither the parse nor the first paint, and the page's own files download first. On a first visit
 *  the page's `load` event waits for its download (about 55 ms on the blog, measured 22 Nov 2026);
 *  a script added only after `load` would lose the view and the errors of anyone who leaves before
 *  it. The address is immutable, so a later visit takes it from the browser's cache.
 *  - linked: the keep-lines keep what breaks until the script runs (at most 20 events), then the
 *    script, for a page whose policy allows inline scripts.
 *  - src: the script alone, for a page whose policy allows the own host's scripts but no inline one.
 *  - inline: the whole script in the page, for a page whose policy allows inline scripts alone:
 *    `<` before `/script` and `!--` becomes `\x3C`, so the text cannot end the element.
 *  The script's observers are buffered: what happened before it ran is still counted. */
const SCRIPT_URL = `${SCRIPT_PATH}?v=${VERSION}`;
const KEEP_LINES =
  `<script>(function(w){if(w.__pageEvents)return;var q=w.__pageEvents={early:[]};q.keep=function(e){q.early.length<20&&q.early.push(e)};` +
  `w.addEventListener("error",q.keep,true);w.addEventListener("unhandledrejection",q.keep)})(window)</script>`;
const LINKED = `<script async fetchpriority="low" src="${SCRIPT_URL}"></script>`;
export const PAGE_TAGS = {
  linked: KEEP_LINES + LINKED,
  src: LINKED,
  inline: `<script>${SCRIPT.replace(/<(?=\/script|!--)/gi, "\\x3C")}</script>`,
} as const;
export type TagForm = keyof typeof PAGE_TAGS;

/** THE APP OF A HOST: the hostname's first label, as worker.ts routes by it; "site" on the apex
 *  and on www. */
export function appOf(hostname: string): string {
  const labels = hostname.split(".");
  const label = labels.length > 2 ? labels[0]! : "site";
  return label === "www" || !APP_SLUG.test(label) ? "site" : label;
}

/** A PATH THAT KEEPS ITS WORDS AND LOSES ITS SECRETS (./cut.ts): no query string and no hash; a
 *  segment that looks like an id or a token becomes `<id>`; at most 200 characters. */
export { pathOf };
/** A path a page sent: the path rule, then the cut of every text. */
const pathCut = (value: unknown) => cutUrls(pathOf(value));

const isHtml = (answer: Response) =>
  (answer.headers.get("content-type") || "").toLowerCase().startsWith("text/html");
const isAttachment = (answer: Response) =>
  (answer.headers.get("content-disposition") || "").toLowerCase().startsWith("attachment");
const isOff = (answer: Response) => answer.headers.get("x-page-events") === "off";

/** A request for a page, with no `if-none-match` and no `if-modified-since`: see the header. */
export function documentRequest(request: Request): Request {
  const wantsPage =
    request.headers.get("sec-fetch-dest") === "document" ||
    (request.headers.get("accept") || "").includes("text/html");
  if (request.method !== "GET" || !wantsPage) return request;
  if (!request.headers.has("if-none-match") && !request.headers.has("if-modified-since"))
    return request;
  const headers = new Headers(request.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  return new Request(request, { headers });
}

/** WHICH FORM OF THE TAG A PAGE'S OWN POLICY ALLOWS. Several policies (a comma between them, or
 *  several headers) must each allow the form. Null: no form runs and reports there. */
export function tagFormOf(policy: string | null): TagForm | null {
  if (policy === null || !policy.trim()) return "linked";
  let form: TagForm = "linked";
  for (const one of policy.split(",")) {
    const next = formOfOne(one);
    if (next === null) return null;
    if (next === "linked") continue;
    if (form === "linked") form = next;
    else if (form !== next) return null;
  }
  return form;
}
function formOfOne(policy: string): TagForm | null {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().toLowerCase().split(/\s+/);
    // the first of two directives of one name stands, as in a browser
    if (name && !directives.has(name)) directives.set(name, values);
  }
  // a sandboxed page has no origin of its own: its report would be refused
  if (directives.has("sandbox")) return null;
  const scripts =
    directives.get("script-src-elem") ??
    directives.get("script-src") ??
    directives.get("default-src");
  const connect = directives.get("connect-src") ?? directives.get("default-src");
  const ownHost = (sources: string[]) =>
    sources.some((source) => source === "'self'" || source === "*" || source === "https:");
  if (connect && !ownHost(connect)) return null;
  if (!scripts) return "linked";
  // a nonce or a hash: the tag would need one too (not in this version); 'strict-dynamic' trusts nothing else
  if (scripts.some((source) => /^'(nonce-|sha(256|384|512)-|strict-dynamic')/.test(source)))
    return null;
  const inline = scripts.includes("'unsafe-inline'");
  if (inline && ownHost(scripts)) return "linked";
  if (inline) return "inline";
  if (ownHost(scripts)) return "src";
  return null;
}

/** WHICH FORM OF THE TAG THIS ANSWER TAKES, or null. A whole HTML page for a person to look at,
 *  and nothing else: no framed document (a preview of someone's HTML is no page of ours), no
 *  download, no encoded body, no page that says `x-page-events: off`, and a form that the page's
 *  own content security policy allows. */
export function tagFormFor(request: Request, answer: Response): TagForm | null {
  if (request.method !== "GET" || !answer.body) return null;
  if (answer.status < 200 || answer.status === 204 || (answer.status >= 300 && answer.status < 400))
    return null;
  if (
    !isHtml(answer) ||
    answer.headers.has("content-encoding") ||
    isAttachment(answer) ||
    isOff(answer)
  )
    return null;
  if (/^(iframe|frame|embed|object)$/.test(request.headers.get("sec-fetch-dest") || ""))
    return null;
  return tagFormOf(answer.headers.get("content-security-policy"));
}

/** THE ANSWER WITH THE TAG IN IT, in the form `tagFormFor` gave: first in its `<head>`; in a page
 *  with no `<head>` tag, first in its `<body>`; with neither, at its end. */
export function withPageTag(answer: Response, form: TagForm): Response {
  const tag = PAGE_TAGS[form];
  const headers = new Headers(answer.headers);
  // the body is another one now: its tag and its length are no longer true
  headers.delete("etag");
  headers.delete("content-length");
  let placed = false;
  const first = {
    element(element: { prepend(content: string, options: { html: boolean }): unknown }) {
      if (placed) return;
      placed = true;
      element.prepend(tag, { html: true });
    },
  };
  return new HTMLRewriter()
    .on("head", first)
    .on("body", first)
    .onDocument({
      end(end) {
        if (!placed) end.append(tag, { html: true });
      },
    })
    .transform(
      new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers }),
    );
}

export type Agent = {
  browser: string;
  browserVersion?: string;
  os: string;
  osVersion?: string;
  device: string;
};
/** THE BROWSER, ITS VERSION, THE SYSTEM, ITS VERSION AND THE KIND OF DEVICE of a `user-agent`, in
 *  PostHog's words. A version is as the user agent writes it ("142.0.0.0", "10.15.7"); a key with
 *  no value is left out. A bot is a bot, whatever else it says. */
export function agentOf(userAgent: string): Agent {
  const ua = userAgent || "";
  const version = (pattern: RegExp) =>
    (ua.match(pattern)?.[1] ?? "").replace(/_/g, ".").slice(0, 40);
  const bot = /bot|crawl|spider|slurp|headless|preview|monitor|curl|wget|python|node|go-http/i.test(
    ua,
  );
  const [browser, browserVersion] = bot
    ? ["bot", ""]
    : /Edg(e|A|iOS)?\//.test(ua)
      ? ["Edge", version(/Edg(?:e|A|iOS)?\/([\d.]+)/)]
      : /OPR\/|OPT\//.test(ua)
        ? ["Opera", version(/(?:OPR|OPT)\/([\d.]+)/)]
        : /SamsungBrowser\//.test(ua)
          ? ["Samsung Internet", version(/SamsungBrowser\/([\d.]+)/)]
          : /Firefox\/|FxiOS\//.test(ua)
            ? ["Firefox", version(/(?:Firefox|FxiOS)\/([\d.]+)/)]
            : /Chrome\/|CriOS\//.test(ua)
              ? ["Chrome", version(/(?:Chrome|CriOS)\/([\d.]+)/)]
              : /Safari\//.test(ua)
                ? ["Safari", version(/Version\/([\d.]+)/)]
                : ["other", ""];
  const [os, osVersion] = /iPad/.test(ua)
    ? ["iPadOS", version(/CPU OS ([\d_]+)/)]
    : /iPhone|iPod/.test(ua)
      ? ["iOS", version(/(?:iPhone|CPU) OS ([\d_]+)/)]
      : /Android/.test(ua)
        ? ["Android", version(/Android ([\d.]+)/)]
        : /CrOS/.test(ua)
          ? ["ChromeOS", version(/CrOS \S+ ([\d.]+)/)]
          : /Mac OS X/.test(ua)
            ? ["macOS", version(/Mac OS X ([\d_.]+)/)]
            : /Windows/.test(ua)
              ? ["Windows", version(/Windows NT ([\d.]+)/)]
              : /Linux/.test(ua)
                ? ["Linux", ""]
                : ["other", ""];
  const device = bot
    ? "bot"
    : /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
      ? "tablet"
      : /Mobi|iPhone|iPod|Android/.test(ua)
        ? "mobile"
        : "desktop";
  return {
    browser,
    ...(browserVersion && { browserVersion }),
    os,
    ...(osVersion && { osVersion }),
    device,
  };
}

/** WHERE CLOUDFLARE PUTS THE ADDRESS, when it says so: `request.cf` first (absent in a test or a
 *  request made by hand), then its headers. Each key only with a value; null when nothing is known.
 *  The address itself is never kept. */
export type Place = {
  region?: string;
  regionCode?: string;
  city?: string;
  postalCode?: string;
  continent?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
};
const PLACE_TEXTS = [
  ["region", "region", "cf-region"],
  ["regionCode", "regionCode", "cf-region-code"],
  ["city", "city", "cf-ipcity"],
  ["postalCode", "postalCode", "cf-postal-code"],
  ["continent", "continent", "cf-ipcontinent"],
  ["timezone", "timezone", "cf-timezone"],
] as const;
const cfOf = (request: Request) => {
  try {
    return objectOf((request as { cf?: unknown }).cf) ?? {};
  } catch {
    return {};
  }
};
export function placeOf(request: Request): Place | null {
  const cf = cfOf(request);
  const place: Record<string, string | number> = {};
  for (const [key, field, header] of PLACE_TEXTS) {
    const value = cut(cf[field] ?? request.headers.get(header) ?? "", 80);
    if (value) place[key] = value;
  }
  for (const [key, header, most] of [
    ["latitude", "cf-iplatitude", 90],
    ["longitude", "cf-iplongitude", 180],
  ] as const) {
    const raw = cf[key] ?? request.headers.get(header);
    const value = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    // two decimals, about 1 km: Cloudflare places an address at a city, so more adds no truth
    if (Number.isFinite(value) && Math.abs(value) <= most)
      place[key] = Math.round(value * 100) / 100;
  }
  // the cast: `place` holds only the keys of Place, each set above with its own check
  return Object.keys(place).length > 0 ? (place as Place) : null;
}
/** The country: Cloudflare's header, else `request.cf`. */
const countryOf = (request: Request) =>
  cut(request.headers.get("cf-ipcountry") || cfOf(request).country || "", 2);

/** THE SEARCH ENGINE of a referrer's host, by its registrable name: `www.google.co.uk` is
 *  "google", `search.brave.com` is "brave". Undefined for any other host. */
export function searchEngineOf(host: unknown): string | undefined {
  const labels = String(host ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "")
    .split(".")
    .filter(Boolean);
  if (labels.length < 2) return undefined;
  labels.pop();
  if (labels.length >= 2 && SECOND_LEVEL.has(labels.at(-1)!)) labels.pop();
  const name = labels.at(-1)!;
  return SEARCH_ENGINES.has(name) ? name : undefined;
}

/** WHAT THE REQUEST SAYS ABOUT THE VISITOR, on every page event: the full hostname, the country,
 *  the place, the agent and the raw user agent (scrubbed, at most 256 characters). */
function visitorFacts(request: Request) {
  const userAgent = request.headers.get("user-agent") || "";
  const place = placeOf(request);
  return {
    host: new URL(request.url).hostname.slice(0, 253),
    country: countryOf(request),
    ...(place && { place }),
    agent: agentOf(userAgent),
    ...(userAgent && { userAgent: cut(userAgent, 256) }),
  };
}

const today = () => new Date(Date.now()).toISOString().slice(0, 10);

/** THE DAY'S SECRET of the visitor id: 32 random hex characters in kv, `page-events/salt/<day>`.
 *  The isolate's kept value; else the stored one; else a new one, put and read again (two isolates
 *  that both made one then agree on what is stored), and the secrets of two and three days before
 *  are deleted. With its secret gone, an id cannot be turned back into an address. Null on a
 *  failure: then there is no visitor. */
const salts = new Map<string, string>();
export async function saltOf(itx: Pick<Itx, "kv">, day = today()): Promise<string | null> {
  const kept = salts.get(day);
  if (kept) return kept;
  try {
    const key = SALT_KEY + day;
    let salt = await itx.kv.get(key);
    if (!salt) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      await itx.kv.put(key, [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
      salt = await itx.kv.get(key);
      if (!salt) return null;
      // a delete that fails leaves the day's secret good; the next day's new secret tries again
      for (const days of [2, 3])
        await itx.kv
          .delete(
            SALT_KEY +
              new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000)
                .toISOString()
                .slice(0, 10),
          )
          .catch(() => {});
    }
    // one day kept: the map cannot grow
    salts.clear();
    salts.set(day, salt);
    return salt;
  } catch {
    return null;
  }
}
/** For the tests: an isolate that keeps no secret. */
export function forgetSalts(): void {
  salts.clear();
}

/** A VISITOR, FOR ONE DAY: twelve characters made from the day's secret, the day, the sender's
 *  address and its browser. The same person on the same day is the same id on every app of the
 *  mind; the next day another. The address is never kept. Null with no secret or no address. */
export async function visitorOf(
  request: Request,
  salt: string | null,
  day = today(),
): Promise<string | null> {
  const address = request.headers.get("cf-connecting-ip");
  if (!salt || !address) return null;
  const input = [salt, day, address, request.headers.get("user-agent") || "", "page-events"].join(
    "\n",
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  return [...digest.slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ── the hosts that report: those the mind served a page with the tag ──
/** The hosts this isolate knows: at most 200, as the list in kv (`remember`). */
const hosts = new Set<string>();
const remember = (hostname: string) => {
  if (hosts.size < MOST_HOSTS) hosts.add(hostname);
};
let hostsReadAt = -Infinity;
const hostsOf = (stored: string | null): string[] => {
  try {
    const list: unknown = JSON.parse(stored ?? "[]");
    return Array.isArray(list)
      ? list.filter((one): one is string => typeof one === "string").slice(0, MOST_HOSTS)
      : [];
  } catch {
    return [];
  }
};
/** The isolate's writes of the list, one after the other: after a publish the first pages of
 *  several hosts come at once, and two writes that both read the old list would lose a host. */
let hostsWritten = Promise.resolve();
/** The mind's zone, read once in an isolate (`itx.url()`). */
let zone: string | null = null;
/** Is `hostname` a name the mind serves: its zone, or one label above it (`dash.<zone>`,
 *  `www.<zone>`)? A deeper name (`dash.x.<zone>`) is not, though an app's first label takes it. */
const servedName = (hostname: string, ofZone: string) =>
  hostname === ofZone ||
  (hostname.endsWith(`.${ofZone}`) && !hostname.slice(0, -ofZone.length - 1).includes("."));
/** THIS HOST SERVED A PAGE WITH THE TAG: worker.ts calls it when an answer takes the tag, and
 *  only an app's page takes it (worker.ts serves the homepage of a label that is no app with
 *  `x-page-events: off`). Null when this isolate knows the host already, or knows 200: no call at
 *  all. Else the isolate knows it at once, and a promise (for `waitUntil`) puts it on the list in
 *  kv: read, add, put, never past 200 hosts, after the isolate's write before it. What the read
 *  finds, the isolate knows too, up to 200. A failure is dropped: the next tagged page of another
 *  isolate tries again. */
export function hostTagged(host: Pick<Host, "getItx">, request: Request): Promise<void> | null {
  const hostname = new URL(request.url).hostname;
  // the bound first: a host the isolate cannot keep is never added
  if (hosts.has(hostname) || hosts.size >= MOST_HOSTS) return null;
  hostsWritten = hostsWritten.then(async () => {
    try {
      // the cast: the root's itx is disposable and has what Itx names; the SDK types it wider
      using itx = host.getItx() as Itx & Disposable;
      // ONLY A NAME THE MIND SERVES: worker.ts routes by the first label, so `dash.x.<zone>` gets
      // the Dash too, and a stranger could invent such names until the list is full. The zone,
      // and one label above it, alone go on the list.
      zone ??= new URL(await itx.url()).hostname;
      if (!servedName(hostname, zone)) return;
      if (hosts.has(hostname) || hosts.size >= MOST_HOSTS) return;
      hosts.add(hostname);
      const list = hostsOf(await itx.kv.get(HOSTS_KEY));
      for (const one of list) remember(one);
      if (list.includes(hostname) || list.length >= MOST_HOSTS) return;
      await itx.kv.put(HOSTS_KEY, JSON.stringify([...list, hostname]));
    } catch {
      // dropped
    }
  });
  return hostsWritten;
}
/** MAY THIS HOST REPORT? When this isolate knows it, or the list in kv has it. The list is read at
 *  most once in 10 s for an isolate, so a flood of invented hosts reads it once, and adds none of
 *  them. A kv that fails: not known. */
export async function hostKnown(itx: Pick<Itx, "kv">, hostname: string): Promise<boolean> {
  if (hosts.has(hostname)) return true;
  if (Date.now() - hostsReadAt < 10_000) return false;
  hostsReadAt = Date.now();
  try {
    const list = hostsOf(await itx.kv.get(HOSTS_KEY));
    for (const one of list) remember(one);
    return list.includes(hostname);
  } catch {
    return false;
  }
}
/** For the tests: an isolate that knows no host. */
export function forgetHosts(): void {
  hosts.clear();
  hostsReadAt = -Infinity;
  hostsWritten = Promise.resolve();
}

// ── the day's budget of the outside, for the whole mind ──
/** The UTC day whose budget this isolate saw full, or null: after ONE REFUSAL this isolate takes
 *  no record from outside until the next UTC day, and asks the facet nothing. */
let spentDay: string | null = null;
/** RESERVE `records` records from outside in today's budget, in the facet `outside-days`
 *  (./backend.ts): true when they fit, and then they are counted. Call it before the append:
 *  a batch whose reservation is refused is dropped whole. It throws when the facet cannot be
 *  asked: the caller drops the records then too. */
async function outsideReserved(itx: Pick<Itx, "cd">, records: number): Promise<boolean> {
  const day = today();
  if (spentDay === day) return false;
  const reserved = await itx
    .cd(OUTSIDE_DAYS.path)
    .facets.get(OUTSIDE_DAYS.name, OUTSIDE_DAYS.spec)
    .reserve(records);
  if (reserved === true) return true;
  spentDay = day;
  return false;
}
/** For the tests: an isolate that has seen no full day. */
export function forgetOutside(): void {
  spentDay = null;
}

// ── the minute's bounds, in this isolate ──
let minute = -1;
const all = { member: 0, outside: 0 };
const perApp = new Map<string, number>();
const perVisitor = new Map<string, number>();
/** May one more record of this kind, app and visitor land in this minute? It counts the record
 *  when it may. `who` is "outside" when the sender is no member (`memberOf`): its bounds are smaller. An error is
 *  counted here for its visitor and for all senders; its app's bound is exceptions.ts's. The maps
 *  are emptied when the minute changes, so they cannot grow for good. */
function within(
  kind: "viewed" | "left" | "captured" | "error",
  app: string,
  visitor: string | null,
  who: "member" | "outside" = "member",
): boolean {
  const now = Math.floor(Date.now() / 60_000);
  if (now !== minute) {
    minute = now;
    all.member = 0;
    all.outside = 0;
    perApp.clear();
    perVisitor.clear();
  }
  const appKey = `${kind}/${app}`;
  const visitorKey = `${who}/${visitor ?? "none"}`;
  if (all[who] >= BOUNDS[who].all || (perVisitor.get(visitorKey) ?? 0) >= BOUNDS[who].visitor)
    return false;
  if (kind !== "error" && (perApp.get(appKey) ?? 0) >= BOUNDS.app[kind]) return false;
  all[who] += 1;
  perVisitor.set(visitorKey, (perVisitor.get(visitorKey) ?? 0) + 1);
  if (kind !== "error") perApp.set(appKey, (perApp.get(appKey) ?? 0) + 1);
  return true;
}
/** For the tests: a new minute. */
export function resetBounds(): void {
  minute = -1;
}

const cut = (value: unknown, max: number) => scrub(value, max);
const whole = (value: unknown, most: number) =>
  Math.min(Math.max(Math.round(Number(value)) || 0, 0), most);
const pair = (value: unknown) =>
  Array.isArray(value) && value.length === 2
    ? [whole(value[0], 100_000), whole(value[1], 100_000)]
    : undefined;
const objectOf = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? // the cast: a non-null object that is no array, as the test above says
      (value as Record<string, unknown>)
    : null;
/** A time the page wrote, when it is one; else the server's. */
const when = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(value)
    ? value
    : new Date().toISOString();
/** The campaign tags and the click ids, and nothing else of a query string, as page.js reads
 *  them. A tag is text: it goes through the cut (./cut.ts) and keeps 80 characters. A click id is
 *  the ad network's name for one click, which PostHog keeps whole: its letters, digits and `._~-`
 *  alone, at most 200 (the cut would make every one `<cut>`). */
const campaignOf = (pairs: Iterable<[string, unknown]>) =>
  Object.fromEntries(
    [...pairs]
      .filter(([key]) => CAMPAIGN_TAG.test(key) || CLICK_ID.test(key))
      .map(([key, value]) => [
        key,
        CLICK_ID.test(key)
          ? String(value ?? "")
              .slice(0, 2_000)
              .replace(/[^\w.~-]/g, "")
              .slice(0, 200)
          : cut(String(value ?? "").slice(0, 2_000), 80),
      ])
      .filter(([, value]) => value !== ""),
  );
/** A whole number within its bounds, else undefined: a value out of range is dropped, not clamped. */
const wholeWithin = (value: unknown, least: number, most: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= least && value <= most
    ? value
    : undefined;
/** A load time in whole ms under 10 minutes, else undefined. */
const loadTime = (value: unknown) => {
  const ms = Math.round(Number(value));
  return Number.isFinite(ms) && ms >= 0 && ms < 600_000 ? ms : undefined;
};
/** CLS as the page measured it: 0 to 10, 3 decimals; else undefined (dropped, not clamped). */
const clsWithin = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10
    ? Math.round(value * 1000) / 1000
    : undefined;
/** THE VITALS a `page/left` adds (page-events.md, "Speed"): `fcp` (the first view's alone), `inp`
 *  (whole ms, 0 to 600,000) and `cls`. A value out of range, or no number, is dropped. */
export function vitalsOf(
  sent: Record<string, unknown>,
  first: boolean,
): { fcp?: number; inp?: number; cls?: number } {
  const fcp = first ? wholeWithin(sent.fcp, 0, 600_000) : undefined;
  const inp = wholeWithin(sent.inp, 0, 600_000);
  const cls = clsWithin(sent.cls);
  return {
    ...(fcp !== undefined && { fcp }),
    ...(inp !== undefined && { inp }),
    ...(cls !== undefined && { cls }),
  };
}
/** A MARK'S NAME: `iterate:` and at most 40 characters of `[a-z0-9:._-]`, with no run of 32 or
 *  more letters, digits, `_` or `-`, which the cut takes for a token (`marksOf`). */
const MARK_NAME = /^iterate:[a-z0-9:._-]{1,40}$/;
/** THE APP'S OWN MILESTONES of a view (`performance.mark("iterate:…")`): at most 20, each a whole
 *  number of ms since the page's start (0 to 600,000). Any other key or value is dropped. Undefined
 *  when none is left. */
export function marksOf(value: unknown): Record<string, number> | undefined {
  const marks: Record<string, number> = {};
  for (const [name, at] of Object.entries(objectOf(value) ?? {})) {
    if (Object.keys(marks).length >= 20) break;
    const ms = wholeWithin(at, 0, 600_000);
    // a name the cut would change (a long run that could be a token) is dropped
    if (MARK_NAME.test(name) && cutUrls(name) === name && ms !== undefined) marks[name] = ms;
  }
  return Object.keys(marks).length > 0 ? marks : undefined;
}
const actorOf = (host: Host, request: Request): { userId: string; email: string } | null => {
  const person = host.auth.person(request) as { userId?: string; email?: string } | null;
  return person?.userId && person.email ? { userId: person.userId, email: person.email } : null;
};
/** Global Privacy Control or Do Not Track, as the browser says it: errors alone, with no visitor. */
const quietOf = (request: Request) =>
  request.headers.get("sec-gpc") === "1" || request.headers.get("dnt") === "1";

/** A PAGE THAT CANNOT TAKE THE TAG IS COUNTED BY ITS REQUEST: its policy allows no form of the tag
 *  (`tagFormOf` gives null), so its view is what the server saw. From anyone who is no member it is
 *  a record from outside: the outside's bounds and the day's budget. One `page/viewed` with
 *  `how: "request"`, appended only after the budget took it (`outsideReserved`) and only with a
 *  visitor (a failed read of the day's secret drops it): the path, where the visitor came from,
 *  the visitor, the host, the country,
 *  the place and the browser; no screen, no time on the page, no error, no `tag`. Only a browser's own navigation counts (it
 *  says `sec-fetch-dest: document`, which a crawler does not), and only a page that was served.
 *  Null for any other answer; else a promise for worker.ts to keep alive (`waitUntil`). */
export function pageRequested(
  request: Request,
  answer: Response,
  host: Host,
): Promise<void> | null {
  if (
    request.method !== "GET" ||
    answer.status !== 200 ||
    request.headers.get("sec-fetch-dest") !== "document"
  )
    return null;
  if (!isHtml(answer) || isAttachment(answer) || isOff(answer) || quietOf(request)) return null;
  const policy = answer.headers.get("content-security-policy");
  if (policy === null || tagFormOf(policy) !== null) return null;
  const facts = visitorFacts(request);
  if (facts.agent.browser === "bot") return null;
  const url = new URL(request.url);
  const app = appOf(url.hostname);
  const from = (() => {
    try {
      const { host: fromHost, pathname } = new URL(request.headers.get("referer") || "");
      return { host: cut(fromHost, 100), pathname: pathCut(pathname) };
    } catch {
      return null;
    }
  })();
  const campaign = campaignOf(url.searchParams);
  return (async () => {
    try {
      // the cast: the root's itx is disposable and has what Itx names; the SDK types it wider
      using itx = host.getItx() as Itx & Disposable;
      const actor = actorOf(host, request);
      const member = memberOf(host, request);
      // no day's secret, no visitor: the view is dropped, never kept with a null visitor
      const salt = await saltOf(itx);
      if (salt === null) return;
      const visitor = await visitorOf(request, salt);
      if (!within("viewed", app, visitor, member ? "member" : "outside")) return;
      // a view from outside is reserved in the day's budget before it is appended
      if (!member && !(await outsideReserved(itx, 1))) return;
      await itx.cd(PAGES).append({
        type: PAGE_VIEWED,
        payload: {
          app,
          pathname: pathCut(url.pathname),
          at: new Date().toISOString(),
          visitor,
          actor,
          ...(member && { member: true }),
          ...facts,
          how: "request",
          ...(from && { from }),
          ...(from && searchEngineOf(from.host) && { searchEngine: searchEngineOf(from.host) }),
          ...(Object.keys(campaign).length > 0 && { campaign }),
          language: cut((request.headers.get("accept-language") || "").split(",")[0], 20),
        },
      });
    } catch {
      // dropped: a view that was not counted is no error
    }
  })();
}

/** The body as text, or null when it holds more than `most` bytes. It stops reading there. */
async function bodyOf(request: Request, most: number): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > most) return null;
  if (!request.body) return "";
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
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** `GET /.page.js` on every host of the mind, and `POST /.page-events` on a host that the mind
 *  served a page with the tag (`hostKnown`), before any guard. Null for any other request: a report
 *  to another host gets what that host answers. A record over a bound, or one that is no record, is dropped and the answer
 *  stays 204; a refusal of the whole send is 405, 403, 413 or 400 (a body that is no JSON object).
 *  The route never throws: a failure after the checks answers 202 and appends nothing more. */
export async function pageEventsRoute(request: Request, host: Host): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === SCRIPT_PATH) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    return new Response(request.method === "HEAD" ? null : SCRIPT, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        // its address names its version: a browser keeps that one for good, any other for a minute
        "cache-control":
          url.searchParams.get("v") === VERSION
            ? "public, max-age=31536000, immutable"
            : "public, max-age=60",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (url.pathname !== "/.page-events") return null;
  if (!hosts.has(url.hostname)) {
    let known = false;
    try {
      // the cast: the root's itx is disposable and has what Itx names; the SDK types it wider
      using itx = host.getItx() as Itx & Disposable;
      known = await hostKnown(itx, url.hostname);
    } catch {
      // not known
    }
    if (!known) return null;
  }
  if (request.method !== "POST")
    return new Response(null, {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  // this host's own page alone: its origin, or a browser's word that it is the same origin
  const origin = request.headers.get("origin");
  if (origin ? origin !== url.origin : request.headers.get("sec-fetch-site") !== "same-origin")
    return done(403);
  // from here on nothing throws out of the route: the body, every value the page sent and every
  // call to the mind are read inside the catch, and a throw answers 202 and appends nothing more
  try {
    return await reported(request, url, host);
  } catch {
    return droppedBatch();
  }
}

const done = (status: number) =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });
/** THE ANSWER TO A SEND THAT WAS DROPPED after the checks: 202, nothing appended. worker.ts answers
 *  it too when the route throws, which it never should. */
export const droppedBatch = () => done(202);

/** One send of a page, after the host, the method and the origin were checked. It may throw:
 *  `pageEventsRoute` answers that as a dropped send. ORDER: every record is read and bounded
 *  first; then the outside's records are reserved in the day's budget, all of them in one
 *  reservation (`outsideReserved`); then they are appended. A refused reservation drops the send
 *  (204), a failed one throws (202): neither appends anything. A failed read of the day's secret
 *  drops the send too: no record is kept with a null visitor, but under Global Privacy Control,
 *  which asks for none. */
async function reported(request: Request, url: URL, host: Host): Promise<Response> {
  const body = await bodyOf(request, 64_000);
  if (body === null) return done(413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return done(400);
  }
  // `null`, a number, a text or a list is no send
  const sent = objectOf(parsed);
  if (!sent) return done(400);
  const page = objectOf(sent.page) ?? {};
  const pageId = typeof page.id === "string" ? page.id : "";
  if (!/^[a-z0-9]{8,32}$/i.test(pageId) || !Array.isArray(sent.events)) return done(400);
  const records = sent.events.slice(0, 20);

  const app = appOf(url.hostname);
  const quiet = quietOf(request);
  // the cast: the root's itx is disposable and has what Itx names; the SDK types it wider
  using itx = host.getItx() as Itx & Disposable;
  const actor = actorOf(host, request);
  // the bounds, the texts and the context are a member's or the outside's, signed in or not
  const member = memberOf(host, request);
  const texts = TEXTS[member ? "member" : "outside"];
  const salt = quiet ? null : await saltOf(itx);
  if (!quiet && salt === null) return droppedBatch();
  const visitor = quiet ? null : await visitorOf(request, salt);
  const tag = typeof page.tag === "string" && TAG_VERSION.test(page.tag) ? page.tag : "";
  const who = {
    visitor,
    actor,
    ...(member && { member: true as const }),
    ...visitorFacts(request),
    ...(tag && { tag }),
    ...(page.automated === true && { automated: true }),
  };
  const timezoneOffset = wholeWithin(page.timezoneOffset, -900, 900);
  const build = cut(page.build, MAX.short);
  // the page events of the send, appended together in one call at the end
  const batch: PageEvent[] = [];
  // the errors of the send, each one `exceptionSeen` after the reservation
  const errors: { key: string; seen: Seen }[] = [];
  for (const raw of records) {
    const event = objectOf(raw);
    if (!event) continue;
    const type = String(event.type);
    if (type !== "error" && (quiet || !["viewed", "left", "captured"].includes(type))) continue;
    if (
      !within(
        type as "viewed" | "left" | "captured" | "error",
        app,
        visitor,
        member ? "member" : "outside",
      )
    )
      continue;
    const n = whole(event.n, 1_000_000);
    const common = {
      app,
      pathname: pathCut(event.pathname),
      page: pageId,
      view: whole(event.view, 100_000),
      at: when(event.at),
      ...who,
    };
    if (type === "error") {
      const kind = ERROR_KINDS.has(String(event.kind)) ? String(event.kind) : "render";
      // the key's parts: a fixed alphabet, and a part the cut would change (a long run that could
      // be a token) is "first"
      const sentPart = String(event.part ?? "")
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 40);
      const part = sentPart && cutUrls(sentPart) === sentPart ? sentPart : "first";
      const mark =
        String(event.fingerprint ?? "")
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 16) || "none";
      // the same error of the same page load, sent again, lands once
      errors.push({
        key: `page:${app}:${mark}:${pageId}-${part}`,
        seen: {
          kind,
          message: String(event.message ?? ""),
          stack: String(event.stack ?? ""),
          count: Math.max(whole(event.count, 100_000), 1),
          firstAt: when(event.firstAt),
          lastAt: when(event.lastAt),
          source: { from: "page", app, ...(build && { build }) },
          where: { pathname: common.pathname },
          actor,
          member,
          more: {
            page: pageId,
            visitor,
            ...(member && { member: true }),
            host: who.host,
            country: who.country,
            ...(who.place && { place: who.place }),
            agent: who.agent,
            ...(who.userAgent && { userAgent: who.userAgent }),
            ...(tag && { tag }),
          },
        },
      });
      continue;
    }
    if (type === "viewed") {
      const from = objectOf(event.from);
      const campaign = campaignOf(Object.entries(objectOf(event.campaign) ?? {}));
      const how = ["load", "route", "restore"].includes(String(event.how))
        ? String(event.how)
        : "load";
      const fromHost = from && cut(from.host, 100);
      const searchEngine = searchEngineOf(fromHost);
      batch.push({
        type: PAGE_VIEWED,
        idempotencyKey: `page/viewed:${pageId}:${n}`,
        payload: {
          ...common,
          how,
          title: cut(page.title, texts.title),
          ...(from && { from: { host: fromHost, pathname: pathCut(from.pathname) } }),
          ...(searchEngine && { searchEngine }),
          ...(Object.keys(campaign).length > 0 && { campaign }),
          screen: pair(page.screen),
          viewport: pair(page.viewport),
          language: cut(page.language, 20),
          timezone: cut(page.timezone, 40),
          ...(timezoneOffset !== undefined && { timezoneOffset }),
          ...(build && { build }),
        },
      });
      continue;
    }
    if (type === "left") {
      const load = objectOf(event.load);
      const scrolled = wholeWithin(event.scrolled, 0, 100);
      const marks = marksOf(event.marks);
      batch.push({
        type: PAGE_LEFT,
        idempotencyKey: `page/left:${pageId}:${n}`,
        payload: {
          ...common,
          openMs: whole(event.openMs, 86_400_000),
          seenMs: whole(event.seenMs, 86_400_000),
          ...(scrolled !== undefined && { scrolled }),
          ...(load && {
            load: {
              // a load time of 10 minutes or more, or none, is no key: dropped, never clamped
              ...Object.fromEntries(
                (["firstByte", "ready", "loaded", "largestPaint"] as const)
                  .map((name) => [name, loadTime(load[name])] as const)
                  .filter(([, ms]) => ms !== undefined),
              ),
              shift: Math.min(Math.max(Number(load.shift) || 0, 0), 100),
              ...vitalsOf(load, true),
            },
          }),
          // a later view of a single-page app: its own INP and CLS
          ...(!load && vitalsOf(event, false)),
          ...(marks && { marks }),
        },
      });
      continue;
    }
    const name = cut(event.name, 80);
    if (!name) continue;
    const values = Object.fromEntries(
      Object.entries(objectOf(event.values) ?? {})
        .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
        .slice(0, texts.values)
        .map(([key, value]) => [
          cut(key, 40),
          typeof value === "string"
            ? cut(value, MAX.short)
            : typeof value === "number" && !Number.isFinite(value)
              ? 0
              : value,
        ]),
    );
    batch.push({
      type: "events.iterate.com/page/event-captured",
      idempotencyKey: `page/event-captured:${pageId}:${n}`,
      payload: { ...common, name, values },
    });
  }
  // the outside's records wait for the day's budget, all of them in one reservation; a refusal
  // drops the send, and a failure throws (`pageEventsRoute` answers 202)
  const count = batch.length + errors.length;
  if (count === 0) return done(204);
  if (!member && !(await outsideReserved(itx, count))) return done(204);
  // exceptionSeen never throws: a failed append of an error is dropped
  for (const { key, seen } of errors) await exceptionSeen(itx, key, seen);
  // a failed append is dropped: `pageEventsRoute` answers 202
  if (batch.length > 0) await itx.cd(PAGES).appendOffsets(...batch);
  return done(204);
}
