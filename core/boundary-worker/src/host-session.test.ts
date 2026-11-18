import { expect, test } from "vitest";
import type { AuthService } from "iterate/workers";
import { mindHostResponse } from "./host-session.ts";

const config = {
  mindId: "a".repeat(64),
  controlPlaneHostname: "iterate.mind.example",
  zones: ["mind.example"],
  ownerEmails: ["ada@elsewhere.example"],
  topology: "full-cloudflare" as const,
};

// why the redirects stay on the host: `signedOutPage` in ./host-session.ts
test("a sign-out ends on a page of its own host, which then goes on to the sign-in", async () => {
  const auth = {
    whoIs: async () => null,
    hostClient: async () => "client-1",
  } as unknown as AuthService;
  const deps = { auth, config, recordFacts: (response: Response) => response };
  // the app's guard, as `auth.requirePerson` answers a browser with no session
  const forward = async () =>
    new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="iterate", scope="identity"' },
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

// An authorization code that the issuer does not take (one of the stack from before the move, or
// one used before) ends on a page whose link starts a new sign-in at the page it began at.
test("a callback whose code the issuer refuses says sign in again, and its link starts the sign-in afresh", async () => {
  const auth = {
    whoIs: async () => null,
    hostClient: async () => "client-1",
    fetch: async () =>
      Response.json(
        { error: "invalid_grant" },
        { status: 400, headers: { "cache-control": "no-store" } },
      ),
  } as unknown as AuthService;
  const deps = { auth, config, recordFacts: (response: Response) => response };
  const forward = async () =>
    new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="iterate", scope="identity"' },
    });
  const begun = await mindHostResponse(
    new Request("https://cloud.mind.example/a/page?x=1", { headers: { accept: "text/html" } }),
    deps,
    forward,
  );
  expect(begun).toMatchObject({ status: 302 });
  const state = new URL(begun.headers.get("location")!).searchParams.get("state")!;
  const flowCookie = begun.headers.getSetCookie()[0]!.split(";")[0]!;
  const callback = await mindHostResponse(
    new Request(
      `https://cloud.mind.example/.iterate/callback?code=old-stack-code&state=${state}&iss=${encodeURIComponent("https://iterate.mind.example")}`,
      {
        headers: { cookie: flowCookie },
      },
    ),
    deps,
    forward,
  );
  expect(callback).toMatchObject({ status: 400 });
  const page = await callback.text();
  expect(page).toContain("The sign-in could not complete. Sign in again.");
  expect(page).toContain('<a href="/a/page?x=1">Sign in again</a>');
  // the link is the page the sign-in began at, which starts a new one
  const fresh = await mindHostResponse(
    new Request("https://cloud.mind.example/a/page?x=1", { headers: { accept: "text/html" } }),
    deps,
    forward,
  );
  expect(fresh).toMatchObject({ status: 302 });
});

test("a person who is no member reads who they are, and can change the account", async () => {
  const auth = {
    whoIs: async () => ({
      principal: { actor: "user-1", email: "ada@sender.example" },
      grant: "grant-1",
      expiresAt: 0,
      member: false,
      method: "email",
    }),
  } as unknown as AuthService;
  const answer = await mindHostResponse(
    new Request("https://dash.mind.example/", {
      headers: { accept: "text/html", cookie: "__Host-iterate-session=token" },
    }),
    { auth, config, recordFacts: (response) => response },
    async () =>
      new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="iterate"' },
      }),
  );
  expect(answer).toMatchObject({ status: 403 });
  const page = await answer.text();
  expect(page).toContain(
    "ada@sender.example, and that address is not a member of iterate.mind.example",
  );
  expect(page).toContain(
    '<form method="post" action="/.iterate/sign-out"><button type="submit">Use another account</button></form>',
  );
});

test("the identity log's path and the stack key's path never reach the mind's own code: the log is the auth Worker's answer for the hostname that was asked, and the key is 404", async () => {
  // the auth Worker answers the log on a hostname that the log's last record lists, else 404
  const askedOfAuth: [string, string | null][] = [];
  const auth = {
    whoIs: async () => null,
    identityLog: async (hostname: string, after: string | null) => {
      askedOfAuth.push([hostname, after]);
      return hostname === "mind.example"
        ? Response.json({ version: 1, mind: "a".repeat(64), head: null, records: [] })
        : new Response("Not found\n", { status: 404 });
    },
  } as unknown as AuthService;
  const reached: string[] = [];
  const answered = async (url: string, method = "GET") => {
    const answer = await mindHostResponse(
      new Request(url, { method }),
      { auth, config, recordFacts: (response) => response },
      async (forwarded) => {
        reached.push(forwarded.url);
        return Response.json({ mind: new URL(url).hostname, records: ["forged"] });
      },
    );
    const text = await answer.text();
    expect(text, url).not.toContain("forged");
    return { status: answer.status, text };
  };
  expect(await answered("https://mind.example/.well-known/iterate")).toEqual({
    status: 200,
    text: JSON.stringify({ version: 1, mind: "a".repeat(64), head: null, records: [] }),
  });
  const after = "b".repeat(64);
  expect(await answered(`https://dash.mind.example/.well-known/iterate?after=${after}`)).toEqual({
    status: 404,
    text: "Not found\n",
  });
  expect(askedOfAuth).toEqual([
    ["mind.example", null],
    ["dash.mind.example", after],
  ]);
  // a record is posted at the control-plane hostname alone, and the key is read there alone
  for (const [url, method] of [
    ["https://mind.example/.well-known/iterate", "POST"],
    ["https://mind.example/.well-known/iterate", "DELETE"],
    ["https://dash.mind.example/keys/stack.json", "GET"],
    // a spelling that a server or a client may take for one of the two paths is the boundary's
    // too, and is answered by nobody
    ["https://mind.example/.well-known/iterate/", "GET"],
    ["https://mind.example/.well-known/Iterate", "GET"],
    ["https://mind.example/.well-known/%69terate", "GET"],
    ["https://mind.example//.well-known/iterate", "GET"],
    ["https://dash.mind.example/keys/%73tack.json", "GET"],
    ["https://dash.mind.example/keys/stack.json/", "GET"],
    ["https://dash.mind.example/KEYS/stack.json", "POST"],
  ] as const)
    expect(await answered(url, method), `${method} ${url}`).toMatchObject({ status: 404 });
  expect(askedOfAuth).toHaveLength(2);
  expect(reached).toEqual([]);
});
