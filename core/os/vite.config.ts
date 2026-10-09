import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The Cloudflare plugin reads the Worker's config from cloudflare.config.ts, in Vite's mode:
// `development` for `vite dev` (`pnpm dev`), `production` for a build, which Alchemy deploys
// (alchemy.run.ts). The dev Worker's iterate config is cloudflare.config.ts's, never a
// deployment's (iterate.config.ts and .secrets, scripts/iterate-config-file.ts), and the plugin
// must not load a stray .env as the dev Worker's vars, as it would by default.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV ||= "false";

/** What the Worker's modules read as `import.meta.url` (below). Any file URL serves: Alchemy
 *  resolves only its local-dev modules against it, and a deployment loads none of them. */
const WORKER_MODULE_URL = JSON.stringify("file:///bundle/worker.js");

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    alchemyInWorkerd(),
    serveConfigDependencies(),
    tanstackStart({
      router: { addExtensions: true, semicolons: true, quoteStyle: "double" },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
    tailwindcss(),
  ],
  // THE WORKER'S import.meta: workerd leaves `import.meta.url` undefined and has no
  // `import.meta.resolve`, and Alchemy's engine (core/deployer/src/engine.ts, in the lazy chunk that
  // src/deployment/run.ts starts) needs both as its modules load: alchemy's
  // lib/Cloudflare/LocalRuntime.js and lib/Local/RpcProviderProxy.js call `import.meta.resolve`,
  // and fdir calls `createRequire(import.meta.url)`. `define` replaces expressions, never strings,
  // so the source text the build embeds keeps its own. Pinned: test/vitest/os/alchemy-pins.test.ts.
  environments: {
    ssr: {
      define: {
        "import.meta.url": WORKER_MODULE_URL,
        "import.meta.resolve": `((specifier, base) => new URL(specifier, base ?? ${WORKER_MODULE_URL}).href)`,
      },
    },
  },
  server: {
    // scripts/dev.ts passes `--port`, which overrides this.
    port: 8788,
    strictPort: true,
    // Vite's own defaults, and a deployment's config and secrets, which no default names: Alchemy's
    // local state (.alchemy/) holds each secret too
    fs: {
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        ".secrets",
        "iterate.config.local.ts",
        "**/.alchemy/**",
      ],
    },
  },
});

/** ALCHEMY'S ENGINE IN THE WORKER: the packages Alchemy imports for local dev and bundling, which
 *  workerd cannot load, become CommonJS modules whose every export throws when called, so the
 *  engine's chunk loads and only a call fails. @alchemy.run/cloudflare-runtime imports the npm
 *  `workerd`, whose main resolves its binary as it loads; @effect/platform-bun is an optional peer
 *  that nothing installs, and the build cannot resolve it; rolldown, vite, sharp and the rest add
 *  chunks nothing runs. `enforce: "pre"`: otherwise Vite's own resolver takes a bare import first.
 *  Pinned: test/vitest/os/alchemy-pins.test.ts. */
function alchemyInWorkerd(): Plugin {
  const stubbed =
    /^(rolldown|vite|pnpapi|proxy-agent|workerd|sharp|@img\/[^/]+|@effect\/platform-bun)(\/.*)?$/;
  const prefix = "\0unavailable-in-workerd:";
  return {
    name: "iterate:alchemy-in-workerd",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.config.consumer === "server",
    resolveId: (source) => (stubbed.test(source) ? prefix + source : undefined),
    load(id) {
      if (!id.startsWith(prefix)) return;
      const name = JSON.stringify(`${id.slice(prefix.length)} is not available in workerd`);
      return `const fail = (key) => () => { throw new Error(${name} + ": " + key); };
module.exports = new Proxy({}, { get: (_target, key) => key === "__esModule" ? true : key === "then" ? undefined : fail(String(key)) });`;
    },
  };
}

/** The Cloudflare plugin (2.0 beta) denies the dev server every file cloudflare.config.ts imports,
 *  by absolute path, so that the browser cannot read a config. The Worker imports some of the
 *  same source (iterate/app-config, iterate/compatibility-date), and the dev server then fails to
 *  load it ("Failed to load url …"). Its patterns stay (`.env`, `.dev.vars`, keys, `.cloudflare/`),
 *  and so does cloudflare.config.ts itself; the source it imports is served again. */
function serveConfigDependencies(): Plugin {
  return {
    name: "iterate:serve-config-dependencies",
    config(config) {
      const fs = config.server?.fs;
      if (!fs?.deny) return;
      fs.deny = fs.deny.filter(
        (entry) => !path.isAbsolute(entry) || path.basename(entry) === "cloudflare.config.ts",
      );
    },
  };
}
