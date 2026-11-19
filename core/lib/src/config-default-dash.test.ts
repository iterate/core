// The default config's Dash host (core/configs/default/apps/dash/app.ts): no path of it acts for
// the Integrations page, whose buttons call the mind's config (cloud-accounts.ts, cloudflare.ts),
// and each app's page asks for its session while its modules load.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("no file of the template names a path of the Dash that acts: the Integrations page's buttons call the mind's config", () => {
  const template = fileURLToPath(new URL("../../configs/default/", import.meta.url));
  const naming = readdirSync(template, { recursive: true, encoding: "utf8" })
    .filter((file) => !file.split(sep).includes("node_modules"))
    .filter((file) => statSync(join(template, file)).isFile())
    .filter((file) => /\/(connect|remove)\//.test(readFileSync(join(template, file), "utf8")));
  expect(naming).toEqual([]);
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
