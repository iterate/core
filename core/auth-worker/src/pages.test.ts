// The stack's own pages as a person meets them: each one card under the mark, narrow for one
// question and one action, wide for a page to work in. With ITERATE_PAGES_OUT set to a folder, the
// pages are also written there as files, for a look in a browser.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { plainPageCssHash } from "iterate/standalone-page";
import { expect, test } from "vitest";
import { emailAddressPage } from "./email-sign-in.ts";
import type { Env } from "./env.ts";
import { deviceTile } from "./device/page.ts";
import { chooserPage, consentPage, errorPage, page, signInPage, STATUS_SCRIPT } from "./pages.ts";
import { configVars } from "./test-support.ts";

const MIND = "iterate.example.com";
// the cast: these pages read the mind's config and no binding
const env = configVars() as unknown as Env;

test("the mailed code's address page is the narrow card: the mark, a named email field, one action, and the passkey as another way", async () => {
  // an outside client's sign-in to an app that names "email": the page is headed with the mind
  const html = await kept(
    "sign-in",
    emailAddressPage(env, "/oauth2/auth?client_id=c", { app: null, methods: ["email", "passkey"] }),
  );
  expect(html).toContain(`<main class="centered"><div class="mark"`);
  expect(html).toContain(`<h1>Sign in to ${MIND}</h1>`);
  // the mind's own line says what a code gives, and that it signs in no member
  expect(html).toContain(
    `<p class="muted">A code gives an account for the apps of ${MIND}, with no access to the mind itself. A member signs in with a passkey.</p>`,
  );
  expect(html).toMatch(/<label>Email <input type="email" name="email"/);
  expect(html).toContain(`<button type="submit">Send a code</button>`);
  expect(html).toContain(`<p class="or">or</p>`);
  expect(html).toContain(`<button type="submit" class="secondary">Sign in with a passkey</button>`);
  // a person who came for a code is not asked for a passkey as the page opens
  expect(html).not.toContain("signIn(false)");
});

test("the mind's sign-in offers the passkey as its main action, and below it an owner's link to Cloudflare Access and no email address; for an app, it names the app and its host under the app's own icon", async () => {
  const html = await kept(
    "sign-in-passkey",
    signInPage({
      mind: MIND,
      next: "/",
      app: null,
      offersEmail: false,
      offersGuest: false,
      asksAtOpen: true,
    }),
  );
  expect(html).toContain(`<h1>Sign in to ${MIND}</h1>`);
  expect(html).toMatch(
    /<button type="submit">Sign in with a passkey<\/button>[^]*<p class="muted">An owner with no passkey yet: <a href="\/sign-in\/access\?next=%2F">prove your email address with Cloudflare<\/a>, and then add one.<\/p>/,
  );
  expect(html).not.toMatch(/class="or"|sign-in\/email|Sign in with your email address/);
  const app = {
    host: "guestbook.example.com",
    origin: "https://guestbook.example.com",
    name: "Guestbook",
    icon: "https://guestbook.example.com/icon.svg",
    members: false,
    signIn: ["passkey" as const],
  };
  // an app that names "email" after the passkey has the button to the mailed code's page below,
  // and no link to Cloudflare Access, which is for owners alone
  const withEmail = await signInPage({
    mind: MIND,
    next: "/oauth2/auth?client_id=c",
    app: { ...app, signIn: ["passkey", "email"] },
    offersEmail: true,
    offersGuest: false,
    asksAtOpen: false,
  }).text();
  expect(withEmail).toMatch(
    /<button type="submit">Sign in with a passkey<\/button>[^]*<form method="get" action="\/sign-in\/email" class="stack">\s*<input type="hidden" name="next" value="\/oauth2\/auth\?client_id=c">\s*<button type="submit" class="secondary">Sign in with your email address<\/button>/,
  );
  expect(withEmail).not.toContain("/sign-in/access");
  const forApp = await kept(
    "sign-in-app-icon",
    signInPage({
      mind: MIND,
      next: "/oauth2/auth?client_id=c",
      app,
      offersEmail: false,
      offersGuest: false,
      asksAtOpen: false,
    }),
  );
  expect(forApp).toContain(
    `<h1>Sign in to Guestbook</h1><p class="muted center">guestbook.example.com</p>`,
  );
  // an app that names the passkey alone offers no mailed code
  expect(forApp).toContain(`<button type="submit">Sign in with a passkey</button>`);
  expect(forApp).not.toMatch(/sign-in\/email|Sign in with your email address/);
  expect(forApp).toContain(
    `<main class="centered"><div class="tile" data-app-mark="icon"><img src="https://guestbook.example.com/icon.svg"`,
  );
  // an app's page asks for no passkey as it opens
  expect(forApp).not.toContain("signIn(false)");
  // an app for members (such as Onboarding) shows the owner's Cloudflare Access link carrying its OAuth next
  const forOnboarding = await signInPage({
    mind: MIND,
    next: "/oauth2/auth?client_id=onboarding",
    app: {
      host: "onboarding.example.com",
      origin: "https://onboarding.example.com",
      name: "Onboarding",
      icon: "https://onboarding.example.com/icon.svg",
      members: true,
      signIn: ["passkey"],
    },
    offersEmail: false,
    offersGuest: false,
    asksAtOpen: false,
  }).text();
  expect(forOnboarding).toContain(
    `<a href="/sign-in/access?next=%2Foauth2%2Fauth%3Fclient_id%3Donboarding">prove your email address with Cloudflare</a>`,
  );
});

