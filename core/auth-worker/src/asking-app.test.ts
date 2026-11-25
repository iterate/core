// The app of the mind that a sign-in is for: which requests name one, what an app says of itself,
// and what the sign-in pages then show.
import type { SignInMethod } from "iterate/principal";
import { expect, test, vi } from "vitest";
import { isOwnerEmail } from "iterate/mind-config";
import {
  allowedEmailsWords,
  appOf,
  appTakes,
  appTile,
  askingAppOf,
  saidIn,
  signInOf,
  takesAddress,
} from "./asking-app.ts";
import { emailSignInResponse } from "./email-sign-in.ts";
import type { Env } from "./env.ts";
import { hostCallbackOf, hostClientOf, oauthHelpers } from "./oauth.ts";
import { appSignIn, chooserPage, consentPage, signInPage } from "./pages.ts";
import { configVars } from "./test-support.ts";

const MIND = "iterate.example.com";
// the mind's one zone, where its apps' hosts are
const DOMAIN = "example.com";
const HOST = `guestbook.${DOMAIN}`;
const ORIGIN = `https://${HOST}`;
const DESCRIPTION = `${ORIGIN}/.well-known/iterate-app`;
// how the people of an app sign in when the app names no method: for anyone, and for members. A
// member signs in with a passkey and nothing else, at an app for members as at the control plane.
const FOR_ANYONE = ["email", "passkey"];
const FOR_MEMBERS = ["passkey"];

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
    signIn: FOR_ANYONE,
    allowedEmails: null,
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
    next({ resource: `https://${MIND}` }),
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

const NOTHING = {
  name: null,
  icon: null,
  members: false,
  signIn: FOR_ANYONE,
  allowedEmails: null,
};

test.for([
  {
    name: "its name, and its icon as a path on its own origin",
    description: { name: "Guestbook", icon: "/icon.svg" },
    said: { name: "Guestbook", icon: `${ORIGIN}/icon.svg` },
  },
  {
    name: "a path that names another host is no icon, and the name still counts",
    description: { name: "Guestbook", icon: "//elsewhere.test/logo.png" },
    said: { name: "Guestbook" },
  },
  {
    name: "a backslash names another host as a slash does",
    description: { name: "Guestbook", icon: "/\\elsewhere.test/logo.png" },
    said: { name: "Guestbook" },
  },
  {
    name: "a name is one line of sixty characters",
    description: { name: `  Guest\nbook ${"x".repeat(80)}` },
    said: { name: `Guest book ${"x".repeat(49)}` },
  },
  {
    name: "an app for the mind's members says so, and its people sign in by a passkey alone",
    description: { name: "Dash", for: "members" },
    said: { name: "Dash", members: true, signIn: FOR_MEMBERS },
  },
  {
    name: "an app names its sign-in methods, in its order",
    description: { name: "Guestbook", signIn: ["passkey", "email"] },
    said: { name: "Guestbook", signIn: ["passkey", "email"] },
  },
  {
    name: "an app that names the passkey alone",
    description: { name: "Guestbook", signIn: ["passkey"] },
    said: { name: "Guestbook", signIn: ["passkey"] },
  },
  {
    // taken as it is written: the app's own code decides
    name: "an app for members that names the mailed code first",
    description: { name: "Dash", for: "members", signIn: ["email", "passkey"] },
    said: { name: "Dash", members: true, signIn: ["email", "passkey"] },
  },
  {
    name: "a method named twice is named once",
    description: { name: "Guestbook", signIn: ["email", "email"] },
    said: { name: "Guestbook", signIn: ["email"] },
  },
  {
    name: "the addresses and the patterns that a mailed code signs in, each once and in lowercase",
    description: {
      name: "Shop",
      allowedEmails: ["Eve@Elsewhere.test", "eve@elsewhere.test"],
      allowedEmailPatterns: ["*@example.com", "*@second.example", "*@example.com"],
    },
    said: {
      name: "Shop",
      allowedEmails: {
        emails: ["eve@elsewhere.test"],
        patterns: ["*@example.com", "*@second.example"],
      },
    },
  },
  {
    name: "addresses alone, and patterns alone",
    description: { name: "Shop", allowedEmails: ["eve@elsewhere.test"] },
    said: { name: "Shop", allowedEmails: { emails: ["eve@elsewhere.test"], patterns: [] } },
  },
  {
    name: "patterns alone",
    description: { name: "Shop", allowedEmailPatterns: ["*@example.com"] },
    said: { name: "Shop", allowedEmails: { emails: [], patterns: ["*@example.com"] } },
  },
  {
    name: "what a browser's manifest would say is passed over",
    description: { name: "Guestbook", short_name: "Book", icons: [{ src: "/other.svg" }] },
    said: { name: "Guestbook" },
  },
  // a JSON object that is no description is wrong, and is not the app's word (null): the issuer
  // keeps what the app last said
  {
    name: "a method that this issuer does not know",
    description: { name: "G", signIn: ["email", "google"] },
    said: null,
  },
  {
    // a restriction that this issuer does not read is never dropped: the last policy stays
    name: "a list of domains, which this issuer does not read",
    description: { name: "G", emailDomains: ["example.com"] },
    said: null,
  },
  {
    name: "an empty list of patterns",
    description: { name: "G", allowedEmailPatterns: [] },
    said: null,
  },
  { name: "an empty list of addresses", description: { name: "G", allowedEmails: [] }, said: null },
  {
    name: "an address that is none",
    description: { name: "G", allowedEmails: ["example.com"] },
    said: null,
  },
  // a pattern is `*@<domain>` in lowercase and nothing else, as an owner email pattern
  ...["example.com", "@example.com", "*@*.example.com", "*@Example.com", "a*@example.com"].map(
    (pattern) => ({
      name: `a pattern that is none: ${pattern}`,
      description: { name: "G", allowedEmailPatterns: [pattern] },
      said: null,
    }),
  ),
  { name: "an empty list of methods", description: { name: "G", signIn: [] }, said: null },
  { name: "methods that are no list", description: { name: "G", signIn: "email" }, said: null },
  {
    name: "any other word than 'members'",
    description: { name: "Dash", for: "everyone" },
    said: null,
  },
  {
    name: "an icon that is no path",
    description: { name: "G", icon: "https://elsewhere.test/logo.png" },
    said: null,
  },
  { name: "no name", description: { icon: "/icon.svg", signIn: ["passkey"] }, said: null },
  { name: "a name that is no text", description: { name: 7 }, said: null },
  // a text that is no JSON object says nothing at all: the app is its host, for anyone
  { name: "not an object", description: ["Guestbook"], said: {} },
])("what an app's description says: $name", ({ description, said }) => {
  expect(saidIn(JSON.stringify(description), DESCRIPTION)).toEqual(said && { ...NOTHING, ...said });
});

