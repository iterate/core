// A bare import loads as `node_modules/<specifier>.js`: `iterate/*` and `zod` from this deployment's
// own build, anything else from esm.sh, its graph crawled once per dependency set and locked in the
// module store. A pkg.pr.new ref that is not a full commit is refused: a lock cannot follow a moving
// ref without asking pkg.pr.new on every cold start.
import { isPkgPrNewCommit, pkgPrNewBuildOf } from "iterate/package-builds";
import {
  failureKind,
  httpFailureKind,
  isPlatformFailureKind,
  logPlatformFailure,
} from "iterate/platform-retry";
import { parse } from "es-module-lexer/js";
import { transform } from "sucrase";
import { z } from "zod";
import { sha256Hex, unavailableError } from "core-itx";

export type ModuleMap = Record<string, string>;

// A source as authored: a file is its text, or `{ base64 }` when it is not text (the repo facet's
// `files()`).
export type SourceFiles = Record<string, string | { base64: string }>;

export type PlatformModules = {
  modules: ModuleMap;
  // esbuild's metafile
  imports: Record<string, string[]>;
};

// values are immutable
export type ModuleStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

export type ResolveOptions = {
  platform: PlatformModules;
  store: ModuleStore;
  fetch: typeof fetch;
  where: string;
  nodejsCompat?: boolean;
  // in place of package.json's `main`; its dependencies are still package.json's
  mainModule?: string;
};

// For a source whose package.json names no `main`, in order: a config repo seeded without `main`,
// and iterate/agents' AI transport source.
const ENTRY_FILES = ["worker.ts", "worker.js", "index.ts", "index.js"];

// esm.sh's bundler cannot find these, and refuses (404) a package that imports one unless it is named
const WORKERD_BUILTINS = ["cloudflare:email", "cloudflare:sockets", "cloudflare:workers"];

const isRelative = (specifier: string) => specifier.startsWith("./") || specifier.startsWith("../");

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
}

function relativeSpecifier(from: string, to: string): string {
  const fromDir = from.split("/").slice(0, -1);
  const toParts = to.split("/");
  let shared = 0;
  while (
    shared < fromDir.length &&
    shared < toParts.length - 1 &&
    fromDir[shared] === toParts[shared]
  )
    shared++;
  const up = fromDir.length - shared;
  return (up === 0 ? "./" : "../".repeat(up)) + toParts.slice(shared).join("/");
}

