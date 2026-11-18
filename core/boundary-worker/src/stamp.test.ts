// THE PERSON INGRESS STAMPS on a mind hostname's request (./stamp.ts): who they are and how they
// signed in, from the auth Worker's answer for the session cookie or for a bearer, the app's own
// MCP client's. The app's guard reads the way (iterate/sdk `auth.requirePerson`).
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
