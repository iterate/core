// live-reload.js — AN APP'S PAGE TAKES A NEW COMMIT BY ITSELF. Every app of this mind serves this
// one file at /live-reload.js (its app.ts), and each page loads it with one line of its index.html.
// Take that line out, and the page changes at its next load only, as before.
//
// A commit to this repo is published a few seconds after it lands. The page then asks for its own
// files again, and each answer has a tag that changes when the file does (serveFiles). Six seconds
// after it first sees a change, when every Worker of the mind serves the new files, it takes it:
//   - a stylesheet that changed is swapped in place: nothing reloads;
//   - a script, or the page itself, that changed needs a reload. The page waits while somebody
//     types in it. Then it reloads, and what the person saw stays over the app until the app has
//     drawn itself again, so nothing flashes.
//
// When it looks: a member's page hears of each publication at once
// (`events.iterate.com/mind/worker-updated` on the mind's root, over the host's /itx). Every page
// also looks when its tab comes to the front. Nothing asks on a timer, so an open tab costs nothing.

const HELD = "live-reload:held";
const app = () => document.getElementById("root") || document.body;
/** Every element of the app that has been scrolled, by where it is in the app, with how far. */
const scrolled = (within) =>
  [...within.querySelectorAll("*")]
    .map((element, index) => [index, element.scrollTop, element.scrollLeft])
    .filter(([, top, left]) => top || left);

// ── AFTER A RELOAD THAT THIS FILE ASKED FOR: what the person saw stays until the app is drawn ──
const held = sessionStorage.getItem(HELD);
if (held) {
  sessionStorage.removeItem(HELD);
  const { html, height, scrolls, scrollY } = JSON.parse(held);
  const live = app();
  // The same element again, so the page's own styles draw it as before. It comes after the live
  // one, so the app finds its own element by id. Markup set this way runs no script.
  const cover = live.cloneNode(false);
  cover.innerHTML = html;
  cover.inert = true;
  cover.setAttribute("aria-hidden", "true");
  const box = live.getBoundingClientRect();
  const { backgroundColor } = getComputedStyle(document.body);
  Object.assign(cover.style, {
    position: "absolute",
    top: `${box.top + window.scrollY}px`,
    left: `${box.left + window.scrollX}px`,
    width: `${box.width}px`,
    height: `${Math.max(height, box.height)}px`,
    margin: "0",
    // above whatever the app draws: the largest z-index a browser keeps
    zIndex: String(2 ** 31 - 1),
    background: backgroundColor === "rgba(0, 0, 0, 0)" ? "Canvas" : backgroundColor,
  });
  live.after(cover);
  const parts = cover.querySelectorAll("*");
  for (const [index, top, left] of scrolls) parts[index]?.scrollTo(left, top);
  window.scrollTo(0, scrollY);
  // The app is drawn when it has changed its element and then left it alone for a moment. A
  // person who touches the page gets it at once, and it never stays covered for long.
  let quiet;
  const drawn = () => {
    watch.disconnect();
    clearTimeout(quiet);
    clearTimeout(latest);
    cover.remove();
  };
  const watch = new MutationObserver(() => {
    clearTimeout(quiet);
    quiet = setTimeout(drawn, 400);
  });
  watch.observe(live, { childList: true, subtree: true, characterData: true, attributes: true });
  const latest = setTimeout(drawn, 4000);
  for (const touch of ["pointerdown", "keydown", "wheel"])
    window.addEventListener(touch, drawn, { once: true, capture: true });
}

// ── THE PAGE'S OWN FILES, AND WHETHER ONE CHANGED ──
/** The page, and each stylesheet and script that it loaded from this origin, with no query. */
function ownFiles() {
  const named = [...document.querySelectorAll('link[rel="stylesheet"][href]')].map(
    (link) => link.href,
  );
  const loaded = performance.getEntriesByType("resource").map((entry) => entry.name);
  const own = [...named, ...loaded]
    .map((address) => new URL(address, location.href))
    .filter((url) => url.origin === location.origin && /\.(?:js|css)$/.test(url.pathname))
    .map((url) => url.pathname);
  // "/" is the page whatever its path: an app's index answers there
  return [...new Set(["/", ...own])];
}

/** A file's tag: as the browser holds it ("force-cache": no request), or as the host has it now.
 *  A page can come with no tag, since a proxy on the way may take it off HTML: its text then says
 *  whether it changed. */
const tagOf = (path, cache) =>
  fetch(path, { cache })
    .then(async (answer) => {
      if (!answer.ok) return null;
      const tag = answer.headers.get("etag");
      if (tag) return tag;
      const text = await answer.text();
      let hash = 5381;
      for (let at = 0; at < text.length; at += 1)
        hash = (Math.imul(hash, 33) ^ text.charCodeAt(at)) >>> 0;
      return `text-${hash.toString(36)}-${text.length}`;
    })
    .catch(() => null);

