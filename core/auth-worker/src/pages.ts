import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { PLAIN_PAGE_ICON_SRC, plainPageCssHash, standalonePage } from "iterate/standalone-page";
import { type AskingApp, appTile } from "./asking-app.ts";
import { clientTile, knownMarkOf, shownLogoOf } from "./client-mark.ts";

export { type Fact, factsTable } from "iterate/standalone-page";

export const text = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** One page. `wide` is a page a person reads or works in (the keys, the members);
 *  without it the page is the narrow card of one question and one action. */
/** THE LINE UNDER A PAGE'S PRESS, the same on every page that has a script: `statusSay` for what
 *  goes on (quiet, `role="status"`), `statusRefused` for a press that did not do what it was for
 *  (the page's error colour, `role="alert"`, scrolled into view), and `statusFailed` for a caught
 *  error, where a passkey sheet that the person closed is no error (`NotAllowedError`). */
export const STATUS_SCRIPT = `
function statusSay(line, words) {
  line.textContent = words;
  line.classList.add("muted");
  line.setAttribute("role", "status");
}
function statusRefused(line, words) {
  line.textContent = words;
  line.classList.remove("muted");
  line.setAttribute("role", "alert");
  line.scrollIntoView({ block: "nearest" });
}
function statusFailed(line, error, fallback, unused = "No passkey was used. Press again when you are ready.") {
  if (error.name === "NotAllowedError") statusSay(line, unused);
  else statusRefused(line, error.message || fallback);
}
`;

export function page(
  input: {
    title: string;
    body: string;
    status?: number;
    script?: string;
    /** A page's own CSS over the plain page's stylesheet. The CSP allows it by the page's nonce,
     *  as it allows the script, so `plainPageCssHash` stays the hash of the shared stylesheet. */
    style?: string;
    wide?: boolean;
    /** Who asks for the mind, as their tile (client-mark.ts), for the card's head. */
    asker?: string;
    /** The one mark at the card's head in place of iterate's (`standalonePage`). */
    mark?: string;
    /** A sign-in's card: its mark and heading in the middle. */
    centered?: boolean;
    /** The one origin an image of this page may come from: a verified client's own logo. */
    imageOrigin?: string;
  },
  headers = new Headers(),
): Response {
  const nonce = (input.script || input.style) && crypto.randomUUID();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set(
    "content-security-policy",
    [
      // No `form-action`: browsers hold a form's redirects to it too, and Allow redirects to the
      // client, wherever that is.
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      input.style
        ? `style-src ${plainPageCssHash} 'nonce-${nonce}'`
        : `style-src ${plainPageCssHash}`,
      ...(input.script ? [`script-src 'nonce-${nonce}'`, "connect-src 'self'"] : []),
      `img-src ${PLAIN_PAGE_ICON_SRC}${input.imageOrigin ? ` ${input.imageOrigin}` : ""}`,
    ].join("; "),
  );
  headers.set("x-frame-options", "DENY");
  // `same-origin`, not `no-referrer`: under `no-referrer` a browser sends `Origin: null` on a
  // form's POST, and the consent and sign-out forms are checked by their Origin.
  headers.set("referrer-policy", "same-origin");
  const body = input.script
    ? `${input.body}<script nonce="${nonce}">${STATUS_SCRIPT}${input.script}</script>`
    : input.body;
  return new Response(
    standalonePage({
      title: input.title,
      head: input.style ? `<style nonce="${nonce}">${input.style}</style>` : "",
      body,
      wide: input.wide,
      asker: input.asker,
      mark: input.mark,
      centered: input.centered,
    }),
    {
      status: input.status ?? 200,
      headers,
    },
  );
}

/** A SIGN-IN THAT AN APP OF THIS MIND STARTED (./asking-app.ts), as each page of it says so: the
 *  heading names the app as the app names itself, and the line under it the host the person
 *  signs in to: the one name in the address bar they came from, which no app chooses. An app
 *  that says no name is its host, and has the heading alone. The card's one mark is the app's
 *  own icon, when the app names one, or iterate's. `heading` is another `h1` for a page that
 *  names the host in its own words; `about` is what the page says of the app at its end: for an
 *  app for members (the Dash, the Docs app: `app.members`), that it works as the person, as a
 *  member's sign-in lets its page act as that member in the whole mind. An app for anyone gets
 *  no words of its own. */
