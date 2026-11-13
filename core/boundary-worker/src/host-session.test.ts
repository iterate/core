import { expect, test } from "vitest";
import type { AuthService } from "iterate/workers";
import { mindHostResponse } from "./host-session.ts";

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
