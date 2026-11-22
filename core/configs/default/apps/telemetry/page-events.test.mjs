// page-events.test.mjs — THE CHECKS OF page-events.ts: `node --test apps/telemetry/*.test.mjs`.
// Node cannot import a folder or the platform's `iterate/lib`, and has no `HTMLRewriter`: the
// hooks below hand over `./public/` as `{ "page.js": <the file's text> }` and a stand-in for
// `forwardIssues`, and a small stand-in `HTMLRewriter` records what the tag's code asks of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";

const PAGE_JS = readFileSync(new URL("./public/page.js", import.meta.url), "utf8");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "iterate/lib")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const forwardIssues = (forward) => { globalThis.forwardIssue = forward; }; export const errorCode = (error) => (typeof error === 'object' %26%26 error %26%26 'code' in error ? error.code : undefined);",
      };
    // the facet shell, as much of it as outside-days.ts asks: `ctx` and `publicMethods`
    if (specifier === "iterate/sdk")
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent('export class FacetDurableObject { static publicMethods = ["fetch"]; constructor(ctx, env) { this.ctx = ctx; this.env = env; } }')}`,
      };
    if (specifier === "./public/" && context.parentURL?.endsWith("/page-events.ts"))
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`export default ${JSON.stringify({ "page.js": PAGE_JS })};`)}`,
      };
    return next(specifier, context);
  },
});
const pe = await import("./page-events.ts");
const { OutsideDaysDurableObject, OUTSIDE_A_DAY, reserveDay } = await import("./outside-days.ts");
const {
  vitalsOf,
  marksOf,
  tagFormOf,
  tagFormFor,
  withPageTag,
  documentRequest,
  appOf,
  agentOf,
  placeOf,
  searchEngineOf,
  visitorOf,
  saltOf,
  forgetSalts,
  pathOf,
  pageRequested,
  pageEventsRoute,
  resetBounds,
  hostTagged,
  hostKnown,
  forgetHosts,
  forgetOutside,
  memberOf,
  pageTagFor,
  setAudience,
  PAGE_TAGS,
  BOUNDS,
  OUTSIDE_DAYS,
} = pe;

/** A Durable Object's SQLite (`ctx.storage.sql`), on Node's own SQLite: each statement runs at
 *  once, as the platform's does. */
const sqlOf = (db) => ({
  exec: (query, ...bindings) => {
    const rows = db.prepare(query).all(...bindings);
    return { toArray: () => rows };
  },
});
/** The facet `outside-days`: the real class, on a database of its own. Each call waits a turn
 *  first, as a call across isolates does, so calls of one test overlap. */
function outsideDays() {
  const db = new DatabaseSync(":memory:");
  const facet = new OutsideDaysDurableObject({ storage: { sql: sqlOf(db) } }, {});
  const days = { db, facet, calls: [], fails: false };
  days.reserve = async (records) => {
    days.calls.push(records);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (days.fails) throw new Error("the facet cannot be reached");
    return facet.reserve(records);
  };
  /** The day's sum, as the table holds it. */
  days.sum = () =>
    db.prepare("select coalesce(sum(records), 0) as sum from outside_days").get()?.sum ?? 0;
  return days;
}

/** A root that records each append, each `appendOffsets` call, keeps a kv in a map, and hosts the
 *  facet of the day's budget (`outsideDays`) at the one place page-events.ts names. */
function recordingMind(days = outsideDays()) {
  const appended = [];
  const batches = [];
  const store = new Map();
  const mind = { appended, batches, store, days };
  mind.itx = {
    cd: (path) => ({
      facets: {
        get: (name, spec) => {
          assert.deepEqual(
            [path, name, spec],
            [OUTSIDE_DAYS.path, OUTSIDE_DAYS.name, OUTSIDE_DAYS.spec],
          );
          return { reserve: (records) => days.reserve(records) };
        },
      },
      append: async (event) => void appended.push({ path, ...event }),
      appendOffsets: async (...events) => {
        batches.push({ path, count: events.length });
        for (const event of events) appended.push({ path, ...event });
        return events.map((_, i) => appended.length - events.length + i);
      },
    }),
    url: async () => "https://example.com",
    kv: {
      get: async (key) => store.get(key) ?? null,
      put: async (key, value) => {
        store.set(key, value);
        return { ok: true };
      },
      delete: async (key) => {
        store.delete(key);
        return { ok: true };
      },
    },
    [Symbol.dispose]() {},
  };
  return mind;
}
/** A host whose platform says who is signed in (`person`) and who is a member (`principal`): by
 *  default a person who is signed in is a member, and nobody signed in is none. */
const hostOf = (
  mind,
  person = null,
  principal = person ? { actor: person.userId, email: person.email } : null,
) => ({
  auth: { person: () => person, principal: () => principal },
  getItx: () => mind.itx,
});
const member = { userId: "u1", email: "member@example.com" };
/** Someone signed in who is no member: an end user of a host that takes people who are not members. */
const outsider = { userId: "u2", email: "someone@example.com" };
/** The hosts the mind served a page with the tag, as worker.ts says it (`hostTagged`). */
async function knowHosts(...origins) {
  const mind = recordingMind();
  for (const origin of origins) await hostTagged(hostOf(mind), new Request(`${origin}/`));
}
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** Date.now in a minute of its own, for the bounds; `run` gets it back as it was. */
let minuteOffset = 1_000;
async function inNewMinute(run) {
  const real = Date.now;
  const fixed = (Math.floor(real() / 60_000) + (minuteOffset += 10)) * 60_000 + 1_000;
  Date.now = () => fixed;
  try {
    return await run();
  } finally {
    Date.now = real;
  }
}

