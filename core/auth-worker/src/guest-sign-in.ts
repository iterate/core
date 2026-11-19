// guest-sign-in.ts — A GUEST: a person who types a name, for an app of the mind that names the
// sign-in method "guest" (iterate/app-description `AppDescription.signIn`).
//
// WHAT IT IS FOR. A page that someone opens by a link, with no account. The app decides what the
// link opens; here the person only says what to call them.
//
// WHAT IT PROVES: NOTHING. Anyone on the internet can be a guest, with any name. So a guest is a
// person and never a member, and counts only at an app that names the method:
//   - the person is a row whose key is `guest:<subject>` (./cookies.ts `GUEST_KEY_PREFIX`), which
//     is no address: no proof of an address reaches it, and no member is ever such a key
//     (./members.ts `isMember`);
//   - it has a cookie of its own (./cookies.ts `guestOf`), which only the authorization endpoint
//     reads, for a hostname's own sign-in whose app names guests (./authorize.ts `guestAt`); none
//     of the mind's own pages reads it, and no consent takes it;
//   - a code or a token from it is for a mind hostname alone, never the mind's API, MCP server or
//     the right to hand in a mind, and says `member: false` (./oauth.ts `tokenIdentity`).
// The cookie gives no reach by itself: it earns a session on the host of an app that names
// guests, and what that app then shows is its own code's decision.
//
//   GET  /sign-in/guest?next=…   the form, for a hostname's own sign-in whose app names guests.
//                                It makes nothing: a browser that fetches the page is no guest
//   POST /sign-in/guest          makes the guest, and goes on to `next`
//
// ONCE A BROWSER. The cookie lasts 30 days from the browser's last visit, so the name is asked
// once. A guest's session on an app's host lasts 15 minutes (./oauth.ts), and the next one comes
// with no question: the host sends the browser here, and the cookie answers. That is when an app
// checks again what the guest holds. A renewal stops when the app no longer names guests, an
// owner blocks the guest, or the stack's bound is reached.
//
// SOMEONE ALREADY SIGNED IN IS NEVER MADE A GUEST. A browser with a session of the mind's own gets
// no form: an app that takes guests and also names that person's method has let them in as
// themselves already (./authorize.ts), and one that does not says so here.
//
// BOUNDS, since anyone can come: a name of 1 to 40 characters (iterate/principal
// `displayNameOf`); 120 new guests and 600 guests' sessions for the stack in ten minutes; 20 new
// guests an address, and 6 sessions a guest, so that no one cookie uses up the stack's number
// (./device/limits.ts). At a bound the page says to try again in ten minutes, and the mind gets
// one `account/guest-refused` for that reason in that window. A guest's grant holds no refresh
// token: every next 15 minutes are asked for here.
import { sameOriginPath } from "iterate/lib";
import { DISPLAY_NAME_MAX_CHARACTERS, displayNameOf } from "iterate/principal";
import { AccountFacts } from "./account-facts.ts";
import { type AskingApp, askingAppOf } from "./asking-app.ts";
import {
  clearGuestFormCookie,
  clearMindCookie,
  GUEST_KEY_PREFIX,
  guestCookie,
  guestFormCookie,
  guestFormOf,
  guestOf,
  personSessionOf,
} from "./cookies.ts";
import { admissionWindowOf, admitted } from "./device/limits.ts";
import { configOf, type Env, issuerOf } from "./env.ts";
import { appSignIn, errorPage, otherAccountForm, page, text } from "./pages.ts";
import { userOf } from "./users.ts";

const GUEST_SIGN_IN_PATH = "/sign-in/guest";

/** The name form for the sign-in that `next` goes on to, as a whole address of the issuer. */
export const guestFormHref = (env: Env, next: string) =>
  `${issuerOf(env)}${GUEST_SIGN_IN_PATH}?${new URLSearchParams({ next })}`;

/** New guests that the stack takes in ten minutes, from every address together. */
const GUESTS_PER_TEN_MINUTES = 120;
/** Guests' sessions on the apps' hosts that the stack gives in ten minutes (./authorize.ts). */
export const GUEST_SESSIONS_PER_TEN_MINUTES = 600;

