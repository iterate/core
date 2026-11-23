// config-code-failed.test.ts — the SDK's `IterateConfigEntrypoint` (core/lib/src/sdk/index.ts) as a
// mind loads a config: in workerd, bundled, in an isolate of a worker loader, its `env.ITX` a stub
// of the host's. What a config's code throws in `fetch`, or rejects in `this.ctx.waitUntil`, is one
// `mind/code-failed` on its root, and the throw reaches the caller unchanged. The SDK gives the
// runtime's `ctx` an own `waitUntil`, which only workerd can say it allows: the Node shim has no
// runtime `ctx`.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { expect, test } from "vitest";

test(
  "a config's fetch throw reaches the caller unchanged and its waitUntil rejection is caught, each one mind/code-failed on its root, in workerd",
  { timeout: 60_000 },
  async () => {
    await using runtime = await loaderWorkers();
    const thrown = await runtime.dispatchFetch("http://mind.example/throw?token=abc");
    expect({ status: thrown.status, body: await thrown.json() }).toEqual({
      status: 500,
      body: { name: "TypeError", message: "the page broke" },
    });
    const rejected = await runtime.dispatchFetch("http://mind.example/reject");
    expect(await rejected.text()).toBe("answered");
    const appended = await appendedOnce(runtime, 2);
    expect(appended).toEqual([
      {
        type: "events.iterate.com/mind/code-failed",
        idempotencyKey: expect.stringMatching(/^code-failed:[0-9a-z]+:\d+$/),
        payload: {
          where: "fetch",
          method: "GET",
          path: "/throw",
          error: {
            name: "TypeError",
            message: "the page broke",
            stack: expect.stringContaining("the page broke"),
          },
        },
      },
      {
        type: "events.iterate.com/mind/code-failed",
        idempotencyKey: expect.stringMatching(/^code-failed:[0-9a-z]+:\d+$/),
        payload: {
          where: "waitUntil",
          error: {
            name: "Error",
            message: "rejected in waitUntil",
            stack: expect.stringContaining("rejected in waitUntil"),
          },
        },
      },
    ]);
  },
);

/** What the host's root was appended, once there are `count` events (the appends run after the
 *  answers, in the loaded isolate's `waitUntil`). */
async function appendedOnce(runtime: Miniflare, count: number): Promise<unknown[]> {
  for (let attempt = 0; ; attempt++) {
    const appended = (await (
      await runtime.dispatchFetch("http://mind.example/appended")
    ).json()) as unknown[];
    if (appended.length >= count || attempt === 100) return appended;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// "host" loads the config with the SDK's flags (worker-loader.ts) and hands it `env.ITX`, whose root
// keeps what is appended; the config is the SDK and a class of it, bundled as one module
async function loaderWorkers() {
  const config = await build({
    stdin: {
      contents: [
        'import { IterateConfigEntrypoint } from "iterate/sdk";',
        "export default class Config extends IterateConfigEntrypoint {",
        "  processEvent() {}",
        "  async email() {}",
        "  async fetch(request) {",
        '    if (new URL(request.url).pathname === "/throw") throw new TypeError("the page broke");',
        '    this.ctx.waitUntil(Promise.reject(new Error("rejected in waitUntil")));',
        '    return new Response("answered");',
        "  }",
        "}",
      ].join("\n"),
      resolveDir: fileURLToPath(new URL(".", import.meta.url).href),
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd"],
    target: "es2022",
    external: ["cloudflare:workers", "node:async_hooks"],
  });
  const host = [
    'import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";',
    "const appended = [];",
    "class Root extends RpcTarget {",
    "  append(...events) { appended.push(...events); return []; }",
    "}",
    "export class Itx extends WorkerEntrypoint {",
    "  get() { return new Root(); }",
    "}",
    "export default {",
    "  async fetch(request, env, ctx) {",
    '    if (new URL(request.url).pathname === "/appended") return Response.json(appended);',
    '    const worker = env.LOADER.get("config", () => ({',
    `      compatibilityDate: ${JSON.stringify(COMPATIBILITY_DATE)},`,
    '      compatibilityFlags: ["nodejs_als", "allow_irrevocable_stub_storage"],',
    '      mainModule: "config.js",',
    `      modules: { "config.js": ${JSON.stringify(config.outputFiles[0]!.text)} },`,
    "      env: { ITX: ctx.exports.Itx({ props: {} }) },",
    "    }));",
    "    try {",
    "      return await worker.getEntrypoint().fetch(request);",
    "    } catch (error) {",
    "      return Response.json({ name: error.name, message: error.message }, { status: 500 });",
    "    }",
    "  },",
    "};",
  ].join("\n");
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "host",
          compatibilityDate: COMPATIBILITY_DATE,
          manifest: {
            mainModule: "host.js",
            modules: { "host.js": { type: "esm" as const, contents: host } },
          },
          env: { LOADER: { type: "worker-loader" } },
          exports: { Itx: { type: "worker" } },
        },
      },
    ],
  });
  await runtime.ready;
  return Object.assign(runtime, { [Symbol.asyncDispose]: () => runtime.dispose() });
}
