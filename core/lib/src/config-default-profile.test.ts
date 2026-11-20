// The default config's public profile (core/configs/default/profile.ts, and the folder profile/
// beside it): what the mind's website answers of its name, its description and its icon, what a
// missing or broken file falls back to, and that the profile stays apart from the mind's signed
// identity at `/.well-known/iterate`.
/// <reference path="../../configs/default/files.d.ts" />
import { expect, test } from "vitest";
// oxlint-disable-next-line import/extensions -- a folder: every file under it, by path
import dashFiles from "../../configs/default/apps/dash/public/";
import { PROFILE_PATH, profileOf, serveProfile } from "../../configs/default/profile.ts";
// oxlint-disable-next-line import/extensions -- a folder: every file under it, by path
import templateFiles from "../../configs/default/profile/";
import Config from "../../configs/default/worker.ts";
import { MIND_IDENTITY_PATH, reservedPathOf } from "./mind-identity-log.ts";

test("a new mind's website says its zone as its name and serves the template's icon, to anyone", async () => {
  expect(Object.keys(templateFiles)).toEqual(["icon.svg", "profile.json"]);
  const profile = await ask(PROFILE_PATH);
  expect(PROFILE_PATH).toBe("/.well-known/iterate-profile");
  expect({
    status: profile.status,
    type: profile.headers.get("content-type"),
    cors: profile.headers.get("access-control-allow-origin"),
    cache: profile.headers.get("cache-control"),
    body: await profile.json(),
  }).toEqual({
    status: 200,
    type: "application/json",
    cors: "*",
    cache: "public, max-age=300",
    body: { name: "example.com", description: "", icon: "https://example.com/favicon.svg" },
  });
  for (const path of ["/favicon.svg", "/favicon.ico"]) {
    const icon = await ask(path);
    expect({
      status: icon.status,
      type: icon.headers.get("content-type"),
      sniff: icon.headers.get("x-content-type-options"),
      policy: icon.headers.get("content-security-policy"),
      cache: icon.headers.get("cache-control"),
      body: await icon.text(),
    }).toEqual({
      status: 200,
      type: "image/svg+xml",
      sniff: "nosniff",
      policy: "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      cache: "public, max-age=300",
      body: templateFiles["icon.svg"],
    });
  }
  expect(String(templateFiles["icon.svg"])).toMatch(/^<svg /);
  expect({
    head: (await ask(PROFILE_PATH, "HEAD")).status,
    post: (await ask(PROFILE_PATH, "POST")).status,
    postIcon: (await ask("/favicon.svg", "POST")).status,
    below: (await ask(`${PROFILE_PATH}/x`)).status,
    theFolder: (await ask("/profile/profile.json")).status,
  }).toEqual({ head: 200, post: 405, postIcon: 405, below: 404, theFolder: 404 });
  expect(await config.profile()).toEqual({
    name: "example.com",
    description: "",
    icon: "https://example.com/favicon.svg",
  });
});

test("the homepage's title is the mind's name, and it shows the icon in the tab and on the page", async () => {
  const html = await (await ask("/")).text();
  expect(html).toContain("<title>example.com</title>");
  expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
  expect(html).toContain('<img src="/favicon.svg" alt="" width="64" height="64"');
});

test.for(["dash", "docs", "meet", "onboarding"])(
  "the %s app's icon is the mind's: one file for the website and every app, to anyone",
  async (host) => {
    // a guard that lets nobody in: the icon is answered before it
    const guarded = Object.create(Config.prototype, {
      auth: { value: { require: () => new Response("Sign in\n", { status: 401 }) } },
    }) as { fetch(request: Request): Promise<Response> };
    const icon = await guarded.fetch(new Request(`https://${host}.example.com/icon.svg`));
    expect({
      status: icon.status,
      type: icon.headers.get("content-type"),
      policy: icon.headers.get("content-security-policy"),
      body: await icon.text(),
    }).toEqual({
      status: 200,
      type: "image/svg+xml",
      policy: "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      body: templateFiles["icon.svg"],
    });
  },
);

test("the owner's words are served trimmed, and no other key of the file is", async () => {
  const files = {
    "profile.json": JSON.stringify({
      name: "  Ada's mind ",
      description: " Thinks about engines.\nWrites notes. ",
      icon: "https://elsewhere.example/x.svg",
      apiKey: "not for the world",
    }),
    "icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    "notes.txt": "the owner's own file",
  };
  expect(await askOf(files, PROFILE_PATH).json()).toEqual({
    name: "Ada's mind",
    description: "Thinks about engines.\nWrites notes.",
    icon: "https://example.com/favicon.svg",
  });
  expect(await askOf(files, "/favicon.svg").text()).toBe(files["icon.svg"]);
  expect(serveProfile(new Request("https://example.com/notes.txt"), files)).toBeNull();
  expect(profileOf(files, "example.com")).toEqual({
    name: "Ada's mind",
    description: "Thinks about engines.\nWrites notes.",
    icon: "https://example.com/favicon.svg",
  });
});

