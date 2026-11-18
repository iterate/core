// asking-app.ts — THE APP OF THIS MIND THAT A SIGN-IN IS FOR. A page of an app's host
// (a hostname of one of the mind's zones) that asks who is there sends the browser to this issuer with an
// authorization request of the host's own: its resource is the host, its redirect is the host's
// own callback, and its client is the one this stack made for the host (./oauth.ts
// `hostClientOf`). The sign-in pages then say which app the person signs in to.
//
// WHAT IS TRUSTED. `next`, the request that a sign-in goes on to, is a query that anyone can
// write. So the app is NAMED from it only when its three parts agree with what this stack holds:
// the test by which the authorization endpoint completes a host's own sign-in with no consent
// page. A link that passes it is the link that the host's own page makes.
//
// WHAT THE APP SAYS OF ITSELF, in the document that its own code answers at
// `/.well-known/iterate-app` on its own host (iterate/app-description; iterate/sdk
// `serveAppDescription`): its name, its icon, whether it is for the mind's members alone, and
// how its people sign in:
//
//   { "name": "Guestbook", "icon": "/icon.svg", "signIn": ["email", "passkey"] }
//
// This Worker reads it over the public internet, as it reads an outside client's document, follows
// no redirect, and asks again after five minutes. An icon counts only from the app's own origin,
// so the page's policy allows that one origin. An app that says nothing is shown by its host and
// its initials. An app that DOES NOT ANSWER (no answer in two seconds, or a 5xx) has said nothing
// new: it is still what it last said, and it is asked again after a minute.
//
// "For members" changes the page's words and the default of `signIn`, and nothing else: who may
// come is the guard in the app's own code (the mind's worker.ts), which this Worker does not
// read.
//
// HOW THE APP'S PEOPLE SIGN IN (`signIn`) is the one part that this Worker enforces: the
// authorization endpoint gives a code for the app's host only to a session whose method the app
// names, or to a passkey's (./authorize.ts, `appTakes`), and the sign-in pages offer those
// methods alone, in the app's order (`signInOf`). It is read from the app, never from the
// request, so an MCP client that signs a person in to the app gets the same list.
//
// AN APP IS AN OAUTH CLIENT, as Codex is: the host's client holds the app's name and icon (its
// `clientName` and `logoUri`), written here whenever the description is read and says something
// else. So the list of a person's sign-ins by client (./oauth.ts `sessionsByClientOf`) names the
// app as the sign-in pages do, and asks no app for it.
import { APP_DESCRIPTION_PATH, AppDescription } from "iterate/app-description";
import type { SignInMethod } from "iterate/principal";
import { admitted } from "./device/limits.ts";
import { configOf, type Env, issuerOf } from "./env.ts";
import {
  AUTHORIZE_ENDPOINT,
  hostCallbackOf,
  keptHostClientOf,
  knownResourceOf,
  mindHostResourceOf,
  oauthHelpers,
} from "./oauth.ts";

export type AskingApp = {
  /** The app's hostname, in one of the mind's zones. */
  host: string;
  origin: string;
  /** What the app calls itself, or its host when it says nothing. */
  name: string;
  /** Its icon, on its own origin, when it names one. */
  icon: string | null;
  /** The app says that it is for the mind's members alone. */
  members: boolean;
  /** How the app's people sign in, in the app's order: what it names, or the default for whom it
   *  is for (`saidIn`). The sign-in page opens on the first. */
  signIn: SignInMethod[];
};

const text = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** HOW A PERSON SIGNS IN TO THE CONTROL PLANE ITSELF, and for a client of the mind's API or its
 *  MCP server: a member's passkey, and nothing else. The mailed code is for the people of the
 *  mind's apps, and opens no way into the mind (./email-sign-in.ts). */
const CONTROL_PLANE_SIGN_IN: SignInMethod[] = ["passkey"];