test("a JSON object that broke off, or that is too long to read, is no word of the app", () => {
  const long = JSON.stringify({
    name: "Shop",
    allowedEmailPatterns: Array.from({ length: 2000 }, (_, n) => `*@shop-${n}.example.com`),
  });
  expect(long.length).toBeGreaterThan(20_000);
  for (const text of ['{"name":"Shop","allowedEmailPatterns":["*@exam', " {", "{<", long])
    expect(saidIn(text, DESCRIPTION), text.slice(0, 40)).toBeNull();
});

test("a text that is no JSON object, of any length, or that is empty says nothing", () => {
  for (const text of ["", "<!doctype html>", `<!doctype html>${"x".repeat(20_000)}`])
    expect(saidIn(text, DESCRIPTION)).toEqual(NOTHING);
});

test("the description is read at its well-known path once in five minutes, with no redirect followed, and the host's own client then holds the app's name and icon", async () => {
  const stack = stackWith({});
  const client = await hostClientOf(stack.env, HOST);
  using web = answers({ name: "Guestbook", icon: "/icon.svg", signIn: ["passkey"] });
  const before = Date.now();
  const app = await appOf(stack.env, ORIGIN);
  expect(app).toEqual({
    host: HOST,
    origin: ORIGIN,
    name: "Guestbook",
    icon: `${ORIGIN}/icon.svg`,
    members: false,
    signIn: ["passkey"],
    allowedEmails: null,
  });
  expect(await appOf(stack.env, ORIGIN)).toEqual(app);
  // the one address that is asked: no web app manifest is read
  expect(web).toMatchObject({ asked: [[DESCRIPTION, "manual"]] });
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
      using _web = answers({ name: "Guestbook", icon: "/icon.svg", for: "members" });
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
      signIn: FOR_MEMBERS,
      allowedEmails: null,
    });
    expect(stack.askedAgainIn(HOST, before)).toBe("1 minute");
    // and the client that the list of sign-ins reads still names the app
    expect(await oauthHelpers(stack.env, ORIGIN).lookupClient(client)).toMatchObject({
      clientName: "Guestbook",
      logoUri: `${ORIGIN}/icon.svg`,
    });
  },
);

