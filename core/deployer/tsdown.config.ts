import { defineConfig } from "tsdown";

// One neutral ES module per export. core/os imports the sources through the workspace; the build
// is what a project installs from pkg.pr.new. Alchemy, Effect and @effect/platform-node stay
// imports here: a host that bundles the package (core/os's Vite build) shims what Alchemy's
// Node-only modules reach for (core/os/vite.config.ts `alchemyInWorkerd`).
export default defineConfig({
  entry: {
    engine: "src/engine.ts",
    names: "src/names.ts",
    stack: "src/stack.ts",
    "state-sql": "src/state-sql.ts",
  },
  format: "esm",
  fixedExtension: true,
  platform: "neutral",
  target: "es2022",
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
});