// ── the form of the tag ──
const POLICIES = {
  newsletter:
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  profile: "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  gunni:
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
  mail: "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  canvas2: "sandbox allow-scripts allow-forms; frame-ancestors 'self'",
  notes: "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  simulator:
    "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  simulatorScript:
    "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; script-src 'sha256-AbC123+/='; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

test("tagFormOf: no policy takes the linked tag", () => {
  assert.equal(tagFormOf(null), "linked");
  assert.equal(tagFormOf(""), "linked");
  assert.equal(tagFormOf("frame-ancestors 'none'"), "linked");
});
test("tagFormOf: the newsletter's apex page allows no script and no connect (default-src 'none')", () =>
  assert.equal(tagFormOf(POLICIES.newsletter), null));
test("tagFormOf: the profile page is sandboxed", () =>
  assert.equal(tagFormOf(POLICIES.profile), null));
test("tagFormOf: Gunni's Galaxy allows inline scripts alone and connects to itself: inline", () =>
  assert.equal(tagFormOf(POLICIES.gunni), "inline"));
test("tagFormOf: the mail app's script-src is 'unsafe-inline' alone (default-src 'self' does not count): inline", () =>
  assert.equal(tagFormOf(POLICIES.mail), "inline"));
test("tagFormOf: canvas2's frame is sandboxed", () =>
  assert.equal(tagFormOf(POLICIES.canvas2), null));
test("tagFormOf: a docs note is sandboxed", () => assert.equal(tagFormOf(POLICIES.notes), null));
test("tagFormOf: the simulator's page without a script connects nowhere (default-src 'none')", () =>
  assert.equal(tagFormOf(POLICIES.simulator), null));
test("tagFormOf: the simulator's page with a script allows one hash alone", () =>
  assert.equal(tagFormOf(POLICIES.simulatorScript), null));
test("tagFormOf: each rule of the brief", () => {
  assert.equal(tagFormOf("script-src 'self'"), "src");
  assert.equal(tagFormOf("default-src 'self'"), "src");
  assert.equal(tagFormOf("script-src https:; connect-src *"), "src");
  assert.equal(tagFormOf("script-src 'self' 'unsafe-inline'"), "linked");
  assert.equal(tagFormOf("script-src-elem 'unsafe-inline'; script-src 'self'"), "inline");
  assert.equal(tagFormOf("script-src 'self'; connect-src 'none'"), null);
  assert.equal(tagFormOf("script-src 'self'; connect-src https://api.example.com"), null);
  assert.equal(tagFormOf("script-src 'nonce-abc' 'unsafe-inline' 'self'"), null);
  assert.equal(tagFormOf("script-src 'self' 'strict-dynamic'"), null);
  assert.equal(tagFormOf("script-src https://cdn.example.com"), null);
  assert.equal(tagFormOf("SCRIPT-SRC 'SELF'"), "src");
});
test("tagFormOf: several policies must each allow the form", () => {
  assert.equal(tagFormOf("script-src 'self', frame-ancestors 'none'"), "src");
  assert.equal(tagFormOf("script-src 'self', script-src 'unsafe-inline'"), null);
  assert.equal(tagFormOf("script-src 'self', sandbox"), null);
});

const page = (headers = {}, status = 200) =>
  new Response("<html><head></head><body>x</body></html>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
const navigation = (
  headers = {},
  url = "https://blog.example.com/posts/hello?utm_source=x&token=abc",
  method = "GET",
) =>
  new Request(url, {
    method,
    headers: {
      "sec-fetch-dest": "document",
      accept: "text/html",
      "user-agent": CHROME,
      "cf-connecting-ip": "203.0.113.9",
      ...headers,
    },
  });

test("tagFormFor: a page takes the form of its policy; any other answer none", () => {
  assert.equal(tagFormFor(navigation(), page()), "linked");
  assert.equal(
    tagFormFor(navigation(), page({ "content-security-policy": POLICIES.mail })),
    "inline",
  );
  assert.equal(
    tagFormFor(navigation(), page({ "content-security-policy": POLICIES.newsletter })),
    null,
  );
  assert.equal(tagFormFor(navigation({}, undefined, "POST"), page()), null);
  assert.equal(tagFormFor(navigation({ "sec-fetch-dest": "iframe" }), page()), null);
  assert.equal(tagFormFor(navigation(), page({ "x-page-events": "off" })), null);
  assert.equal(
    tagFormFor(navigation(), page({ "content-disposition": "attachment; filename=a.html" })),
    null,
  );
  assert.equal(tagFormFor(navigation(), page({ "content-encoding": "gzip" })), null);
  assert.equal(tagFormFor(navigation(), page({ "content-type": "application/json" })), null);
  assert.equal(
    tagFormFor(
      navigation(),
      new Response(null, { status: 304, headers: { "content-type": "text/html" } }),
    ),
    null,
  );
  assert.equal(tagFormFor(navigation(), page({}, 404)), "linked");
});

test("documentRequest: a page request loses its validators; any other request stays as it is", () => {
  const plain = navigation();
  assert.equal(documentRequest(plain), plain);
  const stripped = documentRequest(
    navigation({ "if-none-match": '"abc"', "if-modified-since": "x" }),
  );
  assert.equal(
    stripped.headers.has("if-none-match") || stripped.headers.has("if-modified-since"),
    false,
  );
  const script = new Request("https://blog.example.com/app.js", {
    headers: { accept: "*/*", "if-none-match": '"abc"' },
  });
  assert.equal(documentRequest(script), script);
});

// ── the stand-in HTMLRewriter ──
class FakeRewriter {
  static last;
  constructor() {
    this.selectors = [];
    this.handlers = {};
    this.added = [];
    FakeRewriter.last = this;
  }
  on(selector, handler) {
    this.selectors.push(selector);
    this.handlers[selector] = handler;
    return this;
  }
  onDocument(handler) {
    this.document = handler;
    return this;
  }
  /** Calls the handlers for the elements the test says the page has, then the document's end. */
  transform(answer) {
    for (const name of FakeRewriter.elements)
      this.handlers[name]?.element({
        prepend: (content, options) => this.added.push({ at: `${name}:prepend`, content, options }),
      });
    this.document?.end?.({
      append: (content, options) => this.added.push({ at: "end:append", content, options }),
    });
    return answer;
  }
}
globalThis.HTMLRewriter = FakeRewriter;

test("withPageTag: first in the head, once, and the answer's etag and length go", () => {
  FakeRewriter.elements = ["head", "body"];
  const answer = withPageTag(page({ etag: '"v1"', "content-length": "40" }), "linked");
  assert.deepEqual(FakeRewriter.last.selectors, ["head", "body"]);
  assert.deepEqual(FakeRewriter.last.added, [
    { at: "head:prepend", content: PAGE_TAGS.linked, options: { html: true } },
  ]);
  assert.equal(answer.headers.has("etag") || answer.headers.has("content-length"), false);
});
test("withPageTag: no head, first in the body; neither, at the end", () => {
  FakeRewriter.elements = ["body"];
  withPageTag(page(), "src");
  assert.deepEqual(
    FakeRewriter.last.added.map((a) => [a.at, a.content]),
    [["body:prepend", PAGE_TAGS.src]],
  );
  FakeRewriter.elements = [];
  withPageTag(page(), "inline");
  assert.deepEqual(
    FakeRewriter.last.added.map((a) => [a.at, a.content]),
    [["end:append", PAGE_TAGS.inline]],
  );
});
test("the three tags: linked keeps early errors then loads the script async at low priority, src is that script alone, inline holds the whole script and cannot end early", () => {
  assert.match(
    PAGE_TAGS.linked,
    /^<script>\(function\(w\)\{if\(w\.__pageEvents\)return;.*<\/script><script async fetchpriority="low" src="\/\.page\.js\?v=[a-z0-9]+"><\/script>$/,
  );
  assert.equal(PAGE_TAGS.linked.match(/<script/g).length, 2);
  assert.match(
    PAGE_TAGS.src,
    /^<script async fetchpriority="low" src="\/\.page\.js\?v=[a-z0-9]+"><\/script>$/,
  );
  assert.ok(PAGE_TAGS.linked.endsWith(PAGE_TAGS.src), "the linked form ends with the src form");
  assert.ok(
    PAGE_TAGS.inline.startsWith("<script>") && PAGE_TAGS.inline.includes("capturePageEvent"),
  );
  assert.equal(PAGE_TAGS.inline.match(/<\/script/gi).length, 1);
  assert.equal(/<!--/.test(PAGE_TAGS.inline), false);
});
/** The keep-lines of the linked form, run in a stand-in page. */
function keepLinesIn() {
  const listeners = {};
  const window = { addEventListener: (type, fn) => (listeners[type] ??= []).push(fn) };
  window.window = window;
  const keepLines = PAGE_TAGS.linked.slice(
    0,
    PAGE_TAGS.linked.indexOf("</script>") + "</script>".length,
  );
  vm.runInContext(keepLines.replace(/^<script>|<\/script>$/g, ""), vm.createContext(window));
  return { listeners, window };
}
test("the linked form's keep-lines keep at most 20 early errors and rejections until the script runs, and run once", () => {
  const page = keepLinesIn();
  assert.equal(page.listeners.error.length, 1);
  assert.equal(page.listeners.unhandledrejection.length, 1);
  for (let i = 0; i < 25; i++) page.listeners.error[0]({ type: "error" });
  page.listeners.unhandledrejection[0]({ type: "unhandledrejection" });
  assert.equal(page.window.__pageEvents.early.length, 20);
});

// ── who, where, what ──
test("appOf: the first label; site on the apex and www", () => {
  assert.equal(appOf("blog.iterate.com"), "blog");
  assert.equal(appOf("iterate.com"), "site");
  assert.equal(appOf("www.iterate.com"), "site");
  assert.equal(appOf("Bad_Label.iterate.com"), "site");
});
const AGENTS = {
  chromeMac: [
    CHROME,
    {
      browser: "Chrome",
      browserVersion: "131.0.0.0",
      os: "macOS",
      osVersion: "10.15.7",
      device: "desktop",
    },
  ],
  safariIphone: [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    { browser: "Safari", browserVersion: "17.5", os: "iOS", osVersion: "17.5", device: "mobile" },
  ],
  safariIpad: [
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    {
      browser: "Safari",
      browserVersion: "17.5",
      os: "iPadOS",
      osVersion: "17.5",
      device: "tablet",
    },
  ],
  firefoxWindows: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    {
      browser: "Firefox",
      browserVersion: "133.0",
      os: "Windows",
      osVersion: "10.0",
      device: "desktop",
    },
  ],
  edgeWindows: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
    {
      browser: "Edge",
      browserVersion: "142.0.0.0",
      os: "Windows",
      osVersion: "10.0",
      device: "desktop",
    },
  ],
  chromeAndroid: [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
    {
      browser: "Chrome",
      browserVersion: "142.0.0.0",
      os: "Android",
      osVersion: "14",
      device: "mobile",
    },
  ],
};
test("agentOf: the browser and its version, the system and its version, the device, of six real user agents", () => {
  for (const [name, [ua, agent]] of Object.entries(AGENTS))
    assert.deepEqual(agentOf(ua), agent, name);
  assert.deepEqual(
    agentOf(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1",
    ),
    { browser: "Chrome", browserVersion: "131.0", os: "iOS", osVersion: "18.0", device: "mobile" },
  );
});
test("agentOf: a bot is a bot; an empty user agent has no versions", () => {
  assert.deepEqual(
    agentOf("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"),
    { browser: "bot", os: "other", device: "bot" },
  );
  assert.equal(agentOf(`${CHROME} HeadlessChrome`).device, "bot");
  assert.deepEqual(agentOf(""), { browser: "other", os: "other", device: "desktop" });
});
test("placeOf: request.cf first, then the headers; each key only with a value; null when nothing is known", () => {
  const fromCf = new Request("https://blog.example.com/", {
    headers: { "cf-ipcity": "Header City" },
  });
  Object.defineProperty(fromCf, "cf", {
    value: {
      country: "GB",
      region: "England",
      regionCode: "ENG",
      city: "London",
      postalCode: "EC1A",
      continent: "EU",
      latitude: "51.50853",
      longitude: "-0.12574",
      timezone: "Europe/London",
      asn: 1234,
    },
  });
  assert.deepEqual(placeOf(fromCf), {
    region: "England",
    regionCode: "ENG",
    city: "London",
    postalCode: "EC1A",
    continent: "EU",
    timezone: "Europe/London",
    latitude: 51.51,
    longitude: -0.13,
  });
  const fromHeaders = new Request("https://blog.example.com/", {
    headers: {
      "cf-region": "Bavaria",
      "cf-ipcity": "Munich ".repeat(20),
      "cf-iplatitude": "48.1371",
      "cf-iplongitude": "999",
      "cf-ipcontinent": "EU",
    },
  });
  assert.deepEqual(placeOf(fromHeaders), {
    region: "Bavaria",
    city: "Munich ".repeat(20).slice(0, 80),
    continent: "EU",
    latitude: 48.14,
  });
  assert.equal(placeOf(new Request("https://blog.example.com/")), null);
  const broken = new Request("https://blog.example.com/");
  Object.defineProperty(broken, "cf", {
    get() {
      throw new Error("no cf");
    },
  });
  assert.equal(placeOf(broken), null, "a cf that throws is no place");
});
test("searchEngineOf: by the host's registrable name; none for another site", () => {
  assert.equal(searchEngineOf("www.google.co.uk"), "google");
  assert.equal(searchEngineOf("search.brave.com"), "brave");
  assert.equal(searchEngineOf("duckduckgo.com"), "duckduckgo");
  assert.equal(searchEngineOf("www.bing.com"), "bing");
  assert.equal(searchEngineOf("news.ycombinator.com"), undefined);
  assert.equal(searchEngineOf("google.example.com"), undefined);
  assert.equal(searchEngineOf(undefined), undefined);
});
// allow-high-entropy-next-line: a made-up day's secret of the visitor hash
const SALT = "0123456789abcdef0123456789abcdef";
test("visitorOf: one id for a day and a secret; another day, secret or browser, another id; none with no secret or no address", async () => {
  const request = navigation();
  const today = await visitorOf(request, SALT, "2026-11-21");
  assert.match(today, /^[0-9a-f]{12}$/);
  assert.equal(await visitorOf(navigation(), SALT, "2026-11-21"), today);
  // one person is one visitor on every app of the mind
  assert.equal(
    await visitorOf(
      new Request("https://dash.example.com/agents", { headers: request.headers }),
      SALT,
      "2026-11-21",
    ),
    today,
  );
  assert.notEqual(await visitorOf(request, SALT, "2026-11-22"), today);
  assert.notEqual(
    // allow-high-entropy-next-line: a made-up day's secret of the visitor hash
    await visitorOf(request, "fedcba9876543210fedcba9876543210", "2026-11-21"),
    today,
  );
  assert.notEqual(
    await visitorOf(navigation({ "user-agent": "other" }), SALT, "2026-11-21"),
    today,
  );
  assert.equal(await visitorOf(request, null, "2026-11-21"), null);
  assert.equal(await visitorOf(new Request("https://blog.example.com/"), SALT), null);
});
test("saltOf: makes one secret, reads it back, keeps it for the isolate, and deletes the keys of two and three days before", async () => {
  forgetSalts();
  const mind = recordingMind();
  for (const day of ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"])
    mind.store.set(`page-events/salt/${day}`, "old");
  const salt = await saltOf(mind.itx, "2026-11-21");
  assert.match(salt, /^[0-9a-f]{32}$/);
  assert.equal(mind.store.get("page-events/salt/2026-11-21"), salt);
  assert.deepEqual([...mind.store.keys()].sort(), [
    "page-events/salt/2026-11-17",
    "page-events/salt/2026-11-20",
    "page-events/salt/2026-11-21",
  ]);
  // kept: a kv that would throw is not asked again
  assert.equal(
    await saltOf({ kv: { get: () => Promise.reject(new Error("no")) } }, "2026-11-21"),
    salt,
  );
  // another isolate reads the stored one
  forgetSalts();
  assert.equal(await saltOf(mind.itx, "2026-11-21"), salt);
  // two isolates that both made one agree on the stored one
  forgetSalts();
  const raced = recordingMind();
  raced.itx.kv.put = async (key) => {
    raced.store.set(key, "f".repeat(32));
    return { ok: true };
  };
  assert.equal(await saltOf(raced.itx, "2026-11-21"), "f".repeat(32));
  forgetSalts();
});
test("saltOf: a kv that throws gives null, and the route drops the send (202): no record with a null visitor", async () => {
  forgetSalts();
  resetBounds();
  const throwing = {
    get: () => Promise.reject(new Error("kv down")),
    put: () => Promise.reject(new Error("kv down")),
    delete: () => Promise.reject(new Error("kv down")),
  };
  assert.equal(await saltOf({ kv: throwing }, "2026-11-21"), null);
  const mind = recordingMind();
  mind.itx.kv = throwing;
  assert.equal((await pageEventsRoute(send([VIEWED]), hostOf(mind, member))).status, 202);
  assert.equal(mind.appended.length, 0);
  await pageRequested(
    navigation({}, "https://iterate.com/newsletter"),
    page({ "content-security-policy": POLICIES.newsletter }),
    hostOf(mind),
  );
  assert.equal(mind.appended.length, 0, "a view counted from its request is dropped too");
  assert.deepEqual(mind.days.calls, [], "nothing was reserved");
  forgetSalts();
});
test("pathOf: a path keeps its words and loses its ids, its query and its hash", () => {
  assert.equal(pathOf("/agents/coding-chief-of-staff"), "/agents/coding-chief-of-staff");
  assert.equal(
    pathOf("/posts/why-we-built-iterate-on-cloudflare-workers-and-durable-objects"),
    "/posts/why-we-built-iterate-on-cloudflare-workers-and-durable-objects",
  );
  assert.equal(pathOf("/in/agents/jonas/x"), "/in/agents/jonas/x");
  // the simulator's ids (apps/cloudflare-simulator/app.ts): `i` + 26 and `c` + 16 base32 characters
  assert.equal(
    pathOf("/i/iabcdefghijklmnopqrstuvwx23/oauth2/consents/cqrstuvwxyz234567"),
    "/i/<id>/oauth2/consents/<id>",
  );
  assert.equal(
    pathOf("/i/ia2bcdefghijklmnopqrstuvwxy/oauth2/consents/c7bcdefghijklmnop/approve"),
    "/i/<id>/oauth2/consents/<id>/approve",
  );
  // allow-high-entropy-next-line: a made-up id in a path, which pathOf must turn into <id>
  assert.equal(pathOf("/contexts/3f2b8c1e-9a4d-4b7e-8f21-0c6d5e4a3b2f/log"), "/contexts/<id>/log");
  // allow-high-entropy-next-line: a made-up id in a path, which pathOf must turn into <id>
  assert.equal(pathOf("/share/kQ3x-9vZ_aB7cD1eF2gH3iJ4kL5mN6oP7qR8sT9uV0w"), "/share/<id>");
  // allow-high-entropy-next-line: a made-up id in a path, which pathOf must turn into <id>
  assert.equal(pathOf("/blob/0123456789abcdef0123456789abcdef01234567"), "/blob/<id>");
  assert.equal(pathOf("/a/b?token=SECRET#frag"), "/a/b");
  assert.equal(pathOf("/notifications/integrations"), "/notifications/integrations");
  // 20 and more characters with both cases: an id, with or without a digit
  assert.equal(pathOf("/s/kQxvZaBcDeFgHiJkLmNoPq"), "/s/<id>");
  assert.equal("kQxvZaBcDeFgHiJkLmNoPq".length, 22);
  assert.equal(
    pathOf("/s/kQxvZaBcDeFgHiJkLmN"),
    "/s/kQxvZaBcDeFgHiJkLmN",
    "19 characters and no digit stay",
  );
  assert.equal(pathOf(`/${"word-".repeat(100)}`).length, 200);
  assert.equal(pathOf(undefined), "");
});

// ── a page that takes no tag ──
test("pageRequested: a page whose policy allows no form is one page/viewed from its request", async () => {
  const mind = recordingMind();
  const request = navigation(
    {
      // allow-high-entropy-next-line: a made-up id in a referrer or landing path, which the route must cut
      referer: "https://news.example.com/item/abcdef0123456789abcdef0123456789?x=1",
      "cf-ipcountry": "DE",
      "accept-language": "de-DE,de;q=0.9",
    },
    // allow-high-entropy-next-line: a made-up id in a referrer or landing path, which the route must cut
    "https://iterate.com/newsletter/3f2b8c1e-9a4d-4b7e-8f21-0c6d5e4a3b2f?utm_source=hn&token=abc&ref=x",
  );
  await pageRequested(
    request,
    page({ "content-security-policy": POLICIES.newsletter }),
    hostOf(mind, member),
  );
  const [event] = mind.appended;
  assert.equal(event.path, "/pages");
  assert.equal(event.payload.app, "site");
  assert.equal(event.type, "events.iterate.com/page/viewed");
  assert.equal(event.payload.how, "request");
  assert.equal(event.payload.pathname, "/newsletter/<id>");
  assert.deepEqual(event.payload.campaign, { utm_source: "hn", ref: "x" });
  assert.deepEqual(event.payload.from, { host: "news.example.com", pathname: "/item/<id>" });
  assert.deepEqual(event.payload.actor, member);
  assert.equal(event.payload.member, true);
  assert.equal(event.payload.country, "DE");
  assert.equal(event.payload.language, "de-DE");
  assert.match(event.payload.visitor, /^[0-9a-f]{12}$/);
  assert.ok(
    !JSON.stringify(event).includes("token") && !JSON.stringify(event).includes("203.0.113.9"),
  );
});
test("pageRequested: the host, the place, the agent, the user agent, the search engine and the click ids, as a page sends them", async () => {
  const mind = recordingMind();
  const request = navigation(
    {
      referer: "https://www.google.co.uk/",
      "cf-ipcountry": "GB",
      "cf-ipcity": "London",
      "cf-iplatitude": "51.5",
      "user-agent": AGENTS.safariIphone[0],
    },
    "https://iterate.com/newsletter?gclid=Cj0KCQiA_abc-123&fbclid=IwAR0x&session=zzz&utm_medium=cpc",
  );
  await pageRequested(
    request,
    page({ "content-security-policy": POLICIES.newsletter }),
    hostOf(mind, member),
  );
  const p = mind.appended[0].payload;
  assert.equal(p.host, "iterate.com");
  assert.deepEqual(p.place, { city: "London", latitude: 51.5 });
  assert.deepEqual(p.agent, AGENTS.safariIphone[1]);
  assert.equal(p.userAgent, AGENTS.safariIphone[0]);
  assert.equal(p.searchEngine, "google");
  assert.deepEqual(p.campaign, { gclid: "Cj0KCQiA_abc-123", fbclid: "IwAR0x", utm_medium: "cpc" });
  assert.equal("tag" in p || "timezoneOffset" in p, false, "no script, no tag");
  assert.ok(!JSON.stringify(p).includes("zzz"));
});
test("pageRequested: no other page is counted", () => {
  const mind = recordingMind();
  const csp = { "content-security-policy": POLICIES.newsletter };
  assert.equal(
    pageRequested(navigation(), page(), hostOf(mind)),
    null,
    "no policy: the tag counts it",
  );
  assert.equal(
    pageRequested(navigation(), page({ "content-security-policy": POLICIES.mail }), hostOf(mind)),
    null,
    "the inline tag counts it",
  );
  assert.equal(
    pageRequested(navigation({ "sec-fetch-dest": "empty" }), page(csp), hostOf(mind)),
    null,
  );
  assert.equal(
    pageRequested(navigation({ "user-agent": "Googlebot/2.1" }), page(csp), hostOf(mind)),
    null,
  );
  assert.equal(pageRequested(navigation(), page(csp, 404), hostOf(mind)), null);
  assert.equal(
    pageRequested(navigation(), page({ ...csp, "x-page-events": "off" }), hostOf(mind)),
    null,
  );
  assert.equal(pageRequested(navigation({ "sec-gpc": "1" }), page(csp), hostOf(mind)), null);
  assert.equal(
    pageRequested(
      navigation(),
      page({
        "content-security-policy": "sandbox; default-src 'none'",
        "content-disposition": "attachment",
      }),
      hostOf(mind),
    ),
    null,
  );
});

// ── the route ──
const ORIGIN = "https://blog.example.com";
let pages = 0;
const pageId = () => `p${(pages += 1).toString().padStart(9, "0")}`;
const send = (
  events,
  { headers = {}, page: extra = {}, body, ip = "198.51.100.7", host = ORIGIN } = {},
) =>
  new Request(`${host}/.page-events`, {
    method: "POST",
    headers: {
      origin: host,
      "content-type": "text/plain",
      "user-agent": CHROME,
      "cf-connecting-ip": ip,
      "cf-ipcountry": "GB",
      ...headers,
    },
    body:
      body ??
      JSON.stringify({
        page: {
          id: pageId(),
          build: "0.1.0-main",
          title: "Hello",
          screen: [1440, 900],
          viewport: [1200, 800],
          language: "en-GB",
          timezone: "Europe/London",
          ...extra,
        },
        events,
      }),
  });
await knowHosts(ORIGIN);
const VIEWED = {
  type: "viewed",
  view: 1,
  n: 1,
  at: "2026-11-21T10:00:00.000Z",
  how: "load",
  pathname: "/posts/hello?token=abc#x",
  // allow-high-entropy-next-line: a made-up id in a referrer or landing path, which the route must cut
  from: { host: "news.example.com", pathname: "/item/abcdef0123456789abcdef0123456789" },
  campaign: { utm_source: "hn", session: "secret", ref: "x" },
};

test("the route: the script, its cache, and any other path is not it", async () => {
  const mind = recordingMind();
  const script = await pageEventsRoute(new Request(`${ORIGIN}/.page.js`), hostOf(mind));
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  const version = PAGE_TAGS.src.match(/v=([a-z0-9]+)/)[1];
  // the served script carries its own version, in every form of the tag
  assert.equal(await script.text(), PAGE_JS.replace('"%TAG%"', `"${version}"`));
  assert.ok(PAGE_TAGS.inline.includes(`const TAG = "${version}"`));
  assert.equal(script.headers.get("cache-control"), "public, max-age=60");
  assert.match(
    (
      await pageEventsRoute(new Request(`${ORIGIN}/.page.js?v=${version}`), hostOf(mind))
    ).headers.get("cache-control"),
    /immutable/,
  );
  assert.equal(
    (await pageEventsRoute(new Request(`${ORIGIN}/.page.js`, { method: "POST" }), hostOf(mind)))
      .status,
    405,
  );
  assert.equal(await pageEventsRoute(new Request(`${ORIGIN}/posts/hello`), hostOf(mind)), null);
});

test("the route's refusals: 405, 403, 413, 400, and none appends", async () => {
  const mind = recordingMind();
  const status = async (request) => (await pageEventsRoute(request, hostOf(mind))).status;
  assert.equal(
    await status(new Request(`${ORIGIN}/.page-events`, { headers: { origin: ORIGIN } })),
    405,
  );
  assert.equal(await status(send([VIEWED], { headers: { origin: "https://evil.example" } })), 403);
  const noOrigin = (site) =>
    new Request(`${ORIGIN}/.page-events`, {
      method: "POST",
      headers: site ? { "sec-fetch-site": site } : {},
      body: "{}",
    });
  assert.equal(await status(noOrigin(null)), 403);
  assert.equal(await status(noOrigin("cross-site")), 403);
  assert.equal(await status(send([], { body: "x".repeat(64_001) })), 413);
  assert.equal(await status(send([], { body: "x", headers: { "content-length": "100000" } })), 413);
  assert.equal(await status(send([], { body: "not json" })), 400);
  assert.equal(
    await status(send([], { body: JSON.stringify({ page: { id: "short" }, events: [] }) })),
    400,
  );
  assert.equal(
    await status(send([], { body: JSON.stringify({ page: { id: pageId() }, events: "x" }) })),
    400,
  );
  for (const body of ["null", "5", '"x"', "[]"])
    assert.equal(await status(send([], { body })), 400, body);
  assert.equal(mind.appended.length, 0);
  // no origin header, and the browser says it is the same origin: taken
  assert.equal(
    await status(
      new Request(`${ORIGIN}/.page-events`, {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ page: { id: pageId() }, events: [] }),
      }),
    ),
    204,
  );
});

test("the route: a view, with the platform's actor, the path alone and the campaign tags alone", async () => {
  resetBounds();
  const mind = recordingMind();
  assert.equal(
    (
      await pageEventsRoute(
        send([VIEWED], { page: { email: "someone-else@example.com" } }),
        hostOf(mind, member),
      )
    ).status,
    204,
  );
  const [event] = mind.appended;
  assert.equal(event.path, "/pages");
  assert.equal(event.payload.app, "blog");
  assert.equal(event.type, "events.iterate.com/page/viewed");
  assert.match(event.idempotencyKey, /^page\/viewed:p\d+:1$/);
  const p = event.payload;
  assert.equal(p.pathname, "/posts/hello");
  assert.deepEqual(p.from, { host: "news.example.com", pathname: "/item/<id>" });
  assert.deepEqual(p.campaign, { utm_source: "hn", ref: "x" });
  assert.deepEqual(p.actor, member);
  assert.equal(p.member, true);
  assert.deepEqual(p.screen, [1440, 900]);
  assert.equal(p.title, "Hello");
  assert.equal(p.build, "0.1.0-main");
  assert.equal(p.at, "2026-11-21T10:00:00.000Z");
  assert.ok(
    !/token|session|someone-else|198\.51/.test(JSON.stringify(event)),
    JSON.stringify(event),
  );
});

test("the route: host, place, agent, user agent, tag and time zone offset on every page event; search engine and click ids on a view", async () => {
  resetBounds();
  const mind = recordingMind();
  const view = {
    ...VIEWED,
    from: { host: "www.google.co.uk", pathname: "/search" },
    campaign: {
      utm_source: "google",
      gclid: "g".repeat(300),
      msclkid: "abc 123<x>",
      unknown: "dropped",
    },
  };
  const headers = {
    "user-agent": `${AGENTS.edgeWindows[0]} key=${"s".repeat(40)} ${"x ".repeat(200)}`,
    "cf-region": "England",
    "cf-iplongitude": "-0.12574",
  };
  await pageEventsRoute(
    send([view, { type: "left", n: 2, scrolled: 40 }], {
      headers,
      page: { tag: "d3hqhm", timezoneOffset: -60 },
    }),
    hostOf(mind, member),
  );
  const [viewed, left] = mind.appended.map((e) => e.payload);
  for (const p of [viewed, left]) {
    assert.equal(p.host, "blog.example.com");
    assert.equal(p.country, "GB");
    assert.deepEqual(p.place, { region: "England", longitude: -0.13 });
    assert.deepEqual(p.agent, AGENTS.edgeWindows[1]);
    assert.equal(p.userAgent.length, 256);
    assert.ok(
      p.userAgent.startsWith(AGENTS.edgeWindows[0]) &&
        // the long run, its key with it, is cut first (./cut.ts)
        p.userAgent.includes("<cut>") &&
        !p.userAgent.includes("sss"),
    );
    assert.equal(p.tag, "d3hqhm");
  }
  assert.equal(viewed.searchEngine, "google");
  assert.equal(viewed.timezoneOffset, -60);
  // a tag through the cut; a click id kept as PostHog keeps it: its letters, digits and `._~-`,
  // at most 200
  assert.deepEqual(viewed.campaign, {
    utm_source: "google",
    gclid: "g".repeat(200),
    msclkid: "abc123x",
  });
  assert.equal(left.scrolled, 40);
  assert.equal("searchEngine" in left, false);
});
test("the route: no search engine for another site; an offset, a scroll or a tag out of range is dropped", async () => {
  resetBounds();
  const mind = recordingMind();
  await pageEventsRoute(
    send([VIEWED, { type: "left", n: 2, scrolled: 101 }, { type: "left", n: 3, scrolled: 12.5 }], {
      page: { tag: "<script>", timezoneOffset: 901 },
    }),
    hostOf(mind, member),
  );
  await pageEventsRoute(
    send([{ ...VIEWED, n: 4 }], { page: { timezoneOffset: "60" } }),
    hostOf(mind, member),
  );
  const [viewed, left, half, again] = mind.appended.map((e) => e.payload);
  assert.equal("searchEngine" in viewed, false);
  assert.equal("timezoneOffset" in viewed || "timezoneOffset" in again, false);
  assert.equal("tag" in viewed, false);
  assert.equal("scrolled" in left || "scrolled" in half, false);
  assert.equal("place" in viewed, false, "no place key when nothing is known");
});
test("an error's more holds the host, the place, the agent, the user agent and the tag", async () => {
  resetBounds();
  const mind = recordingMind();
  await pageEventsRoute(
    send([{ type: "error", n: 1, kind: "uncaught", message: "boom", fingerprint: "pl01" }], {
      headers: { "cf-ipcity": "Paris" },
      page: { tag: "abc123" },
    }),
    hostOf(mind, member),
  );
  const p = mind.appended[0].payload;
  assert.equal(p.host, "blog.example.com");
  assert.deepEqual(p.place, { city: "Paris" });
  assert.equal(p.agent.browser, "Chrome");
  assert.equal(p.userAgent, CHROME);
  assert.equal(p.tag, "abc123");
});

test("the route: left and captured; a captured value that is no plain value is dropped; an unknown type is dropped", async () => {
  resetBounds();
  const mind = recordingMind();
  const events = [
    {
      type: "left",
      view: 1,
      n: 2,
      pathname: "/a",
      openMs: 5_000,
      seenMs: 4_000.4,
      scrolled: 250,
      load: { firstByte: 120, ready: 300, loaded: 400, largestPaint: 350, shift: 0.05 },
    },
    {
      type: "captured",
      view: 1,
      n: 3,
      pathname: "/a",
      name: "signup",
      values: { plan: "pro", seats: 3, ok: true, nested: { a: 1 }, list: [1] },
    },
    { type: "captured", n: 4, name: "" },
    { type: "anything", n: 5 },
    "not an object",
  ];
  await pageEventsRoute(send(events), hostOf(mind));
  assert.deepEqual(
    mind.appended.map((e) => e.type),
    ["events.iterate.com/page/left", "events.iterate.com/page/event-captured"],
  );
  assert.equal("scrolled" in mind.appended[0].payload, false, "out of range: dropped, not clamped");
  assert.equal(mind.appended[0].payload.seenMs, 4_000);
  assert.deepEqual(mind.appended[0].payload.load, {
    firstByte: 120,
    ready: 300,
    loaded: 400,
    largestPaint: 350,
    shift: 0.05,
  });
  assert.deepEqual(mind.appended[1].payload.values, { plan: "pro", seats: 3, ok: true });
  assert.equal(mind.appended[1].payload.actor, null);
  assert.equal("member" in mind.appended[1].payload, false, "no key at all for anyone else");
});

test("the route: left takes fcp, inp, cls and marks; a value out of range is dropped, not clamped", async () => {
  resetBounds();
  const mind = recordingMind();
  const load = {
    firstByte: 120,
    ready: 300,
    loaded: 400,
    largestPaint: 350,
    shift: 0.05,
    fcp: 210,
    inp: 96,
    cls: 0.0421,
  };
  const marks = {
    "iterate:itx-open": 412,
    "iterate:ok.2_x-y": 0,
    "iterate:": 5,
    "iterate:Upper": 5,
    other: 7,
    "iterate:late": 600_001,
    "iterate:half": 1.5,
    [`iterate:${"a".repeat(41)}`]: 9,
  };
  const events = [
    { type: "left", view: 1, n: 2, pathname: "/a", openMs: 5_000, seenMs: 4_000, load, marks },
    {
      type: "left",
      view: 2,
      n: 3,
      pathname: "/b",
      openMs: 900,
      seenMs: 900,
      inp: 240,
      cls: 0.2,
      fcp: 9,
      marks: { "iterate:itx-open": 1_900 },
    },
    {
      type: "left",
      view: 1,
      n: 4,
      pathname: "/c",
      openMs: 1,
      seenMs: 1,
      load: { firstByte: 1, fcp: -1, inp: 600_001, cls: 10.5 },
      inp: 5,
    },
    {
      type: "left",
      view: 3,
      n: 5,
      pathname: "/d",
      openMs: 1,
      seenMs: 1,
      inp: 12.5,
      cls: "0.1",
      marks: { other: 1 },
    },
    {
      type: "left",
      view: 1,
      n: 6,
      pathname: "/e",
      openMs: 1,
      seenMs: 1,
      load: { firstByte: 80, largestPaint: 600_000 },
    },
  ];
  await pageEventsRoute(send(events), hostOf(mind));
  const [first, second, third, fourth, fifth] = mind.appended.map((e) => e.payload);
  assert.deepEqual(first.load, {
    firstByte: 120,
    ready: 300,
    loaded: 400,
    largestPaint: 350,
    shift: 0.05,
    fcp: 210,
    inp: 96,
    cls: 0.042,
  });
  assert.deepEqual(first.marks, { "iterate:itx-open": 412, "iterate:ok.2_x-y": 0 });
  assert.equal("inp" in first, false, "the first view's vitals are in load");
  assert.deepEqual(
    [second.inp, second.cls, "fcp" in second, "load" in second],
    [240, 0.2, false, false],
  );
  assert.deepEqual(second.marks, { "iterate:itx-open": 1_900 });
  assert.deepEqual(third.load, { firstByte: 1, shift: 0 }, "out of range or absent: no key");
  assert.equal("inp" in third, false);
  assert.deepEqual(["inp" in fourth, "cls" in fourth, "marks" in fourth], [false, false, false]);
  assert.deepEqual(
    fifth.load,
    { firstByte: 80, shift: 0 },
    "a largest paint of 10 minutes or more is no paint",
  );
});
test("vitalsOf and marksOf: the ranges, and at most 20 marks", () => {
  assert.deepEqual(vitalsOf({ fcp: 0, inp: 600_000, cls: 10 }, true), {
    fcp: 0,
    inp: 600_000,
    cls: 10,
  });
  assert.deepEqual(vitalsOf({ fcp: 5, inp: -1, cls: -0.1 }, false), {});
  assert.deepEqual(vitalsOf({ cls: 0.12345, inp: Infinity }, false), { cls: 0.123 });
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`iterate:m${i}`, i]));
  assert.equal(Object.keys(marksOf(many)).length, 20);
  assert.equal(marksOf([1, 2]), undefined);
  assert.equal(marksOf({ "iterate:x": "12" }), undefined);
  const fortyEight = `iterate:${"ab.".repeat(13)}a`;
  assert.deepEqual(marksOf({ [fortyEight]: 3 }), { [fortyEight]: 3 }, "48 characters");
  // a run of 32 or more letters and digits could be a token: the cut would change it, so it goes
  assert.equal(marksOf({ [`iterate:${"a".repeat(40)}`]: 3 }), undefined);
});
test("the route: an outside person's left takes the same speed fields", async () => {
  resetBounds();
  forgetOutside();
  const mind = recordingMind();
  await pageEventsRoute(
    send([
      {
        type: "left",
        view: 1,
        n: 2,
        pathname: "/a",
        openMs: 1,
        seenMs: 1,
        load: { firstByte: 50, fcp: 80, inp: 40, cls: 0 },
        marks: { "iterate:itx-open": 300 },
      },
    ]),
    hostOf(mind, outsider, null),
  );
  const [left] = mind.appended;
  assert.equal("member" in left.payload, false);
  assert.deepEqual(
    [left.payload.load.fcp, left.payload.load.inp, left.payload.load.cls, left.payload.marks],
    [80, 40, 0, { "iterate:itx-open": 300 }],
  );
});

