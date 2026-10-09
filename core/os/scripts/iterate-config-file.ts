// scripts/iterate-config-file.ts — THE ITERATE CONFIG FILE A DEPLOY READS (SELF-HOSTING.md, "The
// config"): its default export is the config, and a `cloudflare` section in it makes it a
// deployment (../src/iterate-config.ts `deploymentOf`): parsed, and split into the Worker's
// variables. The Alchemy CLI's entry (../alchemy.run.ts) and `pnpm run images` (./images.ts) read
// it.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { deploymentOf } from "../src/iterate-config.ts";

const root = path.resolve(import.meta.dirname, "..");

/** How a deployment changes its config, said wherever a message names a value or a default. */
export const HOW_TO_CHANGE_THE_CONFIG =
  "Set a field in the environment or core/os/.secrets by its variable (ITERATE__<PATH>), or in core/os/iterate.config.local.ts (gitignored: import iterate.config.ts and override) by its path.";

/** The deployment the config file names; undefined when the config has no `cloudflare` section
 *  (a shell that only exports a client's variable). A malformed config throws, naming the field
 *  and how to change it. */
export async function readDeployment(file = configFileInUse()) {
  const module: { default?: unknown } = await import(pathToFileURL(file).href);
  const exported = z.record(z.string(), z.unknown()).safeParse(module.default ?? {});
  if (!exported.success)
    throw new Error(
      `${path.relative(root, file)} must export the iterate config, an object, as its default`,
    );
  if (!exported.data.cloudflare) return undefined;
  try {
    return deploymentOf(exported.data);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n  (the iterate config from ${path.relative(root, file)}) ${HOW_TO_CHANGE_THE_CONFIG}`,
      { cause: error },
    );
  }
}

/** The config file a deploy reads: the one `ITERATE_CONFIG_FILE` names (relative to core/os), else
 *  iterate.config.local.ts when it exists, else iterate.config.ts. iterate's own deploy tooling names
 *  iterate.config.ts, so a developer's own iterate.config.local.ts never reaches one of its deploys. */
function configFileInUse() {
  const named = process.env.ITERATE_CONFIG_FILE?.trim();
  if (named) return path.resolve(root, named);
  const local = path.join(root, "iterate.config.local.ts");
  return existsSync(local) ? local : path.join(root, "iterate.config.ts");
}
