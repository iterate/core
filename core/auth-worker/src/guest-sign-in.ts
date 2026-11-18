// guest-sign-in.ts — A GUEST: a person who types a name, for the apps of the mind that take
// guests. Off unless the config has the method (./config.ts `login.methods.guest`).
//
// WHAT IT IS FOR. An app on a mind hostname whose guard names `"guest"` (iterate/sdk
// `auth.requirePerson`): a page that someone opens by a link, with no account. The app decides
// what the link opens; here the person only says what to call them.
//
// WHAT IT PROVES: NOTHING. Anyone on the internet can be a guest, with any name. So a guest is a
// person and never a member, and counts only where an app names the way:
//   - the person is a row with no address (./users.ts `linkBySubject`, key `guest:<subject>`),
//     which no proof of an address ever reaches, and no rule makes a member (./members.ts);
//   - it has a cookie of its own (./cookies.ts `guestOf`), which only the authorization endpoint
//     reads, for a hostname's own sign-in that names guests (./authorize.ts `sessionFor`); none
//     of the mind's own pages reads it, and no consent takes it;
//   - a code or a token from it is for a mind hostname alone, never the mind's API, MCP server or
//     `/provide`, and says `member: false` (./oauth.ts `tokenIdentity`);
//   - an app's guard that names no ways does not take it (iterate/sdk).
// The cookie gives no reach by itself: it earns a session on the host of an app that names
// guests, and what that app then shows is its own code's decision.
//
//   GET  /sign-in/guest?next=…   the form, for a hostname's own sign-in that names guests. It
//                                makes nothing: a browser that fetches the page is no guest
//   POST /sign-in/guest          makes the guest, and goes on to `next`
//
// ONCE A BROWSER. The cookie lasts 30 days from the browser's last visit, so the name is asked
// once. A guest's session on an app's host lasts 15 minutes (./oauth.ts), and the next one comes
// with no question: the host sends the browser here, and the cookie answers. That is when an app
// checks again what the guest holds. A renewal stops when the app no longer names guests, an
// owner blocks the guest, the config drops the way, or the stack's bound is reached.
//
// SOMEONE ALREADY SIGNED IN IS NEVER MADE A GUEST. A browser with a session of the mind's own, or
// of Cloudflare's, gets no form: an app that takes guests and also names their way has let them in
// as themselves already (./authorize.ts), and one that names guests alone says so here.
//
// BOUNDS, since anyone can come: a name of 1 to 40 characters (iterate/principal
// `displayNameOf`); the stack's new guests and its guests' sessions in ten minutes, each a number
// of the config; 20 new guests an address. At a bound the page says to try again in ten minutes,
// and the mind gets one `account/guest-refused` for that reason in that window.
import { sameOriginPath } from "iterate/lib";
import { DISPLAY_NAME_MAX_CHARACTERS, displayNameOf } from "iterate/principal";
import { AccountFacts } from "./account-facts.ts";
import { type AskingApp, askingAppOf } from "./asking-app.ts";
import {
  clearFlowCookie,
  cloudflareSessionOf,
  flowCookie,
  flowOf,
  guestOf,
  guestSessionCookie,
  sessionOf,
} from "./cookies.ts";
import { admissionWindowOf, admitted } from "./device/limits.ts";
import { type Env, issuerOf, iterateConfigOf, offersMethod } from "./env.ts";
import { appSignIn, errorPage, otherAccountForm, page, text } from "./pages.ts";
import { methodsAskedIn } from "./sign-in.ts";
import { linkBySubject } from "./users.ts";

export const GUEST_SIGN_IN_PATH = "/sign-in/guest";

/** What marks this browser's flow cookie as the name form's: the cookie is the one Google's
 *  sign-in uses, where this field is the id_token's nonce, a random UUID. */
const FLOW_MARK = "guest";

/** The form's own answer is small: a state and a name. */
const FORM_MAX_BYTES = 4096;

export async function guestSignInResponse(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== GUEST_SIGN_IN_PATH) return null;
  if (!offersMethod(env, "guest")) return new Response("Not found", { status: 404 });
  if (request.method === "GET" || request.method === "HEAD") return form(env, request, url);
  if (request.method === "POST") return made(env, request);
  return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
}

/** THE APP THAT TAKES A GUEST, for the request `next` goes on to (a path of this origin), or null.
 *  It is a hostname's own sign-in that this stack holds (./asking-app.ts: its resource, its
 *  redirect and its client agree), and it names guests. So the form exists only on the way to an
 *  app's own page, and after it the browser goes there and nowhere else. */
async function guestAppOf(env: Env, next: string): Promise<AskingApp | null> {
  const app = await askingAppOf(env, next);
  return app && methodsAskedIn(env, next)?.includes("guest") ? app : null;
}

async function form(env: Env, request: Request, url: URL): Promise<Response> {
  const next = sameOriginPath(url.searchParams.get("next") || "/", issuerOf(env));
  const app = await guestAppOf(env, next);
  if (!app) return new Response("Not found", { status: 404 });
  const held = await heldBefore(env, request, app, next);
  if (held) return held;
  const state = crypto.randomUUID();
  const headers = new Headers({
    "set-cookie": await flowCookie(env, { next, state, nonce: FLOW_MARK, verifier: "" }),
  });
  return formPage(app, state, headers);
}