test("the consent page asks one question, with Deny and Allow as a pair", async () => {
  const html = await kept(
    "consent",
    consentPage({
      details: {
        clientName: "Claude Code",
        clientDomain: null,
        redirectHost: "localhost",
        redirectIsLoopback: true,
      } as never,
      handle: "handle",
      email: "owner@example.net",
      mind: MIND,
      resource: "its MCP server",
      here: "/oauth2/auth?client_id=c&state=s",
      headers: new Headers(),
    }),
  );
  // who is signed in, and the way to another account: sign out here, then come back to the request
  expect(html).toContain("Signed in as owner@example.net. Not you?");
  expect(html).toMatch(
    /<form method="post" action="\/sign-out" class="inline">\s*<input type="hidden" name="next" value="\/oauth2\/auth\?client_id=c&#38;state=s">\s*<button type="submit" class="link">Use another account<\/button>/,
  );
  // who asks: the mind's mark and Claude's own, side by side, and the heading says it
  expect(html).toContain(
    `<main class="centered"><div class="asks"><div class="mark" aria-hidden="true">`,
  );
  expect(html).toContain(`<span class="joins" aria-hidden="true"></span><div class="tile"`);
  expect(html).toContain(`data-client-mark="known"`);
  expect(html).toContain(`<h1>Claude Code wants to access ${MIND}</h1>`);
  expect(html).toMatch(
    /<button type="submit" name="decision" value="deny" class="secondary">Deny<\/button>\s*<button type="submit" name="decision" value="allow">Allow<\/button>/,
  );
});

test("a page to work in is the wide card, and a refusal the narrow one", async () => {
  const wide = await kept("wide", page({ title: MIND, body: `<h1>${MIND}</h1>`, wide: true }));
  expect(wide).toContain(`<main class="wide"><div class="mark"`);
  const refusal = await kept("refusal", errorPage("That link has ended."));
  expect(refusal).toContain(`<main><div class="mark"`);
});

