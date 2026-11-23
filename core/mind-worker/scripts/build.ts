// Writes the git-ignored modules under src/generated: core/alchemy's `deploy` runs it first,
// so the Worker Alchemy bundles carries this checkout's SDK and templates.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { PLATFORM_ENTRIES } from "../src/platform-entries.ts";

const root = path.resolve(import.meta.dirname, "..");

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

/** THE REPOS A NEW MIND STARTS WITH beside its config, from `ITERATE_SEED_REPOS`: JSON, a repo
 *  path of the mind to an absolute folder (`{"/repos/onboarding":"/…/core/repos/onboarding"}`).
 *  The deploy command sets it (core/lib/src/cli/deploy.ts); the kernel names no repo itself. Each
 *  folder's git-tracked files; none when the variable is not set. */
function seedRepos(): Record<string, { path: string; content: string }[]> {
  const named = process.env.ITERATE_SEED_REPOS;
  if (!named) return {};
  const folders = z.record(z.string(), z.string()).safeParse(JSON.parse(named));
  if (!folders.success)
    throw new Error(`ITERATE_SEED_REPOS is not an object of repo paths to folders: ${named}`);
  return Object.fromEntries(
    Object.entries(folders.data).map(([repo, folder]) => {
      if (!/^\/repos\/[a-z0-9][a-z0-9-]*$/.test(repo) || repo === "/repos/config")
        throw new Error(
          `ITERATE_SEED_REPOS names ${JSON.stringify(repo)}: a seed repo is /repos/<name>, and never /repos/config`,
        );
      if (!path.isAbsolute(folder) || !existsSync(folder))
        throw new Error(
          `ITERATE_SEED_REPOS names ${JSON.stringify(folder)} for ${repo}: that is no absolute path of a folder that exists`,
        );
      return [repo, trackedFiles(folder)];
    }),
  );
}

export default async function build() {
  mkdirSync(path.join(root, "src/generated"), { recursive: true });
  writeFileSync(
    path.join(root, "src/generated/platform-modules.js"),
    `export default ${JSON.stringify(await platformModules())};\n`,
  );
  writeFileSync(
    path.join(root, "src/generated/config-templates.js"),
    `export const templates = ${JSON.stringify(configTemplates())};\nexport const seedRepos = ${JSON.stringify(seedRepos())};\n`,
  );
  writeFileSync(
    path.join(root, "src/generated/sandbox-files-tool.js"),
    `export default ${JSON.stringify(readFileSync(path.resolve(root, "../lib/src/cli/fs.ts"), "utf8"))};\n`,
  );
}

void createCli(import.meta).run();
