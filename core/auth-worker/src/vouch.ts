// vouch.ts — THIS MIND VOUCHES FOR ITS MEMBER to another mind, for "sign in with your mind"
// (./mind-sign-in.ts is the other mind's half). This mind is B; A is the mind that asks, at a
// hostname `for` that A's identity log lists.
//
//   HEAD /sign-in/vouch                          204: a release that vouches (A asks first)
//   GET  /sign-in/vouch?for=<A>&app&state&nonce  for a member alone: one line and one button
//   POST /sign-in/vouch                          signs, from this page alone
//   GET  /sign-in/open?to=<an app's URL>         this mind's own link to an app of another mind:
//                                                a one-use intent, then on to the app
//
// WHAT IT SIGNS: one statement, with the stack's working key (./stack-key.ts `signedByStack`): for
// A's id, of the type `SIGN_IN_VOUCHED_TYPE`, `{ state, nonce, user: <the member's user id>,
// member: true, to: <A's issuer origin> }`, for 60 seconds. NO ADDRESS AND NO NAME: an address
// owns nothing, and A learns that this person is a member here and which one, nothing more. The
// state and the nonce are A's, for the browser that A sent here; they mean nothing to this mind.
//
// WHERE IT GOES: to A's ISSUER alone, the first hostname of A's log ("where the control plane
// answers; the first is preferred"), whatever hostname of that log `for` names: a page posts it to
// `https://<that hostname>/sign-in/mind/return`, and the statement says so (`to`), which A checks.
// So no other host that A's log lists, and no app of A, gets a proof that A's issuer takes. Never
// in a URL. It proves a person to A; it lets neither mind write to the other.
//
// THE PAGE NAMES the issuer hostname, which A's log proves. `app` comes with the browser, so the
// page names that app only when A's issuer says it is an app of A that names "mind"
// (./mind-sign-in.ts `appNamed`), asked beside A's log, for two seconds at most: "Sign in to
// iterate Cloud (cloud.iterate.com), an app of iterate.iterate.com". Without that answer it names
// the issuer alone.
//
// NO PRESS, ONLY WHEN THE MEMBER BEGAN HERE. Any site can send a member's browser to the vouch, so
// the page always asks, but for a mind that this mind lets in (a meld rule for A's id) when this
// mind's own page opened that app a moment ago (`/sign-in/open`: an intent for that app's host,
// for this member, for one use and two minutes; ./cookies.ts `vouchIntentCookie`). The open is
// taken only from this mind's own site (`Sec-Fetch-Site`), or from an address the person typed.
import { publishedMindOf } from "iterate/mind-identity-log";
import { isMindControlPlaneHostname } from "iterate/signed";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import {
  clearVouchIntentCookie,
  personSessionOf,
  vouchIntentCookie,
  vouchIntentOf,
} from "./cookies.ts";
import { configOf, type Env, issuerOf } from "./env.ts";
import { isMemberSession } from "./members.ts";
import {
  APP_NAME_MAX,
  MIND_APP_PATH,
  MIND_RETURN_PATH,
  SIGN_IN_VOUCHED_TYPE,
  VOUCH_PATH,
} from "./mind-sign-in.ts";
import { errorPage, notMemberPage, page, text } from "./pages.ts";
import { signInHref } from "./sign-in.ts";
import { signedByStack } from "./stack-key.ts";

/** A's state and nonce: its own random text, short. */
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
/** Where a request to open comes from, when it is this mind's own: its site, or the person. */
const OWN_FETCH_SITES = ["same-origin", "same-site", "none"];
/** A's answer about its app waits this long; then the page names the issuer alone. */
const APP_CHECK_MS = 2_000;