test("the route: an error is one exception/seen on /exceptions, scrubbed, with the page's key", async () => {
  resetBounds();
  const mind = recordingMind();
  const error = {
    type: "error",
    n: 6,
    view: 1,
    pathname: "/agents/x?secret=1",
    kind: "uncaught",
    message: "x is not a function at https://blog.example.com/app.js?session=abc",
    stack: "Error\n at f (https://blog.example.com/app.js?token=zzz:1:2)",
    fingerprint: "ab12",
    part: "first",
    count: 3,
  };
  await pageEventsRoute(send([error]), hostOf(mind, member));
  const [event] = mind.appended;
  assert.equal(event.path, "/exceptions");
  assert.equal(event.type, "events.iterate.com/exception/seen");
  assert.match(event.idempotencyKey, /^exception\/seen:page:blog:ab12:p\d+-first$/);
  assert.equal(event.payload.source.from, "page");
  assert.equal(event.payload.source.app, "blog");
  assert.deepEqual(event.payload.where, { pathname: "/agents/x" });
  assert.equal(event.payload.count, 3);
  assert.deepEqual(event.payload.actor, member);
  assert.equal(event.payload.member, true);
  assert.ok(event.payload.stack.includes("app.js:1:2"));
  assert.ok(!/zzz|session=abc|secret=1/.test(JSON.stringify(event)));
});

