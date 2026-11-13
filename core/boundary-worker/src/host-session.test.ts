import { expect, test } from "vitest";
import type { AuthService } from "iterate/workers";
import { mindHostResponse } from "./host-session.ts";

// why the redirects stay on the host: `signedOutPage` in ./host-session.ts
test("a sign-out ends on a page of its own host, which then goes on to the sign-in", async () => {
  const auth = {
    whoIs: async () => null,
    hostClient: async () => "client-1",
  } as unknown as AuthService;
  const deps = { auth, domain: "mind.example", recordFacts: (response: Response) => response };
  // the app's guard, as `auth.requirePerson` answers a browser with no session
  const forward = async () =>
    new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="iterate", acr_values="cloudflare"' },
    });
  const signOut = await mindHostResponse(
    new Request("https://cloud.mind.example/.iterate/sign-out", {
      method: "POST",
      headers: { origin: "https://cloud.mind.example", cookie: "__Host-iterate-session=token" },
    }),
    deps,
    forward,
  );
  expect(signOut).toMatchObject({ status: 303 });
  expect(signOut.headers.getSetCookie()).toEqual([
    expect.stringMatching(/^__Host-iterate-session=; .*Max-Age=0$/),
    expect.stringMatching(/^__Host-iterate-signed-out=1; /),
  ]);
  const landing = new URL(signOut.headers.get("location")!, "https://cloud.mind.example/");
  expect(landing).toMatchObject({ origin: "https://cloud.mind.example" });
  const signedOut = await mindHostResponse(
    new Request(landing, { headers: { accept: "text/html" } }),
    deps,
    forward,
  );
  expect(signedOut).toMatchObject({ status: 200 });
  expect(signedOut.headers.get("cache-control")).toBe("no-store");
  const page = await signedOut.text();
  expect(page).toContain('<meta http-equiv="refresh" content="0;url=/">');
  expect(page).toContain("You are signed out of cloud.mind.example.");
});

test("a person who is no member reads who they are, and can change the account", async () => {
  const auth = {
    whoIs: async () => ({
      principal: { actor: "user-1", email: "ada@sender.example" },
      grant: "grant-1",
      expiresAt: 0,
      member: false,
    }),
  } as unknown as AuthService;
  const answer = await mindHostResponse(
    new Request("https://dash.mind.example/", {
      headers: { accept: "text/html", cookie: "__Host-iterate-session=token" },
    }),
    { auth, domain: "mind.example", recordFacts: (response) => response },
    async () =>
      new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="iterate"' },
      }),
  );
  expect(answer).toMatchObject({ status: 403 });
  const page = await answer.text();
  expect(page).toContain("ada@sender.example, and that address is not a member of mind.example");
  expect(page).toContain(
    '<form method="post" action="/.iterate/sign-out"><button type="submit">Use another account</button></form>',
  );
});