/** The form's own answer is small: a state and a name. */
const FORM_MAX_BYTES = 4096;

export async function guestSignInResponse(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== GUEST_SIGN_IN_PATH) return null;
  if (request.method === "GET" || request.method === "HEAD") return form(env, request, url);
  if (request.method === "POST") return made(env, request);
  return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
}

/** THE APP THAT TAKES A GUEST, for the request `next` goes on to (a path of this origin), or null.
 *  It is a hostname's own sign-in that this stack holds (./asking-app.ts: its resource, its
 *  redirect and its client agree), and its app names guests. So the form exists only on the way
 *  to an app's own page, and after it the browser goes there and nowhere else. */
async function guestAppOf(env: Env, next: string): Promise<AskingApp | null> {
  const app = await askingAppOf(env, next);
  return app?.signIn.includes("guest") ? app : null;
}

async function form(env: Env, request: Request, url: URL): Promise<Response> {
  const next = sameOriginPath(url.searchParams.get("next") || "/", issuerOf(env));
  const app = await guestAppOf(env, next);
  if (!app) return new Response("Not found", { status: 404 });
  const held = await heldBefore(env, request, app, next);
  if (held) return held;
  // A browser that was shown this form already (a second tab, a reload) gets the same state
  // again, so the answer of either page counts.
  const shown = await guestFormOf(env, request);
  const state = shown?.next === next ? shown.state : crypto.randomUUID();
  const headers = new Headers({ "set-cookie": await guestFormCookie(env, { next, state }) });
  return formPage(app, state, headers);
}

async function made(env: Env, request: Request): Promise<Response> {
  // the form makes a person, so it must come from this origin's own page, in the browser that
  // was shown it
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Send this from its own page.", 403);
  if (Number(request.headers.get("content-length")) > FORM_MAX_BYTES)
    return errorPage("This form is too long.", 413);
  const shown = await guestFormOf(env, request);
  const sent = await request.formData().catch(() => null);
  const cleared = new Headers({ "set-cookie": clearGuestFormCookie });
  if (!shown || sent?.get("state") !== shown.state)
    return errorPage("This form is too old. Open the link you came by again.", 400, cleared, []);
  const app = await guestAppOf(env, shown.next);
  if (!app) return new Response("Not found", { status: 404 });
  const held = await heldBefore(env, request, app, shown.next);
  if (held) return held;
  const name = displayNameOf(String(sent.get("name") || ""));
  if (!name) return formPage(app, shown.state, new Headers(), "Type a name.");
  if (!(await admitted(env, "guest", request, GUESTS_PER_TEN_MINUTES)))
    return guestRefusal("rate", app.host);
  // A new person at each form: the subject is this guest's alone, and its key reaches no address.
  const user = await userOf(
    env.DB,
    `${GUEST_KEY_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`,
  );
  console.info({ event: "auth.signed-in", method: "guest", userId: user.id });
  const facts = new AccountFacts();
  facts.add(user.id, {
    type: "events.iterate.com/account/guest-signed-in",
    payload: { userId: user.id, name, app: app.host, at: Date.now() },
    idempotencyKey: `account/guest-signed-in/${user.id}`,
  });
  const headers = new Headers({ location: shown.next, "cache-control": "no-store" });
  headers.append("set-cookie", await guestCookie(env, { id: user.id, key: user.email, name }));
  headers.append("set-cookie", clearGuestFormCookie);
  // one way at a time: a mind's session in this browser ends, so authorize takes this guest
  headers.append("set-cookie", clearMindCookie);
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
  const signedIn = await personSessionOf(env, request);
  if (signedIn)
    return page(
      {
        ...appPage(app),
        status: 403,
        body: `<h1>You are signed in</h1>
      <p class="center">You are signed in to ${text(configOf(env).controlPlaneHostname)} as <strong>${text(signedIn.email)}</strong>. ${text(app.name)} takes a guest here, and takes no sign-in of yours.</p>
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