function joinPath(fromModule: string, specifier: string): string {
  const out = fromModule.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

type SpecifierEdit = { specifier: string; start: number; end: number; dynamic: boolean };

// static specifiers are unquoted spans, dynamic ones include their quotes
function rewriteSpecifiers(code: string, edits: SpecifierEdit[]): string {
  let out = code;
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    out =
      out.slice(0, edit.start) +
      (edit.dynamic ? JSON.stringify(edit.specifier) : edit.specifier) +
      out.slice(edit.end);
  return out;
}

// An `import()` of a computed specifier is left as written: packages do it on purpose (pi-ai's
// `importNodeModule` keeps bundlers off `node:fs` and catches the rejection).
function importsOf(code: string, name: string, where: string): SpecifierEdit[] {
  let imports;
  try {
    [imports] = parse(code, name);
  } catch (error) {
    throw new Error(`${where}: ${name} is not a valid module: ${String(error)}`);
  }
  const out: SpecifierEdit[] = [];
  for (const imp of imports) {
    if (imp.d === -2) continue; // import.meta
    const template = code.slice(imp.s, imp.e).match(/^`([^`\\$]*)`$/)?.[1];
    const specifier = imp.n || template;
    if (!specifier) continue;
    out.push({ specifier, start: imp.s, end: imp.e, dynamic: imp.d > -1 });
  }
  return out;
}

function stripTypes(code: string, name: string, where: string): string {
  try {
    return transform(code, {
      transforms: ["typescript"],
      disableESTransforms: true,
      filePath: name,
    }).code;
  } catch (error) {
    throw new Error(`${where}: ${name} does not parse as TypeScript: ${String(error)}`);
  }
}

const PackageManifest = z.object({
  main: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  compatibilityFlags: z.array(z.string()).optional(),
});

export function readPackage(
  source: SourceFiles,
  where: string,
): {
  entry: string;
  dependencies: Record<string, string>;
  compatibilityFlags: string[] | undefined;
} {
  let manifest: z.infer<typeof PackageManifest> = {};
  const packageJson = source["package.json"];
  if (packageJson && typeof packageJson !== "string")
    throw new Error(`${where}: package.json is not text`);
  if (packageJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(packageJson);
    } catch (error) {
      throw new Error(`${where}: package.json is not valid JSON: ${String(error)}`);
    }
    const result = PackageManifest.safeParse(parsed);
    if (!result.success)
      throw new Error(
        `${where}: package.json needs "main" to be a path and "dependencies" to map package names to versions`,
      );
    manifest = result.data;
  }
  const { main } = manifest;
  const entry = main ? joinPath("", main) : ENTRY_FILES.find((file) => Object.hasOwn(source, file));
  if (!entry || !Object.hasOwn(source, entry))
    throw new Error(
      `${where}: no entry — ${main ? `package.json's main ${JSON.stringify(main)} is not a file` : `name the entry module in package.json "main"`}`,
    );
  return {
    entry,
    dependencies: manifest.dependencies || {},
    compatibilityFlags: manifest.compatibilityFlags,
  };
}

const moduleOfSpecifier = (specifier: string) => `node_modules/${specifier}.js`;

function platformPackages(platform: PlatformModules): string[] {
  const entries = Object.keys(platform.modules).filter(
    (name) => !name.startsWith("node_modules/."),
  );
  return [
    ...new Set(
      entries.map((name) => packageName(name.slice("node_modules/".length, -".js".length))),
    ),
  ].sort();
}

// a subpath of a platform package it does not ship is refused: a second copy would break the one
function platformModuleOf(
  specifier: string,
  platform: PlatformModules,
  where: string,
): string | undefined {
  const name = moduleOfSpecifier(specifier);
  if (Object.hasOwn(platform.modules, name)) return name;
  if (platformPackages(platform).includes(packageName(specifier)))
    throw new Error(
      `${where}: ${specifier} is not a module loaded workers have (the platform ships ${Object.keys(
        platform.modules,
      )
        .filter((module) => !module.startsWith("node_modules/."))
        .map((module) => module.slice("node_modules/".length, -".js".length))
        .join(", ")})`,
    );
  return undefined;
}

// `files` is the part of `source` the resolution read: resolving it alone answers what resolving
// `source` answers. A change that reads more of `source` bumps LOADED_CODE_FORMAT (worker-loader.ts).
// A FILE IMPORT. A relative import of a file that is not code loads it as a module whose default
// export is its text, or its bytes (a `Uint8Array`) when it is not text. An import that ends in `/`
// loads every file under that folder as one object, path → text or bytes: code there is text too,
// since it is a page's, not this worker's.
const fileModuleName = (path: string) => `${path}.file.js`;

function fileModule(content: string | { base64: string }): string {
  if (typeof content === "string") return `export default ${JSON.stringify(content)};\n`;
  return [
    `const binary = atob(${JSON.stringify(content.base64)});`,
    `const bytes = new Uint8Array(binary.length);`,
    `for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);`,
    `export default bytes;`,
    ``,
  ].join("\n");
}

export async function resolveModules(
  source: SourceFiles,
  opts: ResolveOptions,
): Promise<{
  mainModule: string;
  modules: ModuleMap;
  compatibilityFlags: string[] | undefined;
  files: SourceFiles;
}> {
  const { where, platform } = opts;
  const { entry: main, dependencies, compatibilityFlags } = readPackage(source, where);
  const nodejsCompat = compatibilityFlags?.includes("nodejs_compat") ?? false;
  const entry = opts.mainModule ? joinPath("", opts.mainModule) : main;
  if (!Object.hasOwn(source, entry))
    throw new Error(
      `${where}: no module ${JSON.stringify(opts.mainModule)} to load as the main module`,
    );
  const out: ModuleMap = {};
  const outputName = (path: string) => path.replace(/\.(mts|ts|mjs|js)$/, "") + ".js";
  const findSourceFile = (path: string): string | undefined => {
    const candidates = [path, `${path}.ts`, `${path}.js`, `${path}/index.ts`, `${path}/index.js`];
    if (path.endsWith(".js")) candidates.push(path.replace(/\.js$/, ".ts"));
    return candidates.find(
      (candidate) => Object.hasOwn(source, candidate) && /\.(js|mjs|ts|mts)$/.test(candidate),
    );
  };
  const platformUsed: string[] = [];
  const npmSpecifiers = new Set<string>();
  // `read`: every file the resolution read, as code or as text. `queued`: the files loaded as code.
  // A file can be both: a folder import reads code as text too, and another module imports it.
  const read = new Set<string>([entry]);
  const queued = new Set<string>([entry]);
  const queue = [entry];
  const addModule = (name: string, code: string, from: string) => {
    if (Object.hasOwn(out, name) && out[name] !== code)
      throw new Error(`${where}: ${from} and another file both load as ${name}`);
    out[name] = code;
  };
  const loadFile = (file: string): string => {
    read.add(file);
    addModule(fileModuleName(file), fileModule(source[file]!), file);
    return fileModuleName(file);
  };
  const loadFolder = (dir: string, importer: string, specifier: string): string => {
    const prefix = `${dir}/`;
    const files = Object.keys(source)
      .filter((file) => file.startsWith(prefix))
      .sort();
    if (!dir || !files.length)
      throw new Error(`${where}: ${importer} imports ${specifier}, and there is no such folder`);
    const name = `${dir}.files.js`;
    const lines = files.map(
      (file, index) =>
        `import f${index} from ${JSON.stringify(relativeSpecifier(name, loadFile(file)))};`,
    );
    const entries = files.map(
      (file, index) => `  ${JSON.stringify(file.slice(prefix.length))}: f${index},`,
    );
    addModule(name, [...lines, `export default {`, ...entries, `};`, ``].join("\n"), dir);
    return name;
  };
  while (queue.length) {
    const path = queue.pop()!;
    const name = outputName(path);
    if (Object.hasOwn(out, name))
      throw new Error(`${where}: ${path} and another file both load as ${name}`);
    const authored = source[path]!;
    if (typeof authored !== "string")
      throw new Error(`${where}: ${path} is not text, so it is not a module`);
    const code = /\.m?ts$/.test(path) ? stripTypes(authored, path, where) : authored;
    const edits: SpecifierEdit[] = [];
    for (const edit of importsOf(code, name, where)) {
      const { specifier } = edit;
      if (specifier.startsWith("cloudflare:")) continue;
      let target: string;
      if (isRelative(specifier)) {
        const joined = joinPath(path, specifier);
        const file = specifier.endsWith("/") ? undefined : findSourceFile(joined);
        if (specifier.endsWith("/")) {
          target = loadFolder(joined, path, specifier);
        } else if (file) {
          if (!queued.has(file)) {
            queued.add(file);
            read.add(file);
            queue.push(file);
          }
          target = outputName(file);
        } else if (Object.hasOwn(source, joined)) {
          target = loadFile(joined);
        } else {
          throw new Error(`${where}: ${path} imports ${specifier}, and there is no such file`);
        }
      } else if (specifier.startsWith("node:")) {
        if (nodejsCompat) continue;
        throw new Error(
          `${where}: ${path} imports the Node.js builtin ${specifier}, which loaded workers do not have`,
        );
      } else if (specifier.startsWith("/") || /^[a-z]+:/.test(specifier)) {
        throw new Error(
          `${where}: ${path} imports ${specifier}; import packages by name and list them in package.json`,
        );
      } else {
        const platformModule = platformModuleOf(specifier, platform, where);
        if (platformModule) platformUsed.push(platformModule);
        else if (Object.hasOwn(dependencies, packageName(specifier))) npmSpecifiers.add(specifier);
        else
          throw new Error(
            `${where}: ${path} imports ${specifier}; list ${packageName(specifier)} in package.json "dependencies"`,
          );
        target = moduleOfSpecifier(specifier);
      }
      edits.push({ ...edit, specifier: relativeSpecifier(name, target) });
    }
    // workerd's `import.meta` is empty: an author's module that reads it gets the `url` it has in
    // Node or a bundler, `file:///<its path in the source>` (iterate/agents/kinds `makeAgentKind`).
    const url = parse(code, name)[0].some((imp) => imp.d === -2)
      ? `import.meta.url = ${JSON.stringify(new URL(path, "file:///").href)}; `
      : "";
    out[name] = url + rewriteSpecifiers(code, edits);
  }

  if (npmSpecifiers.size) {
    const graph = await lockedDependencyGraph([...npmSpecifiers].sort(), dependencies, {
      ...opts,
      nodejsCompat,
    });
    Object.assign(out, graph.modules);
    platformUsed.push(...graph.platformModules);
  }

  addPlatformModules(out, platformUsed, platform);
  const files = Object.fromEntries(
    ["package.json", main, ...read]
      .filter((path) => Object.hasOwn(source, path))
      .map((path) => [path, source[path]!]),
  );
  return { mainModule: outputName(entry), modules: out, compatibilityFlags, files };
}

