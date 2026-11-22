// page.js — WHAT A PERSON DID ON A PAGE OF THIS MIND, AND WHAT BROKE THERE, SENT TO THE PAGE'S OWN
// HOST (page-events.md; ../page-events.ts answers `POST /.page-events` and puts this file's tag
// into every HTML page of the mind). No page loads it by hand.
//
// What it sends, each as one small record:
//   viewed    a page load, and each change of the path inside a single-page app
//   left      the page went away or the path changed: how long it was open and seen, how far the
//             person scrolled, how fast the page loaded (the vitals: TTFB, FCP, LCP, CLS, INP),
//             and the app's own `iterate:` marks (`performance.mark("iterate:itx-open")`)
//   captured  what the page's own code reports: `window.capturePageEvent("signup", { plan: "pro" })`
//   error     an uncaught error, an unhandled rejection, a script or style sheet that did not
//             load, and what an error boundary hands to `window.reportPageError(error)`
//
// What it never sends: a query string, a hash, a form's values, typed text, a cookie, the page's
// address as a Referer. Only the path of the page, and of the page it came from, each by the path
// rule (`pathOf`), and every text that can hold a URL (an error's message and stack, a path, the
// title) through the cut (`cut`): a URL keeps its path alone, and a `code=`, `state=`, `token=`,
// a bearer token and a long run of letters and digits go. Both are the platform's own rule
// (core/auth-worker/src/page-tag.ts), and the server runs them again (../cut.ts). From a landing
// URL it reads the `utm_*` tags and `ref`, each value cut, and the ad click ids (`gclid`,
// `fbclid`, …), each its letters, digits and `._~-` alone, and no other key. It keeps nothing in the browser: no cookie, no local storage, no session
// storage. Who the visitor
// is, is the server's word (page-events.ts). Each send carries `tag`, this script's version, which
// the server writes into `TAG` when it serves the script.
//
// It sends with `fetch`, `keepalive` (a send outlives the page) and `referrerPolicy: "no-referrer"`:
// a beacon would carry the page's whole address, its query string too, in its Referer.
//
// The bounds: 30 sends a minute, 20 records a send, 100 records waiting; the same error again is
// one more count, with one summary a minute; 50 different errors in one page load, then no more.
// A send that fails is dropped: nothing here can report its own failure, and nothing here throws
// into the page. A browser that asks not to be tracked (Global Privacy Control, Do Not Track)
// sends errors alone. Loaded twice, the second copy does nothing.
(() => {
  const kept = window.__pageEvents;
  if (kept && kept.loaded) return;
  window.__pageEvents = { loaded: true };

  // ── the cut rule: the same as ../cut.ts and core/auth-worker/src/page-tag.ts, which
  //    lint/page-tag-cut-rule.test.ts holds to the same answers ──
  function pathOf(path) {
    const isId = (s) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
      /^[0-9a-f]{32,}$/i.test(s) ||
      (s.length >= 12 && /^\w+$/.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s)) ||
      (s.length >= 16 && /[A-Z]/.test(s) && /[a-z]/.test(s) && (s.length >= 20 || /\d/.test(s)));
    return String(path ?? "")
      .split(/[?#]/)[0]
      .slice(0, 2_000)
      .split("/")
      .map((s) => (isId(s) ? "<id>" : s))
      .join("/")
      .slice(0, 200);
  }
  function cut(text) {
    const keep = (path, rest) => {
      const [, folder, file, at] =
        /^(.*?\/)?([\w.-]{1,80}\.(?:m?[jt]sx?|css|wasm))?((?::\d+){0,2})$/.exec(path || "/") ?? [];
      const line = at || (rest || "").match(/(?::\d+){1,2}$/)?.[0] || "";
      return file ? pathOf(folder || "") + file + line : pathOf(path || "/") + line;
    };
    return String(text ?? "")
      .replace(
        /[a-z][a-z0-9+.-]*:\/\/[^\s"'()<>/?#]*([^\s"'()<>?#]*)([?#][^\s"'()<>]*)?/gi,
        (_, path, rest) => keep(path, rest),
      )
      .replace(
        /(^|[\s"'(=@])\/\/[^\s"'()<>/?#]*([^\s"'()<>?#]*)([?#][^\s"'()<>]*)?/g,
        (_, before, path, rest) => before + keep(path, rest),
      )
      .replace(
        /(^|[\s"'(=@])((?:\.{0,2}\/)[^\s"'()<>?#]*)([?#][^\s"'()<>]*)?/g,
        (_, before, path, rest) => before + keep(path, rest),
      )
      .replace(/([^\s"'()<>?#]+)([?#][^\s"'()<>]+)/g, (_, path, rest) => keep(path, rest))
      .replace(/\b[a-z_]*(?:code|state|token)=[^\s&"'(),;<>]*|\bbearer\s+[^\s"'(),;<>]+/gi, "<cut>")
      .replace(/[A-Za-z0-9_+=-]{32,}/g, "<cut>");
  }
  // ── the end of the cut rule ──
  /** A path as it is sent: the path rule, then the cut. */
  const sentPath = (path) => cut(pathOf(path));

  const ENDPOINT = "/.page-events";
  const TAG = "%TAG%";
  const SENDS_A_MINUTE = 30;
  const RECORDS_A_SEND = 20;
  const MOST_WAITING = 100;
  const SUMMARY_EVERY_MS = 60_000;
  /** Runs `work`, and an error in it never reaches the page. */
  const guarded = (work) =>
    function (...args) {
      try {
        return work.apply(this, args);
      } catch {
        // dropped: this file never breaks the page it watches
      }
    };
  const quiet =
    navigator.globalPrivacyControl === true ||
    navigator.doNotTrack === "1" ||
    window.doNotTrack === "1";
  const pageId = (() => {
    try {
      return [...crypto.getRandomValues(new Uint8Array(8))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    } catch {
      return (Date.now().toString(36) + Math.random().toString(36).slice(2))
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 16)
        .padEnd(8, "0");
    }
  })();
  /** The UI build the page pins (its import map), so an error names the code that threw. Read at
   *  each send: the tag is first in the head, so this script can start before the import map is
   *  parsed. */
  const buildOf = () => {
    try {
      return (
        document
          .querySelector('script[type="importmap"]')
          ?.textContent.match(/@iterate-com\/ui@([^/"]+)/)?.[1] ?? ""
      );
    } catch {
      return "";
    }
  };
  const timezone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      return "";
    }
  })();

  // ── sending ──
  const queue = [];
  let timer = 0;
  let sends = { minute: 0, count: 0 };
  let sequence = 0;
  /** The running minute, with its count of sends. */
  function roll() {
    const minute = Math.floor(Date.now() / 60_000);
    if (sends.minute !== minute) sends = { minute, count: 0 };
    return minute;
  }
  const flush = guarded(() => {
    clearTimeout(timer);
    timer = 0;
    if (queue.length === 0) return;
    const minute = roll();
    // over the minute's sends: what waits goes with the next minute's first send
    if (sends.count >= SENDS_A_MINUTE)
      return void (timer = setTimeout(flush, (minute + 1) * 60_000 - Date.now() + 50));
    sends.count += 1;
    const events = queue.splice(0, RECORDS_A_SEND);
    const body = JSON.stringify({
      page: {
        id: pageId,
        build: buildOf(),
        title: cut(String(document.title || "").slice(0, 400)).slice(0, 120),
        screen: [screen.width, screen.height],
        viewport: [innerWidth, innerHeight],
        language: navigator.language || "",
        timezone,
        timezoneOffset: new Date().getTimezoneOffset(),
        tag: TAG,
        automated: navigator.webdriver === true,
      },
      events,
    });
    // what is left beyond this send's records goes in the next send
    if (queue.length > 0) timer = setTimeout(flush, 0);
    // keepalive outlives the page; no Referer, so the page's query string stays in the page;
    // text/plain keeps it a simple request
    fetch(ENDPOINT, {
      method: "POST",
      body,
      keepalive: true,
      referrerPolicy: "no-referrer",
      credentials: "same-origin",
      headers: { "content-type": "text/plain" },
    }).catch(() => {});
  });
  function push(event, now) {
    if (queue.length >= MOST_WAITING) queue.shift();
    queue.push({ ...event, n: (sequence += 1), at: new Date().toISOString() });
    if (now || queue.length >= 10) return flush();
    if (!timer) timer = setTimeout(flush, 2_000);
  }

  // ── page views ──
  const placeOf = (url) => {
    try {
      const { host, pathname } = new URL(url, location.href);
      return { host, pathname: sentPath(pathname) };
    } catch {
      return null;
    }
  };
  /** The campaign tags of a landing URL, each value cut, and its ad click ids, each its letters,
   *  digits and `._~-` alone (as PostHog keeps them; the cut would make each one `<cut>`), and
   *  nothing else of its query string. */
  function campaignOf(search) {
    const tags = {};
    try {
      for (const [key, value] of new URLSearchParams(search))
        if (/^(utm_(source|medium|campaign|term|content)|ref)$/.test(key))
          tags[key] = cut(value.slice(0, 2_000)).slice(0, 80);
        else if (
          /^(gclid|gad_source|gclsrc|dclid|gbraid|wbraid|fbclid|msclkid|twclid|li_fat_id|mc_cid|igshid|ttclid|rdt_cid|irclid|_kx)$/.test(
            key,
          )
        )
          tags[key] = value
            .slice(0, 2_000)
            .replace(/[^\w.~-]/g, "")
            .slice(0, 200);
    } catch {
      // none
    }
    return tags;
  }
  let view = 0;
  let pathname = location.pathname;
  let viewedAt = performance.now();
  let seenMs = 0;
  let seenSince = document.visibilityState === "visible" ? performance.now() : null;
  let furthest = 0; // the largest scrollY of this view
  function viewed(how, from) {
    view += 1;
    pathname = location.pathname;
    viewedAt = performance.now();
    seenMs = 0;
    seenSince = document.visibilityState === "visible" ? performance.now() : null;
    furthest = scrollY;
    speedOfView();
    if (quiet) return;
    push({
      type: "viewed",
      view,
      pathname: sentPath(pathname),
      how,
      from,
      ...(how === "load" && { campaign: campaignOf(location.search) }),
    });
  }
  // ── speed (page-events.md, "Speed"): the vitals as Google's web-vitals library measures them ──
  let largestPaint = 0;
  // the first moment the page was hidden: a paint after it is no paint the person waited for (web-vitals)
  let hiddenAt = document.visibilityState === "hidden" ? 0 : Infinity;
  let shift = 0; // the page's layout shifts without recent input, summed (`load.shift`, as before)
  let cls = 0; // this view's largest session window of shifts
  let session = { value: 0, first: 0, last: 0 };
  let slowest = new Map(); // this view's 10 slowest interactions: interactionId → its longest duration
  let interactions = 0; // this view's interactions that this file saw
  let lastId = 0;
  let countAtView = 0;
  let marks = {};
  const MARK = /^iterate:[a-z0-9:._-]{1,40}$/;
  const observers = [];
  /** A new view starts with no shift, no interaction and no mark of its own. */
  function speedOfView() {
    cls = 0;
    session = { value: 0, first: 0, last: 0 };
    slowest = new Map();
    interactions = 0;
    // the first view counts from the page's start: the script may load after the first input
    countAtView = view > 1 ? performance.interactionCount || 0 : 0;
    marks = {};
  }
  /** Each entry of `type`, the buffered ones too; `left` takes what still waits before it reports. */
  function observe(type, each, more) {
    try {
      const observer = new PerformanceObserver(guarded((list) => list.getEntries().forEach(each)));
      observer.observe({ type, buffered: true, ...more });
      observers.push([observer, each]);
    } catch {
      // a browser without this type has no number for it
    }
  }
  observe("largest-contentful-paint", (entry) => {
    if (entry.startTime < hiddenAt) largestPaint = entry.startTime;
  });
  // CLS: a session window holds shifts less than 1 s apart, for at most 5 s; the largest one counts
  observe("layout-shift", (entry) => {
    if (entry.hadRecentInput) return;
    const at = entry.startTime;
    shift += entry.value;
    session =
      session.value && at - session.last < 1_000 && at - session.first < 5_000
        ? { value: session.value + entry.value, first: session.first, last: at }
        : { value: entry.value, first: at, last: at };
    if (session.value > cls) cls = session.value;
  });
  // INP: each interaction is its longest event; the 10 slowest are kept, as web-vitals keeps them
  const interacted = (entry) => {
    const id = entry.interactionId;
    if (!id) return;
    if (id > lastId) {
      lastId = id;
      interactions += 1;
    }
    slowest.set(id, Math.max(slowest.get(id) ?? 0, entry.duration));
    if (slowest.size > 10)
      slowest.delete([...slowest].reduce((low, one) => (one[1] < low[1] ? one : low))[0]);
  };
  observe("event", interacted, { durationThreshold: 40 });
  observe("first-input", interacted);
  // the app's own milestones: `performance.mark("iterate:itx-open")`, in the view where it happened
  observe("mark", (entry) => {
    if (!MARK.test(entry.name) || entry.name in marks || Object.keys(marks).length >= 20) return;
    if (view <= 1 || entry.startTime >= viewedAt) marks[entry.name] = Math.round(entry.startTime);
  });
  /** This view's INP: its slowest interaction, or with 50 and more, one fewer for each 50 (the 98th
   *  percentile). Undefined with no interaction. */
  function inpOf() {
    const durations = [...slowest.values()].sort((a, b) => b - a);
    const count = Math.max(interactions, (performance.interactionCount || 0) - countAtView);
    return durations.length > 0
      ? Math.round(durations[Math.min(durations.length - 1, Math.floor(count / 50))])
      : undefined;
  }
  /** This view's speed: INP and CLS (3 decimals). */
  const vitals = () => ({ inp: inpOf(), cls: Math.round(cls * 1000) / 1000 });
  /** How the first load went, in milliseconds, once the browser knows it. */
  function loadTimes() {
    try {
      const navigation = performance.getEntriesByType("navigation")[0] || {};
      const round = (value) => (value > 0 ? Math.round(value) : undefined);
      const [painted] = performance.getEntriesByName("first-contentful-paint");
      const paint = painted && painted.startTime < hiddenAt ? painted : undefined;
      return {
        firstByte: round(navigation.responseStart),
        ready: round(navigation.domContentLoadedEventEnd),
        loaded: round(navigation.loadEventEnd),
        largestPaint: round(largestPaint),
        shift: Math.round(shift * 1000) / 1000,
        fcp: round(paint?.startTime),
        ...vitals(),
      };
    } catch {
      return undefined;
    }
  }
  /** The furthest point of the page that was in view, as a whole percent of its height; 100 for a
   *  page that fits its window. */
  function scrolledOf() {
    try {
      const tall = document.documentElement.scrollHeight;
      return tall > innerHeight
        ? Math.min(100, Math.round(((Math.max(furthest, scrollY) + innerHeight) / tall) * 100))
        : 100;
    } catch {
      return undefined;
    }
  }
  function left() {
    if (quiet || view === 0) return;
    // what the observers hold and have not handed over yet belongs to this view
    for (const [observer, each] of observers) guarded(() => observer.takeRecords().forEach(each))();
    const now = performance.now();
    const scrolled = scrolledOf();
    if (seenSince !== null) {
      seenMs += now - seenSince;
      seenSince = now;
    }
    push({
      type: "left",
      view,
      pathname: sentPath(pathname),
      openMs: Math.round(now - viewedAt),
      seenMs: Math.round(seenMs),
      scrolled,
      ...(Object.keys(marks).length > 0 && { marks }),
      ...(view === 1 ? { load: loadTimes() } : vitals()),
    });
  }
  // one comparison a scroll: the percent is worked out once, when the view ends
  addEventListener("scroll", () => void (scrollY > furthest && (furthest = scrollY)), {
    passive: true,
  });
  document.addEventListener(
    "visibilitychange",
    guarded(() => {
      const now = performance.now();
      if (document.visibilityState === "visible") return void (seenSince = now);
      if (now < hiddenAt) hiddenAt = now;
      if (seenSince !== null) {
        seenMs += now - seenSince;
        seenSince = null;
      }
      // a phone may never fire `pagehide`: what waits goes now
      flush();
    }),
  );
  /** A single-page app changes the path with no load: the view before it ends, a new one starts. */
  const routed = guarded(() => {
    if (location.pathname === pathname) return;
    const from = { host: location.host, pathname: sentPath(pathname) };
    left();
    viewed("route", from);
  });
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    if (typeof original !== "function") continue;
    history[method] = function (...args) {
      const result = original.apply(this, args);
      routed();
      return result;
    };
  }
  addEventListener("popstate", routed);
  // a page taken out of the browser's back-forward cache is seen again
  addEventListener(
    "pageshow",
    guarded((event) => event.persisted && viewed("restore", null)),
  );
  addEventListener(
    "pagehide",
    guarded(() => {
      left();
      for (const [fingerprint, row] of seen)
        if (row.count > row.sent) report(fingerprint, row, "last");
      roll();
      while (queue.length > 0 && sends.count < SENDS_A_MINUTE) flush();
    }),
  );
  /** For the page's own code: one named thing a person did, with at most 12 plain values. */
  window.capturePageEvent = guarded((name, values) => {
    if (quiet || typeof name !== "string" || !name) return;
    const plain = {};
    if (values && typeof values === "object")
      for (const [key, value] of Object.entries(values).slice(0, 12))
        if (["string", "number", "boolean"].includes(typeof value))
          plain[key.slice(0, 40)] = typeof value === "string" ? value.slice(0, 200) : value;
    push({
      type: "captured",
      view,
      pathname: sentPath(pathname),
      name: name.slice(0, 80),
      values: plain,
    });
  });

  // ── errors ──
  const seen = new Map(); // fingerprint → { kind, message, stack, count, sent, firstAt, lastAt, summaries }
  let busy = false; // an error thrown while this file works is not caught again
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(36);
  }
  function report(fingerprint, row, part) {
    row.sent = row.count;
    push(
      {
        type: "error",
        view,
        pathname: sentPath(location.pathname),
        kind: row.kind,
        message: row.message,
        stack: row.stack,
        fingerprint,
        part,
        count: row.count,
        firstAt: row.firstAt,
        lastAt: row.lastAt,
      },
      true,
    );
  }
  function caught(kind, error, fallback) {
    if (busy) return;
    busy = true;
    try {
      // cut before it is sent: a URL in an error keeps its path alone (`cut`)
      const message =
        cut(String(error?.message ?? error ?? fallback ?? "").slice(0, 2_000)).slice(0, 1_024) ||
        "(no message)";
      const stack = cut(String(error?.stack ?? "").slice(0, 8_000)).slice(0, 4_000);
      const top = stack.split("\n").find((line) => /^\s*at |@/.test(line)) ?? "";
      const fingerprint = hash(`${kind}|${message}|${top.replace(/[?#][^\s:)]*/g, "")}`);
      const now = new Date().toISOString();
      const row = seen.get(fingerprint);
      if (row) return void ((row.count += 1), (row.lastAt = now));
      if (seen.size >= 50) return; // a page that throws fifty different errors has said enough
      const first = {
        kind,
        message,
        stack,
        count: 1,
        sent: 0,
        firstAt: now,
        lastAt: now,
        summaries: 0,
      };
      seen.set(fingerprint, first);
      report(fingerprint, first, "first");
    } catch {
      // dropped
    } finally {
      busy = false;
    }
  }
  const isModuleLoad = (text) =>
    /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(
      String(text),
    );
  const onError = guarded((event) => {
    // a script or a style sheet that did not load has no error object, only its element
    const element = event.target instanceof Element ? event.target : null;
    if (element) {
      if (!/^(SCRIPT|LINK)$/.test(element.tagName)) return;
      const from = String(element.src || element.href || "").split(/[?#]/)[0];
      return caught("module-load", null, `${element.tagName.toLowerCase()} did not load: ${from}`);
    }
    caught(isModuleLoad(event.message) ? "module-load" : "uncaught", event.error, event.message);
  });
  const onRejection = guarded((event) => {
    const reason = event.reason;
    caught(
      isModuleLoad(reason?.message ?? reason) ? "module-load" : "rejection",
      reason,
      "A promise was rejected with no reason.",
    );
  });
  addEventListener("error", onError, true);
  addEventListener("unhandledrejection", onRejection);
  // what the tag's keep-lines kept before this file loaded; from here on this file listens
  if (kept && kept.keep) {
    removeEventListener("error", kept.keep, true);
    removeEventListener("unhandledrejection", kept.keep);
    for (const event of (kept.early || []).splice(0))
      event.type === "unhandledrejection" ? onRejection(event) : onError(event);
  }
  /** For an error boundary: a render error never reaches `window.onerror`. */
  window.reportPageError = guarded((error, kind = "render") =>
    caught(/^[a-z-]{1,20}$/.test(String(kind)) ? kind : "render", error),
  );
  setInterval(
    guarded(() => {
      for (const [fingerprint, row] of seen)
        if (row.count > row.sent) report(fingerprint, row, `again-${(row.summaries += 1)}`);
    }),
    SUMMARY_EVERY_MS,
  );

  try {
    viewed("load", document.referrer ? placeOf(document.referrer) : null);
  } catch {
    // no first view: nothing else changes
  }
})();