/** THE SIGN-IN THAT `next` GOES ON TO (a path of this issuer), as its pages show it: the methods
 *  that they offer, in order, and the app that they name. An authorization for a mind hostname
 *  takes the methods of that hostname's app, whichever client asks, since the authorization
 *  endpoint holds the session to the same list; the pages name the app only for its own sign-in
 *  (`askingAppOf`). Anything else is the control plane's own sign-in. Null: too many hostnames
 *  that the stack holds nothing of were asked about just now (`appOf`). */
export async function signInOf(
  env: Env,
  next: string,
): Promise<{ app: AskingApp | null; methods: SignInMethod[] } | null> {
  const authorization = hostAuthorizationIn(env, next);
  if (!authorization) return { app: null, methods: CONTROL_PLANE_SIGN_IN };
  const app = await appOf(env, authorization.origin);
  if (!app) return null;
  return { app: (await isOwnSignIn(env, authorization)) ? app : null, methods: app.signIn };
}

/** The app whose own sign-in `next` goes on to (a path of this issuer), or null: for any other
 *  request, and for one whose parts this stack does not hold. */
export async function askingAppOf(env: Env, next: string): Promise<AskingApp | null> {
  const authorization = hostAuthorizationIn(env, next);
  if (!authorization || !(await isOwnSignIn(env, authorization))) return null;
  return appOf(env, authorization.origin);
}

/** WHETHER AN APP TAKES A SESSION THAT `method` OPENED, for a code for the app's host: a
 *  passkey's counts at every app, and any other when the app names its method. */
export const appTakes = (app: Pick<AskingApp, "signIn">, method: SignInMethod) =>
  method === "passkey" || app.signIn.includes(method);

/** `next` as an authorization request of this issuer for a mind hostname: the hostname's origin,
 *  and the request's parameters. Null for anything else. */
function hostAuthorizationIn(env: Env, next: string) {
  const issuer = issuerOf(env);
  if (!URL.canParse(next, issuer)) return null;
  const url = new URL(next, issuer);
  if (url.origin !== issuer || url.pathname !== AUTHORIZE_ENDPOINT) return null;
  const asked = url.searchParams.get("resource");
  const origin = asked && mindHostResourceOf(configOf(env), knownResourceOf(env, asked));
  return origin ? { origin, parameters: url.searchParams } : null;
}

/** Whether an authorization for a mind hostname is that host's own sign-in: its code goes to
 *  the host's own callback, and its client is the one this stack made for the host. */
async function isOwnSignIn(
  env: Env,
  { origin, parameters }: { origin: string; parameters: URLSearchParams },
) {
  if (parameters.get("redirect_uri") !== hostCallbackOf(origin)) return false;
  const client = await keptHostClientOf(env, new URL(origin).host);
  return Boolean(client) && client === parameters.get("client_id");
}

/** A HOST OF THIS MIND AS AN APP: `origin` is one that `mindHostResourceOf` let through. Anyone
 *  can ask about any hostname of the mind's zones, in the `next` of a sign-in page, so a hostname
 *  that the stack holds nothing of (no description, no client of its own) is counted as a new
 *  host client is (./oauth.ts `hostClientOf`): null when too many were asked about just now. */
export async function appOf(env: Env, origin: string): Promise<AskingApp | null> {
  const { host } = new URL(origin);
  const key = `iterate-app-description:${host}`;
  let kept = await env.OAUTH_KV.get<Kept>(key, "json");
  if (
    !kept &&
    !(await keptHostClientOf(env, host)) &&
    !(await admitted(env, "host-client", new Request(origin)))
  )
    return null;
  if (!kept || kept.askAfter <= Date.now()) {
    const document = `${origin}${APP_DESCRIPTION_PATH}`;
    const heard = await fetch(document, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(2000),
    })
      // an answer of the app: its description's text, which is empty for an app that has none
      // (a 404, a sign-in). Null: the app did not answer, or its answer broke off.
      .then(async (answer) => {
        if (answer.status >= 500) return null;
        return { description: answer.status === 200 ? await answer.text() : "" };
      })
      .catch(() => null);
    const last = kept || NOTHING;
    kept = heard
      ? // "nothing" is kept too: an app with no description is not asked at each page
        { ...saidIn(heard.description, document), askAfter: Date.now() + 5 * 60_000 }
      : // it did not answer: it is what it last said, and is asked again after a minute
        { ...last, askAfter: Date.now() + 60_000 };
    // The row goes a day after it was last written: an app that is asked about is written again
    // within five minutes, and a hostname that nobody asks about any more leaves no row.
    await env.OAUTH_KV.put(key, JSON.stringify(kept), { expirationTtl: 24 * 3600 });
    if (heard) await keepOnClient(env, origin, { name: kept.name || host, icon: kept.icon });
  }
  return {
    host,
    origin,
    name: kept.name || host,
    icon: kept.icon,
    members: kept.members,
    signIn: kept.signIn,
  };
}

