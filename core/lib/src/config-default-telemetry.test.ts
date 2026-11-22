// The default config's page tag, /exceptions, the crash job and page speed
// (core/configs/default/apps/telemetry, page-events.md, errors.md). Their checks are Node's own
// tests, `.test.mjs` beside the code, as a mind's config runs them (`node --test`): they hand
// over the platform's `iterate/lib`, the folder import and `HTMLRewriter` with Node's module
// hooks. This runs them in this repo's test run, and fails with their output.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { defaultConfigInstance, stubHtmlRewriter } from "./test-support/config-default-instance.ts";

const TELEMETRY = fileURLToPath(new URL("../../configs/default/apps/telemetry/", import.meta.url));

test("the telemetry app's node tests pass", () => {
  const files = readdirSync(TELEMETRY).filter((name) => name.endsWith(".test.mjs"));
  expect(files.toSorted()).toEqual([
    "crashes.test.mjs",
    "exceptions.test.mjs",
    "page-events.test.mjs",
    "page-speed.test.mjs",
  ]);
  const run = spawnSync(process.execPath, ["--test", ...files], {
    cwd: TELEMETRY,
    encoding: "utf8",
    timeout: 60_000,
  });
  const said = `${run.stdout}\n${run.stderr}`;
  expect(run, said).toMatchObject({ status: 0 });
  expect(said).toMatch(/^ℹ fail 0$/m);
});

test("the homepage takes the page tag on the zone's own name and www alone: an invented label goes on no list of hosts", async () => {
  stubHtmlRewriter();
  const puts: string[] = [];
  const kept: Promise<unknown>[] = [];
  const config = defaultConfigInstance({
    ctx: { value: { waitUntil: (promise: Promise<unknown>) => kept.push(promise), props: {} } },
    auth: { value: { principal: () => null, person: () => null } },
    getItx: {
      value: () => ({
        whoami: async () => ({ path: "/", mindSlug: "iterate.example.com" }),
        url: async () => "https://example.com/",
        kv: {
          get: async () => JSON.stringify(puts.at(-1) ? JSON.parse(puts.at(-1)!) : []),
          put: async (_key: string, value: string) => void puts.push(value),
        },
        [Symbol.dispose]() {},
      }),
    },
  }) as { fetch(request: Request): Promise<Response> };
  const homepage = async (host: string) => {
    const answer = await config.fetch(new Request(`https://${host}/`));
    return {
      tagged: (await answer.text()).includes("/.page.js"),
      off: answer.headers.get("x-page-events"),
    };
  };
  expect({
    apex: await homepage("example.com"),
    www: await homepage("www.example.com"),
    invented: await homepage("no-such-app.example.com"),
    another: await homepage("x7.example.com"),
  }).toEqual({
    apex: { tagged: true, off: null },
    www: { tagged: true, off: null },
    invented: { tagged: false, off: "off" },
    another: { tagged: false, off: "off" },
  });
  await Promise.all(kept);
  expect(JSON.parse(puts.at(-1)!)).toEqual(["example.com", "www.example.com"]);
});

test("the crash job runs for the platform's tick alone: the same type elsewhere, signed or not, starts no log query", async () => {
  const queries: string[] = [];
  const itx = {
    kv: { get: async () => null, put: async () => {} },
    telemetry: {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    },
    cd: () => ({ append: async () => {} }),
  };
  const config = defaultConfigInstance() as { processEvent(args: unknown): Promise<void> };
  const tick = (path: string, source: Record<string, unknown>) =>
    config.processEvent({
      event: {
        type: "events.iterate.com/exception/sweep-requested",
        path,
        offset: 7,
        createdAt: "2026-11-22T12:00:00.000Z",
        payload: {},
        source,
      },
      itx,
    });
  await tick("/people/ada@example.com", {
    origin: "/people/ada@example.com",
    signer: { principal: { email: "ada@example.com" } },
  });
  await tick("/exceptions/sweeps", { origin: "/exceptions/sweeps" });
  expect(queries).toEqual([]);
  await tick("/exceptions/sweeps", {
    origin: "/",
    schedule: { key: "crash-sweep", scheduledAtOffset: 3, at: "2026-11-22T12:00:00.000Z" },
  });
  expect(queries).toHaveLength(1);
});

test("the day's budget facet is in a module that a publication offers a facet's class from", async () => {
  // the platform's rule (core/mind-worker/src/mind/publication.ts `publishedModules`, not exported):
  // a module at the config's root, or an app's backend.ts. From apps/telemetry/outside-days.ts the
  // facet failed at its first call on the home lab (22 Nov 2026), and every record from outside was
  // dropped, while the class's own tests passed: they loaded it directly.
  const source = readFileSync(
    new URL("../../mind-worker/src/mind/publication.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain(
    '.filter((path) => !path.includes("/") || /^apps\\/[^/]+\\/backend\\.[a-z]+$/.test(path))',
  );
  const { OUTSIDE_DAYS } = await import("../../configs/default/apps/telemetry/page-events.ts");
  expect(OUTSIDE_DAYS.spec.mainModule).toMatch(/^apps\/[^/]+\/backend\.[a-z]+$/);
  expect(
    existsSync(new URL(`../../configs/default/${OUTSIDE_DAYS.spec.mainModule}`, import.meta.url)),
  ).toBe(true);
  // and that module exports the class the spec names
  const exported = (await import("../../configs/default/apps/telemetry/backend.ts")) as Record<
    string,
    unknown
  >;
  expect(typeof exported[OUTSIDE_DAYS.spec.className]).toBe("function");
});
