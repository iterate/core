// Writes the git-ignored modules under src/generated: core/alchemy's `deploy` and `plan` run it first,
// so the Worker Alchemy bundles carries this checkout's SDK and templates.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { createCli } from "trpc-cli";

const root = path.resolve(import.meta.dirname, "..");

/** One zod per isolate, so a schema made by user code is the schema the SDK checks. */
const PLATFORM_ENTRIES = [
  "iterate/sdk",
  "iterate/stream/processor",
  "iterate/stream/contract",
  "iterate/stream/run",
  "iterate/email",
  "iterate/integrations",
  "iterate/api",
  "iterate/lib",
  "iterate/expression",
  "iterate/principal",
  "iterate/agents",
  "iterate/agents/install",
  "iterate/agents/kinds",
  "iterate/agents/contract",
  "iterate/agents/processor",
  "iterate/agents/codemode-format",
  "iterate/standalone-page",
  "zod",
] as const;

/** One split esbuild graph, so `iterate/sdk` and `iterate/stream/processor` share one zod and one
 *  kernel; the resolver hands a loaded worker only what its imports reach. */
async function platformModules() {
  // Resolved from the SDK's own directory: `require.resolve("zod")` would pick zod's CJS build while
  // the SDK links its ESM one, two zods in one graph.
  const sdkDir = path.dirname(createRequire(import.meta.url).resolve("iterate/sdk"));
  const entryPoints = {
    ...Object.fromEntries(
      PLATFORM_ENTRIES.map((specifier) => [
        `node_modules/${specifier}`,
        `platform-entry:${specifier}`,
      ]),
    ),
    // what every loaded worker evaluates first (src/context/module-resolution.ts)
    "node_modules/.platform/loaded-worker": path.join(sdkDir, "loaded-worker.ts"),
  };
  const outdir = path.join(root, "src/generated/.platform-modules");
  const bundled = await esbuild({
    entryPoints,
    plugins: [
      {
        name: "platform-entry",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^platform-entry:/ }, (args) => ({
            path: args.path.slice("platform-entry:".length),
            namespace: "platform-entry",
          }));
          pluginBuild.onLoad({ filter: /.*/, namespace: "platform-entry" }, (args) => ({
            contents:
              (args.path === "zod" ? `export { default } from "zod";` : "") +
              ` export * from ${JSON.stringify(args.path)};`,
            resolveDir: sdkDir,
            loader: "js",
          }));
        },
      },
    ],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd"],
    target: "es2022",
    minify: true,
    write: false,
    metafile: true,
    outdir,
    chunkNames: "node_modules/.platform/[name]-[hash]",
    external: ["cloudflare:workers", "node:async_hooks"],
  });
  const moduleName = (file: string) => path.relative(outdir, file).split(path.sep).join("/");
  const modules: Record<string, string> = {};
  for (const file of bundled.outputFiles) modules[moduleName(file.path)] = file.text;
  const imports: Record<string, string[]> = {};
  for (const [file, output] of Object.entries(bundled.metafile.outputs)) {
    const name = moduleName(path.resolve(file));
    imports[name] = output.imports
      .filter((imported) => !imported.external)
      .map((imported) => moduleName(path.resolve(imported.path)));
  }
  return { modules, imports };
}

/** Git-tracked files only: not the node_modules/ a local `npm install` leaves there. */
function configTemplates() {
  const configs = path.resolve(root, "../configs");
  const names = readdirSync(configs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return Object.fromEntries(names.map((name) => [name, trackedFiles(path.join(configs, name))]));
}

function trackedFiles(folder: string) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: folder, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((file) => ({ path: file, content: readFileSync(path.join(folder, file), "utf8") }));
}

export default async function build() {
  mkdirSync(path.join(root, "src/generated"), { recursive: true });
  writeFileSync(
    path.join(root, "src/generated/platform-modules.js"),
    `export default ${JSON.stringify(await platformModules())};\n`,
  );
  writeFileSync(
    path.join(root, "src/generated/config-templates.js"),
    `export const templates = ${JSON.stringify(configTemplates())};\n`,
  );
  writeFileSync(
    path.join(root, "src/generated/sandbox-files-tool.js"),
    `export default ${JSON.stringify(readFileSync(path.resolve(root, "../lib/src/cli/fs.ts"), "utf8"))};\n`,
  );
}

void createCli(import.meta).run();
