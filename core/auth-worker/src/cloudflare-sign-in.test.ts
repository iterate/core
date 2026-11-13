// SIGN IN WITH CLOUDFLARE (./cloudflare-sign-in.ts says the rule). The tests go through the
// Worker's own endpoints (the OAuth library included) against a store in memory; Cloudflare is a
// stubbed `fetch`. The guard is tested in core/lib/src/sdk/auth.test.ts: here, every grant keeps
// the way it began by.
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { authorizeResponse } from "./authorize.ts";
import { authResponse } from "./http.ts";
import { whoIs } from "./who-is.ts";
import { CLOUDFLARE_SIGN_IN_SCOPE, cloudflareSignInResponse } from "./cloudflare-sign-in.ts";
import { authConfigOf } from "./config.ts";
import { browserSessionsFake } from "./browser-sessions-fake.ts";
import { cloudflareSessionOf, flowCookie, sessionCookie, sessionOf } from "./cookies.ts";
import type { Env } from "./env.ts";
import { standingOf } from "./members.ts";
import {
  hostCallbackOf,
  hostClientOf,
  oauthHelpers,
  tokenEndpointResponse,
  tokenIdentity,
} from "./oauth.ts";
import { signOutResponse } from "./sign-in.ts";

const DOMAIN = "example.com";
const ISSUER = `https://iterate.${DOMAIN}`;
const CLOUD = `https://cloud.${DOMAIN}`;
const OTHER = `https://guestbook.${DOMAIN}`;
const OWNER = "owner@elsewhere.test";
const CALLBACK = `${ISSUER}/sign-in/cloudflare/callback`;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

test("the config names the client alone: which app takes the way is the app's own word", () => {
  const config = (cloudflare: unknown) =>
    authConfigOf(DOMAIN, { login: { methods: { cloudflare }, allow: [{ email: OWNER }] } });
  expect(config({ clientId: "id" })).toMatchObject({
    login: { methods: { cloudflare: { clientId: "id" } } },
  });
  // without the method, nothing of it exists
  expect(authConfigOf(DOMAIN, { login: { allow: [{ email: OWNER }] } })).toMatchObject({
    login: { methods: {} },
  });
  for (const wrong of [
    { clientId: "" },
    {},
    // the secret is the deploy's, never the config's
    { clientId: "id", clientSecret: "s" },
    // no deploy pins the hostnames: an app names the way in its own code
    { clientId: "id", hosts: ["cloud.example.com"] },
  ])
    expect(() => config(wrong)).toThrow();
});

test("without the config's method, or without the deploy's secret, the sign-in does not exist", async () => {
  for (const missing of [{ method: false }, { secret: null }]) {
    const { env } = stackOf(missing);
    for (const path of ["/sign-in/cloudflare", "/sign-in/cloudflare/callback?code=c&state=s"])
      expect(await cloudflareSignInResponse(env, new Request(ISSUER + path))).toMatchObject({
        status: 404,
      });
  }
  const { env } = stackOf();
  expect(await cloudflareSignInResponse(env, new Request(`${ISSUER}/sign-in`))).toBeNull();
  expect(
    await cloudflareSignInResponse(
      env,
      new Request(`${ISSUER}/sign-in/cloudflare`, { method: "POST" }),
    ),
  ).toMatchObject({ status: 404 });
});

