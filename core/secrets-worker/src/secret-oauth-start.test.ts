import { timingSafeEqual } from "node:crypto";
import { expect, test } from "vitest";
import { normalizeSecretOAuth, parseSecretOAuthState, stateOf } from "./secret-oauth.ts";
import { secretOAuthStart, startedHere, startLinkOf } from "./secret-oauth-start.ts";

// workerd's own, which the cookie check uses and Node lacks
Object.assign(crypto.subtle, { timingSafeEqual });

const PLATFORM = "https://iterate.ada.example";
const link = startLinkOf(PLATFORM, "/secrets/github", "n-1");
const target = {
  authorizationUrl: `https://provider.example/authorize?client_id=c&state=${stateOf({ path: "/secrets/github", nonce: "n-1" })}`,
  urls: ["https://api.provider.example"],
  use: { placement: "header" as const, operations: [], lendTo: [] },
  anyoneWithLink: true,
};
test("a client of the mind's own shows the page to confirm on, and goes to the provider from its link", async () => {
  const page = await secretOAuthStart(navigation(link), async () => target);
  const html = await page.text();
  expect(page).toMatchObject({ status: 200 });
  expect(html).toContain("<h1>Connect an account</h1>");
  // the row's "?" is beside its name, and the value is the one place the tokens go
  expect(html).toMatch(
    /<dt>Tokens sent only to <details class="help">.*?<\/details><\/dt><dd>https:\/\/api\.provider\.example<\/dd>/,
  );
  const [cookie] = page.headers.get("set-cookie")!.split(";");
  const proceed = new URL(
    /<a class="button" href="([^"]+)">Continue/.exec(html)![1]!.replace(/&(amp|#38);/g, "&"),
    link,
  ).href;
  // the link alone, in another browser, shows the page again
  expect(await secretOAuthStart(navigation(proceed), async () => target)).toMatchObject({
    status: 200,
  });
  const on = await secretOAuthStart(navigation(proceed, cookie), async () => target);
  const to = new URL(on.headers.get("location")!);
  expect([on.status, to.origin + to.pathname]).toEqual([302, "https://provider.example/authorize"]);
  expect(parseSecretOAuthState(to.searchParams.get("state"))).toMatchObject({
    path: "/secrets/github",
    nonce: "n-1",
    start: new URL(proceed).searchParams.get("start"),
  });
});

test("a client of the mind's own begun straightToProvider has its one page at the provider: this browser is bound here and goes straight on, unless the use is unusual", async () => {
  const straight = { ...target, straightToProvider: true as const };
  const on = await secretOAuthStart(navigation(link), async () => straight);
  const to = new URL(on.headers.get("location")!);
  expect([on.status, to.origin + to.pathname]).toEqual([302, "https://provider.example/authorize"]);
  const state = parseSecretOAuthState(to.searchParams.get("state"))!;
  expect(state).toMatchObject({ path: "/secrets/github", nonce: "n-1" });
  const [cookie] = on.headers.get("set-cookie")!.split(";");
  const callback = (cookies: string) =>
    startedHere(navigation(`${PLATFORM}/x`, cookies), state.start!, "/secrets/github", "n-1");
  expect([await callback(cookie!), await callback("")]).toEqual([true, false]);
  const preview = await secretOAuthStart(new Request(link), async () => straight);
  expect([preview.status, preview.headers.get("set-cookie")]).toEqual([200, null]);
  const unusual = { ...straight, use: { ...target.use, placement: "url" as const } };
  const page = await secretOAuthStart(navigation(link), async () => unusual);
  expect([page.status, await page.text()]).toEqual([
    200,
    expect.stringContaining("It may be placed in a URL"),
  ]);
});

test("a secret that names a body field shows its page here first, whoever else confirms: the provider or the Cloud", async () => {
  const use = {
    ...target.use,
    bodyFields: [
      { method: "POST", url: "https://api.provider.example/v1/hooks", field: "config.secret" },
    ],
  };
  const pages = [
    await secretOAuthStart(navigation(link), async () => ({
      ...target,
      use,
      straightToProvider: true as const,
    })),
    await secretOAuthStart(navigation(link), async () => ({
      ...target,
      use,
      returnTo: `${PLATFORM}/secrets/oauth/callback`,
      beginAt: "https://cloud.example/clients/github/begin",
    })),
  ];
  const sentence =
    "It may be sent inside the body, in the field config.secret, of a POST to https://api.provider.example/v1/hooks.";
  expect(await Promise.all(pages.map(async (page) => [page.status, await page.text()]))).toEqual([
    [200, expect.stringContaining(sentence)],
    [200, expect.stringContaining(sentence)],
  ]);
});

