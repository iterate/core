import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { mindMcpNameOf } from "iterate/mind-api";
import { plainPageCssHash, standalonePage } from "iterate/standalone-page";
import { type AskingApp, appTile } from "./asking-app.ts";
import { clientTile, shownLogoOf } from "./client-mark.ts";

export const text = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

// No `form-action`: browsers hold a form's redirects to it too, and Allow redirects to the client,
// wherever that is.
const CSP = `default-src 'none'; style-src ${plainPageCssHash}; frame-ancestors 'none'; base-uri 'none'`;

/** One page. `wide` is a page a person reads or works in (the start page, the keys, the members);
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
    standalonePage({ title: input.title, head: "", body, wide: input.wide, asker: input.asker }),
    {
      status: input.status ?? 200,
      headers,
    },
  );
}

/** The platform's start page: a member's ways into the mind, or the sign-in for anyone else.
 *  The apps are the ones a new mind's config repo mounts, each on its own host. The platform does
 *  not read the config, so an app the owner removed is still named here, and answers "Not found". */
export function homePage(input: {
  domain: string;
  email: string | null;
  standing: "member" | "passkey-owed" | "not-member" | null;
  mcp: string;
  /** Whether the config trusts a hosted Dash, which `/dash` leads to. */
  dash: boolean;
}) {
  const { domain, email, standing } = input;
  const signOut = `<form method="post" action="/sign-out"><button type="submit" class="link">Sign out</button></form>`;
  if (email && standing === "member") {
    const link = (href: string, label: string, about: string) =>
      `<li><a href="${text(href)}">${text(label)}</a> <span class="muted">${text(about)}</span></li>`;
    return page({
      title: domain,
      wide: true,
      body: `<h1>${text(domain)}</h1>
      <p>You are signed in as <strong>${text(email)}</strong>.</p>
      <h2>Apps</h2>
      <ul class="stack">
        ${link(`https://dash.${domain}`, "Dash", "your mind from above: its events, files, secrets and settings")}
        ${input.dash ? link("/dash", "Hosted Dash", "the same pages, hosted by iterate") : ""}
        ${link(`https://agents.${domain}`, "Agents", "talk to your mind's agents")}
        ${link(`https://onboarding.${domain}`, "Onboarding", "a chat that sets your mind up with you")}
        ${link(`https://docs.${domain}`, "Docs", "your mind's config repo, read as pages")}
        ${link(`https://voice.${domain}`, "Voice", "call your mind from this browser")}
      </ul>
      <h2>Access</h2>
      <ul class="stack">
        ${link("/members", "People", "who may sign in")}
        ${link("/keys", "Your keys", "your passkeys, and the keys of services you allowed")}
        ${link("/secrets/", "Secrets", "the keys and passwords your mind uses")}
        ${link("/secrets/approvals", "Approvals", "requests that wait for your yes")}
        ${link("/self-test", "Self-test", "check that everything works")}
      </ul>
      <h2>Connect Claude Code</h2>
      <p>The MCP address of this mind is <code>${text(input.mcp)}</code>. Run this, then sign in when Claude Code asks:</p>
      <pre><code>claude mcp add --transport http ${text(mindMcpNameOf(domain))} ${text(input.mcp)}</code></pre>
      ${signOut}`,
    });
  }
  const who =
    email && standing === "passkey-owed"
      ? `<p>You are signed in as <strong>${text(email)}</strong>. <a href="/keys">Add a passkey</a> to use the mind.</p>${signOut}`
      : email
        ? `<p>You are signed in as <strong>${text(email)}</strong>, which is not a member of ${text(domain)}.</p>${signOut}`
        : `<p class="muted">You are not signed in.</p>
       <p><a href="/sign-in">Sign in</a></p>`;
  return page({
    title: `Sign-in for ${domain}`,
    body: `<h1>Sign-in for ${text(domain)}</h1>
      <p>This is where you sign in to the iterate mind at ${text(domain)}, and allow apps to use it as you.</p>
      ${who}`,
  });
}

/** A SIGN-IN THAT AN APP OF THIS MIND STARTED (./asking-app.ts), as each page of it says so. The
 *  app is the OAuth client that asks, and it is presented as the consent page presents an outside
 *  client: its tile beside the mind's mark, its name, where it is, and what it gets. A person who
 *  is no member of the mind reads here that the app learns their address and no more, that the
 *  sign-in makes them no member, and how to leave. `heading` is the page's `h1` and the app's
 *  host under it; `about` is the block of facts, for the page's end. `signUps` is the stack's
 *  rule for a new address, where the page mails a code: the block then says it, and the page says
 *  it nowhere else. */
export function appSignIn(
  app: AskingApp,
  domain: string,
  {
    heading = `Sign in to ${app.name}`,
    signUps,
  }: { heading?: string; signUps?: "anyone" | "members" } = {},
) {
  const name = text(app.name);
  const membership =
    signUps === "anyone"
      ? "Anyone can sign in. A new address gets an account of its own, with no access to the mind itself."
      : signUps === "members"
        ? `${domain} takes no new sign-ups: a code goes only to an address that is already a member. Any other address gets no code and no error.`
        : `Signing in does not make you a member of ${domain}.`;
  return {
    title: `Sign in to ${app.name}`,
    asker: appTile(app),
    imageOrigin: app.icon ? app.origin : undefined,
    heading: `<h1>${text(heading)}</h1>
      <p class="muted where">${text(app.host)}</p>`,
    about: `<div class="about" data-app="${text(app.host)}">
        <p><strong>${name}</strong> is an app of <strong>${text(domain)}</strong>, which runs it.</p>
        <ul>
          <li>It learns your email address, and nothing else.</li>
          <li>${text(membership)}</li>
          <li>To leave, sign out in the app, or see <a href="/sign-ins">your sign-ins</a>.</li>
        </ul>
      </div>`,
  };
}

/** The sign-in page of a mind that mails no code: the passkey, and Google when the mind offers it.
 *  With `app`, the sign-in is for that app of the mind (`appSignIn`). */
export function signInPage(domain: string, next: string, google = false, app?: AskingApp | null) {
  const passkey = passkeySignIn(next, "alone");
  const asking = app ? appSignIn(app, domain) : null;
  return page({
    title: asking?.title || `Sign in to ${domain}`,
    asker: asking?.asker,
    imageOrigin: asking?.imageOrigin,
    body: `${asking?.heading || `<h1>Sign in to ${text(domain)}</h1>`}
      ${passkey.body}${google ? googleSignIn(next) : ""}${asking?.about || ""}`,
    script: passkey.script,
  });
}

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
 *  passkeys it holds for this site. `alone`: the page offers no other way to sign in. */
export function passkeySignIn(next: string, alone?: "alone") {
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
}) {
  const url = new URL(input.here, "https://issuer.invalid");
  // a GET form sends its fields as the query, so each parameter of the request is one
  const fields = [...url.searchParams]
    .map(([name, value]) => `<input type="hidden" name="${text(name)}" value="${text(value)}">`)
    .join("");
  const asking = input.app ? appSignIn(input.app, input.domain) : null;
  return page({
    title: asking?.title || `Sign in to ${input.domain}`,
    asker: asking?.asker,
    imageOrigin: asking?.imageOrigin,
    body: `${asking?.heading || `<h1>Sign in to ${text(input.domain)}</h1>`}
      <p>You are signed in as <strong>${text(input.email)}</strong>.</p>
      <form method="get" action="${text(url.pathname)}" class="stack">
        ${fields}
        <button type="submit">Continue as ${text(input.email)}${input.app ? ` to ${text(input.app.name)}` : ""}</button>
      </form>
      <div>${otherAccountForm(input.here)}</div>${asking?.about || ""}`,
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
  host?: string;
  /** That host as the app it is (./asking-app.ts): the page names it as the app names itself. */
  app?: AskingApp;
  /** The authorization request, a path of this origin: where "use another account" comes back. */
  here: string;
  headers: Headers;
}) {
  const { details } = input;
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
      // the client's mark beside the mind's: a known client's, a verified client's own logo, or
      // its initials (client-mark.ts)
      asker: clientTile({ ...details, name: details.clientName }),
      imageOrigin: shownLogoOf(details)?.origin,
      body: `${
        input.host
          ? `<h1>${name} wants to use ${text(input.app?.name || input.host)} as you</h1>
        <p>${name} will learn that you are <strong>${text(input.email)}</strong>, and can use ${text(input.app?.name || input.host)} as you. It gets nothing else in ${domain}.</p>${input.app && input.app.name !== input.host ? `<p class="muted">${text(input.app.name)} is an app of ${domain}, at ${text(input.host)}.</p>` : ""}`
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