function addPlatformModules(out: ModuleMap, names: string[], platform: PlatformModules): void {
  while (names.length) {
    const name = names.pop()!;
    if (Object.hasOwn(out, name)) continue;
    out[name] = platform.modules[name]!;
    names.push(...(platform.imports[name] ?? []));
  }
}

export const LOADED_WORKER_MODULE = "node_modules/.platform/loaded-worker.js";

// on the main module's first line, so its lines keep their numbers
export function enteredThroughPlatform(
  resolved: { mainModule: string; modules: ModuleMap; compatibilityFlags?: string[] },
  platform: PlatformModules,
): { mainModule: string; modules: ModuleMap; compatibilityFlags: string[] | undefined } {
  const modules = { ...resolved.modules };
  addPlatformModules(modules, [LOADED_WORKER_MODULE], platform);
  const { mainModule } = resolved;
  const platformFirst = JSON.stringify(relativeSpecifier(mainModule, LOADED_WORKER_MODULE));
  modules[mainModule] = `import ${platformFirst}; ${modules[mainModule]}`;
  return { mainModule, modules, compatibilityFlags: resolved.compatibilityFlags };
}

type DependencyGraph = { modules: ModuleMap; platformModules: string[] };

async function lockedDependencyGraph(
  specifiers: string[],
  dependencies: Record<string, string>,
  opts: ResolveOptions,
): Promise<DependencyGraph> {
  const packages = [...new Set(specifiers.map(packageName))].sort();
  const bases = Object.fromEntries(
    packages.map((name) => [name, esmPackageBase(name, dependencies[name]!, opts.where)]),
  );
  const lockInput = {
    specifiers,
    ranges: Object.fromEntries(packages.map((name) => [name, dependencies[name]!])),
    externals: [...WORKERD_BUILTINS, ...platformPackages(opts.platform)],
    // the two modes must not share a stored graph: the store is shared across every mind
    nodejsCompat: opts.nodejsCompat === true,
  };
  // The prefix names the lock's shape and the rewrite rules: a change to either is a new prefix.
  const key = `module-lock-3/${await sha256Hex(JSON.stringify(lockInput))}`;
  const stored = await opts.store.get(key);
  if (stored) return JSON.parse(stored) as DependencyGraph;
  const graph = await resolveFromEsm(lockInput, bases, "https://esm.sh", opts);
  // KV allows one write per key per second: a 429 says another resolution wrote the lock.
  await opts.store.put(key, JSON.stringify(graph)).catch((error: unknown) => {
    const kind = failureKind(error);
    if (!isPlatformFailureKind(kind)) throw error;
    logPlatformFailure("module-resolution", "lock-write", kind, {
      name: "module-lock",
      where: opts.where,
      key,
      message: error instanceof Error ? error.message : String(error),
    });
  });
  return graph;
}

