// SIGN IN WITH CLOUDFLARE (./cloudflare-sign-in.ts), and the rule it comes with: a hostname the
// deploy names takes Cloudflare's sign-in alone, and that sign-in serves nothing else. The tests
// go through the Worker's own endpoints (the OAuth library included) against a store in memory;
// Cloudflare is a stubbed `fetch`.
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { authorizeResponse } from "./authorize.ts";
import { authResponse } from "./http.ts";
import { whoIs } from "./who-is.ts";
import { CLOUDFLARE_SIGN_IN_SCOPE, cloudflareSignInResponse } from "./cloudflare-sign-in.ts";
import { authConfigOf } from "./config.ts";
import { cloudflareSessionOf, flowCookie, sessionCookie, sessionOf } from "./cookies.ts";
import { cloudflareAloneAt, type Env, signInServes } from "./env.ts";
import { standingOf } from "./members.ts";
import { hostCallbackOf, hostClientOf, tokenEndpointResponse, tokenIdentity } from "./oauth.ts";
import { signOutResponse } from "./sign-in.ts";

const DOMAIN = "example.com";
const ISSUER = `https://iterate.${DOMAIN}`;
const CLOUD = `https://cloud.${DOMAIN}`;
const OTHER = `https://guestbook.${DOMAIN}`;
const OWNER = "owner@elsewhere.test";
const CALLBACK = `${ISSUER}/sign-in/cloudflare/callback`;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

test("the config names the client and its hostnames, each a hostname of the mind that an app can have", () => {
  const config = (cloudflare: unknown) =>
    authConfigOf(DOMAIN, { login: { methods: { cloudflare }, allow: [{ email: OWNER }] } });
  expect(config({ clientId: "id", hosts: ["cloud.example.com", "example.com"] })).toMatchObject({
    login: {
      methods: { cloudflare: { clientId: "id", hosts: ["cloud.example.com", "example.com"] } },
    },
  });
  // without the method, nothing of it exists
  expect(authConfigOf(DOMAIN, { login: { allow: [{ email: OWNER }] } })).toMatchObject({
    login: { methods: {} },
  });
  for (const wrong of [
    { clientId: "id", hosts: [] },
    { clientId: "", hosts: ["cloud.example.com"] },
    { hosts: ["cloud.example.com"] },
    // the secret is the deploy's, never the config's
    { clientId: "id", clientSecret: "s", hosts: ["cloud.example.com"] },
    { clientId: "id", hosts: ["cloud.elsewhere.test"] },
    { clientId: "id", hosts: ["notexample.com"] },
    // the platform's own hostname, where members sign in
    { clientId: "id", hosts: ["iterate.example.com"] },
    { clientId: "id", hosts: ["https://cloud.example.com"] },
  ])
    expect(() => config(wrong)).toThrow();
});

test("which sign-in serves which resource is the stored config's list alone", () => {
  const { env } = stackOf();
  expect(cloudflareAloneAt(env, CLOUD)).toBe(true);
  for (const resource of [
    OTHER,
    `${ISSUER}/api`,
    `${ISSUER}/mcp`,
    `https://cloud.${DOMAIN}.evil.test`,
    "",
    null,
    "cloud",
  ])
    expect(cloudflareAloneAt(env, resource)).toBe(false);
  // Cloudflare's sign-in serves the named hostname and nothing else; every other, the reverse
  expect([signInServes(env, true, CLOUD), signInServes(env, false, CLOUD)]).toEqual([true, false]);
  expect([signInServes(env, true, OTHER), signInServes(env, false, OTHER)]).toEqual([false, true]);
  expect(signInServes(env, true, `${ISSUER}/api`)).toBe(false);
  // with no such method, nothing changes for anybody, and a Cloudflare grant serves nothing
  const none = stackOf({ hosts: null }).env;
  expect([signInServes(none, false, CLOUD), signInServes(none, true, CLOUD)]).toEqual([
    true,
    false,
  ]);
});

