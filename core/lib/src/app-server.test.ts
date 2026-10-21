// app-server.test.ts — the browser-auth gate's `/.auth/login` with a session the platform still
// honours: through to `next` when the sign-in covers what the page asked for, else the "Sign in
// again" page (`signInAgainPage` in app-server.ts says what it offers). Here `resource` is an
// offline loopback, so the page's best-effort "signed in as / reaches" lines are absent, and the
// permissions line, from the held scopes, is what these tests assert.
import { expect, test } from "vitest";
import { appAuth } from "./app-server.ts";
import type { BrowserSession } from "./app-session.ts";
import { plainPageCss, plainPageCssHash } from "./theme/plain-page-css.gen.ts";

const ISSUER = "https://os.example";
const CONNECTED = "https://iterate.someorg.example";

// ── /.auth/login with a session the platform honours ──
test("covers what the page asked for → straight to next", async () => {
  const response = await login("/.auth/login?next=%2Fprojects%2Facme&scope=iterate", ["iterate"]);
  expect(response?.status).toBe(303);
  expect(response?.headers.get("location")).toBe("/projects/acme");
});

test.for([
  {
    name: "a project the page named",
    path: "/.auth/login?next=%2Fprojects%2Facme&scope=iterate&project=acme",
    says: "does not include a project called <code>acme</code>",
    // without `project`: the page this login returns to judges the fresh sign-in
    returnsTo: "/.auth/login?next=%2Fprojects%2Facme&scope=iterate",
    // the app's home, not the page that asked for the project
    onward: "/",
  },
  {
    name: "a permission the app asks for",
    path: "/.auth/login?next=%2Fsettings&scope=iterate%20account",
    says: "does not include a permission this app asks for",
    returnsTo: "/.auth/login?next=%2Fsettings&scope=iterate+account",
    // where the login was going, which the app serves without the permission
    onward: "/settings",
  },
])("$name → the Sign in again page", async ({ path, says, returnsTo, onward }) => {
  const response = await login(path, ["iterate"]);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  const html = await response!.text();
  expect(html).toContain("<h1>Sign in again</h1>");
  expect(html).toContain(`Your sign-in to <strong>notes.example</strong> ${says}.`);
  // the grant it holds, in the person's words — network-free, from the held scopes
  expect(html).toContain("Permissions: your projects.");
  // Sign in again ends this app's session and comes back to this login
  expect(html).toContain(
    `action="/.auth/logout?next=${encodeURIComponent(returnsTo)}"><button type="submit">Sign in again</button>`,
  );
  // Switch account does too, and that login asks the issuer who to sign in as
  expect(html).toContain(
    `action="/.auth/logout?next=${encodeURIComponent(`${returnsTo}&prompt=select_account`)}"><button class="link" type="submit">Switch account</button>`,
  );
  expect(html).toContain(`<a href="${onward}">Continue without it</a>`);
  // the stylesheet and the CSP that `gatePage` describes
  expect(html).toContain(`<style>${plainPageCss}</style>`);
  expect(response?.headers.get("content-security-policy")).toBe(
    `default-src 'none'; style-src ${plainPageCssHash}; img-src ${ISSUER}; form-action 'self' ${ISSUER}; frame-ancestors 'none'`,
  );
});

test("on the issuer's own origin Sign in again already asks who to sign in as, so there is no Switch account", async () => {
  const sessions = {
    getByName: () => ({
      bearer: async () => "token",
      scopes: async () => ["iterate"],
      host: async () => ({ issuer: ISSUER, resource: "http://127.0.0.1:1/api" }),
    }),
  } as unknown as DurableObjectNamespace<BrowserSession>;
  const response = await appAuth(
    new Request(`${ISSUER}/.auth/login?next=%2Fprojects%2Facme%2Fnotes%2F&project=acme`, {
      headers: { cookie: "__Host-itx-session=00000000-0000-4000-8000-000000000001" },
    }),
    {
      sessions,
      issuer: ISSUER,
      resource: "http://127.0.0.1:1/api",
      api: () => new Response(""),
      loginPage: "/login",
    },
  );
  const html = await response!.text();
  expect(html).toContain("Signing in again asks who to sign in as.");
  expect(html).toContain('<button type="submit">Sign in again</button>');
  expect(html).not.toContain("Switch account");
  expect(html).toContain('<a href="/">Continue without it</a>');
});