export function appSignIn(app: AskingApp, { heading }: { heading?: string } = {}) {
  const host = app.name === app.host ? "" : `<p class="muted center">${text(app.host)}</p>`;
  return {
    title: `Sign in to ${app.name}`,
    mark: app.icon ? appTile(app) : undefined,
    imageOrigin: app.icon ? app.origin : undefined,
    heading: heading ? `<h1>${text(heading)}</h1>` : `<h1>Sign in to ${text(app.name)}</h1>${host}`,
    about: app.members
      ? `<p class="muted" data-for-members>It works as you: it can read and change everything that you can.</p>`
      : "",
  };
}

/** THE SIGN-IN PAGE THAT OPENS ON THE PASSKEY: the control plane's own, and that of an app whose
 *  first sign-in method is the passkey. Nothing to type. With `asksAtOpen` its script asks the
 *  browser for the passkey when the page opens; the button asks again. With `offersEmail`, a
 *  button below leads to the mailed code's page (./email-sign-in.ts): for an app that names
 *  "email" after the passkey, and never for the control plane's own sign-in, since a mailed code
 *  signs in no member. `offersGuest` adds the guest's name form (./guest-sign-in.ts) the same
 *  way. With `app`, the sign-in is for that app of the mind (`appSignIn`). `mind`
 *  is the mind's name, its control-plane hostname, on this page and on each page below. A sign-in
 *  whose first method is the mailed code opens on that page instead (./http.ts). A sign-in that
 *  names no app, or an app for members (such as Onboarding or Dash), also has an owner's link to
 *  Cloudflare Access, the one proof of an address that the mind takes for an owner with no passkey
 *  yet (./access-sign-in.ts); an app for anyone has not: Access is for owners alone.
 *  `noPasskeyYet`: nobody in the mind ever had a passkey, so no browser holds one to ask for. The
 *  page with the owner's way then has it as its main button, asks for nothing as it opens, and
 *  keeps the passkey's button below. */
export function signInPage(input: {
  mind: string;
  next: string;
  app: AskingApp | null;
  offersEmail: boolean;
  /** For an app's own sign-in whose app names "guest": a button to its name form. */
  offersGuest: boolean;
  /** For an app's own sign-in whose app names "mind": a button to its field (./mind-sign-in.ts). */
  offersMind?: boolean;
  asksAtOpen: boolean;
  noPasskeyYet: boolean;
}) {
  const { mind, next } = input;
  const forOwners = !input.app || input.app.members;
  const first = input.noPasskeyYet && forOwners;
  const passkey = passkeySignIn(next, {
    alone: !first,
    asksAtOpen: input.asksAtOpen && !first,
  });
  const asking = input.app ? appSignIn(input.app) : null;
  const way = (
    action: string,
    label: string,
  ) => `<form method="get" action="${action}" class="stack">
        <input type="hidden" name="next" value="${text(next)}">
        <button type="submit" class="secondary">${label}</button>
      </form>`;
  const email =
    (input.offersEmail ? way("/sign-in/email", "Sign in with your email address") : "") +
    (input.offersGuest ? way("/sign-in/guest", "Come in as a guest") : "") +
    (input.offersMind ? way("/sign-in/mind", "Sign in with your mind") : "");
  const firstPasskey = first
    ? `<p class="muted">Nobody has a passkey here yet. An owner proves their email address with Cloudflare, and then adds the first one.</p>
      <form method="get" action="/sign-in/access" class="stack">
        <input type="hidden" name="next" value="${text(next)}">
        <button type="submit">Set up your first passkey</button>
      </form>`
    : "";
  const ownerProof =
    forOwners && !first
      ? `<p class="muted">An owner with no passkey yet: <a href="${text(`/sign-in/access?${new URLSearchParams({ next })}`)}">prove your email address with Cloudflare</a>, and then add one.</p>`
      : "";
  return page({
    title: asking?.title || `Sign in to ${mind}`,
    mark: asking?.mark,
    centered: true,
    imageOrigin: asking?.imageOrigin,
    body: `${asking?.heading || `<h1>Sign in to ${text(mind)}</h1>`}
      ${firstPasskey}${passkey.body}
      ${email}${ownerProof}${asking?.about || ""}`,
    script: passkey.script,
  });
}

