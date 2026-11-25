// The default config's Dash host (core/configs/default/apps/dash/app.ts): no path of it acts for
// the Integrations page, whose buttons call the mind's config (cloud-accounts.ts, cloudflare.ts),
// and each app's page asks for its session while its modules load.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { z } from "zod";
import { framedSignIn } from "../../configs/default/apps/dash/framed-sign-in.ts";
import { dashLink, DashLinkInput, dashLinks } from "../../configs/default/apps/dash/links.ts";
import { CALL_FACET } from "../../configs/default/call.ts";
import {
  isLive,
  LONGEST_LIFETIME_MS,
  reduceShare,
  type ShareEvent,
  type ShareState,
} from "../../configs/default/call/share.ts";
import {
  endShare,
  shareAgent,
  type ShareItx,
  shareLinks as listShares,
} from "../../configs/default/call/share-api.ts";
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
    LONGEST_LIFETIME: number;
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
  // the longest life is the share rules' own limit: exactly that is made, more is refused
  expect(links).toMatchObject({ LONGEST_LIFETIME: LONGEST_LIFETIME_MS });
  const week = { zone: "example.com", agent: "/agents/standup", now };
  const longest = await links.makeLink({ ...week, lifetimeMs: LONGEST_LIFETIME_MS });
  expect(longest.event.payload).toMatchObject({ until: now + LONGEST_LIFETIME_MS });
  for (const lifetimeMs of [LONGEST_LIFETIME_MS + 1, 8 * 86_400_000, Infinity])
    await expect(links.makeLink({ ...week, lifetimeMs })).rejects.toThrow(
      "A link lives 7 days at most",
    );
  // an agent's path only, as written
  expect(
    ["/agents/standup", "/agents/meet/a-b", "/", "/agents", "/agents/../x", "/docs/a"].map(
      links.agentPathOf,
    ),
  ).toEqual(["/agents/standup", "/agents/meet/a-b", null, null, null, null]);
});

test("the Dash and Meet make a link with one module: their two share-links.js are byte for byte the same", () => {
  const read = (app: string) =>
    readFileSync(
      new URL(`../../configs/default/apps/${app}/public/share-links.js`, import.meta.url),
    );
  expect(read("meet").equals(read("dash"))).toBe(true);
});

test("itx.config.shareAgent makes the pages' link: the call turned on, the hash alone in the log, more than 7 days refused, admitted by the call; endShare ends it", async () => {
  const mind = fakeShareMind();
  // 8 days asked for: refused in words, and nothing is turned on or written
  await expect(
    shareAgent(mind.itx, { agent: "/agents/standup", lifetimeMs: 8 * 24 * 3_600_000 }),
  ).rejects.toThrow("A link lives 7 days at most (604800000 ms); 691200000 ms was asked for.");
  expect(mind).toMatchObject({ enabled: [], appended: [] });
  const answer = await shareAgent(mind.itx, {
    agent: "/agents/standup",
    lifetimeMs: LONGEST_LIFETIME_MS,
  });
  const [page, secret] = answer.url.split("#");
  expect(page).toBe("https://meet.example.com/join/agents/standup");
  // the call was off: turned on first, with the config's spec
  expect(mind).toMatchObject({ enabled: [["/agents/standup", "call", CALL_FACET]] });
  const [made] = mind.appended;
  expect(made).toMatchObject({
    type: "share/link-made",
    payload: { link: answer.link, secretHash: await shareLinks.hashOfSecret(secret!) },
  });
  expect(JSON.stringify(mind.appended)).not.toContain(secret);
  // 7 days asked for, 7 days given
  expect(answer.until - mind.madeAt).toBeLessThanOrEqual(LONGEST_LIFETIME_MS);
  expect(answer.until - mind.madeAt).toBeGreaterThan(LONGEST_LIFETIME_MS - 60_000);
  expect(await listShares(mind.itx, { agent: "/agents/standup" })).toEqual([
    expect.objectContaining({ link: answer.link, madeBy: { actor: "user_1", name: "jonas" } }),
  ]);
  expect(JSON.stringify(await listShares(mind.itx, { agent: "/agents/standup" }))).not.toContain(
    "secretHash",
  );
  await endShare(mind.itx, { agent: "/agents/standup", link: answer.link });
  expect(await listShares(mind.itx, { agent: "/agents/standup" })).toEqual([]);
  // a link that the config appended for nobody the platform names (a member's own script, straight
  // on its socket): it admits, and its maker is said in words, not as the path "/"
  mind.stamp = { origin: "/" };
  const unnamed = await shareAgent(mind.itx, { agent: "/agents/standup" });
  expect(await listShares(mind.itx, { agent: "/agents/standup" })).toEqual([
    expect.objectContaining({
      link: unnamed.link,
      madeBy: { actor: null, name: "this mind's own code" },
    }),
  ]);
  await endShare(mind.itx, { agent: "/agents/standup", link: unnamed.link });
  // no link to a context that is no agent, nor to a path that is no agent's
  await expect(shareAgent(mind.itx, { agent: "/repos/config" })).rejects.toThrow(
    "/repos/config is no agent's path.",
  );
  // a path that the catalog does not list is never called: a call would make its context
  mind.called.length = 0;
  for (const call of [shareAgent, listShares, endShare])
    await expect(call(mind.itx, { agent: "/agents/nobody", link: answer.link })).rejects.toThrow(
      "/agents/nobody is no agent of this mind.",
    );
  expect(mind).toMatchObject({ called: [] });
  await expect(shareAgent(mind.itx, { agent: "/agents/no-agent-facet" })).rejects.toThrow(
    "/agents/no-agent-facet is no agent of this mind.",
  );
  // a link the call does not admit (made for a guest) is ended and refused
  // a guest's stamp, which the fold reads as no member's (iterate/principal `kind`)
  mind.stamp = {
    onBehalfOf: { principal: { actor: "guest:g", kind: "guest" } as { actor: string } },
  };
  await expect(shareAgent(mind.itx, { agent: "/agents/standup" }, { foldMs: 0 })).rejects.toThrow(
    "admits nobody",
  );
  expect(mind.appended.at(-1)).toMatchObject({ type: "share/link-ended" });
});

