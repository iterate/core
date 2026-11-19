// A PLACEHOLDER FROM OUTSIDE NEVER REACHES A MIND'S CODE IN A HEADER (iterate/secret-placeholder
// `withoutOutsidePlaceholders`): a header that holds one is taken off, of `cookie` only its pairs
// that hold one, on every hostname. No URL is refused.
import { isHostOnlyCookiePair } from "iterate/secret-placeholder";
import type { AuthService } from "iterate/workers";
import { expect, test } from "vitest";
import { boundaryResponse, type MindTransport } from "./http.ts";
import { PLATFORM_COOKIE_NAMES, sessionTokenOf } from "./session-cookies.ts";

const PLACEHOLDER = 'getSecret("/secrets/openai")';

test("each header that holds a placeholder, as written, percent-encoded or inside a Basic credential, is taken off, and the rest of the request arrives", async () => {
  const stack = stackOf();
  const answer = await stack.answered("https://app.example.com/relay", {
    method: "POST",
    body: "the body",
    headers: {
      "x-literal": `Bearer ${PLACEHOLDER}`,
      "x-encoded": "getSecret(%22/secrets/openai%22)",
      "x-basic": `Basic ${btoa(`user:${PLACEHOLDER}`)}`,
      "x-plain": "kept",
      authorization: `Basic ${btoa("user:password")}`,
    },
  });
  expect(answer).toMatchObject({ status: 200 });
  expect(stack).toMatchObject({
    reached: [
      {
        url: "https://app.example.com/relay",
        body: "the body",
        headers: expect.objectContaining({
          "x-plain": "kept",
          // an ordinary Basic credential with no placeholder passes untouched
          authorization: `Basic ${btoa("user:password")}`,
        }),
      },
    ],
  });
  const arrived = stack.reached[0]?.headers ?? {};
  for (const name of ["x-literal", "x-encoded", "x-basic"])
    expect(arrived).not.toHaveProperty(name);
});

test("a URL that holds the words of a placeholder is refused nowhere: a search for them reaches the mind", async () => {
  const stack = stackOf();
  const answer = await stack.answered(`https://app.example.com/search?q=${PLACEHOLDER}`);
  expect(answer).toMatchObject({ status: 200 });
  expect(stack.reached).toHaveLength(1);
});

test("of the cookie header only the pairs that hold a placeholder go: the session and every other cookie arrive", async () => {
  const stack = stackOf();
  await stack.answered("https://app.example.com/", {
    headers: { cookie: `app=kept; tossed=${PLACEHOLDER}; other=too` },
  });
  expect(stack.reached[0]?.headers).toMatchObject({ cookie: "app=kept; other=too" });
  const only = stackOf();
  await only.answered("https://app.example.com/", { headers: { cookie: `tossed=${PLACEHOLDER}` } });
  expect(only.reached[0]?.headers).not.toHaveProperty("cookie");
});

test("a cookie header that still names a secret once its pairs are taken out, by egress's own reading, goes whole", async () => {
  const basic = `Basic ${btoa(`u:${PLACEHOLDER}`)}`;
  for (const [cookie, arrives] of [
    // a ";" inside a quoted value: what is left names no secret, so it arrives
    [`b="left;${PLACEHOLDER}"; a=1`, 'b="left; a=1'],
    // a ";" inside the placeholder's field: each piece alone names none, the rebuilt header does
    [`x=getSecret("/secrets/openai", { field: "a;b" }); a=1`, undefined],
    // the whole header as one Basic credential
    [basic, undefined],
  ] as const) {
    const stack = stackOf();
    await stack.answered("https://app.example.com/", { headers: { cookie } });
    expect({ cookie, arrives: stack.reached[0]?.headers.cookie }).toEqual({ cookie, arrives });
  }
});

test("the cookie header is read again as it goes to the app, once the reserved cookies are out: a Basic credential left beside the session, or before an empty pair, goes whole", async () => {
  const basic = `Basic ${btoa(`u:${PLACEHOLDER}`)}`;
  for (const cookie of [
    `${basic}; __Host-iterate-session=x`,
    `${basic}; __Host-iterate-session=x; `,
  ])
    for (const by of ["a person's request", "a mind's signed request"] as const) {
      const stack = stackOf();
      const headers: Record<string, string> =
        by === "a mind's signed request"
          ? { cookie, "iterate-auth-statement": "signed" }
          : { cookie };
      await stack.answered("https://app.example.com/", { headers });
      expect({ cookie, by, arrives: stack.reached[0]?.headers.cookie }).toEqual({
        cookie,
        by,
        arrives: undefined,
      });
      // the stamp is what this test thinks it is
      if (by === "a mind's signed request")
        expect(stack.reached[0]?.headers).toHaveProperty("x-itx-mind");
    }
});

test("the fallback keeps a __Host- pair alone, which no other hostname can set, and every cookie name of the boundary has the prefix", () => {
  for (const name of PLATFORM_COOKIE_NAMES) {
    expect(name).toMatch(/^__Host-/);
    expect(isHostOnlyCookiePair(`${name}=v`)).toBe(true);
  }
  // the auth Worker's own, on the control plane (core/auth-worker/src/cookies.ts)
  expect(isHostOnlyCookiePair(" __Host-iterate-auth-session=v")).toBe(true);
  for (const pair of ["iterate-session=v", "__Secure-iterate-session=v", "__Host-iterate-session"])
    expect(isHostOnlyCookiePair(pair)).toBe(false);
});

