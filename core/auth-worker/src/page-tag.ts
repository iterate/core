// page-tag.ts — THE PAGE TAG OF THE CONTROL PLANE: core's own small script, which `page()`
// (./pages.ts) puts into a page that says `tag: true`, as one inline `<script>` with the page's
// nonce; never into an answer where a person signs in, grants, signs or adds a key (./pages.ts
// `takesNoTag`). The mind's code never runs on this origin, and this script is no part of the mind's config.
//
// What it sends to `POST /.page-events` (./page-events.ts), with `fetch` and `keepalive`, with no
// Referer (`referrerPolicy: "no-referrer"`): the page's own address never goes with it.
//   viewed   once, as the page loads
//   left     once, as the page goes away: how long it was open and seen, how far it was scrolled
//   error    an uncaught error or an unhandled rejection: its kind, its message (at most 300
//            characters) and its stack (at most 1,000), each with its URLs cut (`CUT_RULE`)
// Each send also says the page: the title, the screen, the viewport, the language, the time zone
// and its offset. The path is `location.pathname` alone, with a segment that looks like an id or a
// token as `<id>` (`PATH_RULE`) and then cut as a message is (`CUT_RULE`): never a query string
// or a hash.
//
// It NEVER reads a form, an input, a code, an email address, a cookie or the referrer, and it keeps nothing in
// the browser. At most 10 sends a page load; the same error message is sent once. Nothing here
// throws into the page.

/** THE RULE OF A PATH, as the script's own text: the browser runs it, and the route runs
 *  `pathOf` (the same rule in TypeScript) again on what a page sent. A segment is an id when it is
 *  a UUID, 32 or more hex characters, 12 or more letters and digits with both, 20 or more
 *  characters in both cases, or 16 or more in both cases with a digit. At most 200 characters. */
export const PATH_RULE = `function pathOf(path) {
  const isId = (s) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
    /^[0-9a-f]{32,}$/i.test(s) ||
    (s.length >= 12 && /^\\w+$/.test(s) && /[A-Za-z]/.test(s) && /\\d/.test(s)) ||
    (s.length >= 16 && /[A-Z]/.test(s) && /[a-z]/.test(s) && (s.length >= 20 || /\\d/.test(s)));
  return String(path).split(/[?#]/)[0].split("/").map((s) => (isId(s) ? "<id>" : s)).join("/").slice(0, 200);
}`;

