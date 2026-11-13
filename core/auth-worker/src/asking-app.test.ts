// The app of the mind that a sign-in is for: which requests name one, what an app says of itself,
// and what the sign-in pages then show.
import { expect, test, vi } from "vitest";
import { appOf, appTile, askingAppOf, saidIn } from "./asking-app.ts";
import { emailSignInResponse } from "./email-sign-in.ts";
import type { Env } from "./env.ts";
import { hostCallbackOf, hostClientOf, oauthHelpers } from "./oauth.ts";
import { appSignIn, chooserPage, consentPage, signInPage } from "./pages.ts";

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
    members: false,
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
  {
    name: "an app for the mind's members says so",
    manifest: { name: "Dash", iterate: { for: "members" } },
    said: { name: "Dash", icon: null, members: true },
  },
  {
    name: "any other word is not 'for members'",
    manifest: { name: "Dash", iterate: { for: "everyone" } },
    said: { name: "Dash", icon: null },
  },
  {
    name: "another shape of iterate's member is passed over, and the name still counts",
    manifest: { name: "Dash", iterate: "members" },
    said: { name: "Dash", icon: null },
  },
  { name: "no name and no icon", manifest: {}, said: { name: null, icon: null } },
  { name: "not an object", manifest: ["Guestbook"], said: { name: null, icon: null } },
  { name: "a name that is no text", manifest: { name: 7 }, said: { name: null, icon: null } },
])("what a manifest says: $name", ({ manifest, said }) => {
  expect(saidIn(JSON.stringify(manifest), MANIFEST)).toEqual({ members: false, ...said });
});

test("a manifest that is no JSON, is empty or is too long says nothing", () => {
  for (const text of ["", "<!doctype html>", `{"name":"${"x".repeat(20_000)}"}`])
    expect(saidIn(text, MANIFEST)).toEqual({ name: null, icon: null, members: false });
});

test("the manifest is read once in five minutes, with no redirect followed, and the host's own client then holds the app's name and icon", async () => {
  const stack = stackWith({});
  const client = await hostClientOf(stack.env, HOST);
  using web = answers({ name: "Guestbook", icons: [{ src: "/icon.svg" }] });
  const before = Date.now();
  const app = await appOf(stack.env, ORIGIN);
  expect(app).toEqual({
    host: HOST,
    origin: ORIGIN,
    name: "Guestbook",
    icon: `${ORIGIN}/icon.svg`,
    members: false,
  });
  expect(await appOf(stack.env, ORIGIN)).toEqual(app);
  expect(web).toMatchObject({ asked: [[MANIFEST, "manual"]] });
  expect(stack.askedAgainIn(HOST, before)).toBe("5 minutes");
  // five minutes later it is asked again, and no sooner
  stack.due(HOST);
  await appOf(stack.env, ORIGIN);
  expect(web.asked).toHaveLength(2);
  // the OAuth client that the host signs in with is that app now, for any list of clients
  expect(await oauthHelpers(stack.env, ORIGIN).lookupClient(client)).toMatchObject({
    clientName: "Guestbook",
    logoUri: `${ORIGIN}/icon.svg`,
  });
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
      using _web = answers({
        name: "Guestbook",
        icons: [{ src: "/icon.svg" }],
        iterate: { for: "members" },
      });
      await appOf(stack.env, ORIGIN);
    }
    // five minutes later the app is asked again, and it is down
    stack.due(HOST);
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
    using _down = { [Symbol.dispose]: () => spy.mockRestore() };
    const before = Date.now();
    expect(await appOf(stack.env, ORIGIN)).toEqual({
      host: HOST,
      origin: ORIGIN,
      name: "Guestbook",
      icon: `${ORIGIN}/icon.svg`,
      members: true,
    });
    expect(stack.askedAgainIn(HOST, before)).toBe("1 minute");
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
  stack.due(HOST);
  using _web = answers(null);
  expect(await appOf(stack.env, ORIGIN)).toEqual({
    host: HOST,
    origin: ORIGIN,
    name: HOST,
    icon: null,
    members: false,
  });
  expect(await oauthHelpers(stack.env, ORIGIN).lookupClient(client)).toMatchObject({
    clientName: HOST,
  });
});

