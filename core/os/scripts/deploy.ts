// `pnpm run deploy` — ONE ITERATE PLATFORM ONTO A CLOUDFLARE ACCOUNT (SELF-HOSTING.md, "What the
// deploy does"):
//
//   pnpm run deploy [--check] [--template <reference>]… [--template-root <checkout>]
//
// Read the iterate config (./iterate-config-file.ts), build, migrate the D1, then `cf deploy` with
// the plain var `ITERATE` and one secret per secret field, from a file only this user can read.
// `--check` stops at `cf deploy --dry-run`: nothing on the account changes. No secret's value is
// printed or put on a command line.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { type IterateConfig, resourceNamesOf } from "../src/iterate-config.ts";
import { build, type ConfigTemplate, templatesFromArgs } from "./build.ts";
import {
  configFileInUse,
  HOW_TO_CHANGE_THE_CONFIG,
  readDeployment,
} from "./iterate-config-file.ts";
import { viteBuild } from "./vite-build.ts";

const root = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = "src/control-plane/db/migrations";

type Env = Record<string, string | undefined>;

/** `cf` with `args`, run from core/os: its output shown, or returned with `capture`. A failure
 *  throws, its stderr in the message when captured. */
function cf(args: string[], env: Env, capture = false) {
  console.log(`$ cf ${args.join(" ")}`);
  const output = capture ? "pipe" : "inherit";
  return execFileSync(path.join(root, "node_modules/.bin/cf"), args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", output, output],
  });
}

/** The D1 named `name`, by exact name (`--name` matches a prefix). */
function d1Named(name: string, env: Env) {
  const rows = z
    .array(z.object({ uuid: z.string(), name: z.string() }))
    .parse(JSON.parse(cf(["d1", "list", "--name", name], env, true)));
  return rows.find((row) => row.name === name);
}

/** The names of the Worker's secrets; none when the Worker does not exist yet. */
function workerSecretNames(worker: string, env: Env) {
  try {
    const listed = cf(["workers", "secrets", "list", "--worker", worker], env, true);
    return z
      .array(z.object({ name: z.string() }))
      .parse(JSON.parse(listed))
      .map(({ name }) => name);
  } catch (error) {
    if (String(error).includes("[10007]")) return [];
    throw error;
  }
}

/** Apply every migration the D1 has not applied. A deploy cancelled after its request went out can
 *  still land a migration that the next apply then fails on ("table … already exists"): a failed
 *  apply passes when the D1's history holds every migration file after all. */
function migrate(database: { uuid: string; name: string }, env: Env) {
  try {
    cf(["d1", "migrations", "apply", database.uuid, "--dir", MIGRATIONS_DIR], env);
  } catch (error) {
    let applied: Set<string>;
    try {
      const sql = "select name from d1_migrations";
      const history = z
        .array(z.object({ results: z.array(z.object({ name: z.string() })) }))
        .parse(JSON.parse(cf(["d1", "query", database.uuid, "--sql", sql], env, true)));
      applied = new Set(history.flatMap(({ results }) => results.map(({ name }) => name)));
    } catch {
      throw error;
    }
    const files = readdirSync(path.join(root, MIGRATIONS_DIR)).filter((n) => n.endsWith(".sql"));
    if (files.some((name) => !applied.has(name))) throw error;
    console.log(`D1 ${database.name}: every migration is applied (another run landed it)`);
  }
}

/** The config as the deploy prints it: each secret `REDACTED` (its own `toJSON`). */
function printable({ deployId: _deployId, contextBirthEvents, ...rest }: IterateConfig) {
  return JSON.stringify(
    { ...rest, contextBirthEvents: `${contextBirthEvents.length} events` },
    null,
    2,
  );
}

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

/** What a deploy takes: the templates the build offers (`--template`, or iterate's own tooling's
 *  `configTemplates`), and `check` to change nothing. */
export type DeployOptions = { templates: ConfigTemplate[]; check?: boolean };