test("Dash sidebar keeps Contexts, Integrations, Config repo, and Analytics visible (not hidden under Settings)", () => {
  const dashAppJs = readFileSync(
    new URL("../../configs/default/apps/dash/public/app.js", import.meta.url),
    "utf8",
  );
  for (const id of ["integrations", "repos", "contexts", "analytics"]) {
    const block = new RegExp(`id:\\s*"${id}"[\\s\\S]*?component:`).exec(dashAppJs)?.[0];
    expect(block, `Dash page "${id}" entry`).toBeTruthy();
    expect(block).not.toMatch(/\brow\s*:\s*false\b/);
  }
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
  // the onboarding page is the repo /repos/onboarding (core/repos/onboarding), read as an app
  const read = (file: string) =>
    readFileSync(
      file.startsWith("onboarding/")
        ? new URL(`../../repos/${file}`, import.meta.url)
        : new URL(file, apps),
      "utf8",
    );
  const asking = [
    ...readdirSync(apps, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name)
      .filter((app) => existsSync(new URL(`${app}/public/app.js`, apps))),
    "onboarding",
  ].filter((app) => read(`${app}/public/app.js`).includes("/.auth/session.json"));
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

test("a signed-out frame of the Dash gets the guard's refusal with words that say what to do; any other request gets the guard's answer as it is", async () => {
  const refusal = () =>
    new Response("Sign in\n", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="iterate"', "Cache-Control": "no-store" },
    });
  const ask = (headers: Record<string, string>, method = "GET") =>
    new Request("https://dash.example.com/agents/agents/main?embed=1", { method, headers });
  const framed = framedSignIn(
    ask({ "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" }),
    refusal(),
  );
  // the same refusal: the status and the challenge that the boundary reads
  expect(framed?.status).toBe(401);
  expect(framed?.headers.get("www-authenticate")).toBe('Bearer realm="iterate"');
  expect(framed?.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const page = await framed!.text();
  expect(page).toContain("This browser is not signed in to the Dash yet.");
  // one link, to this host's own root, in a tab of its own
  expect([...page.matchAll(/href="([^"]+)"/g)].map((found) => found[1])).toEqual([
    "https://dash.example.com/",
  ]);
  expect(page).toContain('target="_blank" rel="noopener"');
  // a member's request is not touched, and neither is any refusal that is no frame's page load
  expect(framedSignIn(ask({ "sec-fetch-dest": "iframe" }), null)).toBeNull();
  const tab = refusal();
  expect(
    framedSignIn(ask({ "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }), tab),
  ).toBe(tab);
  const script = refusal();
  expect(framedSignIn(ask({ "sec-fetch-dest": "script" }), script)).toBe(script);
  const write = refusal();
  expect(framedSignIn(ask({ "sec-fetch-dest": "iframe" }, "POST"), write)).toBe(write);
  const forbidden = new Response("Cross-site request refused", { status: 403 });
  expect(framedSignIn(ask({ "sec-fetch-dest": "iframe" }), forbidden)).toBe(forbidden);
});

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

/** One agent, `/agents/standup`, whose call folds what is appended by call/share.ts, with the stamp
 *  `stamp` (a member's, unless a test says another). */
function fakeShareMind() {
  const mind = {
    appended: [] as { type: string; payload: { link: string } }[],
    enabled: [] as unknown[][],
    madeAt: 0,
    stamp: { principal: { actor: "user_1", name: "jonas" } } as ShareEvent["source"],
    state: { links: [] } as ShareState,
    callOn: false,
    /** Each path that `itx.cd` was asked for. */
    called: [] as string[],
  };
  const itx: ShareItx = {
    url: async () => "https://example.com/",
    // the catalog lists the agent, and a context that is no agent
    contexts: {
      list: async ({ under }) =>
        ["/agents/standup", "/agents/no-agent-facet"]
          .filter((path) => path === under)
          .map((path) => ({ path })),
    },
    cd: (path) => ({
      called: mind.called.push(path),
      append: async (event) => {
        const typed = event as (typeof mind.appended)[number];
        if (typed.type === "share/link-made") mind.madeAt = Date.now();
        mind.appended.push(typed);
        const createdAt = new Date().toISOString();
        mind.state = reduceShare(mind.state, { ...typed, createdAt, source: mind.stamp });
      },
      processors: {
        list: async () =>
          path === "/agents/standup"
            ? [{ name: "agent" }, ...(mind.callOn ? [{ name: "call" }] : [])]
            : [],
        enable: async (name, spec) => {
          mind.enabled.push([path, name, spec]);
          mind.callOn = true;
        },
      },
      facets: { get: () => ({ snapshot: async () => ({ state: mind.state }) }) },
    }),
  };
  return Object.assign(mind, { itx });
}
