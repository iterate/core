import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { SignInMethod } from "iterate/principal";
import { plainPageCssHash, standalonePage } from "iterate/standalone-page";
import { type AskingApp, appTile } from "./asking-app.ts";
import { clientTile, knownMarkOf, shownLogoOf } from "./client-mark.ts";

export const text = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

// No `form-action`: browsers hold a form's redirects to it too, and Allow redirects to the client,
// wherever that is.
const CSP = `default-src 'none'; style-src ${plainPageCssHash}; frame-ancestors 'none'; base-uri 'none'`;

/** One page. `wide` is a page a person reads or works in (the keys, the members);
 *  without it the page is the narrow card of one question and one action. */
export function page(
  input: {
    title: string;
    body: string;
    status?: number;
    script?: string;
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
  const nonce = input.script && crypto.randomUUID();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set(
    "content-security-policy",
    [
      CSP,
      ...(nonce ? [`script-src 'nonce-${nonce}'`, "connect-src 'self'"] : []),
      ...(input.imageOrigin ? [`img-src ${input.imageOrigin}`] : []),
    ].join("; "),
  );
  headers.set("x-frame-options", "DENY");
  // `same-origin`, not `no-referrer`: under `no-referrer` a browser sends `Origin: null` on a
  // form's POST, and the consent and sign-out forms are checked by their Origin.
  headers.set("referrer-policy", "same-origin");
  const body = nonce
    ? `${input.body}<script nonce="${nonce}">${input.script}</script>`
    : input.body;
  return new Response(
    standalonePage({
      title: input.title,
      head: "",
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
 *  heading names the host the person signs in to, the one name in the address bar they came from.
 *  The card's one mark is the app's own icon, when its manifest names one, or iterate's. `heading`
 *  is the page's `h1`; `about` is what the page says of the app at its end: for an app for
 *  members (the Dash, the Agents app: `app.members`), that it works as the person, as a member's
 *  sign-in lets its page act as that member in the whole mind. An app for anyone gets no words
 *  of its own. */
export function appSignIn(app: AskingApp, { heading = `Sign in to ${app.host}` } = {}) {
  return {
    title: `Sign in to ${app.host}`,
    mark: app.icon ? appTile(app) : undefined,
    imageOrigin: app.icon ? app.origin : undefined,
    heading: `<h1>${text(heading)}</h1>`,
    about: app.members
      ? `<p class="muted" data-for-members>It works as you: it can read and change everything that you can.</p>`
      : "",
  };
}

/** The sign-in page of a mind that mails no code: the passkey, and Google when the mind offers it.
 *  With `app`, the sign-in is for that app of the mind (`appSignIn`). */
export function signInPage(domain: string, next: string, google = false, app?: AskingApp | null) {
  const passkey = passkeySignIn(next, "alone");
  const asking = app ? appSignIn(app) : null;
  return page({
    title: asking?.title || `Sign in to ${domain}`,
    mark: asking?.mark,
    centered: true,
    imageOrigin: asking?.imageOrigin,
    body: `${asking?.heading || `<h1>Sign in to ${text(domain)}</h1>`}
      ${passkey.body}${google ? googleSignIn(next) : ""}${asking?.about || ""}`,
    script: passkey.script,
  });
}

/** THE PAGE OF THE WAYS AN APP TAKES (./sign-in.ts `methodsAskedIn`): a button for each way, in
 *  the app's order, one stack of buttons of one height, and no other way. With `app`, the sign-in
 *  is for that app of the mind (`appSignIn`). The page never sends a person on by itself, so they
 *  see where they are before they leave for Cloudflare. */
export function methodsSignInPage(input: {
  domain: string;
  next: string;
  methods: readonly SignInMethod[];
  app: AskingApp | null;
}) {
  const { domain, next, methods } = input;
  const asking = input.app ? appSignIn(input.app) : null;
  const passkey = passkeySignIn(next, methods[0] === "passkey" ? "alone" : undefined, "");
  const ways = methods.map((method, index) => {
    const way = (action: string, button: string) => `
      <form method="get" action="${action}" class="stack">
        <input type="hidden" name="next" value="${text(next)}">
        ${button}
      </form>`;
    switch (method) {
      case "cloudflare":
        return way(
          "/sign-in/cloudflare",
          `<button type="submit" class="cloudflare">${CLOUDFLARE_MARK}Sign in with Cloudflare</button>`,
        );
      case "google":
        return way(
          "/sign-in/google",
          `<button type="submit" class="outline">${GOOGLE_MARK}Sign in with Google</button>`,
        );
      case "email":
        return way(
          "/sign-in/email",
          `<button type="submit"${index ? ` class="outline"` : ""}>Sign in with a code by email</button>`,
        );
      case "passkey":
        return passkey.body;
      default:
        // a deploy's ticket and an owner's link are no way an app can name (./env.ts `offersMethod`)
        return "";
    }
  });
  const shares = methods.includes("cloudflare")
    ? `<p class="muted note">Cloudflare shares your name and email. Nothing else.</p>`
    : "";
  return page({
    title: asking?.title || `Sign in to ${domain}`,
    mark: asking?.mark,
    centered: true,
    imageOrigin: asking?.imageOrigin,
    body: `${asking?.heading || `<h1>Sign in to ${text(domain)}</h1>`}
      <div class="ways">${ways.join("")}</div>${shares}${asking?.about || ""}`,
    script: methods.includes("passkey") ? passkey.script : undefined,
  });
}

/** An app names only ways to sign in that this stack does not offer (./env.ts `offersMethod`). */
export const nobodySignsInPage = () =>
  errorPage("This app takes a way to sign in that is not set up here, so nobody can sign in.", 503);

/** A cloud, drawn here for "Sign in with Cloudflare" (not Cloudflare's logo): three arcs on a flat
 *  base, in the button's text colour. */
const CLOUDFLARE_MARK = `<svg width="21" height="16" viewBox="1.25 3 22 16.5" aria-hidden="true"><path fill="currentColor" d="M6.5 19h11a4.5 4.5 0 0 0 .6-8.96 6 6 0 0 0-11.5-1.02A5 5 0 0 0 6.5 19z"/></svg>`;

/** Google's mark, as Google draws it: four colours, 18 pixels. */
const GOOGLE_MARK = `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>`;

/** "Sign in with Google", below a page's other ways to sign in (./google-sign-in.ts): a plain
 *  link in a form, so it works with no script. */
export function googleSignIn(next: string) {
  return `<p class="or">or</p>
      <form method="get" action="/sign-in/google" class="stack">
        <input type="hidden" name="next" value="${text(next)}">
        <button type="submit" class="outline">${GOOGLE_MARK}Sign in with Google</button>
      </form>`;
}

/** The page's half of ./passkey-sign-in.ts. It names no credential, so the browser offers the
 *  passkeys it holds for this site. `alone`: the page offers no other way to sign in. `look` is
 *  the button's class: by default the main action alone, else another way under an "or"; "" is a
 *  main action in a stack of ways, with no "or" (`methodsSignInPage`). */
export function passkeySignIn(
  next: string,
  alone?: "alone",
  look: string = alone ? "" : "secondary",
) {
  const or = look === "secondary" ? `<p class="or">or</p>` : "";
  return {
    body: `${alone ? `<p class="muted">Use a passkey you added here.</p>` : or}
      <form id="passkey" class="stack" data-next="${text(next)}">
        <button type="submit"${look ? ` class="${look}"` : ""}>Sign in with a passkey</button>
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
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Waiting for your passkey…";
  try {
    const { statement, challenge } = await post("/sign-in/passkey/challenge", {});
    const assertion = await navigator.credentials.get({ publicKey: {
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
    status.textContent = error.name === "NotAllowedError" ? "No passkey was used. Try again." : error.message || "The passkey did not sign you in.";
  }
});`,
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
  domain: string;
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
    title: asking?.title || `Sign in to ${input.domain}`,
    mark: asking?.mark,
    centered: true,
    imageOrigin: asking?.imageOrigin,
    body: `${asking?.heading || `<h1>Sign in to ${text(input.domain)}</h1>`}
      <p class="center">${
        input.signedOutOf
          ? `You are signed out of ${text(input.signedOutOf)}. You are still signed in to ${text(input.domain)} as`
          : "You are signed in as"
      } <strong>${text(input.email)}</strong>.</p>
      <form method="get" action="${text(url.pathname)}" class="stack">
        ${fields}
        <button type="submit">Continue as ${text(input.email)}</button>
      </form>
      <div class="center">${otherAccountForm(input.here)}</div>${asking?.about || ""}`,
  });
}

export function notMemberPage(input: { domain: string; email: string; here?: string }) {
  return page({
    title: "You can't continue",
    status: 403,
    body: `<h1>You can't continue</h1>
      <p>You are signed in as <strong>${text(input.email)}</strong>, and that address is not a member of ${text(input.domain)}. Ask the mind's owner to add it.</p>
      <div>${otherAccountForm(input.here || "/")}</div>`,
  });
}

export function consentPage(input: {
  details: ConsentDescription;
  handle: string;
  email: string;
  domain: string;
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
  const domain = text(input.domain);
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
        <p>${name} will learn that you are <strong>${text(input.email)}</strong>, and can use ${text(input.host)} as you. It gets nothing else in ${domain}.</p>`
          : `<h1>${name} wants to access ${domain}</h1>
        <p>${name} will use ${domain} through ${text(input.resource)}, as <strong>${text(input.email)}</strong>. It can read and change everything in this mind.</p>`
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
