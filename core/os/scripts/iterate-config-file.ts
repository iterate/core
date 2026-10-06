// iterate-config-file.ts — THE ITERATE CONFIG A DEPLOY READS, and the Worker variables it becomes
// (SELF-HOSTING.md, "The config"). ./deploy.ts and ../cloudflare.config.ts read the same file.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configVarNameOf, deepMerge, unknownKeysOf } from "iterate/app-config";
import { z } from "zod";
import {
  ITERATE_CONFIG_PREFIX,
  IterateConfig,
  parseIterateConfigInput,
  secretFieldsOf,
} from "../src/iterate-config.ts";

const root = path.resolve(import.meta.dirname, "..");

/** How a deployment changes its config, said wherever a message names a value or a default. */
export const HOW_TO_CHANGE_THE_CONFIG =
  "Set a field in the environment or core/os/.secrets by its variable (ITERATE__<PATH>), or in core/os/iterate.config.local.ts (gitignored: import iterate.config.ts and override) by its path.";

/** The config file a deploy reads: the one `ITERATE_CONFIG_FILE` names (relative to core/os), else
 *  iterate.config.local.ts when it exists, else iterate.config.ts. iterate's own deploy tooling names
 *  iterate.config.ts, so a developer's own iterate.config.local.ts never reaches one of its deploys. */
export function configFileInUse() {
  const named = process.env.ITERATE_CONFIG_FILE?.trim();
  if (named) return path.resolve(root, named);
  const local = path.join(root, "iterate.config.local.ts");
  return existsSync(local) ? local : path.join(root, "iterate.config.ts");
}

/** The variable the deploy puts what it found on the account in (./deploy.ts: the Access
 *  application's team and audience), merged over the config file's export. Set by the deploy
 *  alone, so the build's own read (../cloudflare.config.ts) sees it too. */
export const FOUND_BY_DEPLOY = "ITERATE_FOUND_BY_DEPLOY";

const PlainObject = z.record(z.string(), z.unknown());

/** A deployment: its config, parsed, and the Worker's variables. */
export type Deployment = { config: IterateConfig; vars: WorkerVars };

/** The deployment the config file names; undefined when the config has no `cloudflare` section
 *  (local dev, a test, a bare build, or a shell that only exports a client's variable). A malformed
 *  config throws, naming the field and how to change it. */
export async function readDeployment(file = configFileInUse()): Promise<Deployment | undefined> {
  const module: { default?: unknown } = await import(pathToFileURL(file).href);
  const exported = PlainObject.safeParse(module.default ?? {});
  if (!exported.success)
    throw new Error(
      `${path.relative(root, file)} must export the iterate config, an object, as its default`,
    );
  // what the deploy found on the account for this config: its Access application (./deploy.ts)
  const found = PlainObject.safeParse(JSON.parse(process.env[FOUND_BY_DEPLOY] || "{}"));
  const input = deepMerge(exported.data, found.success ? found.data : {});
  if (!input.cloudflare) return undefined;
  try {
    const config = parseIterateConfigInput(input);
    return { config, vars: workerVarsOf(input, config) };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n  (the iterate config from ${path.relative(root, file)}) ${HOW_TO_CHANGE_THE_CONFIG}`,
      { cause: error },
    );
  }
}

/** The Worker's variables: `ITERATE`, the plain var, and `secrets`, each `ITERATE__<PATH>` to its
 *  value. */
export type WorkerVars = { ITERATE: string; secrets: Record<string, string> };

/** The config as the Worker gets it: `input` as the plain var, without its secret fields and the
 *  keys the schema does not name (the parse warned about each); and each set secret field of
 *  `config`, input's parse, as a secret of its own, its value JSON so the parser reads it back
 *  exactly. */
export function workerVarsOf(input: Record<string, unknown>, config: IterateConfig): WorkerVars {
  const fields = secretFieldsOf(config);
  const plain = structuredClone(input);
  for (const field of [...unknownKeysOf(input, IterateConfig), ...fields.map(({ path }) => path)]) {
    let parent: unknown = plain;
    for (const key of field.slice(0, -1))
      parent = typeof parent === "object" && parent ? Reflect.get(parent, key) : undefined;
    if (typeof parent === "object" && parent) Reflect.deleteProperty(parent, field.at(-1)!);
  }
  const secrets = Object.fromEntries(
    fields
      .filter(({ value }) => value)
      .map(({ path, value }) => [
        configVarNameOf(path, ITERATE_CONFIG_PREFIX),
        JSON.stringify(value),
      ]),
  );
  return { ITERATE: JSON.stringify(plain), secrets };
}
