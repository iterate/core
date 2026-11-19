// The default config's Dash host (core/configs/default/apps/dash/app.ts), as far as the
// Integrations page's buttons lead there: "Connect" and "Add account" give a new account the first
// free name (`/secrets/x`, then `/secrets/x-2`), "Connect again" keeps its own, and "Remove" is a
// POST from the page alone that forgets one account of that app.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { dashApp } from "../../configs/default/apps/dash/app.ts";
import { ITERATE_CLOUD } from "../../configs/default/cloud-deliveries.ts";

const DASH = "https://dash.example.com";

test("each X account connected from the page gets the first free name, and 'Connect again' keeps its own", async () => {
  const mind = fakeMind();
  const connect = async (query = "") => {
    const answer = await dashApp().fetch(new Request(`${DASH}/connect/x${query}`), mind.host);
    expect(answer).toMatchObject({ status: 303 });
    return mind.begun.at(-1);
  };
  expect(await connect()).toEqual({
    path: "/secrets/x",
    client: { cloud: "x", origin: ITERATE_CLOUD },
  });
  mind.secrets.add("/secrets/x");
  expect((await connect())?.path).toBe("/secrets/x-2");
  mind.secrets.add("/secrets/x-2");
  expect((await connect())?.path).toBe("/secrets/x-3");
  expect((await connect("?secret=x-2"))?.path).toBe("/secrets/x-2");
  // a link never connects again over another app's secret
  mind.secrets.add("/secrets/google");
  expect((await connect("?secret=google"))?.path).toBe("/secrets/x-3");
});

test("'Remove' is a POST from the page, for a secret of the app it names; the answer is what was done", async () => {
  const mind = fakeMind();
  mind.secrets.add("/secrets/x-2");
  mind.secrets.add("/secrets/google");
  const remove = (query: string, origin: string | null = DASH, method = "POST") =>
    dashApp().fetch(
      new Request(`${DASH}/remove/x${query}`, {
        method,
        headers: origin ? { origin } : {},
      }),
      mind.host,
    );

  // another site's form, or a request with no origin: refused, and nothing is asked
  expect(await remove("?secret=x-2", "https://evil.example")).toMatchObject({ status: 403 });
  expect(await remove("?secret=x-2", null)).toMatchObject({ status: 403 });
  // another app's secret through this app's path
  const other = await remove("?secret=google");
  expect([other.status, await other.text()]).toEqual([400, "google is no account of x."]);
  expect(mind.secrets.has("/secrets/google")).toBe(true);
  // a GET is the page, not a removal
  expect(await (await remove("?secret=x-2", DASH, "GET")).text()).toBe("the page");
  expect(mind.secrets.has("/secrets/x-2")).toBe(true);

  const done = await remove("?secret=x-2");
  expect([done.status, await done.json()]).toEqual([
    200,
    {
      secret: "/secrets/x-2",
      app: "x",
      account: "43",
      cloud: "released",
      said: "Removed /secrets/x-2. iterate Cloud stopped its deliveries.",
    },
  ]);
  expect(mind.secrets.has("/secrets/x-2")).toBe(false);
  // the vault's refusal comes back in its own words
  const again = await remove("?secret=x-2");
  expect([again.status, await again.text()]).toEqual([
    400,
    "Could not remove the account: /secrets/x-2 is no account connected through iterate Cloud: delete a key on the Secrets page",
  ]);
});

test("an app's page asks for its session in its head, while its modules load, and app.js takes that answer", () => {
  const apps = new URL("../../configs/default/apps/", import.meta.url);
  const read = (file: string) => readFileSync(new URL(file, apps), "utf8");
  const asking = readdirSync(apps, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .filter(
      (app) =>
        existsSync(new URL(`${app}/public/app.js`, apps)) &&
        read(`${app}/public/app.js`).includes("/.auth/session.json"),
    );
  expect(asking).toEqual(expect.arrayContaining(["dash", "docs", "onboarding", "voice"]));
  for (const app of asking) {
    const page = read(`${app}/index.html`);
    const asked = page.indexOf('window.__session = fetch("/.auth/session.json")');
    // before the first stylesheet, which a script after it waits for, and before the app's module
    expect({ app, asked: asked > 0 }).toEqual({ app, asked: true });
    expect({ app, beforeStyles: asked < page.indexOf('rel="stylesheet"') }).toEqual({
      app,
      beforeStyles: true,
    });
    expect({ app, takes: read(`${app}/public/app.js`).includes("window.__session") }).toEqual({
      app,
      takes: true,
    });
  }
});

/** A mind's root as the Dash's host hands it out: X secrets of the Cloud's, whose account X says is
 *  43, and a Cloud that takes every ask. */
function fakeMind() {
  const secrets = new Set<string>();
  const begun: { path: string; client: unknown }[] = [];
  const kv = new Map<string, string>();
  const itx = {
    url: async () => "https://example.com/",
    secrets: {
      list: async () =>
        [...secrets].map((path) => ({
          path,
          urls: [],
          cloud: path.split("/").at(-1)!.split("-")[0],
          cloudOrigin: ITERATE_CLOUD,
        })),
      delete: async (path: string) => secrets.delete(path),
      beginOAuth: async (path: string, options: { client: unknown }) => {
        begun.push({ path, client: options.client });
        return { authorizationUrl: `${ITERATE_CLOUD}/begin` };
      },
    },
    kv: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => kv.set(key, value),
      delete: async (key: string) => kv.delete(key),
      list: async (prefix = "") => ({
        keys: [...kv.keys()].filter((key) => key.startsWith(prefix)),
      }),
    },
    fetch: async (request: Request) =>
      request.url.startsWith(ITERATE_CLOUD)
        ? Response.json({ connected: false })
        : Response.json({ data: { id: "43", username: "grace" } }),
    [Symbol.dispose]: () => undefined,
  };
  const host = {
    auth: { memberPage: () => new Response("the page") },
    getItx: () => itx,
  } as unknown as Parameters<ReturnType<typeof dashApp>["fetch"]>[1];
  return { secrets, begun, host };
}