test("the route: Global Privacy Control sends errors alone, with no visitor", async () => {
  resetBounds();
  const mind = recordingMind();
  await pageEventsRoute(
    send(
      [VIEWED, { type: "error", n: 2, kind: "uncaught", message: "boom", fingerprint: "cd34" }],
      { headers: { "sec-gpc": "1" } },
    ),
    hostOf(mind),
  );
  assert.deepEqual(
    mind.appended.map((e) => e.path),
    ["/exceptions/outside"],
  );
  assert.equal(mind.appended[0].payload.visitor, null);
});

test("the route: one appendOffsets for the page events of a send, none for a send of errors alone", async () => {
  resetBounds();
  const mind = recordingMind();
  const error = { type: "error", n: 9, kind: "uncaught", message: "boom", fingerprint: "ef56" };
  await pageEventsRoute(
    send([VIEWED, { type: "left", n: 2 }, error, { type: "captured", n: 3, name: "x" }]),
    hostOf(mind),
  );
  assert.deepEqual(mind.batches, [{ path: "/pages", count: 3 }]);
  assert.deepEqual(mind.appended.map((e) => e.path).sort(), [
    "/exceptions/outside",
    "/pages",
    "/pages",
    "/pages",
  ]);
  await pageEventsRoute(send([{ ...error, fingerprint: "ef57" }]), hostOf(mind));
  assert.equal(mind.batches.length, 1);
});

