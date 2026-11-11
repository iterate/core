// The stack's own pages as a person meets them: each one card under the mark, narrow for one
// question and one action, wide for a page to work in. With ITERATE_PAGES_OUT set to a folder, the
// pages are also written there as files, for a look in a browser.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { emailSignInResponse } from "./email-sign-in.ts";
import type { Env } from "./env.ts";
import { consentPage, errorPage, homePage, signInPage } from "./pages.ts";

const DOMAIN = "example.com";
const env = {
  DOMAIN,
  AUTH_SETTINGS: JSON.stringify({
    login: { methods: { email: {} }, allow: [{ email: "owner@example.net" }] },
    keys: [],
  }),
} as unknown as Env;

test("the sign-in page is the narrow card: the mark, a named email field, one action, and the passkey as another way", async () => {
  const answer = await emailSignInResponse(
    env,
    new Request(`https://iterate.${DOMAIN}/sign-in/email?next=%2Fkeys`),
  );
  const html = await kept("sign-in", answer!);
  expect(html).toContain(`<main><div class="mark"`);
  expect(html).toContain(`<h1>Sign in to ${DOMAIN}</h1>`);
  expect(html).toMatch(/<label>Email <input type="email" name="email"/);
  expect(html).toContain(`<button type="submit">Send a code</button>`);
  expect(html).toContain(`<p class="or">or</p>`);
  expect(html).toContain(`<button type="submit" class="secondary">Sign in with a passkey</button>`);
});

test("a mind that mails no code offers the passkey as the one action", async () => {
  const html = await kept("sign-in-passkey-alone", signInPage(DOMAIN, "/"));
  expect(html).toContain(`<button type="submit">Sign in with a passkey</button>`);
  expect(html).not.toContain(`class="or"`);
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
      domain: DOMAIN,
      resource: `https://iterate.${DOMAIN}/mcp`,
      headers: new Headers(),
    }),
  );
  expect(html).toContain(`<main><div class="mark"`);
  expect(html).toContain(`<h1>Allow Claude Code to act as you in ${DOMAIN}?</h1>`);
  expect(html).toMatch(
    /<button type="submit" name="decision" value="deny" class="secondary">Deny<\/button>\s*<button type="submit" name="decision" value="allow">Allow<\/button>/,
  );
});

test("a member's start page is the wide card, and a refusal the narrow one", async () => {
  const start = await kept(
    "start",
    homePage({
      domain: DOMAIN,
      email: "owner@example.net",
      standing: "member",
      mcp: `https://iterate.${DOMAIN}/mcp`,
      dash: false,
    }),
  );
  expect(start).toContain(`<main class="wide"><div class="mark"`);
  const refusal = await kept("refusal", errorPage("That link has ended."));
  expect(refusal).toContain(`<main><div class="mark"`);
});

/** The page's HTML, written to ITERATE_PAGES_OUT when that names a folder. */
async function kept(name: string, answer: Response) {
  const html = await answer.text();
  const out = process.env.ITERATE_PAGES_OUT;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}.html`), html);
  }
  return html;
}