test("the permissions line names every held scope", async () => {
  const response = await login("/.auth/login?next=%2F&project=acme", [
    "iterate",
    "account",
    "organizations:write",
  ]);
  const html = await response!.text();
  expect(html).toContain("Permissions: your projects, your account, your organizations.");
});

test("the project the page named is text, never markup", async () => {
  const response = await login(`/.auth/login?next=%2F&project=${encodeURIComponent("<b>x</b>")}`, [
    "iterate",
  ]);
  const html = await response!.text();
  expect(html).not.toContain("<b>x</b>");
  expect(html).toContain("&#60;b&#62;x&#60;/b&#62;");
});

// ── a browser CONNECTED to another issuer stays there ──
test("an expired grant signs in again AT THE CONNECTED ISSUER, not the deployment's own", async () => {
  const { response, calls } = connected("/.auth/login?next=%2Fprojects%2Facme&scope=iterate");
  const answer = await response;
  expect(answer?.status).toBe(302);
  expect(answer?.headers.get("location")).toBe(`${CONNECTED}/oauth2/auth?state=x`);
  expect(calls).toEqual(["discard", `begin ${CONNECTED}`]);
});

test("a sign-out from a connected issuer returns through that issuer's connect page, the scopes the login asked for kept", async () => {
  // the Sign-in-again form's `next` is the login URL that showed it, scopes and all
  const loginUrl =
    "/.auth/login?next=%2Fprojects%2Facme&scope=iterate+account+organizations%3Awrite";
  const { response, calls } = connected(`/.auth/logout?next=${encodeURIComponent(loginUrl)}`, {
    method: "POST",
    headers: { origin: "https://notes.example" },
  });
  const answer = await response;
  expect(answer?.status).toBe(303);
  expect(answer?.headers.get("location")).toBe(
    `/.auth/connect?${new URLSearchParams({
      issuer: CONNECTED,
      next: loginUrl,
      scope: "iterate account organizations:write",
    })}`,
  );
  expect(calls).toEqual(["end"]);
});

test("the connect page lets its form redirect on to the issuer it names", async () => {
  // Chromium checks form-action along the submission's whole redirect chain: Continue POSTs here,
  // then 302s to that issuer's authorize endpoint
  const { response } = connected(`/.auth/connect?${new URLSearchParams({ issuer: CONNECTED })}`);
  const answer = await response;
  expect(answer?.status).toBe(200);
  expect(answer?.headers.get("content-security-policy")).toContain(
    `form-action 'self' ${CONNECTED};`,
  );
});

test("the connect form's POST moves on to the issuer's authorize endpoint by a refresh, never a redirect", async () => {
  // why a refresh and not a redirect: `onwardPage` in app-server.ts
  const { response, calls } = connected("/.auth/connect", {
    method: "POST",
    headers: { origin: "https://notes.example" },
    body: new URLSearchParams({ issuer: ISSUER, next: "/projects/acme", scope: "iterate" }),
  });
  const answer = await response;
  expect(answer).toMatchObject({ status: 200 });
  expect(answer?.headers.get("location")).toBeNull();
  expect(answer?.headers.get("set-cookie")).toContain("__Host-itx-session=");
  expect(await answer?.text()).toContain(
    `<meta http-equiv="refresh" content="0;url=${ISSUER}/oauth2/auth?state=x">`,
  );
  expect(calls).toEqual(["end", `begin ${ISSUER}`]);
});

test("a sign-out from a connected issuer bound for an ordinary page carries no scope", async () => {
  const { response } = connected("/.auth/logout?next=%2Fprojects%2Facme", {
    method: "POST",
    headers: { origin: "https://notes.example" },
  });
  expect((await response)?.headers.get("location")).toBe(
    `/.auth/connect?${new URLSearchParams({ issuer: CONNECTED, next: "/projects/acme", scope: "" })}`,
  );
});