test("a row that an issuer kept with a list of domains is read as the patterns of those domains, and never as any address, also while the app does not answer", async () => {
  const stack = stackWith({});
  const key = `iterate-app-description:${HOST}`;
  const row = (askAfter: number) =>
    JSON.stringify({
      name: "Shop",
      icon: null,
      members: false,
      signIn: FOR_ANYONE,
      emailDomains: ["example.com"],
      askAfter,
    });
  const patterns = { emails: [], patterns: ["*@example.com"] };
  // not due yet: the row is read as it is, and the app is not asked
  await stack.env.OAUTH_KV.put(key, row(Date.now() + 60_000));
  {
    using web = answers({ name: "Shop" });
    const app = (await appOf(stack.env, ORIGIN))!;
    expect(app).toMatchObject({ allowedEmails: patterns });
    expect(takesAddress(app, "eve@example.com")).toBe(true);
    expect(takesAddress(app, "eve@elsewhere.test")).toBe(false);
    expect(web).toMatchObject({ asked: [] });
  }
  // due, and the app does not answer: it is what the row said, in this issuer's shape
  await stack.env.OAUTH_KV.put(key, row(0));
  {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("down", { status: 503 }));
    using _down = { [Symbol.dispose]: () => spy.mockRestore() };
    expect(await appOf(stack.env, ORIGIN)).toMatchObject({ allowedEmails: patterns });
    expect(JSON.parse((await stack.env.OAUTH_KV.get(key))!)).toMatchObject({
      allowedEmails: patterns,
    });
  }
  // due, and the app still answers with its list of domains: the row's restriction stays
  stack.due(HOST);
  {
    using _web = answers({ name: "Shop", emailDomains: ["example.com"] });
    const before = Date.now();
    expect(await appOf(stack.env, ORIGIN)).toMatchObject({ allowedEmails: patterns });
    expect(stack.askedAgainIn(HOST, before)).toBe("1 minute");
  }
  // due, and the app answers with its list in this issuer's fields: that is what it is
  stack.due(HOST);
  using _web = answers({ name: "Shop", allowedEmails: ["eve@elsewhere.test"] });
  expect(await appOf(stack.env, ORIGIN)).toMatchObject({
    allowedEmails: { emails: ["eve@elsewhere.test"], patterns: [] },
  });
});

test("an app whose description is wrong is still what it last said, and is asked again after a minute; one that the issuer never heard takes the passkey alone until it says", async () => {
  const stack = stackWith({});
  {
    using _web = answers({ name: "Shop", allowedEmailPatterns: ["*@example.com"] });
    await appOf(stack.env, ORIGIN);
  }
  stack.due(HOST);
  const policyOf = async (origin: string) => {
    const app = (await appOf(stack.env, origin))!;
    return { signIn: app.signIn, allowedEmails: app.allowedEmails };
  };
  {
    // a list that is not whole, in a description that is otherwise right
    using _web = answers({ name: "Shop", for: "members", allowedEmailPatterns: ["@example.com"] });
    const before = Date.now();
    expect(await policyOf(ORIGIN)).toEqual({
      signIn: FOR_ANYONE,
      allowedEmails: { emails: [], patterns: ["*@example.com"] },
    });
    expect(stack.askedAgainIn(HOST, before)).toBe("1 minute");
  }
  // NOTHING IS KEPT OF THESE: the app's first answer is wrong, or it does not answer. The issuer
  // mails no code and takes no mailed code's session for an app that it has not heard.
  for (const [n, answer] of [
    () => Response.json({ name: "Shop", allowedEmailPatterns: ["@example.com"] }),
    () => new Response("down", { status: 503 }),
    () => new Response("too many requests", { status: 429 }),
    () => new Response('{"name":"Shop","allowedEmailPatterns":["*@exam'),
    () => Promise.reject(new Error("no answer")),
  ].entries()) {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
    using _down = { [Symbol.dispose]: () => spy.mockRestore() };
    const origin = `https://shop-${n}.${DOMAIN}`;
    expect(await policyOf(origin), String(n)).toEqual({ signIn: ["passkey"], allowedEmails: null });
    // and once it answers, it is what it says
    spy.mockImplementation(async () =>
      Response.json({ name: "Shop", allowedEmails: ["eve@a.example"] }),
    );
    stack.due(`shop-${n}.${DOMAIN}`);
    expect(await policyOf(origin), String(n)).toEqual({
      signIn: FOR_ANYONE,
      allowedEmails: { emails: ["eve@a.example"], patterns: [] },
    });
  }
});

