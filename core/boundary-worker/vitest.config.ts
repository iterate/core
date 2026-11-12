// THE vitest config for the boundary Worker's own tests: in-process units (src/**/*.test.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // the Worker's modules name the Workers runtime, which a unit test has not got
      "cloudflare:workers": new URL(
        "../lib/src/test-support/cloudflare-workers-shim.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    // The console's reporter, and whichever others the environment names by path: iterate's CI
    // adds its telemetry reporter (.depot/workflows/test.yml), which lives outside core.
    reporters: [
      "default",
      ...(process.env.VITEST_EXTRA_REPORTERS || "").split(",").filter(Boolean),
    ],
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    chaiConfig: { truncateThreshold: 0 },
    silent: "passed-only",
  },
});