test("a login that names no scope asks for the app's own, so Switch account and Stop impersonating sign an app back in with what it needs", async () => {
  const begun: string[][] = [];
  const sessions = {
    getByName: () => ({
      begin: async (host: { issuer: string; scopes: string[] }) => {
        begun.push(host.scopes);
        return `${host.issuer}/oauth2/auth?state=x`;
      },
    }),
  } as unknown as DurableObjectNamespace<BrowserSession>;
  const config = {
    sessions,
    issuer: ISSUER,
    resource: `${ISSUER}/api`,
    scopes: ["admin"],
    api: () => new Response(""),
  };
  // the shell's POST: the logout hands the login on as it is, no scope copied from the ended grant
  const logout = await appAuth(
    new Request("https://admin.example/.auth/logout?next=%2F.auth%2Flogin%3Fnext%3D%2F", {
      method: "POST",
      headers: { origin: "https://admin.example" },
    }),
    config,
  );
  expect(logout?.headers.get("location")).toBe("/.auth/login?next=/");
  const login = await appAuth(new Request("https://admin.example/.auth/login?next=/"), config);
  expect(login?.status).toBe(302);
  expect(begun).toEqual([["iterate", "admin"]]);
});

test("a login that asks to pick the account goes to the issuer's sign-in page first, at the default issuer and through the connect page", async () => {
  const sessions = {
    getByName: () => ({
      host: async () => null,
      begin: async (host: { issuer: string }) => `${host.issuer}/oauth2/auth?state=x`,
    }),
  } as unknown as DurableObjectNamespace<BrowserSession>;
  const config = {
    sessions,
    issuer: ISSUER,
    resource: `${ISSUER}/api`,
    api: () => new Response(""),
  };
  // where Switch account's logout lands: the issuer's page names who it is signed in as, has its
  // own Switch account, and goes on to the authorization
  const switchAccount = "/.auth/login?next=%2Fprojects%2Facme&scope=iterate&prompt=select_account";
  const viaSignIn = `${ISSUER}/login?next=${encodeURIComponent("/oauth2/auth?state=x")}`;
  const login = await appAuth(new Request(`https://notes.example${switchAccount}`), config);
  expect(login?.headers.get("location")).toBe(viaSignIn);
  // A sign-out from a connected issuer hands that login URL to the connect page, whose POST starts
  // the sign-in. The issuer named here is the deployment's own, which needs no discovery read.
  const connect = await appAuth(
    new Request("https://notes.example/.auth/connect", {
      method: "POST",
      headers: { origin: "https://notes.example" },
      body: new URLSearchParams({ issuer: ISSUER, next: switchAccount }),
    }),
    config,
  );
  expect(await connect?.text()).toContain(
    `<meta http-equiv="refresh" content="0;url=${viaSignIn}">`,
  );
});

test("a login hint and a provider hint ride on to the issuer's authorization URL, and a login without them adds none", async () => {
  const sessions = {
    getByName: () => ({
      begin: async (host: { issuer: string }) => `${host.issuer}/oauth2/auth?state=x`,
    }),
  } as unknown as DurableObjectNamespace<BrowserSession>;
  const config = {
    sessions,
    issuer: ISSUER,
    resource: `${ISSUER}/api`,
    api: () => new Response(""),
  };
  const location = async (path: string) =>
    (await appAuth(new Request(`https://dash.example${path}`), config))?.headers.get("location");
  expect(
    await location(
      `/.auth/login?${new URLSearchParams({ next: "/projects/pr1", login_hint: "pr1@preview.iterate.test", provider_hint: "os.iterate.com" })}`,
    ),
  ).toBe(
    `${ISSUER}/oauth2/auth?state=x&login_hint=pr1%40preview.iterate.test&provider_hint=os.iterate.com`,
  );
  expect(await location("/.auth/login?next=%2F")).toBe(`${ISSUER}/oauth2/auth?state=x`);
});

test("a connect link's login hint rides through the connect page to the issuer's authorization URL", async () => {
  const hint = "ada@someorg.example";
  // a login link that names another issuer goes by the connect page, the hint kept
  const login = await connected(
    `/.auth/login?${new URLSearchParams({ issuer: CONNECTED, next: "/projects/acme", login_hint: hint })}`,
  ).response;
  const connect = `/.auth/connect?${new URLSearchParams({ issuer: CONNECTED, next: "/projects/acme", scope: "", login_hint: hint })}`;
  expect(login?.headers.get("location")).toBe(connect);
  // the connect page's Continue carries it
  const page = await connected(connect).response;
  expect(await page?.text()).toContain(`<input type="hidden" name="login_hint" value="${hint}">`);
  // and the POST sets it on the authorization it starts (posted for the deployment's own issuer
  // here: another must first answer over the network, `issuerAnswersAt`)
  const post = await connected("/.auth/connect", {
    method: "POST",
    headers: { origin: "https://notes.example" },
    body: new URLSearchParams({ issuer: ISSUER, next: "/projects/acme", login_hint: hint }),
  }).response;
  expect(await post?.text()).toContain(
    `content="0;url=${ISSUER}/oauth2/auth?state=x&#38;login_hint=ada%40someorg.example"`,
  );
  // a browser bound nowhere goes straight on to sign in at the deployment's own issuer, hint and all
  const fresh = await appAuth(
    new Request(
      `https://notes.example/.auth/connect?${new URLSearchParams({ issuer: ISSUER, login_hint: hint })}`,
    ),
    {
      sessions: {} as DurableObjectNamespace<BrowserSession>,
      issuer: ISSUER,
      resource: `${ISSUER}/api`,
      api: () => new Response(""),
    },
  );
  expect(fresh?.headers.get("location")).toBe(
    `/.auth/login?${new URLSearchParams({ next: "/", scope: "", login_hint: hint })}`,
  );
});