/** What an app said of itself (`saidIn`), and when to ask it again. */
type Kept = ReturnType<typeof saidIn> & { askAfter: number };

/** The host's own client says what the app says: written when it says something else. */
async function keepOnClient(env: Env, origin: string, said: { name: string; icon: string | null }) {
  const clientId = await keptHostClientOf(env, new URL(origin).host);
  if (!clientId) return;
  const helpers = oauthHelpers(env, origin);
  const client = await helpers.lookupClient(clientId);
  if (!client || (client.clientName === said.name && (client.logoUri || null) === said.icon))
    return;
  await helpers.updateClient(clientId, { clientName: said.name, logoUri: said.icon || undefined });
}

/** An app that says nothing: it is shown by its host, and it is for anyone, whose people sign in
 *  by the mailed code first. */
const NOTHING: {
  name: string | null;
  icon: string | null;
  members: boolean;
  signIn: SignInMethod[];
} = { name: null, icon: null, members: false, signIn: ["email", "passkey"] };

/** WHAT THE TEXT OF AN APP'S DESCRIPTION SAYS (iterate/app-description `AppDescription`): a name
 *  of at most sixty characters, its icon when that is on the description's own origin, over
 *  https, whether the app is for members, and how its people sign in: the list it names, as it is
 *  written, or the passkey alone for an app for members (a member signs in with nothing else),
 *  and email then passkey for any other. A text that is no `AppDescription` says nothing: one
 *  that names a method this issuer does not know is such a text, so no app is held to a list that
 *  it did not write. */
export function saidIn(descriptionText: string, descriptionUrl: string): typeof NOTHING {
  if (!descriptionText || descriptionText.length > 20_000) return NOTHING;
  let json: unknown;
  try {
    json = JSON.parse(descriptionText);
  } catch {
    return NOTHING;
  }
  const parsed = AppDescription.safeParse(json);
  if (!parsed.success) return NOTHING;
  const name = parsed.data.name
    // a name is one line of text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim()
    .slice(0, 60);
  const { origin } = new URL(descriptionUrl);
  const icon = parsed.data.icon ? new URL(parsed.data.icon, descriptionUrl) : null;
  const members = parsed.data.for === "members";
  return {
    name: name || null,
    // a path that begins `//` names another host: an icon is the app's own origin's alone
    icon: icon?.protocol === "https:" && icon.origin === origin ? icon.href : null,
    members,
    signIn: [
      ...new Set<SignInMethod>(parsed.data.signIn || (members ? ["passkey"] : NOTHING.signIn)),
    ],
  };
}

/** The app's tile (plain-page.css `.tile`): its icon, or its initials. Never a built-in mark of
 *  ./client-mark.ts: an app of a mind that calls itself "Codex" is not OpenAI's. `small` is for a
 *  row of a list. */
export function appTile(
  app: Pick<AskingApp, "name" | "icon">,
  { small = false }: { small?: boolean } = {},
): string {
  const tile = small ? "tile small" : "tile";
  if (app.icon)
    return `<div class="${tile}" data-app-mark="icon"><img src="${text(app.icon)}" alt="" referrerpolicy="no-referrer"></div>`;
  const initials = [...app.name.replace(/[^\p{L}\p{N}]/gu, "")].slice(0, 2).join("");
  return `<div class="${tile}" data-app-mark="initials">${text(initials.toUpperCase() || "?")}</div>`;
}
