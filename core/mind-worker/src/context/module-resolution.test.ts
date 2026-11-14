import { expect, test } from "vitest";
import { resolveModules, type ResolveOptions } from "./module-resolution.ts";

// A folder import loads every file under the folder as text, code too (a page's). A file there can
// also be imported as code by another module: both must be loaded, in either order.
test.for([
  {
    order: "the folder first",
    worker:
      'import files from "./lib/";\nimport { x } from "./lib/x.ts";\nexport default { files, x };\n',
  },
  {
    order: "the code first",
    worker:
      'import { x } from "./lib/x.ts";\nimport files from "./lib/";\nexport default { files, x };\n',
  },
])(
  "a file imported as code and as part of a folder is both a module and a text ($order)",
  async ({ worker }) => {
    const { modules, files } = await resolveModules(sourceWith(worker), options());
    expect(modules).toMatchObject({
      "lib/x.js": expect.stringContaining("export const x = 1"),
      "lib/x.ts.file.js": `export default ${JSON.stringify("export const x: number = 1;\n")};\n`,
      "worker.js": expect.stringContaining('from "./lib/x.js"'),
    });
    expect(Object.keys(files).sort()).toEqual(["lib/x.ts", "package.json", "worker.ts"]);
  },
);

/** A config whose worker.ts is `worker`, beside one code file in a folder. */
function sourceWith(worker: string) {
  return {
    "package.json": JSON.stringify({ main: "worker.ts" }),
    "worker.ts": worker,
    "lib/x.ts": "export const x: number = 1;\n",
  };
}

/** No platform module, no npm package, no network: the resolution of relative imports alone. */
function options(): ResolveOptions {
  return {
    platform: { modules: {}, imports: {} },
    store: { get: async () => null, put: async () => {} },
    fetch: () => Promise.reject(new Error("no network in this test")),
    where: "test",
  };
}