test("the consent asks Cloudflare for the person's details alone, and the token is used once and revoked", async () => {
  const { env, people } = stackOf();
  const calls = cloudflareOf();
  const { consent, answer } = await signedInAtCloudflare(env, "https://evil.test/away");
  expect(consent.origin + consent.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
  expect(Object.fromEntries(consent.searchParams)).toMatchObject({
    response_type: "code",
    client_id: "the-client-id",
    redirect_uri: CALLBACK,
    scope: "user-details.read",
    code_challenge_method: "S256",
  });
  // one scope: nothing of an account, and no refresh token is asked for
  expect(CLOUDFLARE_SIGN_IN_SCOPE).toBe("user-details.read");
  expect(consent.searchParams.get("scope")).not.toMatch(/offline_access|write|account/);
  expect(consent.href).not.toContain("THE-CLIENT-SECRET");

  // `next` was another site's address: the person lands on this origin
  expect([answer.status, answer.headers.get("location")]).toEqual([303, "/"]);
  expect(calls.map((call) => call.url)).toEqual([
    "https://dash.cloudflare.com/oauth2/token",
    "https://api.cloudflare.com/client/v4/user",
    "https://dash.cloudflare.com/oauth2/revoke",
    "https://dash.cloudflare.com/oauth2/revoke",
  ]);
  expect(Object.fromEntries(calls[0]!.body)).toMatchObject({
    grant_type: "authorization_code",
    code: "THE-CODE",
    redirect_uri: CALLBACK,
    client_secret: "THE-CLIENT-SECRET",
  });
  expect(calls[0]!.body.get("code_verifier")).toEqual(expect.any(String));
  expect(calls[1]).toMatchObject({ authorization: "Bearer ACCESS-SECRET" });
  // the access token, and the refresh token that came unasked
  expect(calls.slice(2).map((call) => call.body.get("token"))).toEqual([
    "ACCESS-SECRET",
    "REFRESH-SECRET",
  ]);

  // the person is the Cloudflare user, and no token is in what the browser gets
  expect([...people]).toEqual([
    ["cloudflare:cf-user-1", { id: expect.stringMatching(/^user_/), email: "ada@example.org" }],
  ]);
  const cookies = answer.headers.getSetCookie().join("\n");
  expect(cookies).not.toMatch(/ACCESS-SECRET|REFRESH-SECRET/);
  // Cloudflare's cookie, and never the mind's session
  expect(cookies).toContain("__Host-iterate-auth-cloudflare-session=");
  expect(cookies).not.toContain("__Host-iterate-auth-session=");
  const cookie = cloudflareCookieOf(answer);
  expect(await cloudflareSessionOf(env, new Request(ISSUER, { headers: { cookie } }))).toEqual({
    userId: [...people.values()][0]!.id,
    email: "ada@example.org",
    method: "cloudflare",
  });
});

test("a callback that this browser did not begin here, or that Cloudflare does not stand behind, signs nobody in", async () => {
  const { env } = stackOf();
  const calls = cloudflareOf();
  const begun = await cloudflareSignInResponse(env, new Request(`${ISSUER}/sign-in/cloudflare`));
  const state = new URL(begun!.headers.get("location")!).searchParams.get("state")!;
  const cookie = cookiePair(begun!.headers.get("set-cookie")!);
  const finish = (query: string, headers: Record<string, string> = { cookie }) =>
    cloudflareSignInResponse(env, new Request(`${CALLBACK}?${query}`, { headers }));
  const refused = async (answer: Promise<Response | null>) => {
    const got = (await answer)!;
    expect(got.headers.getSetCookie().join()).not.toContain("cloudflare-session=ey");
    return got.status;
  };
  expect(await refused(finish(`code=c&state=${state}`, {}))).toBe(400); // another browser
  expect(await refused(finish("code=c&state=another"))).toBe(400);
  expect(await refused(finish(`state=${state}&error=access_denied`))).toBe(400);
  // a flow that began at Google's sign-in is not one of Cloudflare's
  const google = cookiePair(
    await flowCookie(env, { next: "/", state, nonce: crypto.randomUUID(), verifier: "v" }),
  );
  expect(await refused(finish(`code=c&state=${state}`, { cookie: google }))).toBe(400);
  expect(calls).toEqual([]);

  // Cloudflare refuses the read: nobody is signed in, and the tokens are revoked all the same
  const noUser = cloudflareOf(null);
  expect(await refused(finish(`code=c&state=${state}`))).toBe(502);
  expect(noUser.filter((call) => call.url.endsWith("/revoke"))).toHaveLength(2);
  cloudflareOf({ success: true, result: { id: "cf-user-2" } }); // no address
  expect(await refused(finish(`code=c&state=${state}`))).toBe(502);
});

test("the two cookies are two kinds of session: neither is read as the other, and Cloudflare's is never a member's", async () => {
  const { env } = stackOf();
  cloudflareOf({ success: true, result: { id: "cf-owner", email: OWNER } });
  const cloudflare = cloudflareCookieOf((await signedInAtCloudflare(env)).answer);
  const passkey = cookiePair(
    (
      await sessionCookie(
        env,
        new Request(ISSUER),
        { id: "user_owner", email: OWNER },
        "passkey",
        "key-1",
      )
    ).setCookie,
  );
  const at = (cookie: string) => new Request(ISSUER, { headers: { cookie } });
  // each under its own name
  expect(await sessionOf(env, at(cloudflare))).toBeNull();
  expect(await cloudflareSessionOf(env, at(passkey))).toBeNull();
  // each token's value under the other's name: the signature holds, the audience does not
  const swapped = (pair: string, name: string) => `${name}=${pair.slice(pair.indexOf("=") + 1)}`;
  expect(await sessionOf(env, at(swapped(cloudflare, "__Host-iterate-auth-session")))).toBeNull();
  expect(
    await cloudflareSessionOf(env, at(swapped(passkey, "__Host-iterate-auth-cloudflare-session"))),
  ).toBeNull();
  // the owner's address at Cloudflare is no member: Cloudflare vouches for no address here
  const session = (await cloudflareSessionOf(env, at(cloudflare)))!;
  expect(session).toMatchObject({ email: OWNER });
  expect(await standingOf(env, session)).toBe("not-member");
  expect(await standingOf(env, (await sessionOf(env, at(passkey)))!)).toBe("member");

  // signing out ends both
  const out = await signOutResponse(
    env,
    new Request(`${ISSUER}/sign-out`, {
      method: "POST",
      headers: { origin: ISSUER },
      body: new FormData(),
    }),
  );
  expect(out.headers.getSetCookie()).toEqual([
    expect.stringMatching(/^__Host-iterate-auth-session=; .*Max-Age=0/),
    expect.stringMatching(/^__Host-iterate-auth-cloudflare-session=; .*Max-Age=0/),
  ]);
});

test("an app that names Cloudflare gives a code to Cloudflare's session alone, and shows everyone else the page of its ways", async () => {
  const { env } = stackOf();
  cloudflareOf({ success: true, result: { id: "cf-owner", email: OWNER } });
  const cloudflare = cloudflareCookieOf((await signedInAtCloudflare(env)).answer);
  // the mind's own sessions: the owner's passkey, and a mailed code's
  const passkey = await passkeyCookie(env);
  const mailed = cookiePair(
    (
      await sessionCookie(
        env,
        new Request(ISSUER),
        { id: "user_2", email: "ada@example.org" },
        "email",
      )
    ).setCookie,
  );

  const cloud = await authorizationOf(env, CLOUD, { acr_values: "cloudflare" });
  for (const cookie of ["", passkey, mailed]) {
    const answer = await cloud.ask(cookie);
    expect([answer.status, pathOf(answer)]).toEqual([302, "/sign-in"]);
    // and it comes back to this same request, its ways and all
    expect(new URL(answer.headers.get("location")!).searchParams.get("next")).toMatch(
      /^\/oauth2\/auth\?.*acr_values=cloudflare/,
    );
  }
  // the page has the app's one way, and sends nobody on by itself
  const page = await authResponse(
    new Request(new URL((await cloud.ask(passkey)).headers.get("location")!)),
    env,
    ctx,
  );
  const html = await page.text();
  expect([page.status, html]).toEqual([200, expect.stringContaining("Sign in with Cloudflare")]);
  expect(html).toContain("<h1>Sign in to cloud.example.com</h1>");
  expect(html).not.toMatch(/passkey|code by email/);
  // `prompt` ends Cloudflare's session and shows the page again, so no "Continue as" signs the
  // person straight back in; a session the app does not take gets the page too
  for (const [prompt, cookie] of [
    ["login", cloudflare],
    ["select_account", cloudflare],
    ["select_account", passkey],
  ] as const) {
    const again = await (
      await authorizationOf(env, CLOUD, { acr_values: "cloudflare", prompt })
    ).ask(cookie);
    expect(pathOf(again)).toBe("/sign-in");
    if (cookie === cloudflare)
      expect(again.headers.get("set-cookie")).toMatch(/^__Host-iterate-auth-cloudflare-session=; /);
  }

  // Cloudflare's session gets the code, with the passkey's session beside it or not
  for (const cookie of [cloudflare, `${passkey}; ${cloudflare}`]) {
    const answer = await cloud.ask(cookie);
    expect([answer.status, pathOf(answer)]).toEqual([302, `${CLOUD}/.iterate/callback`]);
  }
  const fresh = await authorizationOf(env, CLOUD, { acr_values: "cloudflare" });
  const token = await fresh.tokenFor((await fresh.ask(cloudflare)).headers.get("location")!);
  // the owner's address, and still no member: an app on the host sees a person, never a member
  expect(await tokenIdentity(env, token, CLOUD)).toMatchObject({
    principal: { email: OWNER },
    member: false,
    method: "cloudflare",
  });
  // the token is for that hostname alone
  expect(await tokenIdentity(env, token, OTHER)).toBeNull();
  expect(await tokenIdentity(env, token, `${ISSUER}/api`)).toBeNull();
});

test("an app that names no way gets the mind's own sign-in, where Cloudflare's session counts for nothing", async () => {
  const { env } = stackOf();
  cloudflareOf({ success: true, result: { id: "cf-owner", email: OWNER } });
  const cloudflare = cloudflareCookieOf((await signedInAtCloudflare(env)).answer);
  const other = await authorizationOf(env, OTHER);
  // as if signed out: the mind's own sign-in, which mails a code here
  expect(pathOf(await other.ask(cloudflare))).toBe("/sign-in/email");
  const mailed = cookiePair(
    (
      await sessionCookie(
        env,
        new Request(ISSUER),
        { id: "user_2", email: "ada@example.org" },
        "email",
      )
    ).setCookie,
  );
  const answer = await other.ask(`${mailed}; ${cloudflare}`);
  expect(pathOf(answer)).toBe(`${OTHER}/.iterate/callback`);
  const token = await other.tokenFor(answer.headers.get("location")!);
  expect(await tokenIdentity(env, token, OTHER)).toMatchObject({ member: false, method: "email" });
  // after the host's sign-out (`prompt`), the chooser says the person is signed out of the app, and
  // a press signs them in again
  const chooser = await (
    await authorizationOf(env, OTHER, { prompt: "select_account" })
  ).ask(mailed);
  expect(await chooser.text()).toContain(
    `<p class="center">You are signed out of guestbook.${DOMAIN}. You are still signed in to ${DOMAIN} as <strong>ada@example.org</strong>.</p>`,
  );
  // and no request for the mind's own API reads Cloudflare's cookie, or the ways it names
  const api = await authResponse(
    new Request(
      `${ISSUER}/oauth2/auth?${new URLSearchParams({
        response_type: "code",
        client_id: await hostClientOf(env, `cloud.${DOMAIN}`),
        redirect_uri: hostCallbackOf(CLOUD),
        resource: `${ISSUER}/api`,
        scope: "iterate",
        state: "s",
        acr_values: "cloudflare",
        code_challenge: await calculatePKCECodeChallenge(generateRandomCodeVerifier()),
        code_challenge_method: "S256",
      })}`,
      { headers: { cookie: cloudflare } },
    ),
    env,
    ctx,
  );
  expect(pathOf(api)).toBe("/sign-in/email");
});

test("the mailed code's page of an app that names its ways offers none of the others", async () => {
  const { env } = stackOf();
  const pageFor = async (ways: Record<string, string>) => {
    const next = `/oauth2/auth?${new URLSearchParams({ resource: CLOUD, ...ways })}`;
    const url = `${ISSUER}/sign-in/email?${new URLSearchParams({ next })}`;
    return (await authResponse(new Request(url), env, ctx)).text();
  };
  expect(await pageFor({})).toContain('id="passkey"');
  const email = await pageFor({ acr_values: "email" });
  expect(email).toContain('action="/sign-in/email"');
  expect(email).not.toContain('id="passkey"');
});

test("what a browser changes in the ways ends at the app's guard: every grant says the way it began by", async () => {
  const { env } = stackOf();
  const passkey = await passkeyCookie(env);
  const mailed = cookiePair(
    (
      await sessionCookie(
        env,
        new Request(ISSUER),
        { id: "user_2", email: "ada@example.org" },
        "email",
      )
    ).setCookie,
  );
  // ingress asked for Cloudflare; the browser took the ways out, or put another in their place
  for (const [extra, cookie, method] of [
    [{}, passkey, "passkey"],
    [{ acr_values: "email" }, mailed, "email"],
  ] as const) {
    const changed = await authorizationOf(env, CLOUD, extra);
    const token = await changed.tokenFor((await changed.ask(cookie)).headers.get("location")!);
    // a guard that names Cloudflare refuses this person (iterate/sdk `auth.requirePerson`)
    expect(await tokenIdentity(env, token, CLOUD)).toMatchObject({ method });
  }
  // ways this stack does not offer let nobody in: Google needs a Cloud, and a made-up way is none
  for (const acr_values of ["google", "carrier-pigeon"]) {
    const answer = await (await authorizationOf(env, CLOUD, { acr_values })).ask(passkey);
    expect([answer.status, answer.headers.get("location")]).toEqual([503, null]);
    // and their sign-in page says so, where a redirect would go round
    const next = `/oauth2/auth?${new URLSearchParams({ resource: CLOUD, acr_values })}`;
    const page = await authResponse(
      new Request(`${ISSUER}/sign-in?${new URLSearchParams({ next })}`),
      env,
      ctx,
    );
    expect([page.status, page.headers.get("location")]).toEqual([503, null]);
  }
});

test("a grant from before grants kept their way says none, which no app that names its ways takes", async () => {
  const { env } = stackOf();
  const old = await authorizationOf(env, CLOUD);
  const { redirectTo } = await oauthHelpers(env, CLOUD).completeAuthorization({
    request: await old.request(),
    userId: "user_owner",
    metadata: { clientName: "cloud" },
    scope: ["identity"],
    revokeExistingGrants: false,
    props: { userId: "user_owner", email: OWNER },
  });
  const identity = await tokenIdentity(env, await old.tokenFor(redirectTo), CLOUD);
  expect(identity).toMatchObject({ principal: { email: OWNER }, method: undefined });
});

test("an MCP client of an app that names Cloudflare, which says the ways on (RFC 9470), signs in there through the consent page", async () => {
  const { env } = stackOf();
  cloudflareOf({ success: true, result: { id: "cf-owner", email: OWNER } });
  const cloudflare = cloudflareCookieOf((await signedInAtCloudflare(env)).answer);
  const passkey = await passkeyCookie(env);
  const clientId = await registeredClientOf(env);
  const verifier = generateRandomCodeVerifier();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:7777/callback",
    resource: `${CLOUD}/mcp`,
    scope: "identity",
    state: "s",
    acr_values: "cloudflare",
    code_challenge: await calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
  });
  const ask = (cookie: string) =>
    authResponse(new Request(`${ISSUER}/oauth2/auth?${query}`, { headers: { cookie } }), env, ctx);
  // no session, and a member's passkey session: the page of the app's ways, with no consent page
  for (const cookie of ["", passkey]) expect(pathOf(await ask(cookie))).toBe("/sign-in");

  // Cloudflare's session gets the consent page, as that person
  const page = await ask(cloudflare);
  const html = await page.text();
  expect(page).toMatchObject({ status: 200 });
  expect(html).toContain(OWNER);
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  const consentCookies = page.headers.getSetCookie().map(cookiePair).join("; ");
  const approved = await decided(env, handle, [cloudflare, consentCookies].join("; "));
  const location = new URL(approved.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("http://127.0.0.1:7777/callback");
  const exchanged = await authResponse(
    new Request(`${ISSUER}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: location.searchParams.get("code")!,
        redirect_uri: "http://127.0.0.1:7777/callback",
        client_id: clientId,
        code_verifier: verifier,
        resource: `${CLOUD}/mcp`,
      }),
    }),
    env,
    ctx,
  );
  const tokens = z
    .object({ access_token: z.string(), refresh_token: z.string() })
    .parse(await exchanged.json());
  // the bearer of the app's /mcp: a person on that hostname who began at Cloudflare, no member,
  // and nobody anywhere else
  expect(await whoIs(env, tokens.access_token, CLOUD)).toMatchObject({
    principal: { email: OWNER },
    member: false,
    method: "cloudflare",
  });
  expect(await whoIs(env, tokens.access_token, `${ISSUER}/mcp`)).toBeNull();
  expect(await whoIs(env, tokens.access_token, `${ISSUER}/api`)).toBeNull();
  // an async client keeps its sign-in by refresh, and the refreshed token says the same way
  const refreshed = await authResponse(
    new Request(`${ISSUER}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
        resource: `${CLOUD}/mcp`,
      }),
    }),
    env,
    ctx,
  );
  const again = z.object({ access_token: z.string() }).parse(await refreshed.json());
  expect(await whoIs(env, again.access_token, CLOUD)).toMatchObject({
    member: false,
    method: "cloudflare",
  });
});

