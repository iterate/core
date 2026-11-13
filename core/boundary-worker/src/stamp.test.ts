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
    method: identity.method,
  });
  expect(stamped).toMatchObject({ caller: "non-member", method: identity.method });
});