/** `pnpm run deploy`. iterate's own deploy tooling (scripts/os/deploy.ts) calls it with its own
 *  templates, the config in the environment. */
export async function deploy({ templates, check = false }: DeployOptions) {
  const file = path.relative(root, configFileInUse());
  const deployment = await readDeployment();
  if (!deployment)
    throw new Error(
      `No deployment: the iterate config from ${file} has no \`cloudflare\` section. ${HOW_TO_CHANGE_THE_CONFIG}`,
    );
  const { config, vars } = deployment;
  const cloudflare = config.cloudflare!;
  const names = resourceNamesOf(cloudflare);
  console.log(
    `the iterate config, from ${file}, as the Worker will read it:\n${printable(config)}\n${HOW_TO_CHANGE_THE_CONFIG}`,
  );
  const env: Env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: cloudflare.accountId };

  await build({ templates });
  await viteBuild(root, {});

  // What is on the account. A check without credentials (the public copy's CI) goes on without it.
  let secretNames: string[] = [];
  let existing: { uuid: string; name: string } | undefined;
  try {
    secretNames = workerSecretNames(names.worker, env);
    existing = d1Named(names.db, env);
    if (!existing)
      console.warn(
        `⚠ D1 ${names.db} does not exist: the deploy creates it empty. If this deployment has data, cloudflare.resourcePrefix (${cloudflare.resourcePrefix}) is wrong.`,
      );
  } catch (error) {
    if (!check) throw error;
    console.warn(`⚠ could not look up ${names.worker}'s secrets and D1 ${names.db}: ${error}`);
  }
  // `cf deploy` keeps every secret the upload does not name: an `ITERATE__*` the config no longer
  // sets is uploaded blank (a blank variable is unset), then deleted
  const stale = secretNames.filter(
    (name) => name.startsWith("ITERATE__") && !Object.hasOwn(vars.secrets, name),
  );
  const head = gitHead();

  // the secrets, in a file only this user can read, removed on any exit, Ctrl-C included
  const secretsDir = mkdtempSync(path.join(tmpdir(), "iterate-deploy-"));
  const secretsFile = path.join(secretsDir, "secrets.json");
  const removeSecretsDir = () => rmSync(secretsDir, { recursive: true, force: true });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      removeSecretsDir();
      process.exit(130);
    });
  try {
    const blanked = Object.fromEntries(stale.map((name) => [name, ""]));
    writeFileSync(secretsFile, JSON.stringify({ ...blanked, ...vars.secrets }), { mode: 0o600 });
    const deployArgs = [
      "deploy",
      "--prebuilt",
      "--mode",
      "production",
      ...(head ? ["--message", `iterate core/os ${head}`] : []),
      "--secrets-file",
      secretsFile,
    ];
    if (check) {
      cf([...deployArgs, "--dry-run"], env);
      console.log(
        `\n✅ check passed: ${names.worker} builds and validates; nothing on the account changed`,
      );
      return;
    }
    if (existing) migrate(existing, env);
    cf(deployArgs, env);
  } finally {
    removeSecretsDir();
  }

  // a failed delete leaves the secret blank: unset
  for (const name of stale)
    try {
      cf(["workers", "secrets", "delete", name, "--worker", names.worker, "--force"], env);
    } catch {
      console.warn(`⚠ ${name} is blank, not deleted`);
    }
  if (!existing) {
    const database = d1Named(names.db, env);
    if (!database) throw new Error(`D1 ${names.db} does not exist after the deploy`);
    migrate(database, env);
  }
  console.log(
    `\n✅ deployed ${names.worker} to ${cloudflare.accountId}${head ? ` at ${head}` : ""}: the plain var ITERATE and the secrets ${Object.keys(vars.secrets).join(", ")}`,
  );
}

if (import.meta.main)
  await (async () => {
    const argv = process.argv.slice(2);
    const { templates } = await templatesFromArgs(
      argv.filter((argument) => argument !== "--check"),
    );
    await deploy({ templates, check: argv.includes("--check") });
  })().catch((error: unknown) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
