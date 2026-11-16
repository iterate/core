import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runtime = require("workerd-regression");
assert.equal(runtime.version, "1.20261116.1");
// Node runs each test file in a separate process; this selects only this regression's runtime.
process.env.MINIFLARE_WORKERD_PATH = runtime.default;
console.info({ snapshotRegressionRuntime: runtime.version });
await import("./snapshot-request.test.ts");