/** The page's half of ./passkey-sign-in.ts. It names no credential, so the browser offers the
 *  passkeys it holds for this site. `alone`: the passkey is the page's main action; else it is
 *  another way, under an "or". `asksAtOpen`: the script also asks once when the page opens, with
 *  no press. A browser may refuse that (Safari takes one such call a page load, and not always),
 *  and a person may close the prompt: both say nothing, and the button is the way on. */
export function passkeySignIn(
  next: string,
  { alone, asksAtOpen }: { alone: boolean; asksAtOpen: boolean },
) {
  return {
    body: `${alone ? `<p class="muted">Use a passkey you added here.</p>` : `<p class="or">or</p>`}
      <form id="passkey" class="stack" data-next="${text(next)}">
        <button type="submit"${alone ? "" : ` class="secondary"`}>Sign in with a passkey</button>
        <p id="passkey-status" class="muted" role="status"></p>
      </form>`,
    script: `
const form = document.getElementById("passkey");
const status = document.getElementById("passkey-status");
const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const bytes = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const post = async (path, body) => {
  const answer = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await answer.json();
  if (!answer.ok) throw new Error(result.error);
  return result;
};
// One ask at a time: a press ends the ask before it, whose refusal then says nothing.
let asking;
const signIn = async (pressed) => {
  asking?.abort();
  const ask = (asking = new AbortController());
  statusSay(status, "Waiting for your passkey…");
  try {
    const { statement, challenge } = await post("/sign-in/passkey/challenge", {});
    const assertion = await navigator.credentials.get({ signal: ask.signal, publicKey: {
      challenge: bytes(challenge),
      rpId: location.hostname,
      userVerification: "required",
    } });
    const { signature, authenticatorData, clientDataJSON } = assertion.response;
    const { next } = await post("/sign-in/passkey", {
      statement,
      credentialId: assertion.id,
      sig: b64(signature),
      authenticatorData: b64(authenticatorData),
      clientDataJSON: b64(clientDataJSON),
      next: form.dataset.next,
    });
    location.assign(next);
  } catch (error) {
    if (ask !== asking) return;
    // the page's own ask, closed by the person or refused by the browser, is no fault of theirs
    statusFailed(status, error, "The passkey did not sign you in.", pressed ? undefined : "");
  }
};
form.addEventListener("submit", (event) => {
  event.preventDefault();
  signIn(true);
});${asksAtOpen ? "\nsignIn(false);" : ""}`,
  };
}

export function errorPage(
  message: string,
  status = 403,
  headers?: Headers,
  links: { href: string; label: string }[] = [{ href: "/", label: "Start again" }],
) {
  const ways = links
    .map(({ href, label }) => `<a href="${text(href)}">${text(label)}</a>`)
    .join(" &middot; ");
  return page(
    {
      title: "You can't continue",
      status,
      body: `<h1>You can't continue</h1><p>${text(message)}</p><p>${ways}</p>`,
    },
    headers,
  );
}

/** Where a browser's session at the issuer ends (./sign-in.ts `signOutResponse`). */
export const SIGN_OUT_PATH = "/sign-out";

/** "Not you?": a button that ends this browser's session here and shows the sign-in, which then
 *  comes back to `next`, a path of this origin. One session a browser: to use another account is
 *  to sign out of this one. */
export function otherAccountForm(next: string, label = "Use another account") {
  return `<form method="post" action="${SIGN_OUT_PATH}" class="inline">
        <input type="hidden" name="next" value="${text(next)}">
        <button type="submit" class="link">${text(label)}</button>
      </form>`;
}