/** `PATH_RULE` for the route, on what a page sent. */
export function pathOf(path: string | undefined): string {
  const isId = (s: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
    /^[0-9a-f]{32,}$/i.test(s) ||
    (s.length >= 12 && /^\w+$/.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s)) ||
    (s.length >= 16 && /[A-Z]/.test(s) && /[a-z]/.test(s) && (s.length >= 20 || /\d/.test(s)));
  return (path || "")
    .split(/[?#]/)[0]!
    .slice(0, 2_000)
    .split("/")
    .map((s) => (isId(s) ? "<id>" : s))
    .join("/")
    .slice(0, 200);
}

/** THE RULE OF A TEXT THAT GOES OUT, as the script's own text: the browser runs it on an error's
 *  message and stack and on its own path before it sends them, and the route runs `cut` (the same
 *  rule in TypeScript) again on them, on a path and on a title. Every URL-like run keeps its path
 *  alone, by the path rule (a script's file name stays whole), and its line and column:
 *    absolute           `https://host/a?b#c`   its scheme, host, query string and hash go
 *    protocol-relative  `//host/a?b#c`         its host, query string and hash go
 *    relative           `/a?b`, `../a#c`, `assets/app.js?rev=1#x`, and any other run of text
 *                       with a `?` or a `#` inside it: every `?` and `#` part goes
 *  Then a `code=`, `state=` or `token=` (also `auth_code=`, `access_token=`) and its value, a
 *  bearer token, and a run of 32 or more letters and digits are each `<cut>`. Needs `pathOf`. */
export const CUT_RULE = `function cut(text) {
  const keep = (path, rest) => {
    const [, folder, file, at] = /^(.*?\\/)?([\\w.-]{1,80}\\.(?:m?[jt]sx?|css|wasm))?((?::\\d+){0,2})$/.exec(path || "/") || [];
    const line = at || ((rest || "").match(/(?::\\d+){1,2}$/) || [""])[0];
    return file ? pathOf(folder || "") + file + line : pathOf(path || "/") + line;
  };
  return String(text == null ? "" : text)
    .replace(/[a-z][a-z0-9+.-]*:\\/\\/[^\\s"'()<>\\/?#]*([^\\s"'()<>?#]*)([?#][^\\s"'()<>]*)?/gi, (_, path, rest) => keep(path, rest))
    .replace(/(^|[\\s"'(=@])\\/\\/[^\\s"'()<>\\/?#]*([^\\s"'()<>?#]*)([?#][^\\s"'()<>]*)?/g, (_, before, path, rest) => before + keep(path, rest))
    .replace(/(^|[\\s"'(=@])((?:\\.{0,2}\\/)[^\\s"'()<>?#]*)([?#][^\\s"'()<>]*)?/g, (_, before, path, rest) => before + keep(path, rest))
    .replace(/([^\\s"'()<>?#]+)([?#][^\\s"'()<>]+)/g, (_, path, rest) => keep(path, rest))
    .replace(/\\b[a-z_]*(?:code|state|token)=[^\\s&"'(),;<>]*|\\bbearer\\s+[^\\s"'(),;<>]+/gi, "<cut>")
    .replace(/[A-Za-z0-9_+=-]{32,}/g, "<cut>");
}`;

/** `CUT_RULE` for the route. */
export function cut(text: string | undefined): string {
  const keep = (path: string, rest?: string) => {
    const [, folder, file, at] =
      /^(.*?\/)?([\w.-]{1,80}\.(?:m?[jt]sx?|css|wasm))?((?::\d+){0,2})$/.exec(path || "/") ?? [];
    const line = at || (rest || "").match(/(?::\d+){1,2}$/)?.[0] || "";
    return file ? pathOf(folder || "") + file + line : pathOf(path || "/") + line;
  };
  return (text || "")
    .replace(
      /[a-z][a-z0-9+.-]*:\/\/[^\s"'()<>/?#]*([^\s"'()<>?#]*)([?#][^\s"'()<>]*)?/gi,
      (_, path: string, rest?: string) => keep(path, rest),
    )
    .replace(
      /(^|[\s"'(=@])\/\/[^\s"'()<>/?#]*([^\s"'()<>?#]*)([?#][^\s"'()<>]*)?/g,
      (_, before: string, path: string, rest?: string) => before + keep(path, rest),
    )
    .replace(
      /(^|[\s"'(=@])((?:\.{0,2}\/)[^\s"'()<>?#]*)([?#][^\s"'()<>]*)?/g,
      (_, before: string, path: string, rest?: string) => before + keep(path, rest),
    )
    .replace(/([^\s"'()<>?#]+)([?#][^\s"'()<>]+)/g, (_, path: string, rest: string) =>
      keep(path, rest),
    )
    .replace(/\b[a-z_]*(?:code|state|token)=[^\s&"'(),;<>]*|\bbearer\s+[^\s"'(),;<>]+/gi, "<cut>")
    .replace(/[A-Za-z0-9_+=-]{32,}/g, "<cut>");
}

export const PAGE_EVENTS_PATH = "/.page-events";
/** The sends of one page load. */
const MOST_SENDS = 10;

export const PAGE_TAG_SCRIPT = `(() => {
  if (window.__pageTag) return;
  window.__pageTag = true;
  ${PATH_RULE}
  ${CUT_RULE}
  const page = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const pathname = cut(pathOf(location.pathname));
  const timezone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      return "";
    }
  })();
  const opened = performance.now();
  let shownAt = document.visibilityState === "visible" ? opened : null;
  let seenMs = 0;
  let furthest = scrollY;
  let sends = 0;
  let n = 0;
  const errors = new Set();
  const send = (events) => {
    if (sends >= ${MOST_SENDS}) return;
    sends += 1;
    try {
      fetch("${PAGE_EVENTS_PATH}", {
        method: "POST",
        keepalive: true,
        referrerPolicy: "no-referrer",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
        page: {
          id: page,
          title: String(document.title || "").slice(0, 120),
          screen: [screen.width, screen.height],
          viewport: [innerWidth, innerHeight],
          language: navigator.language || "",
          timezone,
          timezoneOffset: new Date().getTimezoneOffset(),
        },
        events,
      }),
      }).catch(() => {});
    } catch {}
  };
  const record = (event) => ({ ...event, n: (n += 1), pathname, at: new Date().toISOString() });
  // how far down the page was seen, as a whole percent, worked out once as the page goes away
  const scrolledOf = () => {
    try {
      const height = document.documentElement.scrollHeight;
      return height <= innerHeight ? 100 : Math.round(Math.min((Math.max(furthest, scrollY) + innerHeight) / height, 1) * 100);
    } catch {
      return 0;
    }
  };
  const errorSeen = (kind, error, said) => {
    try {
      const message = cut(String(said || (error && error.message) || error || "").slice(0, 2000)).slice(0, 300);
      if (errors.has(message)) return;
      errors.add(message);
      const stack = cut(String((error && error.stack) || "").slice(0, 8000)).slice(0, 1000);
      send([record({ type: "error", kind, message, stack })]);
    } catch {}
  };
  addEventListener("error", (event) => errorSeen("uncaught", event.error, event.message));
  addEventListener("unhandledrejection", (event) => errorSeen("rejection", event.reason));
  // one comparison a scroll, and no layout read
  addEventListener("scroll", () => void (scrollY > furthest && (furthest = scrollY)), { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") shownAt = performance.now();
    else if (shownAt !== null) (seenMs += performance.now() - shownAt), (shownAt = null);
  });
  let left = false;
  addEventListener("pagehide", () => {
    if (left) return;
    left = true;
    const scrolled = scrolledOf();
    const now = performance.now();
    const seen = seenMs + (shownAt === null ? 0 : now - shownAt);
    send([record({ type: "left", openMs: Math.round(now - opened), seenMs: Math.round(seen), scrolled })]);
  });
  send([record({ type: "viewed" })]);
})();`;