test.for<[string, Record<string, string | Uint8Array>, unknown]>([
  ["no profile.json", {}, undefined],
  ["an empty profile.json", { "profile.json": "" }, undefined],
  [
    "text that is no JSON",
    { "profile.json": "{ name: Ada" },
    "profile/profile.json is not valid JSON.",
  ],
  [
    "a file that is no text",
    { "profile.json": new Uint8Array([255, 254]) },
    "profile/profile.json is not text.",
  ],
  [
    "no object",
    { "profile.json": JSON.stringify("Ada") },
    expect.stringContaining("profile/profile.json: the file is not what a profile holds"),
  ],
  [
    "a name of two lines",
    { "profile.json": JSON.stringify({ name: "Ada\nLovelace" }) },
    expect.stringContaining("profile/profile.json: name is not what a profile holds"),
  ],
  [
    "a name of 81 characters",
    { "profile.json": JSON.stringify({ name: "a".repeat(81) }) },
    expect.stringContaining("profile/profile.json: name is not"),
  ],
  [
    "a name that is no text",
    { "profile.json": JSON.stringify({ name: 7 }) },
    expect.stringContaining("profile/profile.json: name is not"),
  ],
  [
    "a description with a tab",
    { "profile.json": JSON.stringify({ description: "a\tb" }) },
    expect.stringContaining("profile/profile.json: description is not"),
  ],
  [
    "a description of 1001 characters",
    { "profile.json": JSON.stringify({ description: "a".repeat(1001) }) },
    expect.stringContaining("profile/profile.json: description is not"),
  ],
])("%s: the name is the zone and the description is empty", async ([, owners, problem]) => {
  const files = { ...owners, "icon.svg": "<svg/>" };
  expect(await askOf(files, PROFILE_PATH).json()).toEqual({
    name: "example.com",
    description: "",
    icon: "https://example.com/favicon.svg",
  });
  const said = profileOf(files, "example.com");
  expect(said).toEqual({
    name: "example.com",
    description: "",
    icon: "https://example.com/favicon.svg",
    problem,
  });
  // what an agent's script returns stays short
  expect(JSON.stringify(said).length).toBeLessThan(400);
});

test("a mind with no icon, one that is no text or one over the bound has none: the icon's paths are not found", async () => {
  const none = { "profile.json": JSON.stringify({ name: "Ada" }) };
  const large = { ...none, "icon.svg": `<svg>${"a".repeat(256 * 1024)}</svg>` };
  const bytes = { ...none, "icon.svg": new Uint8Array([255, 254, 60, 0]) };
  expect(profileOf(bytes, "example.com")).toEqual({
    name: "Ada",
    description: "",
    icon: null,
    problem: "profile/icon.svg is not text and is not served.",
  });
  for (const files of [none, large, bytes]) {
    expect(await askOf(files, PROFILE_PATH).json()).toEqual({
      name: "Ada",
      description: "",
      icon: null,
    });
    expect(askOf(files, "/favicon.svg")).toMatchObject({ status: 404 });
    expect(askOf(files, "/favicon.ico")).toMatchObject({ status: 404 });
  }
  expect(profileOf(none, "example.com")).toEqual({ name: "Ada", description: "", icon: null });
  expect(profileOf(large, "example.com")).toEqual({
    name: "Ada",
    description: "",
    icon: null,
    problem: "profile/icon.svg is over 262144 characters and is not served.",
  });
});

test("the profile is not the mind's identity: the mind's code never answers the identity log's path", async () => {
  // the boundary keeps the identity log's path from the mind's code, in every spelling
  expect(reservedPathOf(MIND_IDENTITY_PATH)).toEqual({ path: MIND_IDENTITY_PATH, exact: true });
  // the profile's path is an ordinary one, which the mind's code answers
  expect(reservedPathOf(PROFILE_PATH)).toBeNull();
  // and the profile's code answers nothing at the identity log's path, were it asked there
  expect(
    serveProfile(new Request(`https://example.com${MIND_IDENTITY_PATH}`), templateFiles),
  ).toBeNull();
  expect(await ask(MIND_IDENTITY_PATH)).toMatchObject({ status: 404 });
});

test("the Dash asks the zone's website for the profile, and draws without it", () => {
  const page = String(dashFiles["app.js"]);
  expect(page).toContain(`fetch(\`https://\${zone}${PROFILE_PATH}\`)`);
  expect(page).toContain("name: name || zone");
});

/** The default worker as a bare instance, with a mind at example.com. */
const config = Object.create(Config.prototype, {
  getItx: {
    value: () => ({
      whoami: async () => ({ path: "/", mindSlug: "iterate.example.com" }),
      url: async () => "https://example.com/",
      [Symbol.dispose]() {},
    }),
  },
}) as { fetch(request: Request): Promise<Response>; profile(): Promise<unknown> };

function ask(path: string, method = "GET") {
  return config.fetch(new Request(`https://example.com${path}`, { method }));
}

/** The answer for a folder of the owner's. */
function askOf(files: Record<string, string | Uint8Array>, path: string) {
  return serveProfile(new Request(`https://example.com${path}`), files)!;
}