// synchronous, so an import is rewritten before its target arrives
function esmModuleName(url: URL): string {
  const path = url.pathname.replace(/\.m?js$/, "");
  const query = url.search ? `~${url.search.slice(1).replace(/[^\w.=@-]+/g, "_")}` : "";
  return `node_modules/.esm${path}${query}.js`.replace(/\/+/g, "/");
}

// esm.sh does not read an npm alias itself: asked for `/react@npm:preact@10`, it serves react.
function esmPackageBase(name: string, version: string, where: string): string {
  if (version.startsWith("npm:")) {
    const alias = version.slice("npm:".length).match(/^((?:@[^/@]+\/)?[^/@]+)(?:@([^:/]+))?$/);
    if (!alias)
      throw new Error(
        `${where}: package.json lists ${name} as ${version}; an alias names a package on npm and its version: npm:<package>@<version>`,
      );
    return `/${alias[1]}@${alias[2] || "latest"}`;
  }
  if (!version.startsWith("https://pkg.pr.new/")) return `/${name}@${version}`;
  const build = pkgPrNewBuildOf(version);
  if (!build)
    throw new Error(
      `${where}: package.json lists ${name} as ${version}; pin it as https://pkg.pr.new/<owner>/<repo>/${name}@<40-hex sha>`,
    );
  if (!isPkgPrNewCommit(build.ref))
    throw new Error(
      `${where}: package.json lists ${name} at ${JSON.stringify(build.ref)}, which is not a commit, so it could name another build tomorrow; pin the commit: https://pkg.pr.new/<owner>/<repo>/${build.name}@<40-hex sha> (a HEAD of the URL names it in x-commit-key)`,
    );
  return `/pr/${build.owner}/${build.repo}/${build.name}@${build.ref}`;
}