test("a consent begun for Cloudflare's session is not approved by the mind's own session", async () => {
  const { env } = stackOf();
  cloudflareOf();
  const cloudflare = cloudflareCookieOf((await signedInAtCloudflare(env)).answer);
  const passkey = await passkeyCookie(env);
  const page = await authResponse(
    new Request(
      `${ISSUER}/oauth2/auth?${new URLSearchParams({
        response_type: "code",
        client_id: await registeredClientOf(env),
        redirect_uri: "http://127.0.0.1:7777/callback",
        resource: CLOUD,
        scope: "identity",
        state: "s",
        acr_values: "cloudflare",
        code_challenge: await calculatePKCECodeChallenge(generateRandomCodeVerifier()),
        code_challenge_method: "S256",
      })}`,
      { headers: { cookie: cloudflare } },
    ),
    env,
    ctx,
  );
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1]!;
  // the form posted by a browser that holds the consent's cookie and the owner's passkey session,
  // and no session of Cloudflare's: the consent kept the ways it began with
  const answer = await decided(
    env,
    handle,
    [passkey, ...page.headers.getSetCookie().map(cookiePair)].join("; "),
  );
  expect(answer).toMatchObject({ status: 401 });
  expect(answer.headers.get("location")).toBeNull();
});

test("a deploy that takes the way away, or loses its secret, ends Cloudflare's grants", async () => {
  const before = stackOf();
  cloudflareOf();
  const cloudflare = cloudflareCookieOf((await signedInAtCloudflare(before.env)).answer);
  const cloud = await authorizationOf(before.env, CLOUD, { acr_values: "cloudflare" });
  const token = await cloud.tokenFor((await cloud.ask(cloudflare)).headers.get("location")!);
  expect(await tokenIdentity(before.env, token, CLOUD)).toMatchObject({ method: "cloudflare" });
  // the same store, deployed without the method, or with its secret gone
  for (const change of [{ method: false }, { secret: null }]) {
    const { env } = stackOf({ ...change, kv: before.kv, people: before.people });
    expect(await tokenIdentity(env, token, CLOUD)).toBeNull();
  }
});