test("without the config's method, or without the deploy's secret, the sign-in does not exist", async () => {
  for (const missing of [{ hosts: null }, { secret: null }]) {
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
    await sessionCookie(env, { id: "user_owner", email: OWNER }, "passkey", "key-1"),
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

test("a hostname that takes Cloudflare alone gives a code to Cloudflare's session, and sends every other session to Cloudflare", async () => {
  const { env } = stackOf();
  cloudflareOf({ success: true, result: { id: "cf-owner", email: OWNER } });
  const cloudflare = cloudflareCookieOf((await signedInAtCloudflare(env)).answer);
  // the mind's own sessions: the owner's passkey, and a mailed code's
  const passkey = cookiePair(
    await sessionCookie(env, { id: "user_owner", email: OWNER }, "passkey", "key-1"),
  );
  const mailed = cookiePair(
    await sessionCookie(env, { id: "user_2", email: "ada@example.org" }, "email"),
  );

  const cloud = await authorizationOf(env, CLOUD);
  for (const cookie of ["", passkey, mailed]) {
    const answer = await cloud.ask(cookie);
    expect([answer.status, pathOf(answer)]).toEqual([302, "/sign-in/cloudflare"]);
    // and it comes back to this same request
    expect(new URL(answer.headers.get("location")!).searchParams.get("next")).toMatch(
      /^\/oauth2\/auth\?/,
    );
  }
  // nothing a request says names a sign-in: the same answers with every parameter one could try
  const tampered = await authorizationOf(env, CLOUD, {
    method: "passkey",
    provider: "google",
    login_hint: OWNER,
    cloudflare: "false",
  });
  expect(pathOf(await tampered.ask(passkey))).toBe("/sign-in/cloudflare");
  // `prompt` asks Cloudflare again, and never shows the mind's sign-in page
  for (const prompt of ["login", "select_account"]) {
    const again = await (await authorizationOf(env, CLOUD, { prompt })).ask(cloudflare);
    expect(pathOf(again)).toBe("/sign-in/cloudflare");
    expect(again.headers.get("set-cookie")).toMatch(/^__Host-iterate-auth-cloudflare-session=; /);
  }

  // Cloudflare's session gets the code, with the passkey's session beside it or not
  for (const cookie of [cloudflare, `${passkey}; ${cloudflare}`]) {
    const answer = await cloud.ask(cookie);
    expect([answer.status, pathOf(answer)]).toEqual([302, `${CLOUD}/.iterate/callback`]);
  }
  const fresh = await authorizationOf(env, CLOUD);
  const token = await fresh.tokenFor((await fresh.ask(cloudflare)).headers.get("location")!);
  // the owner's address, and still no member: an app on the host sees a person, never a member
  expect(await tokenIdentity(env, token, CLOUD)).toMatchObject({
    principal: { email: OWNER },
    member: false,
  });
  // the token is for that hostname alone
  expect(await tokenIdentity(env, token, OTHER)).toBeNull();
  expect(await tokenIdentity(env, token, `${ISSUER}/api`)).toBeNull();
});

test("Cloudflare's session serves no other hostname, and the mind's API not at all", async () => {
  const { env } = stackOf();
  cloudflareOf({ success: true, result: { id: "cf-owner", email: OWNER } });
  const cloudflare = cloudflareCookieOf((await signedInAtCloudflare(env)).answer);
  const other = await authorizationOf(env, OTHER);
  // as if signed out: the mind's own sign-in page
  expect(pathOf(await other.ask(cloudflare))).toBe("/sign-in");
  // and the hostname's own sign-ins work as before
  const mailed = cookiePair(
    await sessionCookie(env, { id: "user_2", email: "ada@example.org" }, "email"),
  );
  const answer = await other.ask(mailed);
  expect(pathOf(answer)).toBe(`${OTHER}/.iterate/callback`);
  const token = await other.tokenFor(answer.headers.get("location")!);
  expect(await tokenIdentity(env, token, OTHER)).toMatchObject({ member: false });
});

test("an MCP client of the app on such a hostname is held to the same sign-in, through the consent page", async () => {
  const { env } = stackOf();
  cloudflareOf({ success: true, result: { id: "cf-owner", email: OWNER } });
  const cloudflare = cloudflareCookieOf((await signedInAtCloudflare(env)).answer);
  const passkey = cookiePair(
    await sessionCookie(env, { id: "user_owner", email: OWNER }, "passkey", "key-1"),
  );
  // the client registers itself, as any MCP client does, and names its server's URL as the resource
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
  const { client_id: clientId } = z
    .object({ client_id: z.string() })
    .parse(await registered.json());
  const verifier = generateRandomCodeVerifier();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:7777/callback",
    resource: `${CLOUD}/mcp`,
    scope: "identity",
    state: "s",
    code_challenge: await calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
  });
  const ask = (cookie: string) =>
    authResponse(new Request(`${ISSUER}/oauth2/auth?${query}`, { headers: { cookie } }), env, ctx);
  // no session, and a member's passkey session: to Cloudflare, with no consent page
  for (const cookie of ["", passkey]) expect(pathOf(await ask(cookie))).toBe("/sign-in/cloudflare");

  // Cloudflare's session gets the consent page, as that person
  const page = await ask(cloudflare);
  const html = await page.text();
  expect(page).toMatchObject({ status: 200 });
  expect(html).toContain(OWNER);
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  const consentCookies = page.headers.getSetCookie().map(cookiePair).join("; ");
  const decide = (cookie: string) =>
    authResponse(
      new Request(`${ISSUER}/oauth2/auth`, {
        method: "POST",
        headers: {
          origin: ISSUER,
          cookie: [cookie, consentCookies].filter(Boolean).join("; "),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ handle, decision: "allow" }),
      }),
      env,
      ctx,
    );
  const approved = await decide(cloudflare);
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
  // the bearer of the app's /mcp: a person on that hostname, no member, and nobody anywhere else
  expect(await whoIs(env, tokens.access_token, CLOUD)).toMatchObject({
    principal: { email: OWNER },
    member: false,
  });
  expect(await whoIs(env, tokens.access_token, `${ISSUER}/mcp`)).toBeNull();
  expect(await whoIs(env, tokens.access_token, `${ISSUER}/api`)).toBeNull();
  // an async client keeps its sign-in by refresh, and the refreshed token is held to the same rule
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
  expect(await whoIs(env, again.access_token, CLOUD)).toMatchObject({ member: false });
});

