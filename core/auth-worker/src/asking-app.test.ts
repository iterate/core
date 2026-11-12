// The app of the mind that a sign-in is for: which requests name one, what an app says of itself,
// and what the sign-in pages then show.
import { expect, test, vi } from "vitest";
import { appOf, appOfClient, appTile, askingAppOf, saidIn } from "./asking-app.ts";
import { emailSignInResponse } from "./email-sign-in.ts";
import type { Env } from "./env.ts";
import { hostCallbackOf, hostClientOf, oauthHelpers } from "./oauth.ts";
import { chooserPage, consentPage, signInPage } from "./pages.ts";

const DOMAIN = "example.com";
const HOST = `guestbook.${DOMAIN}`;
const ORIGIN = `https://${HOST}`;
const MANIFEST = `${ORIGIN}/manifest.webmanifest`;

test("an app is read from a sign-in's request only when the stack holds all three of its parts", async () => {
  const stack = stackWith({ [HOST]: { name: "Guestbook", icon: `${ORIGIN}/icon.svg` } });
  const client = await hostClientOf(stack.env, HOST);
  const next = (change: Record<string, string> = {}) =>
    `/oauth2/auth?${new URLSearchParams({
      response_type: "code",
      client_id: client,
      redirect_uri: hostCallbackOf(ORIGIN),
      resource: ORIGIN,
      scope: "identity",
      state: "s",
      ...change,
    })}`;
  // the request that the host's own page makes
  expect(await askingAppOf(stack.env, next())).toEqual({
    host: HOST,
    origin: ORIGIN,
    name: "Guestbook",
    icon: `${ORIGIN}/icon.svg`,
  });
  // a path on the host is the host, as the authorization endpoint reads it
  expect(await askingAppOf(stack.env, next({ resource: `${ORIGIN}/mcp` }))).toMatchObject({
    host: HOST,
  });
  // one part that is another's, and the page is the mind's own
  for (const forged of [
    next({ client_id: "another-client" }),
    next({ redirect_uri: "https://elsewhere.test/callback" }),
    next({ redirect_uri: `https://docs.${DOMAIN}/.iterate/callback` }),
    next({ resource: "https://guestbook.elsewhere.test" }),
    next({ resource: `https://iterate.${DOMAIN}` }),
    // a host of the mind that never asked for a sign-in has no client
    next({
      resource: `https://docs.${DOMAIN}`,
      redirect_uri: hostCallbackOf(`https://docs.${DOMAIN}`),
    }),
    next().replace("/oauth2/auth", "/keys"),
    `https://elsewhere.test${next()}`,
    "/",
  ])
    expect(await askingAppOf(stack.env, forged)).toBeNull();
});

test.for([
  {
    name: "its name, and an icon beside the manifest",
    manifest: { name: "Guestbook", icons: [{ src: "/icon.svg", sizes: "any" }] },
    said: { name: "Guestbook", icon: `${ORIGIN}/icon.svg` },
  },
  {
    name: "a short name when it has no other, and a relative icon",
    manifest: { short_name: "Book", icons: [{ src: "icons/a.png" }] },
    said: { name: "Book", icon: `${ORIGIN}/icons/a.png` },
  },
  {
    name: "an icon elsewhere does not count: the next one of its own origin does",
    manifest: {
      name: "Guestbook",
      icons: [
        { src: "https://elsewhere.test/logo.png" },
        { src: `http://${HOST}/plain.png` },
        { src: `https://docs.${DOMAIN}/icon.svg` },
        { src: `${ORIGIN}/own.svg` },
      ],
    },
    said: { name: "Guestbook", icon: `${ORIGIN}/own.svg` },
  },
  {
    name: "a name is one line of sixty characters",
    manifest: { name: `  Guest\nbook ${"x".repeat(80)}` },
    said: { name: `Guest book ${"x".repeat(49)}`, icon: null },
  },
  { name: "no name and no icon", manifest: {}, said: { name: null, icon: null } },
  { name: "not an object", manifest: ["Guestbook"], said: { name: null, icon: null } },
  { name: "a name that is no text", manifest: { name: 7 }, said: { name: null, icon: null } },
])("what a manifest says: $name", ({ manifest, said }) => {
  expect(saidIn(JSON.stringify(manifest), MANIFEST)).toEqual(said);
});

test("a manifest that is no JSON, is empty or is too long says nothing", () => {
  for (const text of ["", "<!doctype html>", `{"name":"${"x".repeat(20_000)}"}`])
    expect(saidIn(text, MANIFEST)).toEqual({ name: null, icon: null });
});

