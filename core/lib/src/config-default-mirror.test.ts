// The default config's mirror case (core/configs/default/worker.ts): when it pulls, when it
// pushes, and when it does nothing. The worker runs here with a root that records what it is asked.
// The worker mounts its apps, whose page and folder of files the platform's loader hands over:
// here core/lib's vitest config does (vitest.config-file-imports.ts).
/// <reference path="../../configs/default/files.d.ts" />
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import index from "../../configs/default/apps/agents/index.html";
// oxlint-disable-next-line import/extensions -- a folder: every file under it, by path
import files from "../../configs/default/apps/agents/public/";
import dashIndex from "../../configs/default/apps/dash/index.html";
// oxlint-disable-next-line import/extensions -- a folder: every file under it, by path
import dashFiles from "../../configs/default/apps/dash/public/";
import docsIndex from "../../configs/default/apps/docs/index.html";
// oxlint-disable-next-line import/extensions -- a folder: every file under it, by path
import docsFiles from "../../configs/default/apps/docs/public/";
import onboardingIndex from "../../configs/default/apps/onboarding/index.html";
// oxlint-disable-next-line import/extensions -- a folder: every file under it, by path
import onboardingFiles from "../../configs/default/apps/onboarding/public/";
import voiceIndex from "../../configs/default/apps/voice/index.html";
// oxlint-disable-next-line import/extensions -- a folder: every file under it, by path
import voiceFiles from "../../configs/default/apps/voice/public/";
import Config from "../../configs/default/worker.ts";

test("the default config's pages and folders load here as the platform's loader makes them", () => {
  // The rule is the loader's (core/mind-worker/src/context/module-resolution.ts). When it changes,
  // this fails here and not at a deploy: a page is its text, a folder is its files by path.
  expect(index).toMatch(/^<!doctype html>/i);
  expect(files["app.js"]).toEqual(expect.any(String));
  expect(Object.keys(files)).toEqual(Object.keys(files).toSorted());
  expect(onboardingIndex).toMatch(/<title>Welcome to iterate<\/title>/);
  const own = ["app.css", "app.js", "icon.svg", "manifest.webmanifest"];
  expect(Object.keys(onboardingFiles)).toEqual(own);
  expect(docsIndex).toMatch(/<title>Docs<\/title>/);
  expect(Object.keys(docsFiles)).toEqual(own);
  expect(dashIndex).toMatch(/<title>Dash<\/title>/);
  // the Dash's page has one more script: the store of each page's part of the kit
  expect(Object.keys(dashFiles)).toEqual([
    "app.css",
    "app.js",
    "brands/cloudflare.svg",
    "brands/github.svg",
    "brands/google.svg",
    "brands/slack.svg",
    "brands/x.svg",
    "icon.svg",
    "kit-pages.js",
    "manifest.webmanifest",
  ]);
  expect(voiceIndex).toMatch(/<title>Voice<\/title>/);
  expect(Object.keys(voiceFiles)).toEqual([
    "app.css",
    "app.js",
    "audio.js",
    "capture-worklet.js",
    "icon.svg",
    "manifest.webmanifest",
    "playback-worklet.js",
    "turn-on.js",
  ]);
});

test.for(["agents", "onboarding", "docs", "dash", "voice"])(
  "the %s app says its name and its icon to anyone, and nothing else before a sign-in",
  async (host) => {
    const refusal = new Response("Sign in\n", { status: 401 });
    // a bare instance, with a guard that lets nobody in
    const config = Object.create(Config.prototype, {
      auth: { value: { require: () => refusal } },
    }) as { fetch(request: Request): Promise<Response> };
    const ask = (path: string) =>
      config.fetch(
        new Request(`https://${host}.example.com${path}`, {
          headers: { "x-iterate-routing-slug": host },
        }),
      );
    const manifest = await ask("/manifest.webmanifest");
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    const said = (await manifest.json()) as { name: string; icons: { src: string }[] };
    expect(said.name).toMatch(/^[A-Z][a-z]+$/);
    expect(said.icons.map((icon) => icon.src)).toEqual(["/icon.svg"]);
    const icon = await ask("/icon.svg");
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(await icon.text()).toMatch(/^<svg /);
    // the page, its script and every other path are the guard's
    for (const path of ["/", "/app.js", "/itx", "/manifest.webmanifest/x", "/icon.svg.map"])
      expect(await ask(path)).toBe(refusal);
  },
);

test("the Dash's overview leads to every other app the default worker mounts", () => {
  // the hosts the worker's `fetch` answers: one `case "<host>":` each
  const worker = readFileSync(new URL("../../configs/default/worker.ts", import.meta.url), "utf8");
  const mounted = [...worker.matchAll(/^ {6}case "([a-z]+)":/gm)].map(([, host]) => host);
  expect(mounted).toEqual(["agents", "onboarding", "docs", "dash", "voice"]);
  const linked = [...String(dashFiles["app.js"]).matchAll(/\bhost: "([a-z]+)"/g)].map(
    ([, host]) => host,
  );
  expect(linked.toSorted()).toEqual(mounted.filter((host) => host !== "dash").toSorted());
});

const ORIGIN =
  'https://x-access-token:getSecret("/secrets/github-installation-7", { field: "accessToken" })@github.com/Acme/config.git';

