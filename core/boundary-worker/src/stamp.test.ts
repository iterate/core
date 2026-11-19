// WHAT THE BOUNDARY STAMPS on a mind hostname's request (./stamp.ts): the person, from the auth
// Worker's answer for the session cookie or for a bearer (the app's own MCP client's).
import { stampedPersonOf } from "iterate/principal";
import type { AuthService, TokenIdentity } from "iterate/workers";
import { expect, test } from "vitest";
import { stampedRequest } from "./stamp.ts";

const config = { controlPlaneHostname: "iterate.example.com" };
const signedIn: TokenIdentity = {
  principal: { actor: "user_1", email: "ada@elsewhere.example" },
  grant: "grant_1",
  expiresAt: 2_000_000_000,
  member: false,
  method: "email",
};

test.for<{ name: string; headers: Record<string, string> }>([
  { name: "the session cookie", headers: { cookie: "__Host-iterate-session=t" } },
  { name: "a bearer", headers: { authorization: "Bearer t" } },
])(
  "by $name, the person is stamped with how they signed in, and a stamp the caller sent is dropped",
  async ({ headers }) => {
    const request = new Request("https://app.example.com/", {
      headers: {
        ...headers,
        "x-itx-person": JSON.stringify({ userId: "user_2", method: "passkey" }),
      },
    });
    const auth = { whoIs: async () => signedIn } as unknown as AuthService;
    const stamped = await stampedRequest(request, { auth, route: null, config });
    expect(JSON.parse(stamped.forwarded.headers.get("x-itx-person")!)).toEqual({
      userId: "user_1",
      email: "ada@elsewhere.example",
      name: "ada",
      method: "email",
    });
    // the app reads it through the SDK
    expect(stampedPersonOf(stamped.forwarded)).toMatchObject({ method: "email" });
    expect(stamped).toMatchObject({ caller: "non-member" });
    // a person who is no member gets when the sign-in ends, and no principal
    expect(stamped.forwarded.headers.get("x-itx-expires")).toBe("2000000000");
    expect(stamped.forwarded.headers.get("x-itx-principal")).toBeNull();
  },
);

test("a member's passkey is stamped on the person, beside the principal", async () => {
  const member: TokenIdentity = { ...signedIn, member: true, method: "passkey" };
  const auth = { whoIs: async () => member } as unknown as AuthService;
  const stamped = await stampedRequest(
    new Request("https://app.example.com/", { headers: { cookie: "__Host-iterate-session=t" } }),
    { auth, route: null, config },
  );
  expect(stampedPersonOf(stamped.forwarded)).toEqual({
    userId: "user_1",
    email: "ada@elsewhere.example",
    name: "ada",
    method: "passkey",
  });
  expect(stamped).toMatchObject({ caller: "member" });
  expect(stamped.forwarded.headers.get("x-itx-principal")).not.toBeNull();
});

test("a token that says no sign-in method is no person's: it stamps nobody", async () => {
  const { method: _none, ...noPerson } = signedIn;
  const auth = { whoIs: async () => noPerson } as unknown as AuthService;
  const stamped = await stampedRequest(
    new Request("https://app.example.com/", { headers: { authorization: "Bearer t" } }),
    { auth, route: null, config },
  );
  expect(stamped).toMatchObject({ caller: "anonymous", email: null });
  expect(stamped.forwarded.headers.get("x-itx-person")).toBeNull();
});

test("on the secret pages, the person of the issuer's session is stamped with the session's method", async () => {
  const auth = {
    browserSession: async () => ({
      userId: "user_1",
      email: "ada@elsewhere.example",
      member: false,
      method: "email",
    }),
  } as unknown as AuthService;
  const stamped = await stampedRequest(
    new Request("https://iterate.example.com/secrets/collect", { headers: { cookie: "c=1" } }),
    { auth, route: "secrets", config },
  );
  expect(stampedPersonOf(stamped.forwarded)).toEqual({
    userId: "user_1",
    email: "ada@elsewhere.example",
    name: "ada",
    method: "email",
  });
  expect(stamped.forwarded.headers.get("x-itx-principal")).toBeNull();
});