test("an app that takes Cloudflare alone, on a stack whose secret is missing, lets nobody in", async () => {
  const { env } = stackOf({ secret: null });
  const answer = await (
    await authorizationOf(env, CLOUD, { acr_values: "cloudflare" })
  ).ask(await passkeyCookie(env));
  expect(answer).toMatchObject({ status: 503 });
  expect(answer.headers.get("location")).toBeNull();
  // the ways are an app's word for its own host: with Cloudflare among others, the others count
  const either = await authorizationOf(env, CLOUD, { acr_values: "cloudflare passkey" });
  expect(pathOf(await either.ask(await passkeyCookie(env)))).toBe(`${CLOUD}/.iterate/callback`);
});

/** A stack in memory: the OAuth library's store, and the few rows the sign-in reads. `people`
 *  holds each Cloudflare user id this stack linked. */
function stackOf({
  method = true,
  secret = "THE-CLIENT-SECRET",
  kv = new Map<string, string>(),
  people = new Map<string, { id: string; email: string }>(),
  // the passkey "key-1" is live
  sessions = browserSessionsFake((key) => key === "key-1"),
}: {
  /** false: a config with no such method */
  method?: boolean;
  /** null: a stack whose deploy bound no secret */
  secret?: string | null;
  kv?: Map<string, string>;
  people?: Map<string, { id: string; email: string }>;
  sessions?: ReturnType<typeof browserSessionsFake>;
} = {}) {
  const prepare = (sql: string) => {
    const statement = {
      sql,
      bound: [] as unknown[],
      bind: (...values: unknown[]) => {
        statement.bound = values;
        return statement;
      },
      // the passkey "key-1" is live; nobody is blocked, and nobody was added as a member
      first: async () =>
        sessions.statementOf(sql, statement.bound)?.first() ??
        (sql.includes("from keys") && statement.bound[0] === "key-1" ? {} : null),
      all: async () => sessions.statementOf(sql, statement.bound)?.all() ?? { results: [] },
      run: async () =>
        sessions.statementOf(sql, statement.bound)?.run() ?? { meta: { changes: 0 } },
    };
    return statement;
  };
  const env = {
    DOMAIN,
    AUTH_SIGNING_KEY: "a-signing-key-for-tests-only",
    AUTH_SETTINGS: JSON.stringify({
      login: {
        // the mind mails codes too, so its own sign-in is not the page of an app's ways
        methods: { email: {}, ...(method && { cloudflare: { clientId: "the-client-id" } }) },
        allow: [{ email: OWNER }],
      },
    }),
    CLOUDFLARE_SIGN_IN_CLIENT_SECRET: secret || undefined,
    OAUTH_KV: {
      get: async (name: string, options?: unknown) => {
        const value = kv.get(name) ?? null;
        const json = options === "json" || (options as { type?: string })?.type === "json";
        return value && json ? JSON.parse(value) : value;
      },
      put: async (name: string, value: string) => void kv.set(name, value),
      delete: async (name: string) => void kv.delete(name),
      list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
        keys: [...kv.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
    },
    DB: {
      prepare,
      batch: async (statements: ReturnType<typeof prepare>[]) => {
        // ./cookies.ts `sessionCookie`
        if (statements[0]!.sql.includes("browser_sessions"))
          return statements.map((statement) =>
            sessions.statementOf(statement.sql, statement.bound)!.results(),
          );
        // ./users.ts `linkIdentity`: the person of (provider, subject), made at the first sign-in
        if (statements[0]!.sql.includes("insert into users")) {
          const [id, email, provider, subject] = statements[0]!.bound as string[];
          const key = `${provider}:${subject}`;
          if (!people.has(key)) people.set(key, { id: id!, email: email! });
          return [{}, {}, { results: [people.get(key)] }];
        }
        // ./device/limits.ts `admitted`: a new host client is let through
        return [{}, { results: [{ admitted: 1 }] }];
      },
    },
  } as unknown as Env;
  return { env, kv, people, sessions };
}

function cookiePair(setCookie: string) {
  return setCookie.split(";")[0]!;
}

/** Cloudflare, as three addresses: the code's exchange, `/user`, and the revoke. `calls` keeps
 *  what each was sent. */
function cloudflareOf(
  user: unknown = { success: true, result: { id: "cf-user-1", email: "Ada@Example.org" } },
) {
  const calls: { url: string; body: URLSearchParams; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    // the app's own word for its name (./asking-app.ts), for the sign-in pages
    if (url === `${CLOUD}/manifest.webmanifest`) return Response.json({ name: "Cloud" });
    calls.push({
      url,
      body: new URLSearchParams(String(init.body || "")),
      authorization: new Headers(init.headers).get("authorization"),
    });
    // never followed: the client's secret and the tokens go to Cloudflare's own hosts alone
    expect(init).toMatchObject({ redirect: "manual" });
    if (url === "https://dash.cloudflare.com/oauth2/token")
      return Response.json({ access_token: "ACCESS-SECRET", refresh_token: "REFRESH-SECRET" });
    if (url === "https://api.cloudflare.com/client/v4/user")
      return user ? Response.json(user) : new Response("no", { status: 403 });
    if (url === "https://dash.cloudflare.com/oauth2/revoke") return new Response(null);
    throw new Error(`not Cloudflare's address: ${url}`);
  });
  return calls;
}

