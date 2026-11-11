// This deployment's platform packages (`iterate/*`, zod) as loader modules — written by
// core/mind-worker/scripts/build.ts as platform-modules.js (git ignores it: ../../.gitignore); this
// declaration lets `tsc` and knip resolve the import without it.
import type { PlatformModules } from "../context/module-resolution.ts";
declare const platformModules: PlatformModules;
export default platformModules;