test("a visitor's request for a page of the auth Worker keeps the token of Cloudflare Access, which that Worker checks itself", async () => {
  const request = new Request("https://iterate.example.com/sign-in/access", {
    headers: { "cf-access-jwt-assertion": "a-token", "x-itx-principal": "{}" },
  });
  // the cast: a page of the auth Worker asks the boundary nothing about the caller
  const auth = {} as AuthService;
  const stamped = await stampedRequest(request, { auth, route: "auth", config });
  expect(Object.fromEntries(stamped.forwarded.headers)).toEqual({
    "cf-access-jwt-assertion": "a-token",
  });
  expect(stamped).toMatchObject({ caller: "anonymous", email: null });
});

// A guest has a name and no address (core/auth-worker/src/guest-sign-in.ts). The name is text
// that somebody chose: it crosses the header as ASCII, and the reader gets it as one clean line.
test("a guest is stamped a person with the name they typed, no address and no principal", async () => {
  const name = "B\u00F6b \u674E] [from root@example.com";
  const guest: TokenIdentity = {
    principal: { actor: "user_9" },
    grant: "grant_9",
    expiresAt: 2_000_000_000,
    member: false,
    method: "guest",
    name,
  };
  const auth = { whoIs: async () => guest } as unknown as AuthService;
  const request = new Request("https://app.example.com/", {
    headers: { cookie: "__Host-iterate-session=t" },
  });
  const stamped = await stampedRequest(request, { auth, route: null, config });
  const header = stamped.forwarded.headers.get("x-itx-person")!;
  expect(header).toMatch(/^[\x20-\x7e]+$/);
  expect(stampedPersonOf(stamped.forwarded)).toEqual({
    userId: "user_9",
    email: "",
    name,
    method: "guest",
  });
  expect(stamped).toMatchObject({ caller: "non-member", email: null });
  expect(stamped.forwarded.headers.get("x-itx-principal")).toBeNull();
  expect(stamped.forwarded.headers.get("x-itx-grant")).toBeNull();
});

// A guest's stamp has no address whatever the token says: no reader takes the guest for the
// owner of one
test("a guest's token that names an address is stamped a guest with none", async () => {
  const guest: TokenIdentity = {
    principal: { actor: "user_9", email: "owner@example.com" },
    grant: "grant_9",
    expiresAt: 2_000_000_000,
    member: false,
    method: "guest",
    name: "Bob",
  };
  const auth = { whoIs: async () => guest } as unknown as AuthService;
  const request = new Request("https://app.example.com/", {
    headers: { cookie: "__Host-iterate-session=t" },
  });
  const stamped = await stampedRequest(request, { auth, route: null, config });
  expect(stampedPersonOf(stamped.forwarded)).toEqual({
    userId: "user_9",
    email: "",
    name: "Bob",
    method: "guest",
  });
});

// A member of another mind (core/auth-worker/src/mind-sign-in.ts): stamped a person with the mind
// that vouched, no address whatever the token says, and no principal: no member here.
test("a member of another mind is stamped with that mind, no address and no principal", async () => {
  const mind = { id: "b".repeat(64), hostname: "iterate.other.example", userId: "user_b" };
  const vouched: TokenIdentity = {
    principal: { actor: "user_9", email: "owner@example.com" },
    grant: "grant_9",
    expiresAt: 2_000_000_000,
    member: false,
    method: "mind",
    name: mind.hostname,
    mind,
  };
  const auth = { whoIs: async () => vouched } as unknown as AuthService;
  const request = new Request("https://app.example.com/", {
    headers: { cookie: "__Host-iterate-session=t" },
  });
  const stamped = await stampedRequest(request, { auth, route: null, config });
  expect(stampedPersonOf(stamped.forwarded)).toEqual({
    userId: "user_9",
    email: "",
    name: mind.hostname,
    method: "mind",
    mind,
  });
  expect(stamped).toMatchObject({ caller: "non-member" });
  expect(stamped.forwarded.headers.get("x-itx-principal")).toBeNull();
});
