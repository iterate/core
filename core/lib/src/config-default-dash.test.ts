// The default config's Dash host (core/configs/default/apps/dash/app.ts): no path of it acts for
// the Integrations page, whose buttons call the mind's config (cloud-accounts.ts, cloudflare.ts),
// and each app's page asks for its session while its modules load.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { z } from "zod";
import { dashLink, DashLinkInput, dashLinks } from "../../configs/default/apps/dash/links.ts";
import { CALL_FACET } from "../../configs/default/call.ts";
import { isLive, reduceShare, type ShareEvent } from "../../configs/default/call/share.ts";
// @ts-expect-error -- a plain browser module of the Dash, with no types
import { CALL_FACET as DASH_CALL_FACET } from "../../configs/default/apps/dash/public/call-facet.js";
// @ts-expect-error -- a plain browser module of the Dash, with no types
import * as shareLinks from "../../configs/default/apps/dash/public/share-links.js";
import fixture from "./dash-routes.fixture.json" with { type: "json" };

test("the Dash's call facet spec is the config's own: the Dash turns on the call that call.ts hosts", () => {
  expect(DASH_CALL_FACET).toEqual(CALL_FACET);
});

test("the Dash's Share makes a link that the call's share rules take: Meet's guest page, the secret's hash alone in the log, and End ends it", async () => {
  const links = shareLinks as {
    makeLink(input: { zone: string; agent: string; lifetimeMs: number; now: number }): Promise<{
      event: { type: string; payload: { link: string; secretHash: string; until: number } };
      url: string;
    }>;
    endLink(link: string): { type: string; payload: { link: string } };
    hashOfSecret(secret: string): Promise<string>;
    agentPathOf(value: unknown): string | null;
    LIFETIMES: { ms: number }[];
  };
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const { event, url } = await links.makeLink({
    zone: "example.com",
    agent: "/agents/standup",
    lifetimeMs: 24 * 3_600_000,
    now,
  });
  // the link opens Meet's guest page for the agent; the secret is in the fragment alone
  const [page, secret] = url.split("#");
  expect(page).toBe("https://meet.example.com/join/agents/standup");
  expect(secret).toMatch(/^[\w-]{43}$/);
  expect(JSON.stringify(event)).not.toContain(secret);
  expect(event.payload).toMatchObject({ secretHash: await links.hashOfSecret(secret!) });
  // a member's link, as the call folds it (call/share.ts): live until its end
  const source = { principal: { actor: "user_1", name: "jonas" } } as ShareEvent["source"];
  const createdAt = new Date(now).toISOString();
  const made = reduceShare({ links: [] }, { ...event, createdAt, source });
  expect(made.links).toHaveLength(1);
  expect(isLive(made.links[0]!, now + 1)).toBe(true);
  const ended = reduceShare(made, { ...links.endLink(event.payload.link), createdAt, source });
  expect(isLive(ended.links[0]!, now + 1)).toBe(false);
  // the longest choice is within the share rules' own limit
  expect(Math.max(...links.LIFETIMES.map((choice) => choice.ms))).toBe(7 * 24 * 3_600_000);
  // an agent's path only, as written
  expect(
    ["/agents/standup", "/agents/meet/a-b", "/", "/agents", "/agents/../x", "/docs/a"].map(
      links.agentPathOf,
    ),
  ).toEqual(["/agents/standup", "/agents/meet/a-b", null, null, null, null]);
});

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
  expect(asking).toEqual(expect.arrayContaining(["dash", "docs", "onboarding"]));
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

const FixtureRow = z.object({
  name: z.string(),
  href: z.string(),
  link: DashLinkInput,
});

test.for(z.array(FixtureRow).parse(fixture))(
  "dashLink matches shared fixture: $name ($href)",
  ({ href, link }) => {
    expect(dashLink("example.com", link)).toBe(`https://dash.example.com${href}`);
  },
);

test("dashLinks and dashLink validate structured inputs and reject unsafe destinations", () => {
  const dash = dashLinks("example.com");
  expect(dash.home()).toBe("https://dash.example.com/");
  expect(dash.repos("config", "apps/dash/index.html")).toBe(
    "https://dash.example.com/repos/config/apps/dash/index.html",
  );
  expect(() => dashLinks("https://evil.com")).toThrow("invalid apex");
  expect(() => dashLinks("example.com/path")).toThrow("invalid apex");
  expect(() => dash.agent("agents/onboarding")).toThrow('must start with "/"');
  expect(() => dash.context("repos/config")).toThrow('must start with "/"');
  for (const reserved of ["itx", "connect", "api", "keys", "brands", "app.js", ".auth", "a/b"]) {
    expect(() => dash.page(reserved)).toThrow("not a valid Dash page id");
    expect(() => dashLink("example.com", { view: "page", page: reserved })).toThrow();
  }
  expect(() => dash.repos("a/b")).toThrow("invalid repo");
  expect(() => dash.repos("config", "../secret")).toThrow("invalid repo file");
  expect(() => dash.page("notes", "/leading")).toThrow("invalid page remainder");
  expect(() =>
    // Cast simulates an untyped RPC caller passing an unknown view name at runtime.
    dashLink("example.com", { view: "unknown" } as unknown as DashLinkInput),
  ).toThrow();
});
