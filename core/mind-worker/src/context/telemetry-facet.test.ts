// telemetry-facet.test.ts — the template's telemetry facet (core/configs/default/apps/telemetry/
// backend.ts) as a facet's Worker starts it: in workerd, backend.ts as the Worker's main module,
// asked to reserve by another Worker. workerd takes every export of a Worker's main module as an
// entrypoint and refuses one that is no class or function ("Incorrect type for map entry
// OUTSIDE_A_DAY", the home lab, 22 Nov 2026), which the template's node:sqlite tests cannot see.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { expect, test } from "vitest";

test(
  "the telemetry facet's backend.ts starts as a Worker's main module in workerd, and reserves the outside's day",
  { timeout: 60_000 },
  async () => {
    await using runtime = await facetWorkers();
    const reserve = async (records: number) =>
      (await runtime.dispatchFetch(`http://caller.example/?records=${records}`)).json();
    // a call reserves 1 to 1,000 records; the day holds 20,000
    expect(await reserve(1_001)).toBe(false);
    const filled = [];
    for (let call = 0; call < 20; call++) filled.push(await reserve(1_000));
    expect(filled.every(Boolean)).toBe(true);
    expect(await reserve(1)).toBe(false);
  },
);

// "caller" asks the facet's class over RPC, as the mind's facet call does; "facet" is backend.ts
// alone, bundled, as the Worker's main module
async function facetWorkers() {
  const bundled = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../../../configs/default/apps/telemetry/backend.ts", import.meta.url).href,
      ),
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd"],
    external: ["cloudflare:*", "node:*"],
  });
  const caller = [
    "export default {",
    "  async fetch(request, env) {",
    '    const records = Number(new URL(request.url).searchParams.get("records"));',
    '    const days = env.DAYS.get(env.DAYS.idFromName("outside-days"));',
    "    return Response.json(await days.reserve(records));",
    "  },",
    "};",
  ].join("\n");
  const runtime = new Miniflare({
    workers: [
      // the first Worker answers dispatchFetch
      {
        config: {
          name: "caller",
          compatibilityDate: COMPATIBILITY_DATE,
          manifest: {
            mainModule: "caller.js",
            modules: { "caller.js": { type: "esm" as const, contents: caller } },
          },
          env: {
            DAYS: {
              type: "durable-object",
              worker: "facet",
              exportName: "OutsideDaysDurableObject",
            },
          },
        },
      },
      {
        config: {
          name: "facet",
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "backend.js",
            modules: {
              "backend.js": { type: "esm" as const, contents: bundled.outputFiles[0]!.text },
            },
          },
          exports: { OutsideDaysDurableObject: { type: "durable-object", storage: "sqlite" } },
        },
      },
    ],
  });
  await runtime.ready;
  return Object.assign(runtime, { [Symbol.asyncDispose]: () => runtime.dispose() });
}