export async function vouchResponse(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/sign-in/open" && request.method === "GET")
    return opened(env, request, url);
  if (url.pathname !== VOUCH_PATH) return null;
  if (request.method === "HEAD")
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (request.method === "GET")
    return asked(env, request, url.searchParams, `${url.pathname}${url.search}`, false);
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Send this from its own page.", 403);
  const form = await request.formData().catch(() => null);
  const fields = new URLSearchParams();
  for (const name of ["for", "app", "state", "nonce"])
    fields.set(name, String(form?.get(name) || ""));
  return asked(env, request, fields, `${VOUCH_PATH}?${fields}`, true);
}

/** THIS MIND'S OWN LINK TO AN APP OF ANOTHER MIND: for a member, from this mind's own site, it
 *  sets the intent for that app's host and goes on to `to`. */
async function opened(env: Env, request: Request, url: URL): Promise<Response> {
  const to = URL.parse(url.searchParams.get("to") || "");
  if (!to || to.protocol !== "https:" || to.port || to.username || to.password)
    return errorPage("This link names no app to open.", 400);
  const session = await personSessionOf(env, request);
  if (!session)
    return new Response(null, {
      status: 302,
      headers: {
        location: signInHref(`${url.pathname}${url.search}`),
        "cache-control": "no-store",
      },
    });
  const own = configOf(env);
  if (!(await isMemberSession(env, session)))
    return notMemberPage({ mind: own.controlPlaneHostname, email: session.email });
  if (!OWN_FETCH_SITES.includes(request.headers.get("sec-fetch-site") || ""))
    return errorPage(`Open this from ${own.controlPlaneHostname}'s own page.`, 403);
  return new Response(null, {
    status: 303,
    headers: {
      location: to.href,
      "set-cookie": await vouchIntentCookie(env, { app: to.host, user: session.userId }),
      "cache-control": "no-store",
    },
  });
}

/** The ask in `parameters`, from the member signed in on `request`: the page, the sign-in, or with
 *  `pressed` (or this member's own intent, for a mind this mind lets in) the statement on its way.
 *  `here` is where a sign-in comes back. */
async function asked(
  env: Env,
  request: Request,
  parameters: URLSearchParams,
  here: string,
  pressed: boolean,
): Promise<Response> {
  const ask = askOf(parameters);
  if (!ask) return errorPage("This link is incomplete. Start again from the app.", 400);
  const own = configOf(env);
  if (ask.for === own.controlPlaneHostname)
    return errorPage("A mind does not sign in to itself.", 400);
  const session = await personSessionOf(env, request);
  if (!session)
    return new Response(null, {
      status: 302,
      headers: { location: signInHref(here), "cache-control": "no-store" },
    });
  if (!(await isMemberSession(env, session)))
    return notMemberPage({ mind: own.controlPlaneHostname, email: session.email, here });
  // beside A's log: used only when `for` is the issuer that the log names
  const named = pressed ? null : appNamedBy(ask.for, ask.app);
  const published = await publishedMindOf(ask.for, (fetched) => fetch(fetched));
  // A's issuer: the first hostname of its log, where its control plane answers
  const issuer = "why" in published ? undefined : published.current.hostnames[0];
  if ("why" in published || published.expected === own.mindId || !issuer)
    return errorPage(
      `${ask.for} serves no other mind's identity, so this mind signs nothing for it.`,
      400,
    );
  const intent = await vouchIntentOf(env, request);
  const intended = intent?.app === ask.app && intent.user === session.userId;
  const melded =
    intended &&
    (await env.DB.prepare(`select 1 from mind_melds where mind = ?1 and append != '[]'`)
      .bind(published.expected)
      .first());
  if (!pressed && !melded)
    return confirmPage(
      own.controlPlaneHostname,
      issuer,
      ask,
      issuer === ask.for ? await named : null,
    );
  const envelope = await signedByStack(env, {
    mind: published.expected,
    path: "/",
    type: SIGN_IN_VOUCHED_TYPE,
    payload: {
      state: ask.state,
      nonce: ask.nonce,
      user: session.userId,
      member: true,
      to: `https://${issuer}`,
    },
    expiresInSeconds: 60,
  });
  console.info({ event: "auth.vouched", mind: published.expected, hostname: issuer });
  const facts = new AccountFacts();
  facts.add(session.userId, {
    type: "events.iterate.com/account/sign-in-vouched",
    payload: { mind: published.expected, hostname: issuer, at: Date.now() },
  });
  const posted = postPage(issuer, JSON.stringify(envelope));
  // the intent is spent: one use
  if (intent) posted.headers.append("set-cookie", clearVouchIntentCookie);
  return facts.on(posted);
}

