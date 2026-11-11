// Stdout is the JSON alone: pnpm writes its own lines to stderr.
import { stageOf, storedMindConfig } from "../src/config.ts";

try {
  const name = stageOf(process.argv);
  if (!name) throw new Error("Name the stack: pnpm run config --stage <name>");
  console.log(JSON.stringify(storedMindConfig(name), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