test("an app that says nothing, or whose host does not answer, is its host and its initials, and that is kept too", async () => {
  const stack = stackWith({});
  using web = answers(null);
  const app = await appOf(stack.env, ORIGIN);
  expect(app).toEqual({ host: HOST, origin: ORIGIN, name: HOST, icon: null, members: false });
  expect(appTile(app)).toBe(`<div class="tile" data-app-mark="initials">GU</div>`);
  await appOf(stack.env, ORIGIN);
  expect(web.asked).toHaveLength(1);
});

test("the mailed code's page for an app's sign-in names the host it signs in to, under the app's own icon", async () => {
  const stack = stackWith({ [HOST]: { name: "Guestbook", icon: `${ORIGIN}/icon.svg` } });
  const client = await hostClientOf(stack.env, HOST);
  const next = `/oauth2/auth?${new URLSearchParams({ client_id: client, redirect_uri: hostCallbackOf(ORIGIN), resource: ORIGIN })}`;
  const answer = await emailSignInResponse(
    stack.env,
    new Request(`https://iterate.${DOMAIN}/sign-in/email?${new URLSearchParams({ next })}`),
  );
  const html = await answer!.text();
  expect(html).toContain(`<title>Sign in to ${HOST}</title>`);
  // the app's icon is the card's one mark: no pair, and no mark of iterate's beside it
  expect(html).toContain(
    `<main class="centered"><div class="tile" data-app-mark="icon"><img src="${ORIGIN}/icon.svg" alt="" referrerpolicy="no-referrer"></div><h1>Sign in to ${HOST}</h1>`,
  );
  expect(html).not.toMatch(/class="asks"|class="mark"|class="about"|is an app of/);
  // the mind's own line of who gets a code is not on an app's page
  expect(html).not.toContain("Anyone can sign in");
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

test("the four pages of an app's sign-in agree: each shows the app's icon and its host, and none says the mind's own line", async () => {
  const stack = stackWith({ [HOST]: { name: "Guestbook", icon: `${ORIGIN}/icon.svg` } });
  const client = await hostClientOf(stack.env, HOST);
  const next = `/oauth2/auth?${new URLSearchParams({ client_id: client, redirect_uri: hostCallbackOf(ORIGIN), resource: ORIGIN })}`;
  const app = {
    host: HOST,
    origin: ORIGIN,
    name: "Guestbook",
    icon: `${ORIGIN}/icon.svg`,
    members: false,
  };
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
    expect(html, page).toContain(
      name === "code" ? "<h1>Enter your code</h1>" : `<h1>Sign in to ${HOST}</h1>`,
    );
    expect(html, page).not.toMatch(/class="about"|is an app of|Guestbook/);
    // the mind's own words for its own sign-in are not on an app's page
    expect(html, page).not.toContain(`Sign in to ${DOMAIN}`);
    expect(html, page).not.toContain(`Anyone can sign in to ${DOMAIN}`);
    expect(answer!.headers.get("content-security-policy"), page).toContain(`img-src ${ORIGIN}`);
  }
  // the code's page: one sentence over the field, which names the host; what to do when no code
  // comes is under the button, with the way back
  const code = await (await mailed("/sign-in/email/code", {
    cookie: "__Host-iterate-auth-code=abc",
  }))!.text();
  expect(code).toContain(
    `If <strong>guest@example.net</strong> may sign in to <strong>${HOST}</strong>, a code is on its way. It expires in 10 minutes.`,
  );
  expect(
    code.indexOf("No code after a minute? Check the spam folder, or <a href="),
  ).toBeGreaterThan(code.indexOf('<button type="submit">Sign in</button>'));
  expect(code).toContain(
    '<input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required>',
  );
  // the mind's own code page is as it was
  stack.challenge.next = "/keys";
  const own = await (await mailed("/sign-in/email/code", {
    cookie: "__Host-iterate-auth-code=abc",
  }))!.text();
  expect(own).toContain(
    `<p class="muted">Anyone can sign in to ${DOMAIN}. A new address gets an account of its own, with no access to the mind itself.</p>`,
  );
  expect(own).toContain("may sign in here, a code is on its way.");
  expect(own).not.toContain(`class="about"`);
});

test("an app for members says in one quiet line that it works as the person; an app for anyone says nothing of itself", () => {
  const dash = {
    host: `dash.${DOMAIN}`,
    origin: `https://dash.${DOMAIN}`,
    name: "Dash",
    icon: null,
    members: true,
  };
  expect(appSignIn(dash)).toMatchObject({
    heading: `<h1>Sign in to dash.${DOMAIN}</h1>`,
    about: `<p class="muted" data-for-members>It works as you: it can read and change everything that you can.</p>`,
  });
  expect(appSignIn({ ...dash, members: false })).toMatchObject({ about: "" });
});

test("the address page of an app for members, as the app's own manifest makes it", async () => {
  const origin = `https://dash.${DOMAIN}`;
  const stack = stackWith({
    [`dash.${DOMAIN}`]: { name: "Dash", icon: `${origin}/icon.svg`, members: true },
  });
  const client = await hostClientOf(stack.env, `dash.${DOMAIN}`);
  const next = `/oauth2/auth?${new URLSearchParams({ client_id: client, redirect_uri: hostCallbackOf(origin), resource: origin })}`;
  const answer = await emailSignInResponse(
    stack.env,
    new Request(`https://iterate.${DOMAIN}/sign-in/email?${new URLSearchParams({ next })}`),
  );
  const html = await answer!.text();
  expect(html).toContain(`<h1>Sign in to dash.${DOMAIN}</h1>`);
  expect(html).toContain("It works as you: it can read and change everything that you can.");
  expect(html).not.toContain("Anyone can sign in");
});

test("the passkey's page, the chooser and a consent for the app's host name the host, and a host is text", async () => {
  const app = { host: HOST, origin: ORIGIN, name: "Guestbook", icon: null, members: false };
  const passkey = await signInPage(DOMAIN, "/", false, { ...app, host: `<b>${HOST}</b>` }).text();
  expect(passkey).toContain(`<h1>Sign in to &#60;b&#62;${HOST}&#60;/b&#62;</h1>`);
  expect(passkey).not.toContain(`<b>${HOST}`);
  // an app with no icon has no tile of initials: iterate's mark is the card's one
  expect(passkey).toContain(`<main class="centered"><div class="mark"`);
  expect(passkey).not.toContain("data-app-mark");
  const guestbook = app;
  const chooser = await chooserPage({
    domain: DOMAIN,
    email: "guest@example.net",
    here: "/oauth2/auth?client_id=c",
    app: guestbook,
  }).text();
  expect(chooser).toContain(`<h1>Sign in to ${HOST}</h1>`);
  expect(chooser).toContain(`<button type="submit">Continue as guest@example.net</button>`);
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
    here: "/oauth2/auth?client_id=c",
    headers: new Headers(),
  }).text();
  expect(consent).toContain(`<h1>Notes wants to use ${HOST} as you</h1>`);
  expect(consent).not.toContain("is an app of");
});