test("an app that answers with no description any more has said so: it is its host again, for anyone", async () => {
  const stack = stackWith({});
  const client = await hostClientOf(stack.env, HOST);
  {
    using _web = answers({ name: "Guestbook", icon: "/icon.svg", signIn: ["passkey"] });
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
    signIn: FOR_ANYONE,
    allowedEmails: null,
  });
  expect(await oauthHelpers(stack.env, ORIGIN).lookupClient(client)).toMatchObject({
    clientName: HOST,
  });
});

test("an app that says nothing, or whose host does not answer, is its host and its initials, and that is kept too", async () => {
  const stack = stackWith({});
  using web = answers(null);
  const app = (await appOf(stack.env, ORIGIN))!;
  expect(app).toEqual({
    host: HOST,
    origin: ORIGIN,
    name: HOST,
    icon: null,
    members: false,
    signIn: FOR_ANYONE,
    allowedEmails: null,
  });
  expect(appTile(app)).toBe(`<div class="tile" data-app-mark="initials">GU</div>`);
  await appOf(stack.env, ORIGIN);
  expect(web.asked).toHaveLength(1);
});

test("a hostname that the stack holds nothing of is counted before it is asked: past the count it is not asked, and nothing is kept", async () => {
  const stack = stackWith({});
  using web = answers({ name: "Guestbook" });
  stack.admits(false);
  expect(await appOf(stack.env, ORIGIN)).toBeNull();
  expect(await signInOf(stack.env, `/oauth2/auth?resource=${ORIGIN}`)).toBeNull();
  expect(web).toMatchObject({ asked: [] });
  // a host with a client of its own is an app that the stack knows: it is asked whatever the count
  stack.admits(true);
  await hostClientOf(stack.env, HOST);
  stack.admits(false);
  expect(await appOf(stack.env, ORIGIN)).toMatchObject({ name: "Guestbook" });
});

test("the methods of a sign-in are those of the app that its authorization is for, whichever client asks; the app is named for its own sign-in alone", async () => {
  const stack = stackWith({
    [HOST]: { name: "Guestbook", icon: null, signIn: ["passkey"] },
  });
  const client = await hostClientOf(stack.env, HOST);
  const own = `/oauth2/auth?${new URLSearchParams({ client_id: client, redirect_uri: hostCallbackOf(ORIGIN), resource: ORIGIN })}`;
  expect(await signInOf(stack.env, own)).toMatchObject({
    app: { name: "Guestbook" },
    methods: ["passkey"],
  });
  // an MCP client that signs a person in to the app: its own client and callback, the app's server
  const mcp = `/oauth2/auth?${new URLSearchParams({ client_id: "an-mcp-client", redirect_uri: "http://127.0.0.1:4100/callback", resource: `${ORIGIN}/mcp` })}`;
  expect(await signInOf(stack.env, mcp)).toEqual({
    app: null,
    methods: ["passkey"],
    // a row that was kept before the issuer read `allowedEmails` names none
    mailedCode: expect.objectContaining({ name: "Guestbook", allowedEmails: null }),
  });
  // the control plane's own sign-in, and one for the mind's API or its MCP server
  for (const next of [
    "/",
    "/keys",
    `/oauth2/auth?resource=https://${MIND}/mcp`,
    "https://elsewhere.test/",
  ])
    expect(await signInOf(stack.env, next), next).toEqual({
      app: null,
      methods: FOR_MEMBERS,
      mailedCode: null,
    });
});