test("a client's own logo is shown only for a verified domain, from that domain, and the page's policy allows that one origin", async () => {
  const consent = (details: object) =>
    consentPage({
      details: {
        clientName: "Notes",
        redirectUri: "https://notes.example.org/callback",
        redirectHost: "notes.example.org",
        redirectIsLoopback: false,
        ...details,
      } as never,
      handle: "handle",
      email: "owner@example.net",
      mind: MIND,
      resource: "its MCP server",
      here: "/oauth2/auth?client_id=c&state=s",
      headers: new Headers(),
    });
  const verified = consent({
    clientDomain: "example.org",
    logoUri: "https://cdn.example.org/logo.png",
  });
  expect(verified.headers.get("content-security-policy")).toContain(
    "img-src data: https://cdn.example.org",
  );
  expect(await kept("consent-own-logo", verified)).toContain(
    `<img src="https://cdn.example.org/logo.png" alt="" referrerpolicy="no-referrer">`,
  );
  // a client that registered itself says its own logo: no tile of it is shown, and no image may
  // load but the page's own icon, inline
  for (const details of [
    { logoUri: "https://cdn.example.org/logo.png" },
    { clientDomain: "example.org", logoUri: "https://elsewhere.example/logo.png" },
    { clientDomain: "example.org", logoUri: "http://example.org/logo.png" },
    { clientDomain: "example.org", logoUri: "javascript:alert(1)" },
  ]) {
    const answer = consent(details);
    expect(answer.headers.get("content-security-policy")?.split("; ")).toContain("img-src data:");
    const html = await answer.text();
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/class="asks"|data-client-mark/);
  }
});

test("a known client's mark goes by where its access goes, or by its name", async () => {
  const html = async (details: object) =>
    await consentPage({
      details: { redirectIsLoopback: false, ...details } as never,
      handle: "handle",
      email: "owner@example.net",
      mind: MIND,
      resource: "its MCP server",
      here: "/oauth2/auth?client_id=c&state=s",
      headers: new Headers(),
    }).text();
  const claude = {
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    redirectHost: "claude.ai",
  };
  expect(await html({ clientName: "An app", ...claude })).toContain(`data-client-mark="known"`);
  expect(
    await html({
      clientName: "Cursor",
      redirectUri: "cursor://x/callback",
      redirectHost: "cursor://x/callback",
    }),
  ).toContain(`data-client-mark="known"`);
  // Codex, as its own client document says it: a verified domain, and access to this computer
  expect(
    await html({
      clientName: "Codex",
      clientDomain: "chatgpt.com",
      logoUri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
      redirectUri: "http://127.0.0.1:1455/callback",
      redirectHost: "127.0.0.1:1455",
      redirectIsLoopback: true,
    }),
  ).toContain(`<div class="tile" data-client-mark="known" data-client="openai"><svg`);
  expect(
    await html({
      clientName: "An app",
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      redirectHost: "chatgpt.com",
    }),
  ).toContain(`data-client="openai"`);
  expect(
    await html({
      clientName: "Notes",
      redirectUri: "https://notes.example.org/callback",
      redirectHost: "notes.example.org",
    }),
  ).not.toContain("data-client-mark");
});

test("a device's sign-in shows who asks by the name the device gives: a known mark, or its initials", () => {
  expect(deviceTile("Claude Code")).toContain(`data-client-mark="known"`);
  expect(deviceTile("Codex")).toContain(`data-client-mark="known" data-client="openai"`);
  expect(deviceTile("iterate CLI on a laptop")).toBe(
    `<div class="tile" data-client-mark="initials">IT</div>`,
  );
  // a name is text: markup in it does not reach the page
  expect(deviceTile(`<img src=x onerror=alert(1)>`)).toBe(
    `<div class="tile" data-client-mark="initials">IM</div>`,
  );
});

