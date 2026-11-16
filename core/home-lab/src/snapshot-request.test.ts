import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare, Response } from "miniflare";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";

void test(
  "an ended request's pending snapshot does not fail the next request",
  {
    timeout: 30_000,
  },
  async ({ signal }) => {
    const bundled = await build({
      entryPoints: [fileURLToPath(new URL("./fixtures/snapshot-request.ts", import.meta.url).href)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd"],
      external: ["cloudflare:*", "node:*"],
    });
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const calls: string[] = [];
    const runtime = new Miniflare({
      workers: [
        {
          config: {
            name: "snapshot-fixture",
            compatibilityDate: COMPATIBILITY_DATE,
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm", contents: bundled.outputFiles[0]!.text } },
            },
            env: {
              SOURCE: {
                type: "fetcher",
                handler: async (request) => {
                  const path = new URL(request.url).pathname;
                  if (path === "/ready") {
                    await started.promise;
                    return new Response("ready");
                  }
                  calls.push(path);
                  if (path === "/prime") {
                    started.resolve();
                    await pending.promise;
                  }
                  return Response.json({
                    version: "fresh",
                    rules: [],
                    routing: { fetchRoutes: {}, ingressTarget: null },
                  });
                },
              },
            },
          },
        },
      ],
    });
    try {
      const first = await runtime.dispatchFetch("http://fixture/prime", { signal });
      assert.equal(await first.text(), "primed");
      // Older runtimes recover at the read deadline; newer ones reject the abandoned promise.
      const budget = Number(first.headers.get("x-snapshot-read-budget-ms"));
      const next = await runtime.dispatchFetch("http://fixture/value", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(budget)]),
      });
      assert.equal(next.status, 200, await next.clone().text());
      assert.partialDeepStrictEqual(await next.json(), {
        version: "fresh",
        rules: [],
        routing: { fetchRoutes: {}, ingressTarget: null },
      });
      assert.deepEqual(calls, ["/prime", "/value"]);
    } finally {
      started.resolve();
      pending.resolve();
      await runtime.dispose();
    }
  },
);