test("a non-breaking space before __Host- is another name on the wire: it is no __Host- pair and no session; space and tab around a pair are trimmed", () => {
  const nbsp = "\u00a0";
  expect(isHostOnlyCookiePair(`${nbsp}__Host-iterate-session=v`)).toBe(false);
  expect(isHostOnlyCookiePair(" \t__Host-iterate-session=v")).toBe(true);
  const planted = new Request("https://app.example.com/", {
    headers: { cookie: `${nbsp}__Host-iterate-session=planted` },
  });
  expect(sessionTokenOf(planted)).toBe(null);
  const own = new Request("https://app.example.com/", {
    headers: { cookie: "app=1;\t__Host-iterate-session=own " },
  });
  expect(sessionTokenOf(own)).toBe("own");
});

test("on the control plane the auth Worker's session survives a split placeholder beside it; two __Host- pairs a host planted itself leave no cookie", async () => {
  const split = `x=getSecret("/secrets/openai", { field: "a;b" })`;
  const issuer = "__Host-iterate-auth-session=issuer-token";
  const stack = stackOf();
  await stack.answered("https://iterate.example.com/auth/x", {
    headers: { cookie: `${issuer}; app=1; ${split}` },
  });
  // the auth Worker gets its own cookie, so the member is signed in on that page
  expect(stack.reachedAuth[0]).toMatchObject({ cookie: issuer });
  const own = stackOf();
  await own.answered("https://iterate.example.com/auth/x", {
    headers: { cookie: `__Host-a=getSecret("/secrets/openai", { field: "a;__Host-b=b" })` },
  });
  expect(own.reachedAuth[0]).not.toHaveProperty("cookie");
});

test("a planted cookie never signs a member out: when what is left still names a secret, only the __Host- pairs that name none stay", async () => {
  const session = "__Host-iterate-session=member-token";
  for (const [cookie, arrives] of [
    // one planted pair goes alone, as before
    [`${session}; app=kept; tossed=${PLACEHOLDER}`, "app=kept"],
    // a placeholder split over two planted pairs
    [`${session}; app=kept; x=getSecret("/secrets/openai", { field: "a;b" })`, undefined],
    // a planted Basic form, which names a secret once the session is out
    [`Basic ${btoa(`u:${PLACEHOLDER}`)}; ${session}`, undefined],
  ] as const) {
    const stack = stackOf({ member: true });
    await stack.answered("https://app.example.com/", { headers: { cookie } });
    expect({ cookie, arrives: stack.reached[0]?.headers.cookie }).toEqual({ cookie, arrives });
    // the member is still signed in, by their own session alone
    expect(stack.reached[0]?.headers).toHaveProperty("x-itx-principal");
    expect(stack).toMatchObject({ tokens: ["member-token"] });
  }
});

test("on the control plane's routes too, a header that holds a placeholder is taken off", async () => {
  const stack = stackOf();
  await stack.answered("https://iterate.example.com/auth/x", {
    headers: { "x-literal": PLACEHOLDER, "x-plain": "kept" },
  });
  expect(stack).toMatchObject({ reachedAuth: [{ "x-plain": "kept" }] });
  expect(stack.reachedAuth[0]).not.toHaveProperty("x-literal");
});

/** A stack whose mind and auth Worker record what reaches them. No one is signed in. */
function stackOf({ member = false } = {}) {
  const tokens: string[] = [];
  const reached: { url: string; body: string; headers: Record<string, string> }[] = [];
  const reachedAuth: Record<string, string>[] = [];
  const env = {
    ITERATE: JSON.stringify({
      mindId: "a".repeat(64),
      controlPlaneHostname: "iterate.example.com",
      zones: ["example.com"],
      ownerEmails: ["ada@elsewhere.example"],
      topology: "full-cloudflare",
    }),
    AUTH: {
      fetch: async (request: Request) => {
        reachedAuth.push(Object.fromEntries(request.headers));
        return new Response("the auth Worker's");
      },
      // a member's session, when the test has one
      whoIs: async (token: string) => {
        tokens.push(token);
        return member && token === "member-token"
          ? {
              principal: { actor: "user_1", email: "ada@elsewhere.example" },
              grant: "grant_1",
              expiresAt: 2_000_000_000,
              member: true,
              method: "passkey",
            }
          : null;
      },
      // a signed request from another mind that its check accepts
      mindOfSignedRequest: async () => ({
        principal: { actor: "b".repeat(64), kind: "mind", hostname: "iterate.sender.example" },
        expiresAt: 2_000_000_000,
      }),
    } as Partial<AuthService>,
  } as Parameters<typeof boundaryResponse>[1];
  const mind = {
    fetch: async (request: Request) => {
      reached.push({
        url: request.url,
        body: await request.text(),
        headers: Object.fromEntries(request.headers),
      });
      return new Response("the mind's own");
    },
    append: async () => {},
  } as Partial<MindTransport> as MindTransport;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  return {
    reached,
    reachedAuth,
    tokens,
    answered: (url: string, init: RequestInit = {}) =>
      boundaryResponse(new Request(url, init), env, ctx, mind),
  };
}