test("the route: ten invented hosts land nothing anywhere, and the list of hosts is read once", () =>
  inNewMinute(async () => {
    forgetHosts();
    const mind = recordingMind();
    let reads = 0;
    const get = mind.itx.kv.get;
    mind.itx.kv.get = (key) => {
      if (key === "page-events/hosts") reads += 1;
      return get(key);
    };
    for (let n = 0; n < 10; n++) {
      const host = `https://made-up-${n}-${"x".repeat(n)}.example.com`;
      const answer = await pageEventsRoute(
        send(
          [
            VIEWED,
            { type: "error", n: 2, kind: "uncaught", message: `m${n}`, fingerprint: `h${n}` },
          ],
          { host, ip: `10.9.${n}.1` },
        ),
        hostOf(mind, member),
      );
      assert.equal(answer, null, "the host's own routing answers");
    }
    assert.equal(mind.appended.length, 0);
    assert.equal(reads, 1, "at most once in 10 s");
    await knowHosts(ORIGIN);
  }));

test("the route: an unknown host's report is null and appends nothing; after hostTagged it lands", async () => {
  forgetHosts();
  resetBounds();
  const mind = recordingMind();
  const host = "https://new-app.example.com";
  assert.equal(await pageEventsRoute(send([VIEWED], { host }), hostOf(mind, member)), null);
  assert.equal(mind.appended.length, 0);
  // another isolate served the page: the list in kv has it, read once the 10 s have passed
  await hostTagged(hostOf(mind), new Request(`${host}/`));
  forgetHosts();
  assert.equal((await pageEventsRoute(send([VIEWED], { host }), hostOf(mind, member))).status, 204);
  assert.equal(mind.appended.length, 1);
  assert.equal(mind.appended[0].payload.app, "new-app");
  // the script stays on every host
  assert.equal(
    (await pageEventsRoute(new Request("https://unknown.example.com/.page.js"), hostOf(mind)))
      .status,
    200,
  );
  await knowHosts(ORIGIN);
});

test("hostTagged: three hosts whose first pages come at once are all on the list (the isolate's writes go one after the other)", async () => {
  forgetHosts();
  const mind = recordingMind();
  // a kv whose answers come a tick later, so that writes which did not wait for each other would overlap
  const { get, put } = mind.itx.kv;
  mind.itx.kv.get = async (key) => {
    await new Promise((done) => setTimeout(done, 1));
    return get(key);
  };
  mind.itx.kv.put = async (key, value) => {
    await new Promise((done) => setTimeout(done, 1));
    return put(key, value);
  };
  const kept = ["blog", "david", "gunni"].map((label) =>
    hostTagged(hostOf(mind), new Request(`https://${label}.example.com/`)),
  );
  await Promise.all(kept);
  assert.deepEqual(JSON.parse(mind.store.get("page-events/hosts")), [
    "blog.example.com",
    "david.example.com",
    "gunni.example.com",
  ]);
  forgetHosts();
  await knowHosts(ORIGIN);
});
test("hostTagged: null when the isolate knows the host; else one read and one put; the list stops at 200", async () => {
  forgetHosts();
  const mind = recordingMind();
  const calls = [];
  const { get, put } = mind.itx.kv;
  mind.itx.kv.get = (key) => {
    calls.push(`get ${key}`);
    return get(key);
  };
  mind.itx.kv.put = (key, value) => {
    calls.push(`put ${key}`);
    return put(key, value);
  };
  const kept = hostTagged(hostOf(mind), new Request("https://one.example.com/a"));
  assert.ok(kept instanceof Promise);
  await kept;
  assert.deepEqual(calls, ["get page-events/hosts", "put page-events/hosts"]);
  assert.deepEqual(JSON.parse(mind.store.get("page-events/hosts")), ["one.example.com"]);
  assert.equal(hostTagged(hostOf(mind), new Request("https://one.example.com/b")), null);
  assert.equal(calls.length, 2);
  // a full list takes no more
  mind.store.set(
    "page-events/hosts",
    JSON.stringify(Array.from({ length: 200 }, (_, n) => `h${n}.example.com`)),
  );
  await hostTagged(hostOf(mind), new Request("https://two-hundred-and-one.example.com/"));
  assert.equal(JSON.parse(mind.store.get("page-events/hosts")).length, 200);
  // a kv that fails is dropped
  const broken = {
    getItx: () => ({ kv: { get: () => Promise.reject(new Error("no")) }, [Symbol.dispose]() {} }),
  };
  await hostTagged(broken, new Request("https://three.example.com/"));
  // hostKnown: what the isolate knows, with no read
  assert.equal(
    await hostKnown(
      { kv: { get: () => Promise.reject(new Error("not asked")) } },
      "one.example.com",
    ),
    true,
  );
  forgetHosts();
  await knowHosts(ORIGIN);
});

test("hostTagged and hostKnown: a flood of hosts grows neither the isolate's set nor the list past 200", async () => {
  forgetHosts();
  const mind = recordingMind();
  let kept = 0;
  for (let n = 0; n < 300; n++) {
    const write = hostTagged(hostOf(mind), new Request(`https://flood${n}.example.com/`));
    if (write) kept += 1;
    await write;
  }
  assert.equal(kept, 200, "the 201st host is never added: the bound comes first");
  assert.equal(JSON.parse(mind.store.get("page-events/hosts")).length, 200);
  assert.equal(
    await pageEventsRoute(send([VIEWED], { host: "https://flood250.example.com" }), hostOf(mind)),
    null,
  );
  // invented hosts that report: none is added, and the list stays as it was
  forgetHosts();
  const list = mind.store.get("page-events/hosts");
  for (let n = 0; n < 50; n++)
    assert.equal(await hostKnown(mind.itx, `invented${n}.example.com`), false);
  assert.equal(mind.store.get("page-events/hosts"), list);
  assert.equal(await hostKnown(mind.itx, "flood0.example.com"), true, "read back from the list");
  forgetHosts();
  await knowHosts(ORIGIN);
});

test("the route never throws: a getItx that throws, or an append that rejects, answers 202", async () => {
  resetBounds();
  const broken = {
    auth: { person: () => null, principal: () => null },
    getItx: () => {
      throw new Error("no mind");
    },
  };
  assert.equal((await pageEventsRoute(send([VIEWED]), broken)).status, 202);
  const mind = recordingMind();
  const cd = mind.itx.cd;
  mind.itx.cd = (path) => ({
    ...cd(path),
    appendOffsets: () => Promise.reject(new Error("append failed")),
  });
  assert.equal(
    (await pageEventsRoute(send([VIEWED, { type: "left", n: 2 }]), hostOf(mind))).status,
    202,
  );
  assert.equal(mind.appended.length, 0);
});

test("the route never throws: a body stream that fails answers 202 and appends nothing", async () => {
  resetBounds();
  const mind = recordingMind();
  const body = new ReadableStream({
    pull(controller) {
      controller.error(new Error("the connection was reset"));
    },
  });
  const request = new Request(`${ORIGIN}/.page-events`, {
    method: "POST",
    headers: { origin: ORIGIN, "cf-connecting-ip": "198.51.100.7" },
    body,
    duplex: "half",
  });
  assert.equal((await pageEventsRoute(request, hostOf(mind, member))).status, 202);
  assert.equal(mind.appended.length, 0);
});
test("the route never throws: a sent value whose String() throws answers 202; a page id that is no text is a 400", async () => {
  resetBounds();
  const mind = recordingMind();
  // JSON can hold an object whose `toString` and `valueOf` are no functions: String() throws on it
  const hostile = { toString: 1, valueOf: 1 };
  assert.throws(() => String(hostile));
  for (const event of [
    { ...VIEWED, type: hostile },
    { type: "error", n: 1, kind: hostile, message: "m", fingerprint: "st01" },
    { type: "error", n: 1, kind: "uncaught", message: hostile, fingerprint: "st02" },
  ])
    assert.equal(
      (await pageEventsRoute(send([event]), hostOf(mind, member))).status,
      202,
      JSON.stringify(event),
    );
  assert.equal(
    (await pageEventsRoute(send([VIEWED], { page: { id: hostile } }), hostOf(mind, member))).status,
    400,
  );
  assert.equal(mind.appended.length, 0);
});
test("the route never throws: a salt read that throws drops the send before any reservation or append (202)", () =>
  inNewMinute(async () => {
    forgetSalts();
    forgetOutside();
    const mind = recordingMind();
    mind.itx.kv = { ...mind.itx.kv, get: () => Promise.reject(new Error("kv down")) };
    assert.equal(
      (
        await pageEventsRoute(
          send([
            VIEWED,
            { type: "error", n: 2, kind: "uncaught", message: "m", fingerprint: "sa01" },
          ]),
          hostOf(mind),
        )
      ).status,
      202,
    );
    assert.deepEqual([mind.days.calls, mind.appended], [[], []]);
    forgetSalts();
  }));

