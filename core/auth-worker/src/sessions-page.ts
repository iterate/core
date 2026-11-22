// sessions-page.ts — /sessions: WHERE A PERSON IS SIGNED IN, AND THE WAY TO END IT. For anyone
// signed in here, member or not. Two lists, of this person alone:
//
// A session that a mailed code opened for a person who was no member lists and ends its own kind
// alone (./cookies.ts `reachOf`); a passkey's lists and ends everything of its person.
//
// - the browsers that hold a session at the issuer (./cookies.ts `liveSessionsOf`), this one
//   marked; each ends by its own button, and "End all other browsers" ends the rest. To end this
//   browser's is to sign out (./sign-in.ts `signOutResponse`).
// - the apps and tools that hold a sign-in as the person, by OAuth client (./oauth.ts
//   `sessionsByClientOf`, drawn by ./access-list.ts), each ended by `endAccess`.
//
// It stays on the control-plane hostname, the trusted origin, because a person opens it when they
// suspect a break-in: a mind's own code draws none of it, so a hostile or broken mind hides no
// row. A session's cookie ends access and never adds it (./signed-change.ts), so a form here posts
// with the cookie alone, from this origin's own page.
import { AccountFacts } from "./account-facts.ts";
import { clientsWithAccess, endFields, endsOf, logoOriginsOf, pastTimeTag } from "./access-list.ts";
import {
  endSessions,
  liveSessionsOf,
  type PersonSession,
  personSessionOf,
  reachOf,
  type SessionRow,
} from "./cookies.ts";
import { configOf, type Env, issuerOf } from "./env.ts";
import { endAccess, sessionsByClientOf } from "./oauth.ts";
import { errorPage, page, SIGN_OUT_PATH, text } from "./pages.ts";
import { signInHref } from "./sign-in.ts";

export const SESSIONS_PATH = "/sessions";

const seeOther = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

export async function sessionsResponse(env: Env, request: Request): Promise<Response | null> {
  if (new URL(request.url).pathname !== SESSIONS_PATH) return null;
  const post = request.method === "POST";
  if (!post && request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405 });
  // anyone signed in sees and ends their own: a person who is no member too
  const session = await personSessionOf(env, request);
  if (!session)
    return post
      ? errorPage("You are signed out. Sign in and try again.", 401)
      : seeOther(signInHref(SESSIONS_PATH));
  if (!post) return sessionsPage(env, session);
  // the session's cookie ends a session or a sign-in, so the form must come from this origin's
  // own page
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Send this from its own page.", 403);
  const form = await request.formData().catch(() => null);
  const facts = new AccountFacts();
  const ended = form?.get("session");
  const ends = endsOf(form);
  // this browser's own is ended by the sign-out, whose form is on its row
  const reach = reachOf(session);
  if (typeof ended === "string" && ended && ended !== session.id)
    await endSessions(env, session.userId, reach, { session: ended }, facts);
  else if (form?.get("others"))
    await endSessions(env, session.userId, reach, { allBut: session.id }, facts);
  else if (ends) await endAccess(env, session.userId, reach, ends, facts);
  return facts.on(seeOther(SESSIONS_PATH));
}