/** THE ACCOUNT CHOOSER: who this browser is signed in as, before an authorization goes on. `here`
 *  is the authorization request without its `prompt`, a path of this origin. With `app`, the
 *  request is that app's own sign-in, and the page says so (`appSignIn`). */
export function chooserPage(input: {
  mind: string;
  email: string;
  here: string;
  app?: AskingApp | null;
  /** The host whose own sign-out sent the person here: the chooser says they left it. */
  signedOutOf?: string;
}) {
  const url = new URL(input.here, "https://issuer.invalid");
  // a GET form sends its fields as the query, so each parameter of the request is one
  const fields = [...url.searchParams]
    .map(([name, value]) => `<input type="hidden" name="${text(name)}" value="${text(value)}">`)
    .join("");
  const asking = input.app ? appSignIn(input.app) : null;
  return page({
    title: asking?.title || `Sign in to ${input.mind}`,
    mark: asking?.mark,
    centered: true,
    imageOrigin: asking?.imageOrigin,
    body: `${asking?.heading || `<h1>Sign in to ${text(input.mind)}</h1>`}
      <p class="center">${
        input.signedOutOf
          ? `You are signed out of ${text(input.signedOutOf)}. You are still signed in to ${text(input.mind)} as`
          : "You are signed in as"
      } <strong>${text(input.email)}</strong>.</p>
      <form method="get" action="${text(url.pathname)}" class="stack">
        ${fields}
        <button type="submit">Continue as ${text(input.email)}</button>
      </form>
      <div class="center">${otherAccountForm(input.here)}</div>${asking?.about || ""}`,
  });
}

export function notMemberPage(input: { mind: string; email: string; here?: string }) {
  return page({
    title: "You can't continue",
    status: 403,
    body: `<h1>You can't continue</h1>
      <p><strong>${text(input.email)}</strong> is not a member of ${text(input.mind)}. Ask an owner to add you.</p>
      <div>${otherAccountForm(input.here || "/")}</div>`,
  });
}

export function consentPage(input: {
  details: ConsentDescription;
  handle: string;
  email: string;
  mind: string;
  resource: string;
  /** A host of the mind that the client asks to use: the page names it by that hostname. */
  host?: string;
  /** The authorization request, a path of this origin: where "use another account" comes back. */
  here: string;
  headers: Headers;
}) {
  const { details } = input;
  const client = { ...details, name: details.clientName };
  const name = text(details.clientName);
  const mind = text(input.mind);
  const origin = details.clientDomain
    ? `<p class="muted">${name} is published at ${text(details.clientDomain)}, and access goes to ${text(details.redirectHost)}.</p>`
    : `<p class="muted">This app registered itself, so its name is not verified. Access goes to ${text(details.redirectHost)}.</p>`;
  const loopback = details.redirectIsLoopback
    ? `<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started to sign in from it.</p>`
    : "";
  return page(
    {
      title: `Allow ${details.clientName}?`,
      // the client's mark beside the mind's: a known client's, or a verified client's own logo
      // (client-mark.ts). A client with neither has no tile: the mind's mark is the card's one.
      asker: knownMarkOf(client) || shownLogoOf(details) ? clientTile(client) : undefined,
      centered: true,
      imageOrigin: shownLogoOf(details)?.origin,
      body: `${
        input.host
          ? `<h1>${name} wants to use ${text(input.host)} as you</h1>
        <p>It learns that you are <strong>${text(input.email)}</strong>, and gets nothing else in ${mind}.</p>`
          : `<h1>${name} wants to access ${mind}</h1>
        <p>It will act as <strong>${text(input.email)}</strong> through ${text(input.resource)}, and can read and change everything in this mind.</p>`
      }
        ${origin}
        ${loopback}
        <form method="post" class="actions">
          <input type="hidden" name="handle" value="${text(input.handle)}">
          <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
          <button type="submit" name="decision" value="allow">Allow</button>
        </form>
        <div class="muted">Signed in as ${text(input.email)}. Not you? ${otherAccountForm(input.here)}</div>`,
    },
    input.headers,
  );
}