/** The page's HTML, written to ITERATE_PAGES_OUT when that names a folder. */
test("the account chooser says who is signed in, goes on as them, or signs out and comes back", async () => {
  const html = await kept(
    "chooser",
    chooserPage({
      mind: MIND,
      email: "owner@example.net",
      here: "/oauth2/auth?client_id=c&state=s",
    }),
  );
  expect(html).toContain(
    `<p class="center">You are signed in as <strong>owner@example.net</strong>.</p>`,
  );
  // the request's parameters ride the GET form, so "Continue" is the request without its prompt
  expect(html).toMatch(
    /<form method="get" action="\/oauth2\/auth" class="stack">\s*<input type="hidden" name="client_id" value="c"><input type="hidden" name="state" value="s">\s*<button type="submit">Continue as owner@example.net<\/button>/,
  );
  expect(html).toContain(`name="next" value="/oauth2/auth?client_id=c&#38;state=s"`);
  expect(html).toContain("Use another account");
  const app = {
    host: "guestbook.example.com",
    origin: "https://guestbook.example.com",
    name: "Guestbook",
    icon: null,
    members: false,
    signIn: ["email" as const, "passkey" as const],
  };
  const forApp = await kept(
    "chooser-app",
    chooserPage({ mind: MIND, email: "guest@example.net", here: "/oauth2/auth?x=1", app }),
  );
  expect(forApp).toContain(
    `<h1>Sign in to Guestbook</h1><p class="muted center">guestbook.example.com</p>`,
  );
  expect(forApp).toContain(`<button type="submit">Continue as guest@example.net</button>`);
  const signedOut = await kept(
    "chooser-signed-out",
    chooserPage({
      mind: MIND,
      email: "guest@example.net",
      here: "/oauth2/auth?x=1",
      app,
      signedOutOf: "<b>guestbook.example.com</b>",
    }),
  );
  expect(signedOut).toContain(
    `<p class="center">You are signed out of &#60;b&#62;guestbook.example.com&#60;/b&#62;. You are still signed in to ${MIND} as <strong>guest@example.net</strong>.</p>`,
  );
});

test("a page's own style is allowed by the page's nonce, beside the shared stylesheet's hash", async () => {
  const answer = page({ title: "Styled", body: "<p>x</p>", style: ".x { color: red; }" });
  const policy = answer.headers.get("content-security-policy") || "";
  const nonce = /style-src \S+ 'nonce-([^']+)'/.exec(policy)?.[1];
  expect(policy).toContain(`style-src ${plainPageCssHash} 'nonce-${nonce}'`);
  expect(policy).not.toContain("script-src");
  expect(await answer.text()).toContain(`<style nonce="${nonce}">.x { color: red; }</style>`);
  // a page with no style of its own allows the shared stylesheet alone
  const plain = page({ title: "Plain", body: "" }).headers.get("content-security-policy");
  expect(plain?.split("; ")).toContain(`style-src ${plainPageCssHash}`);
});

test("every scripted page has one line for its press: a refusal reads as an error, a closed passkey sheet stays quiet", async () => {
  // the page's own script text, run on a stand-in for its status line
  const { statusFailed, statusSay } = runInNewContext(
    `${STATUS_SCRIPT}; ({ statusFailed, statusSay })`,
  ) as Record<string, (...args: unknown[]) => void>;
  const line = () => {
    const state = { text: "", muted: true, role: "status", scrolled: false };
    return {
      state,
      set textContent(words: string) {
        state.text = words;
      },
      classList: {
        add: () => void (state.muted = true),
        remove: () => void (state.muted = false),
      },
      setAttribute: (_name: string, value: string) => void (state.role = value),
      scrollIntoView: () => void (state.scrolled = true),
    };
  };
  const refused = line();
  statusFailed!(refused, new Error("Not signed: the statement has expired."), "Not signed.");
  expect(refused).toMatchObject({
    state: {
      text: "Not signed: the statement has expired.",
      muted: false,
      role: "alert",
      scrolled: true,
    },
  });
  const closed = line();
  statusFailed!(closed, Object.assign(new Error(""), { name: "NotAllowedError" }), "Not signed.");
  expect(closed).toMatchObject({
    state: {
      text: "No passkey was used. Press again when you are ready.",
      muted: true,
      role: "status",
      scrolled: false,
    },
  });
  // a refused line goes quiet again with the next press
  statusSay!(refused, "Waiting for your passkey…");
  expect(refused).toMatchObject({ state: { muted: true, role: "status" } });
  const html = await page({ title: "A press", body: "", script: "statusSay;" }).text();
  expect(html).toContain("function statusRefused(line, words)");
});

async function kept(name: string, answer: Response) {
  const html = await answer.text();
  const out = process.env.ITERATE_PAGES_OUT;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}.html`), html);
  }
  return html;
}