test("an app that names addresses and patterns takes a mailed code's session for an address that one of them names alone, by the rule that says who owns a mind; a passkey's session counts whatever its address", () => {
  const shop = {
    signIn: FOR_ANYONE as SignInMethod[],
    allowedEmails: {
      emails: ["guest@elsewhere.test"],
      patterns: ["*@example.com", "*@second.example"],
    },
  };
  const takes = (method: SignInMethod, email: string) => appTakes(shop, { method, email });
  expect({
    atAPattern: takes("email", "eve@example.com"),
    atTheOther: takes("email", "eve@second.example"),
    inCapitals: takes("email", "Eve@EXAMPLE.com"),
    named: takes("email", "guest@elsewhere.test"),
    namedInCapitals: takes("email", "Guest@Elsewhere.test"),
    // a subdomain is another domain, and so is a name that ends as the domain does
    atASubdomain: takes("email", "eve@mail.example.com"),
    atALookalike: takes("email", "eve@notexample.com"),
    twoAts: takes("email", "eve@elsewhere.test@example.com"),
    quotedLocalPart: takes("email", '"eve@example.com"@elsewhere.test'),
    // another address at the domain of a named address is not named
    besideTheNamed: takes("email", "eve@elsewhere.test"),
    passkeyElsewhere: takes("passkey", "ada@elsewhere.test"),
  }).toEqual({
    atAPattern: true,
    atTheOther: true,
    inCapitals: true,
    named: true,
    namedInCapitals: true,
    atASubdomain: false,
    atALookalike: false,
    twoAts: false,
    quotedLocalPart: false,
    besideTheNamed: false,
    passkeyElsewhere: true,
  });
  // THE SAME ANSWER AS THE MIND CONFIG'S OWN MATCHER, for every address above
  for (const email of [
    "eve@example.com",
    "Guest@Elsewhere.test",
    "eve@mail.example.com",
    "x@y@example.com",
  ])
    expect(takesAddress(shop, email), email).toBe(
      isOwnerEmail(
        { ownerEmails: shop.allowedEmails.emails, ownerEmailPatterns: shop.allowedEmails.patterns },
        email,
      ),
    );
  // the list binds the mailed code alone: a method that the app does not name is still refused,
  // and an app that names nobody takes any address
  expect(
    appTakes(
      { signIn: ["passkey"], allowedEmails: { emails: [], patterns: ["*@example.com"] } },
      { method: "email", email: "eve@example.com" },
    ),
  ).toBe(false);
  expect(takesAddress({ allowedEmails: null }, "eve@elsewhere.test")).toBe(true);
  // the pages' words name the domains of the patterns, and no address that the app names
  expect([
    allowedEmailsWords({ name: "Shop", ...shop }),
    allowedEmailsWords({
      name: "Shop",
      allowedEmails: { emails: [], patterns: ["*@example.com"] },
    }),
    allowedEmailsWords({
      name: "Shop",
      allowedEmails: { emails: ["guest@elsewhere.test"], patterns: [] },
    }),
    allowedEmailsWords({ name: "Shop", allowedEmails: null }),
  ]).toEqual([
    "Shop takes an address at example.com or second.example, and the addresses that it names, only.",
    "Shop takes an address at example.com only.",
    "Shop takes only the addresses that it names.",
    "",
  ]);
});

