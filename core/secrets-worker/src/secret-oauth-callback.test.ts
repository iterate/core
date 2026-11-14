// The provider's callback with `error=`: the attempt keeps it. The person's no goes on as after a
// consent; any other error is a failure, with a way to try again.
import { timingSafeEqual } from "node:crypto";
import { expect, test, vi } from "vitest";
import { stateOf } from "./secret-oauth.ts";
import { secretOAuthCallback } from "./secret-oauth-callback.ts";
import { secretOAuthStart, startLinkOf } from "./secret-oauth-start.ts";

// workerd's own, which the cookie check uses and Node lacks
Object.assign(crypto.subtle, { timingSafeEqual });

const PLATFORM = "https://iterate.ada.example";
const PATH = "/secrets/github";

test.for([
  { next: "https://ada.example/connected", status: 303, location: "https://ada.example/connected" },
  { next: null, status: 200, location: null },
])(
  "a declined consent is kept on the attempt, and the tab goes to next or says so, with no error ($status)",
  async ({ next, status, location }) => {
    const recordOAuthError = vi.fn(async () => ({ status: "declined" as const, next }));
    const completeOAuth = vi.fn();
    const answer = await secretOAuthCallback(
      await callbackFromTheProvider("error=access_denied"),
      completeOAuth,
      async () => true,
      recordOAuthError,
    );
    const text = await answer.text();
    expect({
      status: answer.status,
      location: answer.headers.get("location"),
      recorded: recordOAuthError.mock.calls,
      completed: completeOAuth.mock.calls.length,
      said: status === 200 && text.includes("You declined. You can close this tab."),
      alert: /<p role="alert" data-type="error">/.test(text),
      // the browser's binding to the attempt is spent, as after a consent
      cleared: /Max-Age=0/.test(answer.headers.get("set-cookie") || ""),
    }).toEqual({
      status,
      location,
      recorded: [[PATH, { nonce: "n-1", error: "access_denied", by: null }]],
      completed: 0,
      said: status === 200,
      alert: false,
      cleared: true,
    });
  },
);

test("an error that is the provider's, not the person's no, is kept as a failure, with a link to try again", async () => {
  const recordOAuthError = vi.fn(async () => ({
    status: "failed" as const,
    next: "https://ada.example/connected",
  }));
  const answer = await secretOAuthCallback(
    await callbackFromTheProvider("error=server_error"),
    vi.fn(),
    async () => true,
    recordOAuthError,
  );
  const text = await answer.text();
  const again = /<a href="([^"]+)">Try again<\/a>/.exec(text)?.[1]?.replace(/&(amp|#38);/g, "&");
  expect({
    status: answer.status,
    location: answer.headers.get("location"),
    recorded: recordOAuthError.mock.calls,
    said: /<p role="alert" data-type="error">The provider could not connect the account\. It answered: server_error<\/p>/.test(
      text,
    ),
    again: again && new URL(again, PLATFORM).href,
    cleared: /Max-Age=0/.test(answer.headers.get("set-cookie") || ""),
  }).toEqual({
    status: 400,
    location: null,
    recorded: [[PATH, { nonce: "n-1", error: "server_error", by: null }]],
    said: true,
    again: startLinkOf(PLATFORM, PATH, "n-1"),
    cleared: false,
  });
});

test("a decline that matches no live attempt says so, and is no decline", async () => {
  const answer = await secretOAuthCallback(
    await callbackFromTheProvider("error=access_denied"),
    vi.fn(),
    async () => true,
    async () => {
      throw new Error("no pending attempt matches this callback — begin again");
    },
  );
  expect([answer.status, await answer.text()]).toEqual([
    400,
    expect.stringContaining("no pending attempt matches this callback"),
  ]);
});

/** The provider's redirect back to the platform's callback, in the browser that opened the start
 *  link: its start cookie is set by the start page, as a person's would be. */
async function callbackFromTheProvider(query: string): Promise<Request> {
  const target = {
    authorizationUrl: `https://provider.example/authorize?state=${stateOf({ path: PATH, nonce: "n-1" })}`,
    urls: ["https://api.provider.example"],
    use: { placement: "header" as const, operations: [], lendTo: [] },
    anyoneWithLink: true,
  };
  const page = await secretOAuthStart(
    navigation(startLinkOf(PLATFORM, PATH, "n-1")),
    async () => target,
  );
  const [cookie] = page.headers.get("set-cookie")!.split(";");
  const proceed = new URL(
    /<a href="([^"]+)">Continue/.exec(await page.text())![1]!.replace(/&(amp|#38);/g, "&"),
    PLATFORM,
  );
  const start = proceed.searchParams.get("start")!;
  const state = stateOf({ path: PATH, nonce: "n-1", start });
  return navigation(`${PLATFORM}/secrets/oauth/callback?state=${state}&${query}`, cookie);
}

function navigation(url: string, cookie = "") {
  return new Request(url, {
    headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", cookie },
  });
}