test("the route: 20 records a send, the rest dropped", async () => {
  resetBounds();
  const mind = recordingMind();
  await pageEventsRoute(
    send(Array.from({ length: 30 }, (_, n) => ({ ...VIEWED, n }))),
    hostOf(mind),
  );
  assert.equal(mind.appended.length, 20);
});

// ── the bounds ──
/** Sends `total` records of `type`, 20 a send; each send from its own address unless `ip`. */
/** Each send comes from another address (another visitor, on whatever host), unless `ip` names one. */
let sender = 0;
async function flood(mind, type, total, { ip, host = ORIGIN, person = member } = {}) {
  await knowHosts(host);
  let n = 0;
  for (let sent = 0; sent < total; sent += 20) {
    const events = Array.from({ length: Math.min(20, total - sent) }, () => ({
      type,
      n: (n += 1),
      name: "x",
      kind: "uncaught",
      message: `m${n}`,
      fingerprint: `f${n}`,
    }));
    sender += 1;
    const answer = await pageEventsRoute(
      send(events, { ip: ip ?? `10.${Math.floor(sender / 250)}.${sender % 250}.1`, host }),
      hostOf(mind, person),
    );
    assert.equal(answer.status, 204, "a record over a bound is dropped silently");
  }
}
for (const type of ["viewed", "left", "captured"])
  test(`a bound: each app ${BOUNDS.app[type]} ${type} a minute`, () =>
    inNewMinute(async () => {
      const mind = recordingMind();
      await flood(mind, type, 200);
      assert.equal(mind.appended.length, BOUNDS.app[type]);
      // another app has its own count
      await flood(mind, type, 20, { host: "https://docs.example.com" });
      assert.equal(mind.appended.length, BOUNDS.app[type] + 20);
    }));
test("a bound: each app 30 errors a minute (exceptions.ts)", () =>
  inNewMinute(async () => {
    const mind = recordingMind();
    await flood(mind, "error", 60, { host: "https://errors-bound.example.com" });
    assert.equal(mind.appended.length, 30);
  }));
test(`a bound: each member's visitor ${BOUNDS.member.visitor} records a minute, of any kind`, () =>
  inNewMinute(async () => {
    const mind = recordingMind();
    await flood(mind, "viewed", 40, { ip: "192.0.2.1" });
    await flood(mind, "left", 40, { ip: "192.0.2.1" });
    assert.equal(mind.appended.length, BOUNDS.member.visitor);
    // a sender with no address is the visitor "none"
    const none = recordingMind();
    for (let n = 0; n < 4; n++)
      await pageEventsRoute(
        new Request(`${ORIGIN}/.page-events`, {
          method: "POST",
          headers: { origin: ORIGIN },
          body: JSON.stringify({
            page: { id: pageId() },
            events: Array.from({ length: 20 }, (_, i) => ({ type: "captured", n: i, name: "x" })),
          }),
        }),
        hostOf(none, member),
      );
    assert.equal(none.appended.length, BOUNDS.member.visitor);
  }));
test(`a bound: all members together ${BOUNDS.member.all} records a minute`, () =>
  inNewMinute(async () => {
    const mind = recordingMind();
    for (let app = 0; app < 8; app++)
      await flood(mind, "viewed", 100, { host: `https://app${app}.example.com` });
    assert.equal(mind.appended.length, BOUNDS.member.all);
  }));
test(`a bound: the outside ${BOUNDS.outside.visitor} records a minute for a visitor, ${BOUNDS.outside.all} for all of it; a member's stay`, () =>
  inNewMinute(async () => {
    forgetOutside();
    const mind = recordingMind();
    await flood(mind, "viewed", 40, { ip: "192.0.2.50", person: null });
    assert.equal(mind.appended.length, 20);
    for (let n = 0; n < 6; n++) await flood(mind, "captured", 20, { person: null });
    assert.equal(mind.appended.length, 60);
    // the outside's minute is spent; a member's is not
    await flood(mind, "left", 20, { ip: "192.0.2.50" });
    assert.equal(mind.appended.length, 80);
    forgetOutside();
  }));
test("a bound: a new minute starts every count again", async () => {
  const mind = recordingMind();
  await inNewMinute(() => flood(mind, "viewed", 140, { host: "https://minute.example.com" }));
  await inNewMinute(() => flood(mind, "viewed", 20, { host: "https://minute.example.com" }));
  assert.equal(mind.appended.length, BOUNDS.app.viewed + 20);
});

// ── the day's budget of the outside ──
/** The day's sum in the facet set to `records`, as earlier sends would have left it. */
const spendDay = (mind, records) =>
  assert.equal(
    reserveDay(
      sqlOf(mind.days.db),
      new Date(Date.now()).toISOString().slice(0, 10),
      records,
      records,
    ),
    true,
  );
test(`the day's budget: at ${OUTSIDE_A_DAY} no record from outside lands, signed in or not, and a member's still does`, () =>
  inNewMinute(async () => {
    forgetOutside();
    const mind = recordingMind();
    spendDay(mind, OUTSIDE_A_DAY);
    assert.equal(
      (
        await pageEventsRoute(
          send([
            VIEWED,
            { type: "error", n: 2, kind: "uncaught", message: "m", fingerprint: "bd01" },
          ]),
          hostOf(mind),
        )
      ).status,
      204,
    );
    assert.equal(mind.appended.length, 0);
    assert.deepEqual(mind.days.calls, [2], "one reservation for the whole send");
    await pageRequested(
      navigation({}, "https://iterate.com/newsletter"),
      page({ "content-security-policy": POLICIES.newsletter }),
      hostOf(mind),
    );
    assert.equal(mind.appended.length, 0, "a view counted from its request asks the same budget");
    await pageEventsRoute(send([VIEWED]), hostOf(mind, outsider, null));
    assert.equal(mind.appended.length, 0, "signed in is not a member");
    assert.deepEqual(mind.days.calls, [2], "after one refusal the isolate asks nothing that day");
    await pageEventsRoute(send([VIEWED]), hostOf(mind, member));
    assert.equal(mind.appended.length, 1);
    assert.equal(mind.days.sum(), OUTSIDE_A_DAY);
    forgetOutside();
  }));
test("the day's budget: sends that overlap never take the day past it; a send that does not fit lands nothing", () =>
  inNewMinute(async () => {
    forgetOutside();
    const mind = recordingMind();
    spendDay(mind, OUTSIDE_A_DAY - 7);
    // six sends of two records each, from six visitors, all at once: three fit
    const answers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        pageEventsRoute(
          send(
            [
              { ...VIEWED, n: 1 },
              { type: "error", n: 2, kind: "uncaught", message: "m", fingerprint: `ov0${i}` },
            ],
            { ip: `192.0.2.${80 + i}` },
          ),
          hostOf(mind),
        ),
      ),
    );
    assert.deepEqual(
      answers.map((answer) => answer.status),
      [204, 204, 204, 204, 204, 204],
    );
    assert.deepEqual(mind.days.calls, [2, 2, 2, 2, 2, 2], "each asked before any was answered");
    assert.equal(mind.days.sum(), OUTSIDE_A_DAY - 1);
    // three sends landed whole, each a view and an error; the other three nothing
    assert.equal(mind.appended.filter((e) => e.path === "/pages").length, 3);
    assert.equal(mind.appended.filter((e) => e.path === "/exceptions/outside").length, 3);
    forgetOutside();
  }));
test("the day's budget: a reservation that throws appends nothing, from a send (202) or a request", () =>
  inNewMinute(async () => {
    forgetOutside();
    const mind = recordingMind();
    mind.days.fails = true;
    assert.equal(
      (
        await pageEventsRoute(
          send([
            VIEWED,
            { type: "error", n: 2, kind: "uncaught", message: "m", fingerprint: "bd02" },
          ]),
          hostOf(mind),
        )
      ).status,
      202,
    );
    await pageRequested(
      navigation({}, "https://iterate.com/newsletter"),
      page({ "content-security-policy": POLICIES.newsletter }),
      hostOf(mind),
    );
    assert.equal(mind.days.calls.length, 2);
    assert.equal(mind.appended.length, 0);
    mind.days.fails = false;
    assert.equal((await pageEventsRoute(send([VIEWED]), hostOf(mind))).status, 204);
    assert.equal(mind.appended.length, 1, "a failure is no refusal: the next send asks again");
    forgetOutside();
  }));
test("outside-days: one statement adds a batch only while the day stays within the budget; days before yesterday go", () => {
  const db = new DatabaseSync(":memory:");
  const sql = sqlOf(db);
  assert.equal(reserveDay(sql, "2026-11-20", 3, 10), true);
  assert.equal(reserveDay(sql, "2026-11-21", 6, 10), true);
  assert.equal(reserveDay(sql, "2026-11-21", 5, 10), false, "6 + 5 is past 10: refused whole");
  assert.equal(reserveDay(sql, "2026-11-21", 4, 10), true, "6 + 4 is 10: it fits");
  assert.equal(reserveDay(sql, "2026-11-21", 1, 10), false);
  const rows = () => db.prepare("select day, records from outside_days order by day").all();
  assert.deepEqual(
    rows().map((row) => [row.day, row.records]),
    [
      ["2026-11-20", 3],
      ["2026-11-21", 10],
    ],
  );
  assert.equal(reserveDay(sql, "2026-11-22", 11, 10), false, "a batch larger than a day");
  assert.equal(reserveDay(sql, "2026-11-22", 1, 10), true);
  assert.deepEqual(
    rows().map((row) => row.day),
    ["2026-11-21", "2026-11-22"],
    "the day before yesterday went",
  );
  // the facet takes a whole number from 1 to 1,000 alone, and lists `reserve` for its callers
  const facet = new OutsideDaysDurableObject({ storage: { sql } }, {});
  for (const records of [0, -1, 1.5, 1_001, "5", null]) assert.equal(facet.reserve(records), false);
  assert.equal(facet.reserve(1), true);
  assert.deepEqual(OutsideDaysDurableObject.publicMethods, ["fetch", "reserve"]);
});

