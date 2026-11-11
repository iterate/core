// The `iterate fs` tool a sandbox runs in its container (core/lib src/cli/fs.ts), as text — written by
// core/mind-worker/scripts/build.ts as sandbox-files-tool.js (git ignores it: ../../.gitignore); this
// declaration lets `tsc` resolve the import without it.
declare const filesTool: string;
export default filesTool;
