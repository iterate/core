import { expect, test } from "vitest";
import type { Env } from "./env.ts";
import { authResponse } from "./http.ts";

const env = {
  DOMAIN: "example.com",
  AUTH_SETTINGS: JSON.stringify({
    login: { methods: { email: {} }, allow: [{ email: "owner@example.net" }] },
    keys: [],
  }),
} as unknown as Env;

test("the platform's host has no start page: `/` leads a signed-out visitor to the Dash", async () => {
  for (const method of ["GET", "HEAD"]) {
    const answer = await authResponse(
      new Request("https://iterate.example.com/", { method }),
      env,
      {} as ExecutionContext,
    );
    expect(answer).toMatchObject({ status: 302 });
    expect(Object.fromEntries(answer.headers)).toMatchObject({
      location: "https://dash.example.com/",
      "cache-control": "no-store",
    });
  }
});

test("the mind's own sign-in is the passkey's page: one button, an ask as the page opens, and the mailed code behind one link", async () => {
  const answer = await asked("/sign-in?next=%2Fkeys");
  expect(answer).toMatchObject({ status: 200 });
  const html = await answer.text();
  expect(html).toContain(`<h1>Sign in to example.com</h1>`);
  expect(html).toContain(`<button type="submit">Sign in with a passkey</button>`);
  expect(html).toContain("\nsignIn(false);");
  expect(html).toContain(
    `<a href="/sign-in/email?next=%2Fkeys">No passkey on this device? Get a code by email</a>`,
  );
  // nothing to type and no rule on sign-ups: those are on the code's page
  expect(html).not.toMatch(/type="email"|sign-ups|class="or"/);
});

test("a mind that mails no code and offers Google has no link to a code, and Google's button under the passkey's", async () => {
  const login = { methods: { google: {} }, allow: [{ email: "owner@example.net" }] };
  const html = await (
    await asked("/sign-in?next=%2Fkeys", login, { CLOUD_ORIGIN: "https://cloud.example.org" })
  ).text();
  expect(html).toContain("\nsignIn(false);");
  expect(html).toMatch(
    /<button type="submit">Sign in with a passkey<\/button>[^]*<p class="or">or<\/p>[^]*<form method="get" action="\/sign-in\/google"[^]*Sign in with Google<\/button>/,
  );
  expect(html).not.toContain("code by email");
});

test("a person who signed out is not asked for a passkey as the page opens: the sign-out's link says so, with a way back and with none", async () => {
  const signedOut = async (form: Record<string, string>) => {
    const out = await authResponse(
      new Request("https://iterate.example.com/sign-out", {
        method: "POST",
        headers: { origin: "https://iterate.example.com" },
        body: new URLSearchParams(form),
      }),
      env,
      {} as ExecutionContext,
    );
    return out.headers.get("location");
  };
  expect(await signedOut({ next: "/sessions" })).toBe("/sign-in?next=%2Fsessions&signed-out=1");
  // the button on /sessions names no way back: the sign-in for the start page, which waits too
  expect(await signedOut({})).toBe("/sign-in?next=%2F&signed-out=1");
  const html = await (await asked("/sign-in?next=%2Fsessions&signed-out=1")).text();
  expect(html).toContain(`<button type="submit">Sign in with a passkey</button>`);
  expect(html).not.toContain("signIn(false)");
});

test.for([
  {
    open: "its mailed code goes to anyone",
    login: { methods: { email: { anyone: true } }, allow: [{ email: "owner@example.net" }] },
  },
  {
    open: "its rule admits everyone",
    login: { methods: { email: {} }, allow: [{ everyone: {} }] },
  },
])(
  "a stack where anyone may sign in ($open) asks for the passkey too at the mind's own sign-in: a member comes there",
  async ({ login }) => {
    const answer = await asked("/sign-in?next=%2Fkeys", login);
    expect(answer).toMatchObject({ status: 200 });
    const html = await answer.text();
    expect(html).toContain("\nsignIn(false);");
    expect(html).toContain(`<a href="/sign-in/email?next=%2Fkeys">`);
  },
);

/** A signed-out GET of the issuer, on a stack with these sign-in rules (by default `env`'s) and
 *  these bindings beside them. */
function asked(path: string, login?: object, bound: Partial<Env> = {}) {
  const settings = login ? { AUTH_SETTINGS: JSON.stringify({ login, keys: [] }) } : {};
  return authResponse(
    new Request(`https://iterate.example.com${path}`),
    // the bindings a sign-in page reads, not a whole stack's
    { ...env, ...settings, ...bound } as Env,
    {} as ExecutionContext,
  );
}
