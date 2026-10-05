import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The Cloudflare plugin reads the Worker's config from cloudflare.config.ts, in Vite's mode:
// `development` for `vite dev` (`cf dev`), `production` for a build (`cf build`, `cf deploy`).
// A deployment's iterate config is iterate.config.ts and .secrets (scripts/iterate-config-file.ts),
// never local dev's, and the plugin must not load a stray .env as the dev Worker's vars, as it would
// by default.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV ||= "false";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    serveConfigDependencies(),
    tanstackStart({
      router: { addExtensions: true, semicolons: true, quoteStyle: "double" },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
    tailwindcss(),
  ],
  server: {
    // scripts/dev.ts passes `--port`, which overrides this.
    port: 8788,
    strictPort: true,
    // Vite's own defaults, and a deployment's config and secrets, which no default names
    fs: {
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", ".secrets", "iterate.config.local.ts"],
    },
  },
});

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