async function made(env: Env, request: Request): Promise<Response> {
  // the form makes a person, so it must come from this origin's own page, in the browser that
  // was shown it
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Send this from its own page.", 403);
  if (Number(request.headers.get("content-length")) > FORM_MAX_BYTES)
    return errorPage("This form is too long.", 413);
  const flow = await flowOf(env, request);
  const sent = await request.formData().catch(() => null);
  const cleared = new Headers({ "set-cookie": clearFlowCookie });
  if (!flow || flow.nonce !== FLOW_MARK || sent?.get("state") !== flow.state)
    return errorPage("This form is too old. Open the link you came by again.", 400, cleared, []);
  const app = await guestAppOf(env, flow.next);
  if (!app) return new Response("Not found", { status: 404 });
  const held = await heldBefore(env, request, app, flow.next);
  if (held) return held;
  const name = displayNameOf(String(sent.get("name") || ""));
  if (!name) return formPage(app, flow.state, new Headers(), "Type a name.");
  const { newPerTenMinutes } = iterateConfigOf(env).login.methods.guest!;
  if (!(await admitted(env, "guest", request, newPerTenMinutes)))
    return guestRefusal("rate", app.host);
  // A new person at each form: the subject is this guest's alone, and its key reaches no address.
  const subject = crypto.randomUUID().replaceAll("-", "");
  const user = await linkBySubject(env.DB, { provider: "guest", subject });
  console.info({ event: "auth.signed-in", method: "guest", userId: user.id });
  const facts = new AccountFacts();
  facts.add(user.id, {
    type: "events.iterate.com/account/guest-signed-in",
    payload: { userId: user.id, name, app: app.host, at: Date.now() },
    idempotencyKey: `account/guest-signed-in/${user.id}`,
  });
  const headers = new Headers({ location: flow.next, "cache-control": "no-store" });
  headers.append(
    "set-cookie",
    await guestSessionCookie(env, { id: user.id, key: user.email, name }),
  );
  headers.append("set-cookie", clearFlowCookie);
  return facts.on(new Response(null, { status: 303, headers }));
}

/** WHAT A BROWSER THAT IS SOMEONE ALREADY GETS in place of the form, or null for a stranger.
 *  Someone signed in keeps who they are, and reads how to come in. A guest goes on as the guest
 *  they are; a guest an owner blocked is refused. */
async function heldBefore(
  env: Env,
  request: Request,
  app: AskingApp,
  next: string,
): Promise<Response | null> {
  const signedIn = (await sessionOf(env, request)) || (await cloudflareSessionOf(env, request));
  if (signedIn)
    return page(
      {
        ...appPage(app),
        status: 403,
        body: `<h1>You are signed in</h1>
      <p class="center">You are signed in to ${text(iterateConfigOf(env).domain)} as <strong>${text(signedIn.email)}</strong>. ${text(app.name)} takes a guest here, and takes no sign-in of yours.</p>
      <div class="center">${otherAccountForm(next, "Sign out, and come in as a guest")}</div>`,
      },
      unlisted(),
    );
  const guest = await guestOf(env, request);
  if (guest?.blocked) return guestRefusal("blocked", app.host, guest.userId);
  if (guest)
    return new Response(null, {
      status: 303,
      headers: { location: next, "cache-control": "no-store" },
    });
  return null;
}

/** A GUEST IS NOT LET IN: the page that says so, and the mind's record of it. One event for each
 *  reason in one window of the bounds (its key), so a stranger who is refused a thousand times
 *  writes one. A blocked guest's is on their own context; a bound's names nobody, and is the
 *  mind's. */
export function guestRefusal(
  reason: "rate" | "session-rate" | "blocked",
  app: string,
  userId?: string,
): Response {
  const at = Date.now();
  console.info({ event: "auth.sign-in-refused", method: "guest", reason });
  const facts = new AccountFacts();
  const fact = {
    type: "events.iterate.com/account/guest-refused",
    payload: { reason, app, at },
    idempotencyKey: `account/guest-refused/${reason}/${userId || "stack"}/${admissionWindowOf(at)}`,
  } as const;
  if (userId) facts.add(userId, fact);
  else facts.addToMind(fact);
  const refused =
    reason === "blocked"
      ? errorPage("You cannot come in here as a guest.", 403, unlisted(), [])
      : errorPage(
          "Too many guests came here just now. Try again in ten minutes.",
          429,
          unlisted(new Headers({ "retry-after": "600" })),
          [],
        );
  return facts.on(refused);
}

function formPage(app: AskingApp, state: string, headers: Headers, error?: string): Response {
  return page(
    {
      ...appPage(app),
      status: error ? 400 : 200,
      body: `<h1>${text(`Join ${app.name}`)}</h1>
      <p class="center muted">You come in as a guest. The others here see the name you type.</p>
      ${error ? `<p class="center" role="alert"><strong>${text(error)}</strong></p>` : ""}
      <form method="post" action="${GUEST_SIGN_IN_PATH}" class="stack">
        <input type="hidden" name="state" value="${text(state)}">
        <label>Your name <input type="text" name="name" maxlength="${DISPLAY_NAME_MAX_CHARACTERS}" autocomplete="name" autofocus required></label>
        <button type="submit">Continue</button>
      </form>`,
    },
    unlisted(headers),
  );
}

/** The card of an app's own sign-in (./pages.ts `appSignIn`): its title, and its icon. */
function appPage(app: AskingApp) {
  const { title, mark, imageOrigin } = appSignIn(app);
  return { title, mark, imageOrigin, centered: true };
}

/** No search engine lists a page of this sign-in. The page helper adds the rest: nothing caches
 *  it, and it sends no referrer to another origin (`referrer-policy: same-origin`; with
 *  `no-referrer` a browser would post the form with `Origin: null`, which is refused above). */
function unlisted(headers = new Headers()) {
  headers.set("x-robots-tag", "noindex, nofollow");
  return headers;
}