export const minute = (at: number) =>
  `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** A SHORT NAME FOR A BROWSER, from its User-Agent: its browser and its system, such as "Chrome on
 *  macOS". A string it does not know is "A browser". The order matters: Edge and Opera say Chrome
 *  too, Chrome says Safari, and an iPhone says "like Mac OS X". */
export function browserNameOf(userAgent: string): string {
  const { browser, system } = parsedAgent(userAgent);
  if (browser && system) return `${browser.name} on ${system.name}`;
  if (browser) return browser.name;
  return system ? `A browser on ${system.name}` : "A browser";
}

async function sessionsPage(env: Env, session: PersonSession): Promise<Response> {
  const mind = configOf(env).controlPlaneHostname;
  const now = Date.now();
  const [browsers, access] = await Promise.all([
    liveSessionsOf(env, session.userId, reachOf(session)),
    sessionsByClientOf(env, session.userId, reachOf(session)),
  ]);
  const others = browsers.filter((browser) => browser.id !== session.id).length;
  const apps = clientsWithAccess(
    env,
    access,
    (ends, button, label) => `<form method="post" action="${SESSIONS_PATH}">
          ${endFields(ends)}
          <button type="submit" class="secondary small" aria-label="${text(label)}">${text(button)}</button>
        </form>`,
  );
  return page({
    title: `Sessions at ${mind}`,
    wide: true,
    imageOrigin: logoOriginsOf(access),
    body: `<div class="page-head">
        <h1>Where you are signed in</h1>
        <p class="muted"><strong>${text(session.email)}</strong> &middot; ${text(mind)}</p>
      </div>
      <section class="session-section">
        <div class="section-head">
          <div class="section-title"><h2>Browsers</h2><span class="count">${browsers.length}</span></div>
          ${
            others
              ? `<form method="post" action="${SESSIONS_PATH}">
            <input type="hidden" name="others" value="1">
            <button type="submit" class="secondary small">End all other browsers</button>
          </form>`
              : ""
          }
        </div>
        <ul class="browser-sessions">${browsers.map((browser) => browserItem(browser, session.id, now)).join("")}</ul>
      </section>
      <section class="session-section">
        <div class="section-head">
          <div class="section-title"><h2>Apps and tools</h2>${access.length ? `<span class="count">${access.length}</span>` : ""}</div>
        </div>
        ${apps ? `<ul class="access-list">${apps}</ul>` : `<p class="muted">Nothing acts as you.</p>`}
      </section>`,
  });
}

function browserItem(browser: SessionRow, current: string, now: number): string {
  const here = browser.id === current;
  const name = browserNameOf(browser.userAgent);
  const { browser: kind, system } = parsedAgent(browser.userAgent);
  const iconKey = kind?.key || system?.device || "unknown";
  const method = browser.method === "passkey" ? "Passkey" : "Email code";
  const metaParts = [method, ...browserActivityOf(browser, here, now)]
    .map((part) => `<span class="meta-item">${part}</span>`)
    .join(" ");
  const end = here
    ? `<form method="post" action="${SIGN_OUT_PATH}">
          <button type="submit" class="secondary small" aria-label="Sign out of this browser (${text(name)})">Sign out</button>
        </form>`
    : `<form method="post" action="${SESSIONS_PATH}">
          <input type="hidden" name="session" value="${text(browser.id)}">
          <button type="submit" class="secondary small" aria-label="End ${text(name)} session">End</button>
        </form>`;
  return `<li class="browser-row" data-session="${text(browser.id)}"${here ? " data-current" : ""}>
        <div class="tile small" aria-hidden="true" data-browser="${iconKey}">${BROWSER_SVGS[iconKey]}</div>
        <div class="row-title">
          <strong>${text(name)}</strong>${here ? ` <span class="badge badge-current">This browser</span>` : ""}
        </div>
        <div class="row-meta">
          <div class="meta-line"><div class="meta-track">${metaParts}</div></div>
        </div>
        ${end}
      </li>`;
}

function browserActivityOf(browser: SessionRow, here: boolean, now: number): string[] {
  if (here) {
    return now - browser.createdAt < 60_000
      ? ["Active now"]
      : ["Active now", `Signed in ${pastTimeTag(browser.createdAt, now)}`];
  }
  if (browser.lastSeenAt - browser.createdAt >= 60_000) {
    return [
      `Seen ${pastTimeTag(browser.lastSeenAt, now)}`,
      `Signed in ${pastTimeTag(browser.createdAt, now)}`,
    ];
  }
  return [`Signed in ${pastTimeTag(browser.createdAt, now)}`];
}

type BrowserKey = "edge" | "opera" | "samsung" | "firefox" | "chrome" | "safari";
type DeviceKind = "phone" | "tablet";

function parsedAgent(userAgent: string) {
  const browser = BROWSERS.find(({ pattern }) => pattern.test(userAgent));
  const system = SYSTEMS.find(({ pattern }) => pattern.test(userAgent));
  return { browser, system };
}

const BROWSERS: { pattern: RegExp; key: BrowserKey; name: string }[] = [
  { pattern: /\bEdg(e|A|iOS)?\//, key: "edge", name: "Edge" },
  { pattern: /\b(OPR|Opera)\//, key: "opera", name: "Opera" },
  { pattern: /\bSamsungBrowser\//, key: "samsung", name: "Samsung Internet" },
  { pattern: /\b(Firefox|FxiOS)\//, key: "firefox", name: "Firefox" },
  { pattern: /\b(Chrome|HeadlessChrome|CriOS|Chromium)\//, key: "chrome", name: "Chrome" },
  { pattern: /\bVersion\/[\d.]+.*\bSafari\//, key: "safari", name: "Safari" },
];

const SYSTEMS: { pattern: RegExp; name: string; device?: DeviceKind }[] = [
  { pattern: /\biPhone\b/, name: "iPhone", device: "phone" },
  { pattern: /\biPad\b/, name: "iPad", device: "tablet" },
  { pattern: /\bAndroid\b/, name: "Android", device: "phone" },
  { pattern: /\bCrOS\b/, name: "ChromeOS" },
  { pattern: /\bWindows\b/, name: "Windows" },
  { pattern: /\bMac OS X\b|\bMacintosh\b/, name: "macOS" },
  { pattern: /\bLinux\b/, name: "Linux" },
];

// Inline SVGs because the page's CSP allows no outside image (`pages.ts`).
const BROWSER_SVGS: Record<BrowserKey | DeviceKind | "unknown", string> = {
  chrome: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#EA4335" d="M3.64 6.52A10 10 0 0 1 20.93 7.5H12A4.5 4.5 0 0 0 8.1 14.25Z"/><path fill="#FBBC05" d="M20.93 7.5A10 10 0 0 1 11.43 21.98L15.9 14.25A4.5 4.5 0 0 0 12 7.5Z"/><path fill="#34A853" d="M11.43 21.98A10 10 0 0 1 3.64 6.52L8.1 14.25A4.5 4.5 0 0 0 15.9 14.25Z"/><circle cx="12" cy="12" r="3.4" fill="#4285F4"/></svg>`,
  safari: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#006CFF"/><path stroke="#fff" stroke-opacity=".55" stroke-width="1.25" stroke-linecap="round" d="M12 3.5v1.6M12 18.9v1.6M3.5 12h1.6M18.9 12h1.6"/><polygon fill="#FF453A" points="17.3,6.7 13.5,13.5 10.5,10.5"/><polygon fill="#fff" points="6.7,17.3 10.5,10.5 13.5,13.5"/></svg>`,
  firefox: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12.2" cy="12.6" r="5.8" fill="#7542E5"/><path fill="#FF7139" d="M19.6 6.2A9.8 9.8 0 0 0 14.8 3c.5 1.1.6 2.3.2 3.4a4.2 4.2 0 0 0-3.3-1.6c-2.3 0-4.2 1.8-4.3 4.1-1-.4-1.8-1.2-2.1-2.2A9.9 9.9 0 0 0 2.2 13c0 5.4 4.4 9.5 9.8 9.5s9.8-4.3 9.8-9.7c0-2.4-.8-4.7-2.2-6.6m-7.4 11.4a4.3 4.3 0 0 1-4.3-4.3c0-1.6.9-3 2.3-3.7-.2 1.5.7 2.9 2.2 3.2 1.2.3 2.5-.3 3.1-1.4.7 1.1.8 2.5.2 3.7a4 4 0 0 1-3.5 2.5"/><path fill="#FFBD4F" d="M19.6 6.2c-1-1.3-2.5-2.4-4.8-3.2.5 1.1.6 2.3.2 3.4 1.5.3 2.8 1.3 3.4 2.8.4 1 .5 2.2.2 3.3 1.4-2 .9-4.6-1-6.3z"/></svg>`,
  edge: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#0078D4" d="M12 2C6.48 2 2 6.48 2 12c0 1.9.53 3.68 1.45 5.2C3.1 12.6 6.5 8.6 11.2 8.6c2.6 0 4.5 1.35 4.5 3.15 0 1.35-1.05 2.35-2.65 2.35-1.2 0-2.25-.55-2.75-1.4-.35 2.15 1.3 4.05 3.85 4.05 4.35 0 7.85-2.65 7.85-6.55C22 5.75 17.52 2 12 2"/><path fill="#14B8A6" d="M3.45 17.2A9.96 9.96 0 0 0 12 22c3.95 0 7.36-2.28 8.98-5.6-1.58 1.35-3.73 2.05-6.08 1.85-4.15-.35-6.9-3.4-6.4-6.95.32-2.25 2.2-3.95 4.7-4.2A7.9 7.9 0 0 0 10.6 6.6c-4.55 0-7.65 3.9-7.15 10.6"/></svg>`,
  opera: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#FF1B2D" fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m.7 3.2c2.6 0 4.6 3 4.6 6.8s-2 6.8-4.6 6.8S8.1 15.8 8.1 12s2-6.8 4.6-6.8"/></svg>`,
  samsung: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="7.2" fill="#7459F5"/><ellipse cx="12" cy="12" rx="10.4" ry="3.4" fill="none" stroke="currentColor" stroke-width="1.6" transform="rotate(-22 12 12)"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10 6h4M10.5 18.5h3"/></svg>`,
  tablet: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2.5" width="16" height="19" rx="2.5"/><circle cx="12" cy="18.5" r="1" fill="currentColor" stroke="none"/></svg>`,
  unknown: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18"/><circle cx="6.5" cy="6.5" r=".9" fill="currentColor" stroke="none"/><circle cx="9.5" cy="6.5" r=".9" fill="currentColor" stroke="none"/></svg>`,
};