test("the manifest is read once in five minutes, with no redirect followed, and the host's own client then holds what the app says", async () => {
  const stack = stackWith({});
  const client = await hostClientOf(stack.env, HOST);
  using web = answers({ name: "Guestbook", icons: [{ src: "/icon.svg" }] });
  const app = await appOf(stack.env, ORIGIN);
  expect(app).toEqual({
    host: HOST,
    origin: ORIGIN,
    name: "Guestbook",
    icon: `${ORIGIN}/icon.svg`,
  });
  expect(await appOf(stack.env, ORIGIN)).toEqual(app);
  expect(web).toMatchObject({ asked: [[MANIFEST, "manual"]] });
  expect(stack.ttl.get(`iterate-app-said:${HOST}`)).toBe(300);
  // the OAuth client that the host signs in with is that app now, for any list of clients
  const kept = await oauthHelpers(stack.env, ORIGIN).lookupClient(client);
  expect(kept).toMatchObject({ clientName: "Guestbook", logoUri: `${ORIGIN}/icon.svg` });
  expect(await appOfClient(stack.env, kept!)).toEqual(app);
  // a client that only says it is the host's is no app of the mind
  expect(await appOfClient(stack.env, { ...kept!, clientId: "another-client" })).toBeNull();
  expect(
    await appOfClient(stack.env, { clientId: client, clientUri: "https://elsewhere.test" }),
  ).toBeNull();
});

test.for([
  { name: "a 503", answer: () => new Response("Unavailable\n", { status: 503 }) },
  {
    name: "no answer",
    answer: () => {
      throw new TypeError("fetch failed");
    },
  },
  {
    name: "an answer that breaks off",
    answer: () =>
      new Response(new ReadableStream({ start: (stream) => stream.error(new Error("cut")) })),
  },
])(
  "an app that does not answer ($name) is still what it last said, and is asked again after a minute",
  async ({ answer }) => {
    const stack = stackWith({});
    const client = await hostClientOf(stack.env, HOST);
    {
      using _web = answers({ name: "Guestbook", icons: [{ src: "/icon.svg" }] });
      await appOf(stack.env, ORIGIN);
    }
    // five minutes later the kept answer is gone, and the app is down
    stack.kv.delete(`iterate-app-said:${HOST}`);
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
    using _down = { [Symbol.dispose]: () => spy.mockRestore() };
    expect(await appOf(stack.env, ORIGIN)).toEqual({
      host: HOST,
      origin: ORIGIN,
      name: "Guestbook",
      icon: `${ORIGIN}/icon.svg`,
    });
    expect(stack.ttl.get(`iterate-app-said:${HOST}`)).toBe(60);
    // and the client that the list of sign-ins reads still names the app
    expect(await oauthHelpers(stack.env, ORIGIN).lookupClient(client)).toMatchObject({
      clientName: "Guestbook",
      logoUri: `${ORIGIN}/icon.svg`,
    });
  },
);

test("an app that answers with no manifest any more has said so: it is its host again", async () => {
  const stack = stackWith({});
  const client = await hostClientOf(stack.env, HOST);
  {
    using _web = answers({ name: "Guestbook", icons: [{ src: "/icon.svg" }] });
    await appOf(stack.env, ORIGIN);
  }
  stack.kv.delete(`iterate-app-said:${HOST}`);
  using _web = answers(null);
  expect(await appOf(stack.env, ORIGIN)).toEqual({
    host: HOST,
    origin: ORIGIN,
    name: HOST,
    icon: null,
  });
  expect(await oauthHelpers(stack.env, ORIGIN).lookupClient(client)).toMatchObject({
    clientName: HOST,
  });
});

test("an app that says nothing, or whose host does not answer, is its host and its initials, and that is kept too", async () => {
  const stack = stackWith({});
  using web = answers(null);
  const app = await appOf(stack.env, ORIGIN);
  expect(app).toEqual({ host: HOST, origin: ORIGIN, name: HOST, icon: null });
  expect(appTile(app)).toBe(`<div class="tile" data-app-mark="initials">GU</div>`);
  await appOf(stack.env, ORIGIN);
  expect(web.asked).toHaveLength(1);
});