test("a client of iterate Cloud's has its one page at the Cloud: this browser is bound here and goes straight on", async () => {
  const cloud = {
    ...target,
    returnTo: `${PLATFORM}/secrets/oauth/callback`,
    // the accounts the mind asked for go to the Cloud's page with the link
    beginAt: "https://cloud.example/clients/github/begin?accounts=ada,acme",
  };
  const on = await secretOAuthStart(navigation(link), async () => cloud);
  const there = new URL(on.headers.get("location")!);
  expect([on.status, there.origin + there.pathname, there.searchParams.get("accounts")]).toEqual([
    302,
    "https://cloud.example/clients/github/begin",
    "ada,acme",
  ]);
  // what the Cloud's page sends the browser on to: the provider's page, whose state names this
  // deployment's callback and then the attempt
  const to = new URL(there.searchParams.get("to")!);
  expect(to.origin + to.pathname).toBe("https://provider.example/authorize");
  const [returnTo, own] = to.searchParams.get("state")!.split(".");
  expect(Buffer.from(returnTo!, "base64url").toString()).toBe(cloud.returnTo);
  const state = parseSecretOAuthState(own!)!;
  expect(state).toMatchObject({ path: "/secrets/github", nonce: "n-1" });
  // the binding is the same cookie the page sets: the callback completes in this browser alone
  const [cookie] = on.headers.get("set-cookie")!.split(";");
  expect(on.headers.get("set-cookie")).toMatch(/^__Host-itx-oauth-start-.*HttpOnly; Secure/);
  const callback = (cookies: string) =>
    startedHere(navigation(`${PLATFORM}/x`, cookies), state.start!, "/secrets/github", "n-1");
  expect([await callback(cookie!), await callback("")]).toEqual([true, false]);
  // a link preview is no navigation: it binds nothing and goes nowhere
  const preview = await secretOAuthStart(new Request(link), async () => cloud);
  expect([preview.status, preview.headers.get("set-cookie")]).toEqual([200, null]);
});

test("a client of iterate Cloud's whose secret is to be used in an unusual way shows that here first, then goes to the Cloud", async () => {
  const cloud = {
    ...target,
    use: {
      placement: "url" as const,
      operations: ["signHmac" as const],
      lendTo: ["/secrets/other"],
    },
    returnTo: `${PLATFORM}/secrets/oauth/callback`,
    beginAt: "https://cloud.example/clients/github/begin",
  };
  const page = await secretOAuthStart(navigation(link), async () => cloud);
  const html = await page.text();
  expect(page).toMatchObject({ status: 200 });
  // what the Cloud's own page cannot say
  for (const line of [
    "It may be placed in a URL",
    "sign and verify with it: signHmac",
    "/secrets/other",
  ])
    expect(html).toContain(line);
  const [cookie] = page.headers.get("set-cookie")!.split(";");
  const proceed = new URL(
    /<a class="button" href="([^"]+)">Continue/.exec(html)![1]!.replace(/&(amp|#38);/g, "&"),
    link,
  ).href;
  const on = await secretOAuthStart(navigation(proceed, cookie), async () => cloud);
  const there = new URL(on.headers.get("location")!);
  expect([on.status, there.origin + there.pathname]).toEqual([
    302,
    "https://cloud.example/clients/github/begin",
  ]);
});

test("a client of iterate Cloud's whose secret is lent to every secret says so here first", async () => {
  const cloud = {
    ...target,
    use: { ...target.use, lendTo: null },
    beginAt: "https://cloud.example/clients/github/begin",
  };
  const page = await secretOAuthStart(navigation(link), async () => cloud);
  expect(page).toMatchObject({ status: 200 });
  expect(await page.text()).toContain("The refresh of any secret of this mind may borrow it");
});

test("a connect through a Cloud client names the accounts whose installations the mind asks for", () => {
  const cloud = {
    name: "github",
    origin: "https://cloud.example",
    clientId: "Iv1.client",
    authorizationEndpoint: "https://provider.example/login/oauth/authorize",
    beginEndpoint: "https://cloud.example/clients/github/begin",
    redirectUri: "https://cloud.example/clients/github/callback",
    tokenEndpoint: "https://cloud.example/clients/github/token",
    urls: ["https://api.provider.example"],
  };
  const begun = (client: Record<string, unknown>) =>
    normalizeSecretOAuth(
      { client: { cloud: "github", origin: cloud.origin, ...client } },
      [],
      cloud,
    ).cloud;
  expect(begun({ accounts: ["Ada", "acme-inc"] })).toMatchObject({
    name: "github",
    // the Cloud that the caller named is kept with the attempt, and then with the secret
    origin: "https://cloud.example",
    beginEndpoint: cloud.beginEndpoint,
    accounts: ["Ada", "acme-inc"],
  });
  // none named: no list goes to the Cloud, which then connects no installation
  expect(begun({})).not.toHaveProperty("accounts");
  expect(begun({ accounts: [] })).not.toHaveProperty("accounts");
  for (const accounts of ["ada", ["ada", "not a name"], ["a,b"], [7], Array(21).fill("ada")])
    expect(() => begun({ accounts })).toThrow("client.accounts is a list of account names");
});

function navigation(url: string, cookie = "") {
  return new Request(url, {
    headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", cookie },
  });
}