/** One whole sign-in at Cloudflare for this browser. Answers the callback's answer. */
async function signedInAtCloudflare(env: Env, next = "/after") {
  const begun = await cloudflareSignInResponse(
    env,
    new Request(`${ISSUER}/sign-in/cloudflare?${new URLSearchParams({ next })}`),
  );
  const consent = new URL(begun!.headers.get("location")!);
  const answer = await cloudflareSignInResponse(
    env,
    new Request(`${CALLBACK}?code=THE-CODE&state=${consent.searchParams.get("state")}`, {
      headers: { cookie: cookiePair(begun!.headers.get("set-cookie")!) },
    }),
  );
  return { consent, answer: answer! };
}
function cloudflareCookieOf(answer: Response) {
  return cookiePair(
    answer.headers.getSetCookie().find((each) => each.includes("cloudflare-session="))!,
  );
}

/** The authorization request of `resource`'s own host client, as the boundary sends a visitor. */
async function authorizationOf(env: Env, resource: string, extra: Record<string, string> = {}) {
  const verifier = generateRandomCodeVerifier();
  const clientId = await hostClientOf(env, new URL(resource).host);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: hostCallbackOf(resource),
    resource,
    scope: "identity",
    state: "s",
    code_challenge: await calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    ...extra,
  });
  /** The access token for the code in `location`, as the boundary's callback gets it. */
  const tokenFor = async (location: string) => {
    const answer = await tokenEndpointResponse(
      env,
      new Request(`${ISSUER}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: new URL(location).searchParams.get("code")!,
          redirect_uri: hostCallbackOf(resource),
          client_id: clientId,
          code_verifier: verifier,
          resource,
        }),
      }),
      ctx,
    );
    return z.object({ access_token: z.string() }).parse(await answer.json()).access_token;
  };
  return {
    ask: (cookie = "") =>
      authorizeResponse(
        env,
        new Request(`${ISSUER}/oauth2/auth?${query}`, { headers: { cookie } }),
      ),
    tokenFor,
    /** The request as the OAuth library parses it, for a grant made by hand. */
    request: () =>
      oauthHelpers(env, resource).parseAuthRequest(new Request(`${ISSUER}/oauth2/auth?${query}`)),
  };
}
function pathOf(answer: Response) {
  const url = new URL(answer.headers.get("location")!);
  return url.origin === ISSUER ? url.pathname : url.origin + url.pathname;
}

async function passkeyCookie(env: Env) {
  return cookiePair(
    (
      await sessionCookie(
        env,
        new Request(ISSUER),
        { id: "user_owner", email: OWNER },
        "passkey",
        "key-1",
      )
    ).setCookie,
  );
}

/** An MCP client that registers itself, as any MCP client does. Answers its id. */
async function registeredClientOf(env: Env) {
  const registered = await authResponse(
    new Request(`${ISSUER}/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "An MCP client",
        redirect_uris: ["http://127.0.0.1:7777/callback"],
        token_endpoint_auth_method: "none",
      }),
    }),
    env,
    ctx,
  );
  return z.object({ client_id: z.string() }).parse(await registered.json()).client_id;
}

/** The consent page's form, allowed, from a browser that sends `cookie`. */
function decided(env: Env, handle: string, cookie: string) {
  return authResponse(
    new Request(`${ISSUER}/oauth2/auth`, {
      method: "POST",
      headers: {
        origin: ISSUER,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ handle, decision: "allow" }),
    }),
    env,
    ctx,
  );
}