/** A stack with an in-memory store, which already holds what the named hosts' apps say, as heard
 *  a moment ago. */
function stackWith(
  said: Record<string, { name: string | null; icon: string | null; members?: boolean }>,
) {
  const keyOf = (host: string) => `iterate-app-said:${host}`;
  const kv = new Map<string, string>(
    Object.entries(said).map(([host, value]) => [
      keyOf(host),
      JSON.stringify({ members: false, ...value, askAfter: Date.now() + 5 * 60_000 }),
    ]),
  );
  const keptOf = (host: string) => JSON.parse(kv.get(keyOf(host))!) as { askAfter: number };
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
      put: async (key: string, value: string) => void kv.set(key, value),
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (...bound: unknown[]) => ({ sql, bound, first: async () => challenge }),
      }),
      // the admission of a new host client: its count admits
      batch: async () => [{}, { results: [{ admitted: 1 }] }],
    },
  } as unknown as Env;
  return {
    env,
    challenge,
    /** The time has come to ask `host`'s app again. */
    due: (host: string) => kv.set(keyOf(host), JSON.stringify({ ...keptOf(host), askAfter: 0 })),
    /** How long after `since` the app is asked again, in whole minutes. */
    askedAgainIn(host: string, since: number) {
      const minutes = Math.round((keptOf(host).askAfter - since) / 60_000);
      return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    },
  };
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