test("the mailed code's page for an app's sign-in shows the app as the client that asks: its tile, name, host and what it gets", async () => {
  const stack = stackWith({ [HOST]: { name: "Guestbook", icon: `${ORIGIN}/icon.svg` } });
  const client = await hostClientOf(stack.env, HOST);
  const next = `/oauth2/auth?${new URLSearchParams({ client_id: client, redirect_uri: hostCallbackOf(ORIGIN), resource: ORIGIN })}`;
  const answer = await emailSignInResponse(
    stack.env,
    new Request(`https://iterate.${DOMAIN}/sign-in/email?${new URLSearchParams({ next })}`),
  );
  const html = await answer!.text();
  expect(html).toContain("<title>Sign in to Guestbook</title>");
  expect(html).toContain(
    `<span aria-hidden="true">⇄</span><div class="tile" data-app-mark="icon"><img src="${ORIGIN}/icon.svg" alt="" referrerpolicy="no-referrer"></div>`,
  );
  expect(html).toMatch(
    /<h1>Sign in to Guestbook<\/h1>\s*<p class="muted where">guestbook\.example\.com<\/p>/,
  );
  expect(html).toContain(
    "<strong>Guestbook</strong> is an app of <strong>example.com</strong>, which runs it.",
  );
  expect(html).toContain("It learns your email address, and nothing else.");
  // who gets a code is said once, in the block, and not above the form too
  expect(html.match(/Anyone can sign in/g)).toHaveLength(1);
  expect(html).toContain(
    "<li>Anyone can sign in. A new address gets an account of its own, with no access to the mind itself.</li>",
  );
  expect(html).toContain(`see <a href="/sign-ins">your sign-ins</a>`);
  // the one image the page may load is on the app's own origin
  expect(answer!.headers.get("content-security-policy")).toContain(`img-src ${ORIGIN}`);
  // a sign-in for the mind itself is the mind's page, with no image at all
  const plain = await emailSignInResponse(
    stack.env,
    new Request(`https://iterate.${DOMAIN}/sign-in/email?next=%2Fkeys`),
  );
  expect(await plain!.text()).toContain(`<h1>Sign in to ${DOMAIN}</h1>`);
  expect(plain!.headers.get("content-security-policy")).not.toContain("img-src");
});

test("the four pages of an app's sign-in agree: each shows the app, its host and its block, and none says the mind's own line", async () => {
  const stack = stackWith({ [HOST]: { name: "Guestbook", icon: `${ORIGIN}/icon.svg` } });
  const client = await hostClientOf(stack.env, HOST);
  const next = `/oauth2/auth?${new URLSearchParams({ client_id: client, redirect_uri: hostCallbackOf(ORIGIN), resource: ORIGIN })}`;
  const app = { host: HOST, origin: ORIGIN, name: "Guestbook", icon: `${ORIGIN}/icon.svg` };
  stack.challenge.next = next;
  const mailed = (path: string, headers?: HeadersInit) =>
    emailSignInResponse(stack.env, new Request(`https://iterate.${DOMAIN}${path}`, { headers }));
  const pages = {
    address: await mailed(`/sign-in/email?${new URLSearchParams({ next })}`),
    code: await mailed("/sign-in/email/code", { cookie: "__Host-iterate-auth-code=abc" }),
    passkey: signInPage(DOMAIN, next, false, app),
    chooser: chooserPage({ domain: DOMAIN, email: "guest@example.net", here: next, app }),
  };
  for (const [name, answer] of Object.entries(pages)) {
    const html = await answer!.text();
    const page = `the ${name} page`;
    expect(html, page).toContain(
      `<div class="tile" data-app-mark="icon"><img src="${ORIGIN}/icon.svg"`,
    );
    expect(html, page).toContain(`<p class="muted where">${HOST}</p>`);
    expect(html, page).toContain(`<div class="about" data-app="${HOST}">`);
    expect(html, page).toContain(
      "<strong>Guestbook</strong> is an app of <strong>example.com</strong>",
    );
    expect(html, page).toContain("It learns your email address, and nothing else.");
    expect(html, page).toContain(`see <a href="/sign-ins">your sign-ins</a>`);
    // the mind's own words for its own sign-in are not on an app's page
    expect(html, page).not.toContain(`Sign in to ${DOMAIN}`);
    expect(html, page).not.toContain(`Anyone can sign in to ${DOMAIN}`);
    expect(answer!.headers.get("content-security-policy"), page).toContain(`img-src ${ORIGIN}`);
  }
  // a page that mails a code says who gets one, once, in the block
  for (const answer of [
    await mailed(`/sign-in/email?${new URLSearchParams({ next })}`),
    await mailed("/sign-in/email/code", { cookie: "__Host-iterate-auth-code=abc" }),
  ])
    expect((await answer!.text()).match(/Anyone can sign in/g)).toHaveLength(1);
  // the code's page keeps what to do when no code comes
  const code = await (await mailed("/sign-in/email/code", {
    cookie: "__Host-iterate-auth-code=abc",
  }))!.text();
  expect(code).toContain("No code after a minute? Check the spam folder, then send a new one.");
  expect(code).toContain("You sign in to <strong>Guestbook</strong>.");
  // the mind's own code page is as it was
  stack.challenge.next = "/keys";
  const own = await (await mailed("/sign-in/email/code", {
    cookie: "__Host-iterate-auth-code=abc",
  }))!.text();
  expect(own).toContain(
    `Anyone can sign in to ${DOMAIN}. A new address gets an account of its own, with no access to the mind itself. No code after a minute?`,
  );
  expect(own).not.toContain(`class="about"`);
});