// ── where a page's error lands, and how long its texts are ──
test("an error from outside lands on /exceptions/outside, cut to 300 and 1,000; a member's on /exceptions, cut to 1,024 and 4,000", () =>
  inNewMinute(async () => {
    forgetOutside();
    const mind = recordingMind();
    const long = (fingerprint) => ({
      type: "error",
      n: 1,
      kind: "uncaught",
      message: "m ".repeat(2_000),
      stack: "s ".repeat(5_000),
      fingerprint,
    });
    await pageEventsRoute(
      send([long("an01")], { page: { title: "Title ".repeat(40) } }),
      hostOf(mind),
    );
    await pageEventsRoute(send([long("an02")], { ip: "192.0.2.70" }), hostOf(mind, member));
    await pageEventsRoute(send([long("an03")], { ip: "192.0.2.72" }), hostOf(mind, outsider, null));
    const [outside, inside, signedIn] = mind.appended;
    assert.equal(outside.path, "/exceptions/outside");
    assert.equal(outside.payload.message.length, 300);
    assert.equal(outside.payload.stack.length, 1_000);
    assert.equal(outside.payload.actor, null);
    assert.equal("member" in outside.payload, false);
    assert.equal(inside.path, "/exceptions");
    assert.equal(inside.payload.message.length, 1_024);
    assert.equal(inside.payload.stack.length, 4_000);
    assert.equal(inside.payload.member, true);
    assert.equal(outside.type, inside.type);
    // signed in and no member: the outside's context and texts, with the platform's actor
    assert.equal(signedIn.path, "/exceptions/outside");
    assert.equal(signedIn.payload.message.length, 300);
    assert.deepEqual(signedIn.payload.actor, outsider);
    assert.equal("member" in signedIn.payload, false);
    forgetOutside();
  }));
test("the outside's texts: a title of 80, a captured event of 6 values, signed in or not", () =>
  inNewMinute(async () => {
    forgetOutside();
    const mind = recordingMind();
    const values = Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`k${n}`, n]));
    await pageEventsRoute(
      send([VIEWED, { type: "captured", n: 2, name: "x", values }], {
        page: { title: "Title ".repeat(40) },
      }),
      hostOf(mind),
    );
    await pageEventsRoute(
      send([VIEWED, { type: "captured", n: 2, name: "x", values }], {
        page: { title: "Title ".repeat(40) },
        ip: "192.0.2.71",
      }),
      hostOf(mind, member),
    );
    await pageEventsRoute(
      send([VIEWED, { type: "captured", n: 2, name: "x", values }], {
        page: { title: "Title ".repeat(40) },
        ip: "192.0.2.73",
      }),
      hostOf(mind, outsider, null),
    );
    const [view, captured, memberView, memberCaptured, signedInView, signedInCaptured] =
      mind.appended;
    assert.equal(view.payload.title.length, 80);
    assert.equal(Object.keys(captured.payload.values).length, 6);
    assert.equal(memberView.payload.title.length, 120);
    assert.equal(Object.keys(memberCaptured.payload.values).length, 12);
    assert.equal(signedInView.payload.title.length, 80);
    assert.equal(Object.keys(signedInCaptured.payload.values).length, 6);
    assert.deepEqual(signedInView.payload.actor, outsider);
    assert.equal("member" in signedInView.payload, false);
    forgetOutside();
  }));
test("the outside's texts: an outside view with every new field stays under the outside sizes", () =>
  inNewMinute(async () => {
    forgetOutside();
    const mind = recordingMind();
    const view = {
      ...VIEWED,
      from: { host: "search.brave.com", pathname: "/" },
      campaign: { utm_source: "hn ".repeat(60), fbclid: "f".repeat(500) },
    };
    await pageEventsRoute(
      send([view], {
        headers: { "user-agent": "a ".repeat(500), "cf-ipcity": "city ".repeat(40) },
        page: { title: "Title ".repeat(40), tag: "abc", timezoneOffset: 0 },
        ip: "192.0.2.74",
      }),
      hostOf(mind),
    );
    const p = mind.appended[0].payload;
    assert.equal(p.title.length, 80);
    assert.equal("member" in p, false);
    assert.equal(p.userAgent.length, 256);
    assert.equal(p.place.city.length, 80);
    assert.equal(p.campaign.utm_source.length, 80);
    assert.equal(p.campaign.fbclid, "f".repeat(200));
    assert.equal(p.searchEngine, "brave");
    assert.equal(p.timezoneOffset, 0);
    assert.ok(JSON.stringify(p).length < 2_000);
    forgetOutside();
  }));

// ── who is a member, and who gets the tag ──
const plain = () => new Request(`${ORIGIN}/`);
test("memberOf: a principal that is no other mind; nobody, a person who is no member, another mind or a read that throws is none", () => {
  const mind = recordingMind();
  assert.equal(memberOf(hostOf(mind, member), plain()), true);
  assert.equal(memberOf(hostOf(mind), plain()), false);
  assert.equal(memberOf(hostOf(mind, outsider, null), plain()), false);
  assert.equal(
    memberOf(
      hostOf(mind, null, { actor: "a".repeat(64), kind: "mind", hostname: "other.example.com" }),
      plain(),
    ),
    false,
  );
  const throwing = {
    auth: {
      person: () => null,
      principal: () => {
        throw new Error("malformed stamp");
      },
    },
    getItx: () => mind.itx,
  };
  assert.equal(memberOf(throwing, plain()), false);
});
test('pageTagFor: "members" takes a member alone; "everyone" takes all', () => {
  const mind = recordingMind();
  const throwing = {
    auth: {
      person: () => null,
      principal: () => {
        throw new Error("malformed stamp");
      },
    },
    getItx: () => mind.itx,
  };
  const hosts = {
    nobody: hostOf(mind),
    outsider: hostOf(mind, outsider, null),
    mind: hostOf(mind, null, {
      actor: "a".repeat(64),
      kind: "mind",
      hostname: "other.example.com",
    }),
    throwing,
    member: hostOf(mind, member),
  };
  setAudience("members");
  try {
    for (const name of ["nobody", "outsider", "mind", "throwing"])
      assert.equal(pageTagFor(hosts[name], plain()), false, name);
    assert.equal(pageTagFor(hosts.member, plain()), true);
  } finally {
    setAudience("everyone");
  }
  for (const [name, host] of Object.entries(hosts))
    assert.equal(pageTagFor(host, plain()), true, name);
});

// ── the script, in a stand-in browser (node:vm): no real page, so layout, beacons and paint
//    numbers are not checked here ──
const SERVED = await (
  await pageEventsRoute(new Request(`${ORIGIN}/.page.js`), hostOf(recordingMind()))
).text();
/** A window with just what page.js touches. `sent` holds each fetch: its address, its options and
 *  its body (`text`); timers run by hand. */
function browser({ gpc = false } = {}) {
  const listeners = {};
  const timers = [];
  const sent = [];
  const observers = {};
  const clock = { now: 0 };
  const entries = { navigation: [], paint: [] };
  const on = (type, handler) => (listeners[type] ??= []).push(handler);
  const location = {
    href: "https://blog.example.com/posts/a?utm_source=hn&token=x&gclid=Cj0abc&fbclid=IwAR",
    pathname: "/posts/a",
    search: "?utm_source=hn&token=x&gclid=Cj0abc&fbclid=IwAR",
    host: "blog.example.com",
  };
  class Element {}
  const window = {
    location,
    navigator: {
      globalPrivacyControl: gpc,
      language: "en-GB",
      // a beacon would carry the page's address as its Referer: the script never calls it
      sendBeacon: () => assert.fail("page.js sends with fetch alone"),
    },
    document: {
      title: "A",
      referrer: "",
      visibilityState: "visible",
      querySelector: () => null,
      addEventListener: on,
      documentElement: { scrollHeight: 1000 },
    },
    history: {
      pushState(_s, _t, path) {
        location.pathname = path;
      },
      replaceState() {},
    },
    screen: { width: 1, height: 1 },
    innerWidth: 1,
    innerHeight: 1,
    scrollY: 0,
    performance: {
      now: () => clock.now,
      getEntriesByType: (type) => (type === "navigation" ? entries.navigation : []),
      getEntriesByName: (name) => (name === "first-contentful-paint" ? entries.paint : []),
    },
    PerformanceObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.held = [];
      }
      observe(options) {
        if (options.type === "unknown-type") throw new Error("no");
        (observers[options.type] ??= []).push(this);
        this.options = options;
      }
      takeRecords() {
        return this.held.splice(0);
      }
    },
    crypto: globalThis.crypto,
    Intl,
    URL,
    URLSearchParams,
    Date,
    Math,
    JSON,
    String,
    Object,
    Number,
    Uint8Array,
    Map,
    Array,
    Promise,
    Element,
    Blob: class {
      constructor(parts) {
        this.text = parts.join("");
      }
    },
    addEventListener: on,
    removeEventListener: (type, handler) =>
      (listeners[type] = (listeners[type] || []).filter((h) => h !== handler)),
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => {},
    setInterval: () => 0,
    fetch: (url, init) => {
      sent.push({ url, init, text: init.body });
      return Promise.resolve();
    },
  };
  window.window = window;
  const context = vm.createContext(window);
  return {
    window,
    listeners,
    sent,
    observers,
    clock,
    entries,
    /** The browser hands `list` to each observer of `type`. */
    observed: (type, list) =>
      (observers[type] || []).forEach((o) => o.callback({ getEntries: () => list })),
    /** Entries the browser holds and has not handed over yet: `takeRecords` gives them. */
    held: (type, list) => (observers[type] || []).forEach((o) => o.held.push(...list)),
    load: () => vm.runInContext(SERVED, context),
    fire: (type, event) => (listeners[type] || []).forEach((h) => h(event)),
    tick: () => timers.splice(0).forEach((fn) => fn()),
    records: () => sent.flatMap((blob) => JSON.parse(blob.text).events),
  };
}

