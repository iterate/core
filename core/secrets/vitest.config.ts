// THE vitest config for the secrets Worker's own tests: in-process units (src/**/*.test.ts), the
// secret's object among them, driven in Node with a fake of its storage. Nothing here runs workerd.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // the modules' only platform imports are base classes (core/lib's shim says why)
      "cloudflare:workers": fileURLToPath(
        new URL("../lib/src/test-support/cloudflare-workers-shim.ts", import.meta.url),
      ),
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
