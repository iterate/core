// The mind's own logo at the head of the sign-in and consent pages (./mind-mark.ts): what the
// issuer takes from the mind's profile, how long it keeps it, and how the pages show it.
import { expect, test, vi } from "vitest";
import type { Env } from "./env.ts";
import { mindMarkOf } from "./mind-mark.ts";
import { consentPage, signInPage } from "./pages.ts";
import { configVars } from "./test-support.ts";

const WEBSITE = "https://example.com";
const ICON = `${WEBSITE}/favicon.svg`;
const TILE = `<div class="tile" data-mind-mark="icon"><img src="${ICON}" alt="" referrerpolicy="no-referrer"></div>`;

test("the mind's logo is the icon of its website's profile, read once in five minutes with no redirect followed", async () => {
  const stack = stackOf();
  using web = answers(() => Response.json({ name: "Ada's mind", description: "", icon: ICON }));
  expect(await mindMarkOf(stack.env)).toEqual({ html: TILE, origin: WEBSITE });
  expect(await mindMarkOf(stack.env)).toEqual({ html: TILE, origin: WEBSITE });
  expect(web).toMatchObject({
    asked: [{ url: `${WEBSITE}/.well-known/iterate-profile`, redirect: "manual" }],
  });
});

test.for([
  { name: "a mind with no icon", answer: () => Response.json({ name: "Ada", icon: null }) },
  { name: "a website with no profile", answer: () => new Response("Not found", { status: 404 }) },
  // the website's own origin over https, and nothing else
  ...[
    "https://elsewhere.test/logo.svg",
    "https://sub.example.com/logo.svg",
    "http://example.com/favicon.svg",
    "//elsewhere.test/logo.svg",
    "/favicon.svg",
    "javascript:alert(1)",
    `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>`,
  ].map((icon) => ({ name: `an icon at ${icon}`, answer: () => Response.json({ icon }) })),
])("$name is no logo: the pages show iterate's mark", async ({ answer }) => {
  const stack = stackOf();
  using _web = answers(answer);
  expect(await mindMarkOf(stack.env)).toBeNull();
});

test.for([
  { name: "a 503", answer: () => new Response("down", { status: 503 }) },
  { name: "a redirect", answer: () => new Response(null, { status: 302 }) },
  { name: "no answer", answer: () => Promise.reject(new Error("no answer")) },
  { name: "a text that is no JSON", answer: () => new Response("<!doctype html>") },
  { name: "an object that is no profile", answer: () => Response.json({ icon: 7 }) },
])(
  "a website that answers with $name has said nothing new: the logo is what it was, and the website is asked again after a minute",
  async ({ answer }) => {
    const stack = stackOf();
    // nothing kept yet: no logo, and the next page does not ask again
    {
      using web = answers(answer);
      expect(await mindMarkOf(stack.env)).toBeNull();
      expect(await mindMarkOf(stack.env)).toBeNull();
      expect(web.asked).toHaveLength(1);
    }
    // a logo that was kept stays
    stack.keep({ icon: ICON, askAfter: 0 });
    using _web = answers(answer);
    const before = Date.now();
    expect(await mindMarkOf(stack.env)).toMatchObject({ html: TILE });
    await stack.asked();
    expect(stack.kept()).toMatchObject({ icon: ICON });
    expect(Math.round((stack.kept().askAfter - before) / 60_000)).toBe(1);
  },
);

test("a page that finds the logo older than five minutes shows what is kept and waits for nothing: the website is asked after the answer", async () => {
  const stack = stackOf();
  stack.keep({ icon: ICON, askAfter: 0 });
  let answered = () => {};
  const slow = new Promise<void>((resolve) => (answered = resolve));
  using web = answers(async () => {
    await slow;
    return Response.json({ icon: null });
  });
  // the page has its logo while the website has not answered yet
  expect(await mindMarkOf(stack.env)).toMatchObject({ html: TILE });
  expect(web.asked).toHaveLength(1);
  answered();
  await stack.asked();
  // the website took its icon away: the next page shows iterate's mark
  expect(await mindMarkOf(stack.env)).toBeNull();
});

test("a logo never stops a page: a store that fails at the read or at the write, and a profile that is too long, leave iterate's mark or the logo that was read", async () => {
  const profile = () => Response.json({ icon: ICON });
  // the store does not answer: no logo, and no error
  {
    const stack = stackOf();
    stack.env.OAUTH_KV.get = () => Promise.reject(new Error("the store is down"));
    using _web = answers(profile);
    expect(await mindMarkOf(stack.env)).toBeNull();
  }
  // the row cannot be written: this page has the logo that was read
  {
    const stack = stackOf();
    stack.env.OAUTH_KV.put = () => Promise.reject(new Error("too many writes of one key"));
    using _web = answers(profile);
    expect(await mindMarkOf(stack.env)).toMatchObject({ html: TILE });
  }
  // a profile over the bound is read no further than the bound, and is no word of the website
  const stack = stackOf();
  let sent = 0;
  let cancelled = false;
  using _web = answers(
    () =>
      new Response(
        new ReadableStream({
          pull(stream) {
            sent += 1;
            stream.enqueue(new TextEncoder().encode(" ".repeat(8_000)));
          },
          cancel: () => void (cancelled = true),
        }),
      ),
  );
  expect(await mindMarkOf(stack.env)).toBeNull();
  expect({ cancelled, readNoFurther: sent < 6 }).toEqual({ cancelled: true, readNoFurther: true });
});