// esm.sh out of reach, too slow or answering 5xx, 429 or 408 is the platform's failure: a
// publication meets it again rather than refusing the commit.
async function fetchModuleText(url: string, fetchFn: typeof fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { "user-agent": "iterate-os" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw unavailableError(
      timedOut ? "overloaded" : "disconnected",
      `${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await response.text();
  if (response.status !== 200) {
    const kind = httpFailureKind(response);
    const message = `${url} answered ${response.status}`;
    throw isPlatformFailureKind(kind) ? unavailableError(kind, message) : new Error(message);
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("javascript")) throw new Error(`${url} is ${type || "untyped"}, not a module`);
  return text;
}

function prSelfImportOf(specifier: string, importer: URL): string | undefined {
  const pr = importer.pathname.match(/^\/pr\/([^/]+\/[^/]+\/(?:@[^/]+\/)?[^/@]+)@([^/]+)\//);
  if (!pr || !specifier.startsWith(`${pr[1]}/`)) return undefined;
  return `/pr/${pr[1]}@${pr[2]}/${specifier.slice(pr[1]!.length + 1)}`;
}

// esm.sh spells a package's import of its own export bare when the package is external: a platform
// package an alias loads from npm, whose own modules are the aliased version's.
function npmSelfImportOf(specifier: string, importer: URL): string | undefined {
  const own = importer.pathname.match(/^\/((?:@[^/]+\/)?[^/@]+)@([^/]+)\//);
  if (!own || packageName(specifier) !== own[1]) return undefined;
  return `/${own[1]}@${own[2]}${specifier.slice(own[1].length)}`;
}

async function resolveFromEsm(
  lock: { specifiers: string[]; externals: string[] },
  bases: Record<string, string>,
  origin: string,
  opts: ResolveOptions,
): Promise<DependencyGraph> {
  const { where, platform } = opts;
  const query = new URLSearchParams({ target: "es2022", external: lock.externals.join(",") });
  const modules: ModuleMap = {};
  const platformModules = new Set<string>();
  const started = new Map<string, string>();
  const aliases = new Map<string, string>();
  const inFlight = new Set<Promise<void>>();
  const failures: Error[] = [];

  // One module per URL: wanted under another name, that name re-exports it, never a second copy,
  // whose classes would be other classes.
  const load = (href: string, name: string): void => {
    const loadedAs = started.get(href);
    if (loadedAs) {
      if (loadedAs !== name) aliases.set(name, loadedAs);
      return;
    }
    started.set(href, name);
    const url = new URL(href);
    const loading = (async () => {
      const code = await fetchModuleText(href, opts.fetch);
      const edits: SpecifierEdit[] = [];
      for (const edit of importsOf(code, href, where)) {
        const { specifier } = edit;
        const builtin = specifier.match(/^\/?(cloudflare:[^?]+)/)?.[1];
        const self = prSelfImportOf(specifier, url) || npmSelfImportOf(specifier, url);
        if (builtin) {
          edits.push({ ...edit, specifier: builtin });
        } else if (specifier.startsWith("node:")) {
          if (opts.nodejsCompat) edits.push({ ...edit, specifier });
          else
            throw new Error(
              `${url.pathname} needs the Node.js builtin ${specifier}, which loaded workers do not have`,
            );
        } else if (specifier.startsWith("/") || isRelative(specifier)) {
          const child = new URL(specifier, url);
          if (child.origin !== origin)
            throw new Error(`${url.pathname} imports ${child.href}, outside esm.sh`);
          const childName = esmModuleName(child);
          load(child.href, childName);
          edits.push({ ...edit, specifier: relativeSpecifier(name, childName) });
        } else if (self) {
          const child = new URL(`${self}?${query}`, origin);
          const childName = esmModuleName(child);
          load(child.href, childName);
          edits.push({ ...edit, specifier: relativeSpecifier(name, childName) });
        } else {
          const platformModule = platformModuleOf(specifier, platform, url.pathname);
          if (!platformModule)
            throw new Error(`${url.pathname} imports ${specifier}, which esm.sh left unresolved`);
          platformModules.add(platformModule);
          edits.push({ ...edit, specifier: relativeSpecifier(name, platformModule) });
        }
      }
      modules[name] = rewriteSpecifiers(code, edits);
    })().catch((error: Error) => void failures.push(error));
    inFlight.add(loading);
    void loading.finally(() => inFlight.delete(loading));
  };

  for (const specifier of lock.specifiers) {
    const name = packageName(specifier);
    const base = bases[name]!;
    load(`${origin}${base}${specifier.slice(name.length)}?${query}`, moduleOfSpecifier(specifier));
  }
  while (inFlight.size) await Promise.all(inFlight);
  if (failures.length) {
    const message = `${where}: resolving ${lock.specifiers.join(", ")} failed: ${failures.map((failure) => failure.message).join("; ")}`;
    const platform = failures.map(failureKind).find(isPlatformFailureKind);
    throw platform ? unavailableError(platform, message) : new Error(message);
  }
  for (const [name, loadedAs] of aliases)
    modules[name] ??= aliasModule(name, loadedAs, modules[loadedAs]!);
  return { modules, platformModules: [...platformModules].sort() };
}

// `export *` leaves a default out
function aliasModule(name: string, loadedAs: string, code: string): string {
  const target = JSON.stringify(relativeSpecifier(name, loadedAs));
  const hasDefault = parse(code)[1].some((exported) => exported.n === "default");
  return `export * from ${target};${hasDefault ? ` export { default } from ${target};` : ""}\n`;
}