test("the mailed code's page for an app's sign-in names the host it signs in to, under the app's own icon", async () => {
  const stack = stackWith({ [HOST]: { name: "Guestbook", icon: `${ORIGIN}/icon.svg` } });
  const client = await hostClientOf(stack.env, HOST);
  const next = `/oauth2/auth?${new URLSearchParams({ client_id: client, redirect_uri: hostCallbackOf(ORIGIN), resource: ORIGIN })}`;
  const answer = await emailSignInResponse(
    stack.env,
    new Request(`https://${MIND}/sign-in/email?${new URLSearchParams({ next })}`),
  );
  const html = await answer!.text();
  expect(html).toContain(`<title>Sign in to Guestbook</title>`);
  // the app's icon is the card's one mark: no pair, and no mark of iterate's beside it. The
  // heading is the app's own name, and the line under it the host, which no app chooses.
  expect(html).toContain(
    `<main class="centered"><div class="tile" data-app-mark="icon"><img src="${ORIGIN}/icon.svg" alt="" referrerpolicy="no-referrer"></div><h1>Sign in to Guestbook</h1><p class="muted center">${HOST}</p>`,
  );
  expect(html).not.toMatch(/class="asks"|class="mark"|class="about"|is an app of/);
  // the mind's own line of who gets a code is not on an app's page
  expect(html).not.toContain("Anyone can sign in");
  // the one image the page may load is on the app's own origin
  expect(answer!.headers.get("content-security-policy")).toContain(`img-src data: ${ORIGIN}`);
  // a sign-in for the mind itself has no mailed code: its address page leads to its sign-in page
  const plain = await emailSignInResponse(
    stack.env,
    new Request(`https://${MIND}/sign-in/email?next=%2Fkeys`),
  );
  expect({ status: plain!.status, location: plain!.headers.get("location") }).toEqual({
    status: 303,
    location: "/sign-in?next=%2Fkeys",
  });
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
    allowedEmails: null,
    signIn: ["email", "passkey"] as SignInMethod[],
  };
  stack.challenge.next = next;
  const mailed = (path: string, headers?: HeadersInit) =>
    emailSignInResponse(stack.env, new Request(`https://${MIND}${path}`, { headers }));
  const pages = {
    address: await mailed(`/sign-in/email?${new URLSearchParams({ next })}`),
    code: await mailed("/sign-in/email/code", { cookie: "__Host-iterate-auth-code=abc" }),
    passkey: signInPage({
      mind: MIND,
      next,
      app,
      offersEmail: true,
      offersGuest: false,
      asksAtOpen: false,
      noPasskeyYet: false,
    }),
    chooser: chooserPage({ mind: MIND, email: "guest@example.net", here: next, app }),
  };
  for (const [name, answer] of Object.entries(pages)) {
    const html = await answer!.text();
    const page = `the ${name} page`;
    expect(html, page).toContain(
      `<div class="tile" data-app-mark="icon"><img src="${ORIGIN}/icon.svg"`,
    );
    expect(html, page).toContain(
      name === "code"
        ? "<h1>Enter your code</h1>"
        : `<h1>Sign in to Guestbook</h1><p class="muted center">${HOST}</p>`,
    );
    expect(html, page).not.toMatch(/class="about"|is an app of/);
    // the mind's own words for its own sign-in are not on an app's page
    expect(html, page).not.toContain(`Sign in to ${MIND}`);
    expect(html, page).not.toContain("Anyone can sign in");
    expect(answer!.headers.get("content-security-policy"), page).toContain(
      `img-src data: ${ORIGIN}`,
    );
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
  // an outside client's sign-in to the app is no page of the app's: the code's page is the mind's
  // own, with the mind's line of what a code gives
  stack.challenge.next = `/oauth2/auth?${new URLSearchParams({ client_id: "an-mcp-client", redirect_uri: "http://127.0.0.1:4100/callback", resource: `${ORIGIN}/mcp` })}`;
  const own = await (await mailed("/sign-in/email/code", {
    cookie: "__Host-iterate-auth-code=abc",
  }))!.text();
  expect(own).toContain(
    `<p class="muted">A code signs you in to the apps of ${MIND}, never to the mind itself. Members sign in with a passkey.</p>`,
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
    allowedEmails: null,
    signIn: ["passkey"] as SignInMethod[],
  };
  expect(appSignIn(dash)).toMatchObject({
    heading: `<h1>Sign in to Dash</h1><p class="muted center">dash.${DOMAIN}</p>`,
    about: `<p class="muted" data-for-members>It works as you: it can read and change everything that you can.</p>`,
  });
  expect(appSignIn({ ...dash, members: false })).toMatchObject({ about: "" });
});

test("the address page of an app for members that names the mailed code, as the app's own description makes it", async () => {
  const origin = `https://dash.${DOMAIN}`;
  const stack = stackWith({
    [`dash.${DOMAIN}`]: {
      name: "Dash",
      icon: `${origin}/icon.svg`,
      members: true,
      signIn: ["passkey", "email"],
    },
  });
  const client = await hostClientOf(stack.env, `dash.${DOMAIN}`);
  const next = `/oauth2/auth?${new URLSearchParams({ client_id: client, redirect_uri: hostCallbackOf(origin), resource: origin })}`;
  const answer = await emailSignInResponse(
    stack.env,
    new Request(`https://${MIND}/sign-in/email?${new URLSearchParams({ next })}`),
  );
  const html = await answer!.text();
  expect(html).toContain(`<h1>Sign in to Dash</h1><p class="muted center">dash.${DOMAIN}</p>`);
  expect(html).toContain("It works as you: it can read and change everything that you can.");
  expect(html).not.toContain("Anyone can sign in");
});