test("on the issuer's own origin, a signed-out login goes to its sign-in page with the provider hint", async () => {
  const config = {
    sessions: { getByName: () => ({}) } as unknown as DurableObjectNamespace<BrowserSession>,
    issuer: ISSUER,
    resource: `${ISSUER}/api`,
    api: () => new Response(""),
    loginPage: "/login",
  };
  const location = async (path: string) =>
    (await appAuth(new Request(`${ISSUER}${path}`), config))?.headers.get("location");
  expect(
    await location(
      `/.auth/login?${new URLSearchParams({ next: "/projects/pr1/notes/", provider_hint: "os.iterate.com" })}`,
    ),
  ).toBe("/login?next=%2Fprojects%2Fpr1%2Fnotes%2F&provider_hint=os.iterate.com");
  expect(await location("/.auth/login?next=%2F")).toBe("/login?next=%2F");
});

test("client metadata publishes app branding relative to its own origin, independently of the issuer", async () => {
  const response = await appAuth(new Request("https://notes.example/.auth/client.json"), {
    sessions: {} as DurableObjectNamespace<BrowserSession>,
    issuer: ISSUER,
    resource: `${ISSUER}/api`,
    api: () => new Response(),
    client: { name: "Iterate Notes", logoUri: "/client-logo.svg" },
  });
  expect(await response!.json()).toMatchObject({
    client_id: "https://notes.example/.auth/client.json",
    client_name: "Iterate Notes",
    client_uri: "https://notes.example",
    logo_uri: "https://notes.example/client-logo.svg",
    token_endpoint_auth_method: "none",
  });
});

/** One app session the platform honours, holding `scopes`; the platform read is pointed at a closed
 *  port so it fails at once and the page degrades. */
function login(path: string, scopes: string[]) {
  const sessions = {
    getByName: () => ({
      bearer: async () => "token",
      scopes: async () => scopes,
      host: async () => ({ issuer: ISSUER, resource: "http://127.0.0.1:1/api" }),
    }),
  } as unknown as DurableObjectNamespace<BrowserSession>;
  return appAuth(
    new Request(`https://notes.example${path}`, {
      headers: { cookie: "__Host-itx-session=00000000-0000-4000-8000-000000000001" },
    }),
    { sessions, issuer: ISSUER, resource: "http://127.0.0.1:1/api", api: () => new Response("") },
  );
}

/** A session bound to `CONNECTED` whose grant the platform no longer honours (the probe is 401):
 *  what `/.auth/login` starts next, and where `/.auth/logout` sends the person. */
function connected(path: string, init?: RequestInit) {
  const calls: string[] = [];
  const sessions = {
    getByName: () => ({
      bearer: async () => "stale",
      scopes: async () => ["iterate"],
      host: async () => ({ issuer: CONNECTED, resource: `${CONNECTED}/api` }),
      discard: async () => calls.push("discard"),
      end: async () => calls.push("end"),
      begin: async (host: { issuer: string }) => {
        calls.push(`begin ${host.issuer}`);
        return `${host.issuer}/oauth2/auth?state=x`;
      },
    }),
  } as unknown as DurableObjectNamespace<BrowserSession>;
  const response = appAuth(
    new Request(`https://notes.example${path}`, {
      ...init,
      headers: {
        cookie: "__Host-itx-session=00000000-0000-4000-8000-000000000001",
        ...(init?.headers as Record<string, string>),
      },
    }),
    {
      sessions,
      issuer: ISSUER,
      resource: `${ISSUER}/api`,
      api: () => new Response("", { status: 401 }),
    },
  );
  return { response, calls };
}