test("page.js: a load is one view with the campaign tags alone; loaded twice, it listens once", () => {
  const b = browser();
  b.load();
  b.load();
  assert.equal(b.listeners.error.length, 1);
  b.tick();
  const [view] = b.records();
  assert.equal(view.type, "viewed");
  assert.deepEqual(view.campaign, { utm_source: "hn", gclid: "Cj0abc", fbclid: "IwAR" });
  assert.equal(JSON.stringify(b.records()).includes("token"), false);
  const sent = JSON.parse(b.sent[0].text).page;
  assert.equal(sent.tag, PAGE_TAGS.src.match(/v=([a-z0-9]+)/)[1]);
  assert.equal(sent.timezoneOffset, new Date().getTimezoneOffset());
});
test("page.js: left says how far down the page was in view; 100 for a page that fits its window", () => {
  const b = browser();
  b.window.innerHeight = 200;
  b.load();
  for (const y of [100, 300, 50]) {
    b.window.scrollY = y;
    b.fire("scroll", {});
  }
  b.fire("pagehide", {});
  const left = b.records().find((r) => r.type === "left");
  assert.equal(left.scrolled, 50, "(300 + 200) of 1000");
  const short = browser();
  short.window.innerHeight = 1200;
  short.load();
  short.fire("pagehide", {});
  assert.equal(short.records().find((r) => r.type === "left").scrolled, 100);
  assert.equal(b.listeners.scroll.length, 1);
});
test("page.js: more than 20 waiting records go in the next send, none lost", () => {
  const b = browser();
  b.load();
  for (let n = 0; n < 9; n++) b.window.capturePageEvent(`e${n}`);
  for (let n = 9; n < 34; n++) b.window.capturePageEvent(`e${n}`, { ok: true, deep: { no: 1 } });
  b.tick();
  b.tick();
  const names = b
    .records()
    .filter((r) => r.type === "captured")
    .map((r) => r.name);
  assert.equal(names.length, 34);
  assert.ok(b.sent.every((blob) => JSON.parse(blob.text).events.length <= 20));
  assert.deepEqual(b.records().find((r) => r.name === "e20").values, { ok: true });
});
test("page.js: nothing it does throws into the page", () => {
  const b = browser();
  b.load();
  const hostile = {
    get message() {
      throw new Error("no");
    },
    toString() {
      throw new Error("no");
    },
  };
  assert.doesNotThrow(() => b.window.reportPageError(hostile));
  assert.doesNotThrow(() =>
    b.window.capturePageEvent("x", {
      get bad() {
        throw new Error("no");
      },
    }),
  );
  assert.doesNotThrow(() => b.fire("error", { target: null, message: "boom", error: hostile }));
  assert.doesNotThrow(() =>
    b.fire("unhandledrejection", {
      get reason() {
        throw new Error("no");
      },
    }),
  );
  b.window.navigator.sendBeacon = () => {
    throw new Error("no beacon");
  };
  assert.doesNotThrow(() => b.fire("pagehide", {}));
  assert.doesNotThrow(() => b.window.history.pushState(null, "", "/posts/b"));
});
test("page.js: a route change ends one view and starts the next; an error is sent at once", () => {
  const b = browser();
  b.load();
  b.window.history.pushState(null, "", "/posts/b");
  b.window.reportPageError(new Error("render broke"));
  const records = b.records();
  assert.deepEqual(
    records.map((r) => r.type),
    ["viewed", "left", "viewed", "error"],
  );
  assert.deepEqual(records[2].from, { host: "blog.example.com", pathname: "/posts/a" });
  assert.equal(records[3].kind, "render");
});
test("page.js: every send is a fetch with keepalive, no Referer and the page's own credentials", () => {
  const b = browser();
  b.load();
  b.tick();
  b.fire("pagehide", {});
  assert.ok(b.sent.length >= 2);
  for (const { url, init } of b.sent)
    // through JSON: the options were made in the page's own realm
    assert.deepEqual(JSON.parse(JSON.stringify({ url, ...init, body: typeof init.body })), {
      url: "/.page-events",
      method: "POST",
      body: "string",
      keepalive: true,
      referrerPolicy: "no-referrer",
      credentials: "same-origin",
      headers: { "content-type": "text/plain" },
    });
});
test("page.js: an error's message and stack, the path, the referrer and the title are cut before they are sent", () => {
  const b = browser();
  b.window.document.title = "Reset https://blog.example.com/reset?token=abc for ada";
  b.window.document.referrer = `https://mail.example.com/inbox/${"AbCd".repeat(5)}?code=1`;
  b.window.location.pathname = "/posts/a";
  b.load();
  b.window.history.pushState(null, "", `/orders/${"0f".repeat(16)}`);
  const error = new Error(
    "fetch https://api.example.com/v1/me?access_token=abc failed with code=xyz, state=s1",
  );
  error.stack = `Error: x\n    at f (https://blog.example.com/app.js?rev=9#h:12:34)\n    at //cdn.example.com/lib.js?x=1:1:2`;
  b.window.reportPageError(error);
  const records = b.records();
  const [view, , routed, failed] = records;
  assert.deepEqual(view.from, { host: "mail.example.com", pathname: "/inbox/<id>" });
  assert.equal(routed.pathname, "/orders/<id>");
  assert.equal(failed.pathname, "/orders/<id>");
  assert.equal(failed.message, "fetch /v1/me failed with <cut>, <cut>");
  assert.equal(failed.stack, "Error: x\n    at f (/app.js:12:34)\n    at /lib.js:1:2");
  const sent = JSON.stringify(b.sent.map((one) => JSON.parse(one.text)));
  for (const secret of ["token=abc", "code=", "state=s1", "example.com/reset", "rev=9", "AbCdEf"])
    assert.equal(sent.includes(secret), false, secret);
  assert.equal(JSON.parse(b.sent[0].text).page.title, "Reset /reset for ada");
});
test("page.js: the build is read when a send is made, after the import map is parsed", () => {
  const b = browser();
  let map = null;
  b.window.document.querySelector = () => map;
  b.load();
  map = {
    textContent: '{"imports":{"@iterate-com/ui":"https://esm.sh/@iterate-com/ui@0.4.2/x.js"}}',
  };
  b.tick();
  assert.equal(JSON.parse(b.sent[0].text).page.build, "0.4.2");
});
test("page.js: Global Privacy Control sends errors alone", () => {
  const b = browser({ gpc: true });
  b.load();
  b.window.capturePageEvent("x");
  b.window.reportPageError(new Error("e"));
  b.fire("pagehide", {});
  assert.deepEqual(
    b.records().map((r) => r.type),
    ["error"],
  );
});

// ── speed, in the stand-in browser ──
const shiftAt = (startTime, value, hadRecentInput = false) => ({
  startTime,
  value,
  hadRecentInput,
});
const leftOf = (b) => b.records().filter((r) => r.type === "left");
test("page.js: CLS is the largest session window (1 s gap, 5 s at most); shift stays the plain sum; input ends no window", () => {
  const b = browser();
  b.load();
  assert.equal(
    JSON.stringify(b.observers["layout-shift"][0].options),
    '{"type":"layout-shift","buffered":true}',
  );
  b.observed("layout-shift", [
    shiftAt(100, 0.1),
    shiftAt(500, 0.1),
    shiftAt(1_700, 0.3),
    shiftAt(2_000, 0.05),
    shiftAt(2_100, 0.5, true),
  ]);
  // one shift every 0.9 s from 10 s: a window of 6 (5 s), then a window of 2
  b.observed(
    "layout-shift",
    Array.from({ length: 8 }, (_, i) => shiftAt(10_000 + i * 900, 0.1)),
  );
  b.entries.navigation = [{ responseStart: 80.4, domContentLoadedEventEnd: 300, loadEventEnd: 0 }];
  b.entries.paint = [{ startTime: 150.6 }];
  b.fire("pagehide", {});
  const [left] = leftOf(b);
  assert.equal(left.load.cls, 0.6, "not 0.8: a window lasts 5 s at most");
  assert.equal(left.load.shift, 1.35);
  assert.deepEqual([left.load.firstByte, left.load.fcp, left.load.loaded], [80, 151, undefined]);
});
test("page.js: INP is the slowest interaction, each its longest event; with 50 and more, one fewer for each 50", () => {
  const b = browser();
  b.load();
  assert.equal(b.observers.event[0].options.durationThreshold, 40);
  b.observed("event", [
    { interactionId: 7, duration: 80 },
    { interactionId: 7, duration: 120 },
    { interactionId: 0, duration: 900 },
    { interactionId: 14, duration: 300 },
  ]);
  b.observed("first-input", [{ interactionId: 21, duration: 56 }]);
  b.fire("pagehide", {});
  assert.equal(leftOf(b)[0].load.inp, 300, "an event that is no interaction (id 0) does not count");
  const many = browser();
  many.load();
  // 120 interactions, of 1 to 120 ms: the third slowest (120 / 50 = 2 skipped)
  many.observed(
    "event",
    Array.from({ length: 120 }, (_, i) => ({ interactionId: (i + 1) * 7, duration: i + 1 })),
  );
  many.fire("pagehide", {});
  assert.equal(leftOf(many)[0].load.inp, 118);
  const counted = browser();
  counted.load();
  counted.window.performance.interactionCount = 100;
  counted.observed("event", [
    { interactionId: 7, duration: 400 },
    { interactionId: 14, duration: 250 },
    { interactionId: 21, duration: 90 },
  ]);
  counted.fire("pagehide", {});
  assert.equal(
    leftOf(counted)[0].load.inp,
    90,
    "the browser's count of interactions: 100, so 2 skipped",
  );
  const none = browser();
  none.load();
  none.fire("pagehide", {});
  assert.equal("inp" in leftOf(none)[0].load, false);
});
test("page.js: only `iterate:` marks of the allowed characters, at most 20, the first of a name, in whole ms", () => {
  const b = browser();
  b.load();
  const named = (name, startTime) => ({ name, startTime });
  b.observed("mark", [
    named("iterate:itx-open", 412.4),
    named("iterate:itx-open", 900),
    named("other", 5),
    named("iterate:Upper", 5),
    named("iterate:", 5),
    named(`iterate:${"a".repeat(41)}`, 5),
    named("iterate:a b", 5),
  ]);
  b.observed(
    "mark",
    Array.from({ length: 30 }, (_, i) => named(`iterate:m${i}`, i)),
  );
  b.fire("pagehide", {});
  const { marks } = leftOf(b)[0];
  assert.equal(marks["iterate:itx-open"], 412);
  assert.equal(Object.keys(marks).length, 20);
  assert.equal(
    Object.keys(marks).some((name) => !/^iterate:[a-z0-9:._-]{1,40}$/.test(name)),
    false,
  );
});
test("page.js: a later view carries its own INP, CLS and marks; what an observer still holds counts at the left", () => {
  const b = browser();
  b.load();
  b.observed("event", [{ interactionId: 7, duration: 500 }]);
  b.observed("layout-shift", [shiftAt(100, 0.3)]);
  b.observed("mark", [{ name: "iterate:itx-open", startTime: 400 }]);
  b.clock.now = 5_000;
  b.window.history.pushState(null, "", "/posts/b");
  b.observed("event", [{ interactionId: 14, duration: 64 }]);
  b.observed("mark", [
    { name: "iterate:old", startTime: 4_000 },
    { name: "iterate:route-ready", startTime: 5_200.7 },
  ]);
  b.held("layout-shift", [shiftAt(5_300, 0.04)]);
  b.fire("pagehide", {});
  const [first, second] = leftOf(b);
  assert.deepEqual(
    [first.load.inp, first.load.cls, first.marks],
    [500, 0.3, { "iterate:itx-open": 400 }],
  );
  assert.equal(second.load, undefined);
  assert.deepEqual(
    [second.inp, second.cls, second.marks],
    [64, 0.04, { "iterate:route-ready": 5_201 }],
    "a mark from before the view is not its own",
  );
});

test("a long sent text from outside costs little: the route cuts each text before its patterns run", async () => {
  resetBounds();
  const mind = recordingMind();
  // three texts under the route's 64,000 bytes: unbounded, their patterns took about a second
  const long = "a".repeat(18_000);
  const started = performance.now();
  const answer = await pageEventsRoute(
    send(
      [{ type: "error", n: 1, kind: "uncaught", message: long, stack: long, fingerprint: "ln01" }],
      {
        page: { title: long, tag: "abc" },
      },
    ),
    hostOf(mind),
  );
  assert.ok(performance.now() - started < 500, "the route took too long");
  assert.equal(answer.status, 204);
  assert.ok(mind.appended[0].payload.message.length <= 300);
});

test("hostTagged keeps only a name the mind serves: the zone and one label above it, never a deeper name that an app's first label takes too", async () => {
  forgetHosts();
  const mind = recordingMind();
  for (const name of [
    "dash.a1.example.com",
    "dash.x.y.example.com",
    "example.org",
    "dash.example.org",
  ])
    await hostTagged(hostOf(mind), new Request(`https://${name}/`));
  assert.equal(mind.store.get("page-events/hosts"), undefined);
  for (const name of ["dash.example.com", "www.example.com", "example.com"])
    await hostTagged(hostOf(mind), new Request(`https://${name}/`));
  assert.deepEqual(JSON.parse(mind.store.get("page-events/hosts")), [
    "dash.example.com",
    "www.example.com",
    "example.com",
  ]);
  assert.equal(await hostKnown(mind.itx, "dash.a1.example.com"), false);
  forgetHosts();
});
