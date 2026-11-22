// Core's page tag (./page-tag.ts) and the pages that take it (./pages.ts `page`): its script
// reads no form, no input, no code, no email address, no cookie and no referrer; its path rule
// and its cut of URLs; the policy of a tagged page and of one with no tag; and the path rule
// that keeps it off every answer where a person signs in, grants, signs or adds a key.
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { sessionCookie } from "./cookies.ts";
import { emailAddressPage } from "./email-sign-in.ts";
import type { Env } from "./env.ts";
import { authResponse } from "./http.ts";
import { CUT_RULE, cut, PAGE_TAG_SCRIPT, PATH_RULE, pathOf } from "./page-tag.ts";
import {
  chooserPage,
  consentPage,
  errorPage,
  notMemberPage,
  page,
  signInPage,
  takesNoTag,
} from "./pages.ts";
import { configVars, sqliteStack } from "./test-support.ts";

const MIND = "iterate.example.com";
const ISSUER = `https://${MIND}`;
const OWNER = { id: "user_owner", email: "owner@example.net" };
const ADA = { id: "user_ada", email: "ada@example.org" };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
// the cast: these pages read the mind's config and no binding
const env = configVars() as unknown as Env;

test("the script reads no form, no input, no code, no email address, no cookie and no referrer, keeps nothing in the browser, and sends with no Referer", () => {
  for (const read of [
    /cookie/i,
    /\.value\b/,
    /forms?\b/,
    /input/i,
    /querySelector|getElementBy|elements/,
    /email/i,
    /localStorage|sessionStorage|indexedDB|caches/,
    /location\.(search|hash|href)/,
    /textContent|innerText|innerHTML/,
    /document\.referrer|sendBeacon/,
  ])
    expect(PAGE_TAG_SCRIPT).not.toMatch(read);
  expect(PAGE_TAG_SCRIPT).toContain(`fetch("/.page-events", {
        method: "POST",
        keepalive: true,
        referrerPolicy: "no-referrer",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },`);
  // the path goes through the route's own rules before it is sent
  expect(PAGE_TAG_SCRIPT).toContain("const pathname = cut(pathOf(location.pathname));");
  expect(PAGE_TAG_SCRIPT.split("\n").length).toBeLessThanOrEqual(110);
  // nothing in it ends its element early
  expect(PAGE_TAG_SCRIPT).not.toMatch(/<\/script|<!--/i);
});

test("an OAuth callback's URL in a message or a stack keeps its path alone, and a code, a state or a token is <cut>; the script's rule and the route's agree", () => {
  const scriptCut = runInNewContext(`${PATH_RULE}; ${CUT_RULE}; cut`) as (text: string) => string;
  const cases: [string, string][] = [
    [
      "Failed to fetch https://iterate.example.com/oauth2/callback?code=abc123&state=xyz789#frag",
      "Failed to fetch /oauth2/callback",
    ],
    ["GET /oauth2/callback?code=abc123&state=xyz789 failed", "GET /oauth2/callback failed"],
    ["went to ../sign-in/email/code?next=%2Fkeys", "went to ../sign-in/email/code"],
    [
      "Error: no\n    at go (https://iterate.example.com/oauth2/auth?client_id=c&state=s:12:5)\n    at https://cdn.example.com/assets/app-AbCdEfGh12.js:1:2",
      "Error: no\n    at go (/oauth2/auth:12:5)\n    at /assets/app-AbCdEfGh12.js:1:2",
    ],
    ["bad code=abc123 and state=s1, access_token=t2", "bad <cut> and <cut>, <cut>"],
    ["Authorization: Bearer abc.def.ghi", "Authorization: <cut>"],
    ["key " + "a1".repeat(20), "key <cut>"],
    [
      "decodeURIComponent failed: Unexpected token < in JSON",
      "decodeURIComponent failed: Unexpected token < in JSON",
    ],
    ["/keys/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee?x=1", "/keys/<id>"],
    // a relative URL and a protocol-relative one, in a message and in a stack
    ["load assets/app.js?rev=sample#section failed", "load assets/app.js failed"],
    ["load //cdn.example/assets/app.js?rev=sample failed", "load /assets/app.js failed"],
    ["GET /x?y and x?y#z", "GET /x and x"],
    [
      "Error: no\n    at go (assets/app.js?rev=sample#x:3:4)\n    at //cdn.example/lib/a.js?v=2:1:2\n    at f@vendor.js?v=9:5:6",
      "Error: no\n    at go (assets/app.js:3:4)\n    at /lib/a.js:1:2\n    at f@vendor.js:5:6",
    ],
    // a question mark or a hash with no text on both sides is no URL
    ["is it ok? see issue #12", "is it ok? see issue #12"],
  ];
  for (const [text, kept] of cases) {
    expect(cut(text)).toBe(kept);
    expect(scriptCut(text)).toBe(kept);
  }
});

