import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { plainPageCssHash, standalonePage } from "iterate/standalone-page";

export const text = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

// No `form-action`: browsers hold a form's redirects to it too, and Allow redirects to the client,
// wherever that is.
const CSP = `default-src 'none'; style-src ${plainPageCssHash}; frame-ancestors 'none'; base-uri 'none'`;

export function page(
  input: { title: string; body: string; status?: number; script?: string },
  headers = new Headers(),
): Response {
  const nonce = input.script && crypto.randomUUID();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set(
    "content-security-policy",
    nonce ? `${CSP}; script-src 'nonce-${nonce}'; connect-src 'self'` : CSP,
  );
  headers.set("x-frame-options", "DENY");
  // `same-origin`, not `no-referrer`: under `no-referrer` a browser sends `Origin: null` on a
  // form's POST, and the consent and sign-out forms are checked by their Origin.
  headers.set("referrer-policy", "same-origin");
  const body = nonce
    ? `${input.body}<script nonce="${nonce}">${input.script}</script>`
    : input.body;
  return new Response(standalonePage({ title: input.title, head: "", body }), {
    status: input.status ?? 200,
    headers,
  });
}

/** The platform's start page: a member's ways into the project, or the sign-in for anyone else. */
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
      body: `<h1>${text(domain)}</h1>
      <p>You are signed in as <strong>${text(email)}</strong>.</p>
      <ul class="stack">
        ${input.dash ? link("/dash", "Open the Dash", "your project's events, files and settings") : ""}
        ${link(`https://agents.${domain}`, "Open the Agents app", "talk to your project's agents")}
        ${link("/members", "People", "who may sign in")}
        ${link("/keys", "Your keys", "your passkeys, and the keys of services you allowed")}
        ${link("/secrets/", "Secrets", "the keys and passwords your project uses")}
        ${link("/secrets/approvals", "Approvals", "requests that wait for your yes")}
        ${link("/self-test", "Self-test", "check that everything works")}
      </ul>
      <h2>Connect Claude Code</h2>
      <p>The MCP address of this project is <code>${text(input.mcp)}</code>. Run this, then sign in when Claude Code asks:</p>
      <pre><code>claude mcp add --transport http ${text(domain)} ${text(input.mcp)}</code></pre>
      ${signOut}`,
    });
  }
  const who =
    email && standing === "passkey-owed"
      ? `<p>You are signed in as <strong>${text(email)}</strong>. <a href="/keys">Add a passkey</a> to use the project.</p>${signOut}`
      : email
        ? `<p>You are signed in as <strong>${text(email)}</strong>, which is not a member of ${text(domain)}.</p>${signOut}`
        : `<p class="muted">You are not signed in.</p>
       <p><a href="/sign-in">Sign in</a></p>`;
  return page({
    title: `Sign-in for ${domain}`,
    body: `<h1>Sign-in for ${text(domain)}</h1>
      <p>This is where you sign in to the iterate project at ${text(domain)}, and allow apps to use it as you.</p>
      ${who}`,
  });
}

export function signInPage(domain: string, next: string, mailsCodes: boolean) {
  const passkey = passkeySignIn(next);
  return page({
    title: `Sign in to ${domain}`,
    body: `<h1>Sign in to ${text(domain)}</h1>
      <form method="get" action="/sign-in/iterate">
        <input type="hidden" name="next" value="${text(next)}">
        <button type="submit">Log in with iterate</button>
      </form>
      ${
        mailsCodes
          ? `<p class="muted">Or sign in with a code we email you.</p>
      <form method="post" action="/sign-in/email" class="stack">
        <input type="hidden" name="next" value="${text(next)}">
        <input type="email" name="email" autocomplete="email" required aria-label="Email">
        <button type="submit">Send a code</button>
      </form>`
          : ""
      }
      ${passkey.body}`,
    script: passkey.script,
  });
}

/** The page's half of ./passkey-sign-in.ts. It names no credential, so the browser offers the
 *  passkeys it holds for this site. */
export function passkeySignIn(next: string) {
  return {
    body: `<p class="muted">Or use a passkey you added here.</p>
      <form id="passkey" class="stack" data-next="${text(next)}">
        <button type="submit">Sign in with a passkey</button>
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

export function notMemberPage(input: { domain: string; email: string; issuer?: string }) {
  const upstream = input.issuer && new URL(input.issuer).host;
  return errorPage(
    `You are signed in as ${input.email}, and that address is not a member of ${input.domain}. Ask the project's owner to add it. To use another account, sign out${upstream ? ` at ${upstream}` : ""}, then try again.`,
    403,
    undefined,
    [
      input.issuer
        ? { href: input.issuer, label: `Open ${upstream}` }
        : { href: "/", label: "Sign out" },
    ],
  );
}

export function consentPage(input: {
  details: ConsentDescription;
  handle: string;
  email: string;
  domain: string;
  resource: string;
  host?: string;
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
      body: `${
        input.host
          ? `<h1>Allow ${name} to use ${text(input.host)} as you?</h1>
        <p>${name} will learn that you are <strong>${text(input.email)}</strong>, and can use ${text(input.host)} as you. It gets nothing else in ${domain}.</p>`
          : `<h1>Allow ${name} to act as you in ${domain}?</h1>
        <p>${name} will use ${domain} through ${text(input.resource)}, as <strong>${text(input.email)}</strong>. It can read and change everything in this project.</p>`
      }
        ${origin}
        ${loopback}
        <form method="post" class="actions">
          <input type="hidden" name="handle" value="${text(input.handle)}">
          <button type="submit" name="decision" value="allow">Allow</button>
          <button type="submit" name="decision" value="deny" class="link">Deny</button>
        </form>`,
    },
    input.headers,
  );
}