const tags = new Map();
/** The files that changed since the page loaded them, each with its new tag. */
async function changedFiles() {
  const changed = [];
  for (const path of ownFiles()) {
    const before = tags.get(path) || (await tagOf(path, "force-cache"));
    const now = await tagOf(path, "no-cache");
    if (before) tags.set(path, before);
    if (before && now && now !== before) changed.push({ path, tag: now });
  }
  return changed;
}

// ── WHAT A CHANGE DOES ──
/** The new stylesheet beside the old one, which goes when the new one is there: no bare moment. */
function swap({ path, tag }) {
  tags.set(path, tag);
  for (const old of document.querySelectorAll('link[rel="stylesheet"][href]')) {
    if (new URL(old.href).pathname !== path || new URL(old.href).origin !== location.origin)
      continue;
    const next = old.cloneNode();
    next.href = `${path}?live=${encodeURIComponent(tag)}`;
    next.addEventListener("load", () => {
      old.remove();
      // as the page's own first script does: the theme file says whether the page is dark
      const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
      document.documentElement.classList.toggle("dark", dark);
    });
    old.after(next);
  }
}

/** Somebody has written in a field of the page and is still in it. */
function typing() {
  const at = document.activeElement;
  if (!at || at === document.body) return false;
  // an editor that is not a form field (the chat's composer) holds its words as text
  const written = /^(?:TEXTAREA|INPUT)$/.test(at.tagName)
    ? at.value
    : at.isContentEditable && at.textContent.trim();
  return Boolean(written);
}

let owed = false;
function reload() {
  owed = typing();
  if (owed) return;
  const live = app();
  sessionStorage.setItem(
    HELD,
    JSON.stringify({
      html: live.innerHTML,
      height: live.getBoundingClientRect().height,
      scrolls: scrolled(live),
      scrollY: window.scrollY,
    }),
  );
  location.reload();
}
// a reload that waited for a person goes when they send, clear or leave what they wrote
for (const moment of ["input", "focusout"])
  document.addEventListener(moment, () => owed && setTimeout(reload), true);

const later = (seconds) => new Promise((wait) => setTimeout(wait, seconds * 1000));

let looking;
// a publication's event that came while a look was under way: it gets a look of its own after
let owedLook = false;
/** Ask for the page's files again: once, or, after a publication's event, again and again for
 *  half a minute with longer and longer waits, since a publication can be served a while after
 *  its event. Most commits change no file of this page: then every look finds nothing, and each
 *  answer is a 304.
 *
 *  A CHANGE IS TAKEN WHEN IT HAS STOOD FOR SIX SECONDS. For five seconds after a publication some
 *  of the mind's Workers still answer with the one before it. So of two requests in that time one
 *  can get the new file and the next the old one: a stylesheet swapped then, or a page reloaded
 *  then, could come back old and stay old. */
function look(afterAnEvent) {
  if (looking) {
    owedLook ||= afterAnEvent;
    return looking;
  }
  looking = (async () => {
    for (const seconds of afterAnEvent ? [0, 1, 1, 1, 2, 2, 3, 5, 8, 13] : [0]) {
      await later(seconds);
      if (!(await changedFiles()).length) continue;
      await later(6);
      const changed = await changedFiles();
      if (changed.some(({ path }) => !path.endsWith(".css"))) return reload();
      return changed.forEach(swap);
    }
  })().finally(() => {
    looking = undefined;
    if (!owedLook) return;
    owedLook = false;
    void look(true);
  });
  return looking;
}

// ── WHEN IT LOOKS ──
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void look(false);
});

/** The member's itx on this host, for the one event. A host with no /itx, and a person who is no
 *  member, get no socket: their page looks when its tab comes to the front. */
// Kept for the page's life: a session and a subscription that nothing holds can be collected, and
// the events would stop with no sign.
const listening = {};
function listen() {
  const socket = new WebSocket(new URL("/itx", location.href.replace(/^http/, "ws")));
  let opened = false;
  socket.addEventListener("open", async () => {
    opened = true;
    const { newWebSocketRpcSession } = await import("@iterate-com/ui/live");
    listening.itx = newWebSocketRpcSession(socket);
    listening.subscription = await listening.itx.subscribe({
      consumes: ["events.iterate.com/mind/worker-updated"],
      target: () => void look(true),
    });
    // what was published while no socket was open
    void look(false);
  });
  // a mind that was deployed again closes its sockets: listen again, a little later
  socket.addEventListener("close", () => opened && setTimeout(listen, 5000));
}
listen();