test("a consent for such a hostname is not approved by the mind's own session", async () => {
  const { env } = stackOf();
  cloudflareOf();
  const cloudflare = cloudflareCookieOf((await signedInAtCloudflare(env)).answer);
  const passkey = cookiePair(
    await sessionCookie(env, { id: "user_owner", email: OWNER }, "passkey", "key-1"),
  );
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
  const { client_id: clientId } = z
    .object({ client_id: z.string() })
    .parse(await registered.json());
  const page = await authResponse(
    new Request(
      `${ISSUER}/oauth2/auth?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:7777/callback",
        resource: CLOUD,
        scope: "identity",
        state: "s",
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
  // and no session of Cloudflare's
  const answer = await authResponse(
    new Request(`${ISSUER}/oauth2/auth`, {
      method: "POST",
      headers: {
        origin: ISSUER,
        cookie: [passkey, ...page.headers.getSetCookie().map(cookiePair)].join("; "),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ handle, decision: "allow" }),
    }),
    env,
    ctx,
  );
  expect(answer).toMatchObject({ status: 401 });
  expect(answer.headers.get("location")).toBeNull();
});

test("a deploy that names a hostname ends the tokens it gave before, and one that stops naming it ends Cloudflare's", async () => {
  const before = stackOf({ hosts: null });
  const passkey = cookiePair(
    await sessionCookie(before.env, { id: "user_owner", email: OWNER }, "passkey", "key-1"),
  );
  const open = await authorizationOf(before.env, CLOUD);
  const old = await open.tokenFor((await open.ask(passkey)).headers.get("location")!);
  expect(await tokenIdentity(before.env, old, CLOUD)).toMatchObject({ member: true });
  // the same store, deployed with the hostname named
  const named = stackOf({ kv: before.kv, people: before.people }).env;
  expect(await tokenIdentity(named, old, CLOUD)).toBeNull();

  cloudflareOf();
  const cloudflare = cloudflareCookieOf((await signedInAtCloudflare(named)).answer);
  const closed = await authorizationOf(named, CLOUD);
  const token = await closed.tokenFor((await closed.ask(cloudflare)).headers.get("location")!);
  expect(await tokenIdentity(named, token, CLOUD)).toMatchObject({ member: false });
  // deployed without the name again: Cloudflare's token opens nothing
  expect(await tokenIdentity(before.env, token, CLOUD)).toBeNull();
});

test("a named hostname whose secret is missing lets nobody in: the config still names it", async () => {
  const { env } = stackOf({ secret: null });
  expect(cloudflareAloneAt(env, CLOUD)).toBe(true);
  const passkey = cookiePair(
    await sessionCookie(env, { id: "user_owner", email: OWNER }, "passkey", "key-1"),
  );
  const answer = await (await authorizationOf(env, CLOUD)).ask(passkey);
  expect(answer).toMatchObject({ status: 503 });
  expect(answer.headers.get("location")).toBeNull();
});

/** A stack in memory: the OAuth library's store, and the few rows the sign-in reads. `people`
 *  holds each Cloudflare user id this stack linked. */
function stackOf({
  hosts = [`cloud.${DOMAIN}`],
  secret = "THE-CLIENT-SECRET",
  kv = new Map<string, string>(),
  people = new Map<string, { id: string; email: string }>(),
}: {
  /** null: a config with no such method */
  hosts?: string[] | null;
  /** null: a stack whose deploy bound no secret */
  secret?: string | null;
  kv?: Map<string, string>;
  people?: Map<string, { id: string; email: string }>;
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
      first: async () => (sql.includes("from keys") && statement.bound[0] === "key-1" ? {} : null),
      run: async () => ({ meta: { changes: 0 } }),
    };
    return statement;
  };
  const env = {
    DOMAIN,
    AUTH_SIGNING_KEY: "a-signing-key-for-tests-only",
    AUTH_SETTINGS: JSON.stringify({
      login: {
        methods: hosts ? { cloudflare: { clientId: "the-client-id", hosts } } : {},
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
  return { env, kv, people };
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
  };
}
function pathOf(answer: Response) {
  const url = new URL(answer.headers.get("location")!);
  return url.origin === ISSUER ? url.pathname : url.origin + url.pathname;
}