test("a kept row is read again as it is shown: an icon of another origin in it is no logo", async () => {
  const stack = stackOf();
  stack.keep({ icon: "https://elsewhere.test/logo.svg", askAfter: Date.now() + 60_000 });
  expect(await mindMarkOf(stack.env)).toBeNull();
});

test("the consent page and the mind's sign-in page show the mind's logo where iterate's mark was, and the page's policy allows its one origin beside the client's", async () => {
  const mindMark = { html: TILE, origin: WEBSITE };
  const consent = (mark: typeof mindMark | null, details: object = {}) =>
    consentPage({
      details: {
        clientName: "Claude",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        redirectHost: "claude.ai",
        redirectIsLoopback: false,
        ...details,
      } as never,
      handle: "handle",
      email: "owner@example.net",
      mind: "iterate.example.com",
      mindMark: mark,
      resource: "its MCP server",
      here: "/oauth2/auth?client_id=c&state=s",
      headers: new Headers(),
    });
  const withLogo = consent(mindMark);
  expect(withLogo.headers.get("content-security-policy")?.split("; ")).toContain(
    `img-src data: ${WEBSITE}`,
  );
  const html = await withLogo.text();
  // the mind's logo, the dotted line, the client's tile: and no mark of iterate's
  expect(html).toContain(`<div class="asks">${TILE}<span class="joins" aria-hidden="true"></span>`);
  expect(html).not.toContain(`class="mark"`);
  // a mind with no logo is as before
  expect(await consent(null).text()).toContain(`<div class="asks"><div class="mark"`);
  // a client with a logo of its own: both origins, and both pictures
  const both = consent(mindMark, {
    clientName: "Notes",
    redirectUri: "https://notes.example.org/callback",
    redirectHost: "notes.example.org",
    clientDomain: "example.org",
    logoUri: "https://cdn.example.org/logo.png",
  });
  expect(both.headers.get("content-security-policy")?.split("; ")).toContain(
    `img-src data: https://cdn.example.org ${WEBSITE}`,
  );
  expect(await both.text()).toContain(
    `${TILE}<span class="joins" aria-hidden="true"></span><div class="tile" data-client-mark="logo">`,
  );
  // a client with no tile: the mind's logo is the card's one mark
  const alone = consent(mindMark, {
    clientName: "Notes",
    redirectUri: "https://notes.example.org/callback",
    redirectHost: "notes.example.org",
  });
  expect(await alone.text()).toContain(`<main class="centered">${TILE}<h1>`);

  const signIn = (mark: typeof mindMark | null) =>
    signInPage({
      mind: "iterate.example.com",
      mindMark: mark,
      next: "/oauth2/auth?client_id=c",
      app: null,
      offersEmail: false,
      offersGuest: false,
      asksAtOpen: false,
      noPasskeyYet: false,
    }).text();
  expect(await signIn(mindMark)).toContain(`<main class="centered">${TILE}<h1>Sign in to`);
  expect(await signIn(null)).toContain(`<main class="centered"><div class="mark"`);
});

type Kept = { icon: string | null; askAfter: number };

/** A mind at `iterate.example.com` whose website is `https://example.com`, with the issuer's KV
 *  as a map. */
function stackOf() {
  const kv = new Map<string, string>();
  // the cast: the logo's code reads the config and this one binding
  const env = {
    ...configVars(),
    OAUTH_KV: {
      get: async (key: string) => JSON.parse(kv.get(key) || "null"),
      put: async (key: string, value: string) => void kv.set(key, value),
    },
  } as unknown as Env;
  return {
    env,
    keep: (row: Kept) => void kv.set("iterate-mind-mark", JSON.stringify(row)),
    kept: () => JSON.parse(kv.get("iterate-mind-mark")!) as Kept,
    // what a page left to run after its answer has written its row
    asked: () =>
      vi.waitFor(() =>
        expect(JSON.parse(kv.get("iterate-mind-mark")!).askAfter).toBeGreaterThan(0),
      ),
  };
}

/** The web for a test: every request gets `answer`, and `asked` lists them. */
function answers(answer: () => Response | Promise<Response>) {
  const asked: { url: string; redirect?: string }[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    asked.push({ url: String(input), redirect: init?.redirect });
    return answer();
  });
  return { asked, [Symbol.dispose]: () => spy.mockRestore() };
}