test("the passkey's page, the chooser and a consent for the app's host name the app too, and a name is text", async () => {
  const app = { host: HOST, origin: ORIGIN, name: `<b>Guest</b>book`, icon: null };
  const passkey = await signInPage(DOMAIN, "/", false, app).text();
  expect(passkey).toContain("<h1>Sign in to &#60;b&#62;Guest&#60;/b&#62;book</h1>");
  expect(passkey).toContain(`<div class="tile" data-app-mark="initials">BG</div>`);
  expect(passkey).not.toContain("<b>Guest");
  const guestbook = { ...app, name: "Guestbook" };
  const chooser = await chooserPage({
    domain: DOMAIN,
    email: "guest@example.net",
    here: "/oauth2/auth?client_id=c",
    app: guestbook,
  }).text();
  expect(chooser).toContain(
    `<button type="submit">Continue as guest@example.net to Guestbook</button>`,
  );
  expect(chooser).toContain(`<p class="muted where">${HOST}</p>`);
  // a page that mails no code says the membership plainly
  expect(chooser).toContain(`<li>Signing in does not make you a member of ${DOMAIN}.</li>`);
  // without an app, the chooser is the mind's own, as a member sees it
  const own = await chooserPage({ domain: DOMAIN, email: "m@example.net", here: "/x" }).text();
  expect(own).toContain(`<button type="submit">Continue as m@example.net</button>`);
  expect(own).not.toContain(`class="about"`);
  const consent = await consentPage({
    details: {
      clientName: "Notes",
      redirectUri: "https://notes.example.org/callback",
      redirectHost: "notes.example.org",
      redirectIsLoopback: false,
    } as never,
    handle: "handle",
    email: "guest@example.net",
    domain: DOMAIN,
    resource: "its API",
    host: HOST,
    app: guestbook,
    here: "/oauth2/auth?client_id=c",
    headers: new Headers(),
  }).text();
  expect(consent).toContain("<h1>Notes wants to use Guestbook as you</h1>");
  expect(consent).toContain(`Guestbook is an app of ${DOMAIN}, at ${HOST}.`);
});

/** A stack with an in-memory store, which already holds what the named hosts' apps say. */
function stackWith(said: Record<string, { name: string | null; icon: string | null }>) {
  const kv = new Map<string, string>(
    Object.entries(said).map(([host, value]) => [
      `iterate-app-said:${host}`,
      JSON.stringify(value),
    ]),
  );
  const ttl = new Map<string, number | undefined>();
  // the one mailed code that waits, as the code's page reads it
  const challenge = { email: "guest@example.net", next: "/" };
  const env = {
    DOMAIN,
    AUTH_SETTINGS: JSON.stringify({
      login: { methods: { email: { anyone: true } }, allow: [{ email: "owner@example.net" }] },
      keys: [],
    }),
    OAUTH_KV: {
      get: async (key: string, type?: unknown) => {
        const kept = kv.get(key);
        return kept && type ? JSON.parse(kept) : kept || null;
      },
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        kv.set(key, value);
        ttl.set(key, options?.expirationTtl);
      },
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (...bound: unknown[]) => ({ sql, bound, first: async () => challenge }),
      }),
      // the admission of a new host client: its count admits
      batch: async () => [{}, { results: [{ admitted: 1 }] }],
    },
  } as unknown as Env;
  return { env, kv, ttl, challenge };
}

/** The web for one test: every fetch answers `manifest` as JSON (null: a 404), and is recorded. */
function answers(manifest: object | null) {
  const asked: [string, string | undefined][] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    asked.push([String(input), init?.redirect]);
    return manifest ? Response.json(manifest) : new Response("Not found\n", { status: 404 });
  });
  return { asked, [Symbol.dispose]: () => spy.mockRestore() };
}