type Ask = { for: string; app: string; state: string; nonce: string };

const AppNamed = z.object({ host: z.string(), name: z.string().min(1).max(APP_NAME_MAX) });
type AppNamed = z.infer<typeof AppNamed>;

/** THE APP `app` AS A's ISSUER `issuer` NAMES IT, or null: A said no, or did not answer in time. */
async function appNamedBy(issuer: string, app: string): Promise<AppNamed | null> {
  const answer = await fetch(
    `https://${issuer}${MIND_APP_PATH}?${new URLSearchParams({ host: app })}`,
    { redirect: "manual", signal: AbortSignal.timeout(APP_CHECK_MS) },
  ).catch(() => null);
  if (!answer?.ok) {
    await answer?.body?.cancel();
    return null;
  }
  const parsed = AppNamed.safeParse(await answer.json().catch(() => null));
  return parsed.success && parsed.data.host === app ? parsed.data : null;
}

function askOf(parameters: URLSearchParams): Ask | null {
  const ask = {
    for: parameters.get("for") || "",
    app: parameters.get("app") || "",
    state: parameters.get("state") || "",
    nonce: parameters.get("nonce") || "",
  };
  if (!isMindControlPlaneHostname(ask.for) || !isMindControlPlaneHostname(ask.app)) return null;
  return TOKEN.test(ask.state) && TOKEN.test(ask.nonce) ? ask : null;
}

/** ONE LINE AND ONE BUTTON: the issuer that asks, by the hostname its log proves, its app when
 *  that issuer named it (`app`), and what goes to it. */
function confirmPage(mind: string, issuer: string, ask: Ask, app: AppNamed | null) {
  const to = app ? (app.name === app.host ? app.host : app.name) : issuer;
  const whom = app
    ? `<strong>${text(to)}</strong>${to === app.host ? "" : ` (${text(app.host)})`}, an app of ${text(issuer)},`
    : `<strong>${text(issuer)}</strong>`;
  return page({
    title: `Sign in to ${to}`,
    centered: true,
    body: `<h1>Sign in to ${text(to)}</h1>
      <p class="center">Sign in to ${whom} as a member of <strong>${text(mind)}</strong>.</p>
      <p class="muted center">It learns that you are a member of this mind. It does not learn your email address.</p>
      <form method="post" action="${VOUCH_PATH}" class="stack">
        <input type="hidden" name="for" value="${text(issuer)}">
        <input type="hidden" name="app" value="${text(issuer)}">
        <input type="hidden" name="state" value="${text(ask.state)}">
        <input type="hidden" name="nonce" value="${text(ask.nonce)}">
        <button type="submit">Continue</button>
      </form>`,
  });
}

/** THE STATEMENT ON ITS WAY: a form that posts it to A's issuer, sent by the page's script, and by
 *  the button where scripts do not run. */
function postPage(issuer: string, envelope: string) {
  return page({
    title: "Signing you in",
    centered: true,
    body: `<h1>Signing you in</h1>
      <form id="vouch" method="post" action="${text(`https://${issuer}${MIND_RETURN_PATH}`)}" class="stack">
        <input type="hidden" name="envelope" value="${text(envelope)}">
        <button type="submit">Continue to ${text(issuer)}</button>
      </form>`,
    script: `document.getElementById("vouch").submit();`,
  });
}
