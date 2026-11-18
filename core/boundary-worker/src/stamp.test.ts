// THE PERSON INGRESS STAMPS on a mind hostname's request (./stamp.ts): who they are and how they
// signed in, from the auth Worker's answer for the session cookie or for a bearer, the app's own
// MCP client's. The app's guard reads the way (iterate/sdk `auth.requirePerson`).
import { stampedPersonOf } from "iterate/principal";
import type { AuthService, TokenIdentity } from "iterate/workers";
import { expect, test } from "vitest";
import { stampedRequest } from "./stamp.ts";

const signedIn: TokenIdentity = {
  principal: { actor: "user_1", email: "ada@example.org" },
  grant: "grant_1",
  expiresAt: 2_000_000_000,
  member: false,
  method: "cloudflare",
};

test.for<{ name: string; headers: Record<string, string>; identity: TokenIdentity }>([
  {
    name: "the session cookie",
    headers: { cookie: "__Host-iterate-session=t" },
    identity: signedIn,
  },
  { name: "a bearer", headers: { authorization: "Bearer t" }, identity: signedIn },
  {
    name: "a grant from before grants kept their way",
    headers: { cookie: "__Host-iterate-session=t" },
    identity: { ...signedIn, method: undefined },
  },
])("by $name, the person is stamped with the way they signed in", async ({ headers, identity }) => {
  // a stamp the caller sent is dropped, whatever way it claims
  const request = new Request("https://app.example.com/", {
    headers: {
      ...headers,
      "x-itx-person": JSON.stringify({ userId: "user_2", method: "passkey" }),
    },
  });
  const auth = { whoIs: async () => identity } as unknown as AuthService;
  const stamped = await stampedRequest(request, { auth, route: null, domain: "example.com" });
  expect(JSON.parse(stamped.forwarded.headers.get("x-itx-person")!)).toEqual({
    userId: "user_1",
    email: "ada@example.org",
    name: "ada",
    method: identity.method,
  });
  expect(stamped).toMatchObject({ caller: "non-member", method: identity.method });
  // a person who is no member gets when the sign-in ends, and no principal
  expect(stamped.forwarded.headers.get("x-itx-expires")).toBe("2000000000");
  expect(stamped.forwarded.headers.get("x-itx-principal")).toBeNull();
});

// The secret pages are on the platform's hostname, where the issuer's own session says who is there.
test.for([
  { name: "a member", member: true },
  { name: "a person who is no member", member: false },
])("on a secret page, $name is stamped a person with a name", async ({ member }) => {
  const session = { userId: "user_1", email: "ada.lovelace@example.org", member };
  const auth = { browserSession: async () => session } as unknown as AuthService;
  const request = new Request("https://iterate.example.com/secrets/x", {
    headers: { cookie: "__Host-iterate-auth-session=t" },
  });
  const stamped = await stampedRequest(request, { auth, route: "secrets", domain: "example.com" });
  expect(JSON.parse(stamped.forwarded.headers.get("x-itx-person")!)).toEqual({
    userId: "user_1",
    email: "ada.lovelace@example.org",
    name: "ada.lovelace",
  });
  // the name is the person's alone: a member's principal has none
  expect(JSON.parse(stamped.forwarded.headers.get("x-itx-principal") || "null")).toEqual(
    member ? { actor: "user_1", email: "ada.lovelace@example.org" } : null,
  );
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
  const stamped = await stampedRequest(request, { auth, route: null, domain: "example.com" });
  const header = stamped.forwarded.headers.get("x-itx-person")!;
  expect(header).toMatch(/^[\x20-\x7e]+$/);
  expect(stampedPersonOf(stamped.forwarded)).toEqual({
    userId: "user_9",
    email: "",
    name,
    method: "guest",
  });
  expect(stamped).toMatchObject({ caller: "non-member", email: null, method: "guest" });
  expect(stamped.forwarded.headers.get("x-itx-principal")).toBeNull();
  expect(stamped.forwarded.headers.get("x-itx-grant")).toBeNull();
});

// A sandbox's own session is served by its egress, inside the mind Worker
// (core/mind-worker/src/sandbox/own-session.ts). The internet's way to the API stays this one: no
// bearer, no caller, whatever else the request says.
test("the mind's API from the internet with no bearer is refused here, whatever it claims", async () => {
  let asked = 0;
  const auth = {
    whoIs: async () => {
      asked += 1;
      return null;
    },
  } as unknown as AuthService;
  const request = new Request("https://iterate.example.com/api", {
    headers: {
      upgrade: "websocket",
      "x-itx-principal": JSON.stringify({ actor: "user_1" }),
      "x-itx-caller-path": "/agents/ada/box",
      "x-itx-app": "1",
      "x-iterate-sandbox-session-refused": "no",
      cookie: "__Host-iterate-session=t",
    },
  });
  const stamped = await stampedRequest(request, { auth, route: "api", domain: "example.com" });
  expect(stamped).toMatchObject({ answer: { status: 401 }, caller: "anonymous" });
  // nothing a caller sent as a stamp goes on, and no credential was there to ask about
  expect([...stamped.forwarded.headers.keys()].filter((name) => name.startsWith("x-itx-"))).toEqual(
    [],
  );
  expect(asked).toBe(0);
});