test("a path keeps its words; a segment that looks like an id or a token is <id>; a query string and a hash are gone; the script's rule and the route's agree", () => {
  const scriptRule = runInNewContext(`${PATH_RULE}; pathOf`) as (path: string) => string;
  const cases: [string, string][] = [
    ["/members", "/members"],
    ["/sessions?next=%2Fkeys#top", "/sessions"],
    ["/keys/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "/keys/<id>"],
    ["/keys/aaaaabbbbbccccc111112222233333aaaaabbbbb", "/keys/<id>"],
    ["/sign-in/user123abc456", "/sign-in/<id>"],
    ["/minds/AbCdEfGhIjKlMnOpQrStUv", "/minds/<id>"],
    ["/settings/first-passkey", "/settings/first-passkey"],
    ["/a/" + "word-".repeat(60), ("/a/" + "word-".repeat(60)).slice(0, 200)],
  ];
  for (const [path, kept] of cases) {
    expect(pathOf(path)).toBe(kept);
    expect(scriptRule(path)).toBe(kept);
  }
});

test("a tagged page's policy allows exactly the tag, by its nonce, and a beacon to its own origin; a page with no tag has the policy it had", async () => {
  const tagged = page({ title: "t", body: "<h1>t</h1>", tag: true });
  const policy = tagged.headers.get("content-security-policy")!;
  const nonce = policy.match(/script-src 'nonce-([^']+)'/)![1];
  expect(policy).toContain("connect-src 'self'");
  expect(policy).not.toMatch(/unsafe|https:|\*/);
  const html = await tagged.text();
  expect(html).toContain(`<script nonce="${nonce}">${PAGE_TAG_SCRIPT}</script>`);
  expect(html.match(/<script/g)).toHaveLength(1);

  const untagged = page({ title: "t", body: "<h1>t</h1>" });
  const plain = untagged.headers.get("content-security-policy")!;
  expect(plain).not.toMatch(/script-src|connect-src/);
  expect(await untagged.text()).not.toContain("<script");

  // a page with its own script and the tag: one nonce, the tag first
  const both = await page({ title: "t", body: "", script: "go();", tag: true }).text();
  expect(both.indexOf(PAGE_TAG_SCRIPT)).toBeLessThan(both.indexOf("go();"));
  expect(new Set(both.match(/nonce="[^"]+"/g))).toMatchObject({ size: 1 });
});

test("no answer under /sign-in, /oauth2, /keys, /members, /minds or /sign-out has the tag, nor a policy for it: the forms, the pages and the refusals", async () => {
  const stack = await signedInStack();
  const { owner, outsider } = stack;
  const answers: [string, Response][] = [
    // the forms and the pages
    ["/members", await stack.ask("/members", owner)],
    ["/minds", await stack.ask("/minds", owner)],
    ["/keys", await stack.ask("/keys", owner)],
    ["/keys/enrol", await stack.ask("/keys/enrol?" + new URLSearchParams({ label: "l" }), owner)],
    ["/keys/first", await firstPasskeyForm()],
    ["/sign-in", await stack.ask("/sign-in?next=%2F")],
    ["/sign-in/email", await stack.ask("/sign-in/email?next=%2F")],
    ["/oauth2/device", await stack.ask("/oauth2/device")],
    // the refusals: a person who is no member, a request from another origin, a missing client
    ["/members refused", await stack.ask("/members", outsider)],
    ["/minds refused", await stack.ask("/minds", outsider)],
    ["/keys refused", await stack.ask("/keys", outsider)],
    ["/oauth2/auth refused", await stack.ask("/oauth2/auth?client_id=nobody", owner)],
    [
      "/sign-out refused",
      await stack.ask("/sign-out", owner, { method: "POST", origin: "https://evil.example" }),
    ],
    ["/sign-in/mind refused", await stack.ask("/sign-in/mind/return", owner)],
  ];
  const seen: Record<string, unknown> = {};
  for (const [name, answer] of answers) {
    const html = await answer.text();
    const policy = answer.headers.get("content-security-policy") || "";
    seen[name] = {
      tag: html.includes(PAGE_TAG_SCRIPT),
      // a policy for scripts only where the page has a script of its own
      policyWithNoScript: !html.includes("<script") && /script-src|connect-src/.test(policy),
    };
  }
  expect(seen).toEqual(
    Object.fromEntries(answers.map(([name]) => [name, { tag: false, policyWithNoScript: false }])),
  );
  // a refusal is still the error page, with its words
  const refused = await (await stack.ask("/members", outsider)).text();
  expect(refused).toContain("is not a member of");
});

test("the pages that keep the tag: /sessions, the not-a-member page at /, and an error page elsewhere", async () => {
  const stack = await signedInStack();
  const sessions = await stack.ask("/sessions", stack.owner);
  expect(await sessions.text()).toContain(PAGE_TAG_SCRIPT);
  expect(sessions.headers.get("content-security-policy")).toContain("connect-src 'self'");
  expect(await (await stack.ask("/", stack.outsider)).text()).toContain(PAGE_TAG_SCRIPT);
  expect(await tagged(errorPage("No."))).toBe(true);
  expect(await tagged(notMemberPage({ mind: MIND, email: "a@example.org" }))).toBe(true);
  // the builders of the sign-in, the code and the grant have none of their own
  expect(
    await tagged(
      signInPage({
        mind: MIND,
        next: "/",
        app: null,
        offersEmail: true,
        offersGuest: true,
        offersMind: true,
        asksAtOpen: true,
        noPasskeyYet: false,
      }),
    ),
  ).toBe(false);
  expect(
    await tagged(emailAddressPage(env, "/", { app: null, methods: ["email", "passkey"] })),
  ).toBe(false);
  expect(await tagged(chooserPage({ mind: MIND, email: "a@example.org", here: "/x" }))).toBe(false);
  expect(
    await tagged(
      consentPage({
        // the cast: the page reads these four fields of the library's description
        details: {
          clientName: "Claude",
          clientDomain: "claude.ai",
          redirectHost: "claude.ai",
          redirectIsLoopback: false,
        } as unknown as Parameters<typeof consentPage>[0]["details"],
        handle: "h",
        email: "a@example.org",
        mind: MIND,
        resource: `https://${MIND}/mcp`,
        here: "/x",
        headers: new Headers(),
      }),
    ),
  ).toBe(false);
});

test("the path rule: each path of the six and each under it, and no other", () => {
  for (const path of [
    "/sign-in",
    "/sign-in/email/code",
    "/oauth2/auth",
    "/keys",
    "/keys/first",
    "/members",
    "/minds/published",
    "/sign-out",
    "/statements",
    "/statements/sign",
  ])
    expect(takesNoTag(path)).toBe(true);
  for (const path of ["/", "/sessions", "/self-test", "/keysx", "/statementsx", "/.page-events"])
    expect(takesNoTag(path)).toBe(false);
});

async function tagged(answer: Response) {
  return (await answer.text()).includes(PAGE_TAG_SCRIPT);
}

/** A stack on SQLite whose owner holds one passkey and has a session it opened; `outsider` is the
 *  session of a person who is no member. */
async function signedInStack() {
  const stack = sqliteStack();
  stack.db.prepare("insert into users (id, email) values ('user_owner', ?)").run(OWNER.email);
  stack.db.prepare("insert into users (id, email) values ('user_ada', ?)").run(ADA.email);
  stack.db
    .prepare(
      `insert into keys (id, user_id, public_key, format, credential_id, label, added_via, added_by, added_at)
       values ('passkey-phone', 'user_owner', 'public-key-of-phone', 'webauthn', 'credential-of-phone', 'A phone', 'keys-page', 'user_owner', 1)`,
    )
    .run();
  stack.db
    .prepare(
      `insert into keys (id, user_id, public_key, format, credential_id, label, added_via, added_by, added_at)
       values ('passkey-of-ada', 'user_ada', 'public-key-of-ada', 'webauthn', 'credential-of-ada', 'Ada', 'keys-page', 'user_ada', 2)`,
    )
    .run();
  const cookieOf = async (user: { id: string; email: string }, key: string) =>
    (await sessionCookie(stack.env, new Request(ISSUER), user, key)).setCookie.split(";")[0]!;
  const ask = (path: string, cookie = "", more: { method?: string; origin?: string } = {}) =>
    authResponse(
      new Request(`${ISSUER}${path}`, {
        method: more.method || "GET",
        headers: more.origin ? { cookie, origin: more.origin } : { cookie },
      }),
      stack.env,
      ctx,
    );
  return {
    ...stack,
    ask,
    owner: await cookieOf(OWNER, "passkey-phone"),
    outsider: await cookieOf(ADA, "passkey-of-ada"),
  };
}

/** The first passkey's form, as an owner with no passkey yet gets it after Cloudflare Access. */
async function firstPasskeyForm() {
  const stack = sqliteStack();
  stack.db.prepare("insert into users (id, email) values ('user_owner', ?)").run(OWNER.email);
  const { setCookie } = await sessionCookie(stack.env, new Request(ISSUER), OWNER, "");
  stack.db.exec("update browser_sessions set method = 'cloudflare-access'");
  const form = await authResponse(
    new Request(`${ISSUER}/keys/first`, { headers: { cookie: setCookie.split(";")[0]! } }),
    stack.env,
    ctx,
  );
  // the form itself, not the page of a link that is over
  expect(form.headers.get("content-security-policy")).toContain("script-src");
  return new Response(await form.text(), form);
}