test.for([
  {
    name: "a push to the linked repository's main, relayed and signed by the Cloud, is pulled",
    calls: ["pull"],
  },
  {
    name: "a commit to the config repo is pushed",
    event: {
      type: "events.iterate.com/repo/commit-completed",
      path: "/",
      payload: { path: "/repos/config" },
    },
    calls: ["push"],
  },
  {
    name: "the same commit's fact on the repo's own log is not pushed again",
    event: {
      type: "events.iterate.com/repo/commit-completed",
      path: "/repos/config",
      payload: { path: "/repos/config" },
    },
  },
  {
    name: "a commit to another repo is not",
    event: {
      type: "events.iterate.com/repo/commit-completed",
      path: "/repos/site",
      payload: { path: "/repos/site" },
    },
  },
  { name: "a push nobody signed is not GitHub's word", event: { source: {} } },
  {
    name: "nor one signed by another key",
    event: { source: { signer: { principal: { actor: "someone" }, key: "k" } } },
  },
  { name: "nor one outside the installation's own log", event: { path: "/agents/x/push" } },
  { name: "a push to another branch moves nothing", body: { ref: "refs/heads/next" } },
  {
    name: "a push to another repository of the installation moves nothing",
    body: { repository: { full_name: "acme/site" } },
  },
  { name: "another delivery about main moves nothing", delivery: { name: "create" } },
  { name: "a mind with no origin does nothing", origin: null },
  { name: "nor one whose origin is not on GitHub", origin: "https://git.example/acme/config.git" },
] as {
  name: string;
  event?: Record<string, unknown>;
  body?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  origin?: string | null;
  calls?: string[];
}[])("$name", async ({ event, body, delivery, origin = ORIGIN, calls = [] }) => {
  const root = rootWith({ origin });
  await run(root, {
    type: "events.iterate.com/github/webhook-received",
    path: "/integrations/github/7",
    offset: 5,
    source: { signer: { principal: { actor: "iterate-cloud" }, key: "cloud-key" } },
    payload: {
      delivery: { id: "d-1", name: "push", ...delivery },
      installationId: "7",
      body: { ref: "refs/heads/main", repository: { full_name: "acme/config" }, ...body },
    },
    ...event,
  });
  // what merely confirmed that both sides agree leaves no fact
  expect(root).toMatchObject({ calls, appended: [] });
});

test("what moved is a fact on the root, and histories that diverged stop there: nothing is forced", async () => {
  const pushed = {
    type: "events.iterate.com/repo/commit-completed",
    path: "/",
    offset: 9,
    payload: { path: "/repos/config" },
  };
  const moved = rootWith({ origin: ORIGIN, answer: { status: "updated", commitOid: "abc" } });
  await run(moved, pushed);
  const diverged = rootWith({
    origin: ORIGIN,
    answer: Object.assign(new Error("origin's main has commits this repo lacks"), {
      code: "NOT_FAST_FORWARD",
    }),
  });
  await run(diverged, pushed);
  expect([moved.appended, diverged.appended, diverged.calls]).toEqual([
    [
      {
        type: "config/github-mirrored",
        idempotencyKey: "config/github-mirrored:/:9",
        payload: {
          direction: "push",
          repository: "Acme/config",
          status: "updated",
          commitOid: "abc",
        },
      },
    ],
    [
      {
        type: "config/github-mirrored",
        idempotencyKey: "config/github-mirrored:/:9",
        payload: {
          direction: "push",
          repository: "Acme/config",
          status: "not-fast-forward",
          error: "origin's main has commits this repo lacks",
        },
      },
    ],
    ["push"],
  ]);
});

test("a push that GitHub lets wait is tried once more, and one it refuses twice is said to have failed", async () => {
  // two commits close together push at the same moment: GitHub cannot lock main for the second
  const busy = new Error("refused the push: cannot lock ref 'refs/heads/main'");
  const pushed = {
    type: "events.iterate.com/repo/commit-completed",
    path: "/",
    offset: 9,
    payload: { path: "/repos/config" },
  };
  const waited = rootWith({
    origin: ORIGIN,
    answers: [busy, { status: "updated", commitOid: "abc" }],
  });
  await run(waited, pushed);
  const refused = rootWith({ origin: ORIGIN, answers: [busy, busy] });
  await run(refused, pushed);
  expect([waited, refused]).toMatchObject([
    { calls: ["push", "push"], appended: [{ payload: { direction: "push", status: "updated" } }] },
    {
      calls: ["push", "push"],
      appended: [{ payload: { status: "failed", error: expect.stringContaining("cannot lock") } }],
    },
  ]);
});

/** A mind's root as the case uses it: the config repo's origin, its pull and push (which take
 *  no argument: a `force` would show in `calls`), and what is appended to the root. */
function rootWith({
  origin,
  answer = { status: "up-to-date", commitOid: "abc" },
  answers = [answer],
}: {
  origin: string | null;
  answer?: { status: string; commitOid: string } | Error;
  /** What each call answers, in order; the last one again after that. */
  answers?: ({ status: string; commitOid: string } | Error)[];
}) {
  const calls: string[] = [];
  const appended: unknown[] = [];
  const sync = (name: string) => async (options?: unknown) => {
    calls.push(options ? `${name} ${JSON.stringify(options)}` : name);
    const answered = answers[Math.min(calls.length, answers.length) - 1]!;
    if (answered instanceof Error) throw answered;
    return answered;
  };
  return {
    calls,
    appended,
    repos: { get: () => ({ origin: async () => origin, pull: sync("pull"), push: sync("push") }) },
    append: async (event: unknown) => {
      appended.push(event);
    },
  };
}

function run(itx: ReturnType<typeof rootWith>, event: Record<string, unknown>) {
  // the entrypoint's own state is not the case's: the method is called on a bare instance
  const config = Object.create(Config.prototype) as { processEvent(args: unknown): Promise<void> };
  return config.processEvent({ event, itx });
}
