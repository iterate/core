import { builtinModules } from "node:module";
import { defineConfig, type UserConfig } from "tsdown";

// TWO BUILDS. `dist/`: one neutral ES module per export, Alchemy, Effect and @effect/platform-node
// left as imports, for a host that bundles the package itself and shims what Alchemy's Node-only
// modules reach for (core/os's Vite build, core/os/vite.config.ts `alchemyInWorkerd`). core/os
// imports the sources through the workspace. `dist/workerd/`: the same modules with Alchemy, Effect
// and platform-node bundled in and the shims applied, for a Worker that cannot bundle: a project's
// config repo hosting a deployment facet of its own loads `workerd/engine.mjs` as it is.
const entries = {
  attempt: "src/attempt.ts",
  engine: "src/engine.ts",
  names: "src/names.ts",
  stack: "src/stack.ts",
  "state-sql": "src/state-sql.ts",
};

const common = {
  format: "esm",
  fixedExtension: true,
  platform: "neutral",
  target: "es2022",
} satisfies UserConfig;

/** What the bundled modules read as `import.meta.url`; nothing is read at it. Why Alchemy's engine
 *  needs it defined in workerd: core/os/vite.config.ts. */
const WORKER_MODULE_URL = JSON.stringify("file:///deployer/workerd/engine.mjs");

/** The same stubs as core/os/vite.config.ts `alchemyInWorkerd`, which says why, plus Puppeteer's
 *  browsers (Alchemy's browser-rendering local dev). */
const stubbed =
  /^(rolldown|vite|pnpapi|proxy-agent|workerd|sharp|@img\/[^/]+|@effect\/platform-bun|@puppeteer\/browsers)(\/.*)?$/;
const STUB = "\0unavailable-in-workerd:";
/** Node's own modules, named with their `node:` prefix: what workerd's Node compatibility serves,
 *  and what the platform's loader lets a worker import without a dependency. A bare `fs` or `path`
 *  (Alchemy's engine has a few) is the same module. */
const nodeBuiltins = new Set(builtinModules.filter((name) => !name.startsWith("_")));
const alchemyInWorkerd = {
  name: "deployer:alchemy-in-workerd",
  resolveId: (source: string) => {
    if (stubbed.test(source)) return STUB + source;
    if (!source.startsWith("node:") && nodeBuiltins.has(source))
      return { id: `node:${source}`, external: true as const };
    return undefined;
  },
  load(id: string) {
    if (!id.startsWith(STUB)) return;
    const name = JSON.stringify(`${id.slice(STUB.length)} is not available in workerd`);
    // CommonJS, so that a named import of the stub resolves through the Proxy (an ES module would
    // have to name each export).
    return `const fail = (key) => () => { throw new Error(${name} + ": " + key); };
module.exports = new Proxy({}, { get: (_target, key) => key === "__esModule" ? true : key === "then" ? undefined : fail(String(key)) });`;
  },
};

/** A dynamic `import()` of a computed specifier becomes a rejection: the platform's loader resolves
 *  a worker's module graph ahead of time and refuses one it cannot name. Alchemy's engine has three,
 *  all on paths a deploy never takes (its local runtime and Vite's dev server). */
const noComputedImports = {
  name: "deployer:no-computed-imports",
  renderChunk(code: string) {
    let out = "";
    let at = 0;
    const re = /\bimport\(\s*(?=[^"'`\s])/g;
    for (let m = re.exec(code); m; m = re.exec(code)) {
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < code.length && depth > 0; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")") depth--;
      }
      const expression = code.slice(m.index + "import(".length, i - 1).trim();
      out += code.slice(at, m.index);
      out += `Promise.reject(new Error("a dynamic import of a computed specifier is not available in workerd: " + ${JSON.stringify(expression.replace(/\s+/g, " ").slice(0, 80))}))`;
      at = i;
      re.lastIndex = i;
    }
    return at === 0 ? null : { code: out + code.slice(at), map: null };
  },
};

export default defineConfig([
  {
    ...common,
    entry: entries,
    deps: {
      neverBundle: [
        "cloudflare:workers",
        "@cloudflare/workers-types",
        "alchemy",
        "effect",
        "@effect/platform-node",
        "iterate",
      ],
    },
    dts: true,
    clean: true,
  },
  {
    ...common,
    entry: entries,
    outDir: "dist/workerd",
    deps: {
      neverBundle: ["cloudflare:workers", "iterate", /^node:/],
      // the dependencies of Alchemy's engine are the bundle's own
      alwaysBundle: [/./],
    },
    plugins: [alchemyInWorkerd, noComputedImports],
    define: {
      "import.meta.url": WORKER_MODULE_URL,
      "import.meta.resolve": `((specifier, base) => new URL(specifier, base ?? ${WORKER_MODULE_URL}).href)`,
    },
    dts: false,
    clean: false,
  },
]);