test("the passkey's page, the chooser and a consent for the app's host name the host, and a host is text", async () => {
  const app = {
    host: HOST,
    origin: ORIGIN,
    name: HOST,
    icon: null,
    members: false,
    allowedEmails: null,
    signIn: ["email", "passkey"] as SignInMethod[],
  };
  const passkey = await signInPage({
    mind: MIND,
    next: "/",
    app: { ...app, name: "<b>Guestbook</b>", host: `<b>${HOST}</b>` },
    offersEmail: true,
    offersGuest: false,
    asksAtOpen: false,
    noPasskeyYet: false,
  }).text();
  // an app's name and its host are text
  expect(passkey).toContain(
    `<h1>Sign in to &#60;b&#62;Guestbook&#60;/b&#62;</h1><p class="muted center">&#60;b&#62;${HOST}&#60;/b&#62;</p>`,
  );
  expect(passkey).not.toMatch(/<b>/);
  // an app with no icon has no tile of initials: iterate's mark is the card's one
  expect(passkey).toContain(`<main class="centered"><div class="mark"`);
  expect(passkey).not.toContain("data-app-mark");
  const guestbook = app;
  const chooser = await chooserPage({
    mind: MIND,
    email: "guest@example.net",
    here: "/oauth2/auth?client_id=c",
    app: guestbook,
  }).text();
  expect(chooser).toContain(`<h1>Sign in to ${HOST}</h1>`);
  expect(chooser).toContain(`<button type="submit">Continue as guest@example.net</button>`);
  // without an app, the chooser is the mind's own, as a member sees it
  const own = await chooserPage({ mind: MIND, email: "m@example.net", here: "/x" }).text();
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
    mind: MIND,
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
  said: Record<
    string,
    { name: string | null; icon: string | null; members?: boolean; signIn?: SignInMethod[] }
  >,
) {
  const keyOf = (host: string) => `iterate-app-description:${host}`;
  const kv = new Map<string, string>(
    Object.entries(said).map(([host, value]) => [
      keyOf(host),
      JSON.stringify({
        members: false,
        allowedEmails: null,
        signIn: FOR_ANYONE,
        ...value,
        askAfter: Date.now() + 5 * 60_000,
      }),
    ]),
  );
  // whether the count of new hostnames admits one more (./device/limits.ts `admitted`)
  let admits = true;
  const keptOf = (host: string) => JSON.parse(kv.get(keyOf(host))!) as { askAfter: number };
  // the one mailed code that waits, as the code's page reads it
  const challenge = { email: "guest@example.net", next: "/" };
  const env = {
    ...configVars(),
    OAUTH_KV: {
      get: async (key: string, type?: unknown) => {
        const kept = kv.get(key);
        return kept && type ? JSON.parse(kept) : kept || null;
      },
      put: async (key: string, value: string) => void kv.set(key, value),
    },
    DB: {
      prepare: (sql: string) => ({
        first: async () => ({ id: "test-member-passkey" }),
        bind: (...bound: unknown[]) => ({ sql, bound, first: async () => challenge }),
      }),
      // the admission of a new host client, or of a hostname that is asked about first
      batch: async () => [{}, { results: admits ? [{ admitted: 1 }] : [] }],
    },
  } as unknown as Env;
  return {
    env,
    challenge,
    admits: (more: boolean) => void (admits = more),
    /** The time has come to ask `host`'s app again. */
    due: (host: string) => kv.set(keyOf(host), JSON.stringify({ ...keptOf(host), askAfter: 0 })),
    /** How long after `since` the app is asked again, in whole minutes. */
    askedAgainIn(host: string, since: number) {
      const minutes = Math.round((keptOf(host).askAfter - since) / 60_000);
      return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    },
  };
}

/** The web for one test: every fetch answers `description` as JSON (null: a 404), and is
 *  recorded. */
function answers(description: object | null) {
  const asked: [string, string | undefined][] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    asked.push([String(input), init?.redirect]);
    return description ? Response.json(description) : new Response("Not found\n", { status: 404 });
  });
  return { asked, [Symbol.dispose]: () => spy.mockRestore() };
}
