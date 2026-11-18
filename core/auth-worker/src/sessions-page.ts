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
import { clientsWithAccess, endFields, endsOf, logoOriginsOf } from "./access-list.ts";
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

async function sessionsPage(env: Env, session: PersonSession): Promise<Response> {
  const mind = configOf(env).controlPlaneHostname;
  const [browsers, access] = await Promise.all([
    liveSessionsOf(env, session.userId, reachOf(session)),
    sessionsByClientOf(env, session.userId, reachOf(session)),
  ]);
  const others = browsers.filter((browser) => browser.id !== session.id).length;
  const apps = clientsWithAccess(
    env,
    access,
    (ends, button) => `<form method="post" action="${SESSIONS_PATH}" class="inline">
          ${endFields(ends)}
          <button type="submit" class="link">${button}</button>
        </form>`,
  );
  return page({
    title: `Sessions at ${mind}`,
    wide: true,
    imageOrigin: logoOriginsOf(access),
    body: `<h1>Where you are signed in</h1>
      <p>You are signed in to ${text(mind)} as <strong>${text(session.email)}</strong>. End anything here that you do not know: it must sign in again.</p>
      <h2>This browser and your other browsers</h2>
      <p class="muted">Each browser that signed in here, at ${text(new URL(issuerOf(env)).host)}, holds a session. It signs you in to the mind's apps without a new sign-in.</p>
      <ul class="browser-sessions">${browsers.map((browser) => browserItem(browser, session.id)).join("")}</ul>
      ${
        others
          ? `<form method="post" action="${SESSIONS_PATH}" class="inline">
          <input type="hidden" name="others" value="1">
          <button type="submit">End all other browsers</button>
        </form>`
          : ""
      }
      <h2>Apps and tools signed in as you</h2>
      <p class="muted">Each app, CLI, device or agent that you let in, and each of the mind's own pages that you opened, holds a sign-in as you. Under its name is each sign-in it holds, and what that reaches. End one here, and it stops working with every token it holds.</p>
      ${apps ? `<ul class="access-list">${apps}</ul>` : `<p class="muted">No app or tool holds a sign-in as you.</p>`}`,
  });
}

function browserItem(browser: SessionRow, current: string): string {
  const here = browser.id === current;
  const end = here
    ? `<form method="post" action="${SIGN_OUT_PATH}" class="inline">
          <button type="submit" class="link">Sign out</button>
        </form>`
    : `<form method="post" action="${SESSIONS_PATH}" class="inline">
          <input type="hidden" name="session" value="${text(browser.id)}">
          <button type="submit" class="link">End</button>
        </form>`;
  return `<li data-session="${text(browser.id)}"${here ? " data-current" : ""}>
        <strong>${text(browserNameOf(browser.userAgent))}</strong>${here ? " <span>(this browser)</span>" : ""}
        <span class="muted">signed in with ${browser.method === "passkey" ? "a passkey" : "a code by email"} at ${minute(browser.createdAt)}, last seen ${minute(browser.lastSeenAt)}.</span>
        ${end}
      </li>`;
}

export const minute = (at: number) =>
  `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** A SHORT NAME FOR A BROWSER, from its User-Agent: its browser and its system, such as "Chrome on
 *  macOS". A string it does not know is "A browser". The order matters: Edge and Opera say Chrome
 *  too, Chrome says Safari, and an iPhone says "like Mac OS X". */
export function browserNameOf(userAgent: string): string {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  if (browser) return browser;
  return system ? `A browser on ${system}` : "A browser";
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\b(OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(Firefox|FxiOS)\//, "Firefox"],
  [/\b(Chrome|HeadlessChrome|CriOS|Chromium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];
