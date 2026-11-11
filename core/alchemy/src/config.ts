import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AuthSettings } from "core-auth-worker/config";
import { z } from "zod";

export const MindConfig = z
  .strictObject({
    name: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]{0,39}$/,
        "a lowercase name of letters, digits and dashes, at most 40",
      ),
    accountId: z.string().regex(/^[0-9a-f]{32}$/, "a Cloudflare account id: 32 hex characters"),
    domain: z.string(),
    // `platform`: `iterate.<domain>` alone, for a zone that serves other things. Absent: the apex, every
    // name under it, and the zone's mail.
    hostnames: z.enum(["all", "platform"]).optional(),
    // `{ provided: true }`: a mind that runs elsewhere (core/home-lab) and dials `/provide`.
    mind: z
      .strictObject({
        provided: z.literal(true).optional(),
        name: z.string().min(1).optional(),
        template: z.string().min(1).optional(),
        // `managed`: no image built; sandboxes start Cloudflare's managed image (a deploy with no Docker).
        sandboxImage: z.enum(["built", "managed"]).optional(),
      })
      .refine(
        ({ provided, ...worker }) => !provided || Object.keys(worker).length === 0,
        "a provided mind has no Worker here: give { provided: true } alone",
      )
      .optional(),
    auth: AuthSettings,
    // `environment`: ITERATE_SECRETS_AT_REST_KEY at every deploy, refused without it: a generated key in
    // its place would make every stored value unreadable.
    atRestKey: z.enum(["generated", "environment"]).optional(),
    mail: z.literal(true).optional(),
    telemetry: z.literal(true).optional(),
    // The Cloud's key, which signs the events it delivers, is one of `auth.keys`.
    cloud: z.strictObject({ origin: z.url({ protocol: /^https$/ }) }).optional(),
  })
  .refine(({ hostnames, mail }) => !(hostnames === "platform" && mail), {
    path: ["mail"],
    error: 'a stack with hostnames: "platform" does not own the zone\'s mail',
  })
  .refine(({ auth, hostnames }) => !(hostnames === "platform" && auth.login.methods.email), {
    path: ["auth", "login", "methods", "email"],
    error:
      'a mailed sign-in code needs the zone\'s mail, which a stack with hostnames: "platform" does not own: sign in another way',
  })
  .refine(
    ({ auth, hostnames, mail }) => hostnames === "platform" || !auth.login.methods.email || mail,
    {
      path: ["auth", "login", "methods", "email"],
      error: "a mailed sign-in code needs the stack's mail: add mail: true, or sign in another way",
    },
  );

export type MindConfig = z.infer<typeof MindConfig>;

// The config is stored in the state store, which every holder of the state token reads: a field joins
// this list only once it is shown to be no secret. An array's items are `[]`.
const PUBLIC_FIELDS = new Set([
  "name",
  "accountId",
  "domain",
  "hostnames",
  "mind.provided",
  "mind.name",
  "mind.template",
  "mind.sandboxImage",
  // empty: a mind whose one way to sign in is a passkey
  "auth.login.methods",
  "auth.login.methods.email",
  "auth.login.methods.email.anyone",
  "auth.login.allow[].email",
  "auth.login.allow[].subaddresses",
  "auth.login.allow[].emailDomain",
  "auth.login.allow[].everyone",
  "auth.trustedClients[]",
  // a key's public half, who it speaks for, and where it may add events: nothing a holder could sign with
  "auth.keys[].actor",
  "auth.keys[].email",
  "auth.keys[].publicKey",
  "auth.keys[].label",
  "auth.keys[].paths[]",
  "cloud.origin",
  "atRestKey",
  "mail",
  "telemetry",
]);

function unlistedFields(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => unlistedFields(item, `${path}[]`));
  if (value instanceof Object && Object.keys(value).length > 0)
    return Object.entries(value).flatMap(([key, child]) =>
      unlistedFields(child, path ? `${path}.${key}` : key),
    );
  return PUBLIC_FIELDS.has(path) ? [] : [path];
}

function parseMindConfig(value: unknown, source: string): MindConfig {
  const parsed = MindConfig.safeParse(value);
  if (parsed.success) {
    const unlisted = unlistedFields(parsed.data);
    if (unlisted.length > 0)
      throw new Error(
        `The mind config ${source} has fields not shown to be public, which the stored config may not hold: ${unlisted.join(", ")} (src/config.ts PUBLIC_FIELDS)`,
      );
    return parsed.data;
  }
  throw new Error(
    `The mind config ${source} is invalid: ${parsed.error.issues.map(({ path, message }) => (path.length > 0 ? `${path.join(".")}: ${message}` : message)).join("; ")}`,
  );
}

// A file named but missing is an error, never a fall back to the stored config.
export async function loadMindConfig(stage: string | undefined): Promise<MindConfig> {
  const named = process.env.ITERATE_MIND_CONFIG;
  const path = resolve(named || `${import.meta.dirname}/../mind.config.local.ts`);
  if (existsSync(path))
    return parseMindConfig(
      path.endsWith(".json")
        ? JSON.parse(readFileSync(path, "utf8"))
        : (await import(pathToFileURL(path).href)).default,
      `at ${path}`,
    );
  if (named) throw new Error(`ITERATE_MIND_CONFIG names ${path}, and there is no such file`);
  if (!stage)
    throw new Error(
      `No mind config at ${path}, and no --stage <name> to read a stored one by. Copy mind.config.example.ts to mind.config.local.ts, or name a config file in ITERATE_MIND_CONFIG.`,
    );
  return storedMindConfig(stage);
}

export function storedMindConfig(name: string): MindConfig {
  const local = process.env.ITERATE_STATE_STORE === "local";
  const store = local ? "the local state (.alchemy/)" : resourceNamesOf(name).state;
  const read = spawnSync(
    process.execPath,
    [
      `${import.meta.dirname}/../node_modules/alchemy/bin/cli.js`,
      "state",
      "read",
      `mind/${name}/output`,
      ...(local ? ["--backend", "local"] : ["--backend", "cloudflare", "--name", store]),
    ],
    // `CI` makes a missing store an error: outside CI, Alchemy would deploy one to read from.
    { cwd: `${import.meta.dirname}/..`, env: { ...process.env, CI: "true" }, encoding: "utf8" },
  );
  if (read.status !== 0) {
    const reason =
      read.stderr
        .trim()
        .split("\n")
        .findLast((line) => line.trim()) ?? "no answer";
    throw new Error(`No stored config for the stack ${name}: reading ${store} failed: ${reason}`);
  }
  // Alchemy's CLI writes log lines to stdout before the value (and, on a checkout with no store
  // credentials yet, a refresh notice). The value is pretty-printed JSON, from the first `{` line.
  const at = read.stdout.search(/^\{$/m);
  const output = (at < 0 ? null : JSON.parse(read.stdout.slice(at))) as {
    config?: unknown;
  } | null;
  if (!output?.config)
    throw new Error(
      `No config is stored for the stack ${name} in ${store}: deploy it once with a config file (ITERATE_MIND_CONFIG=<file>)`,
    );
  return parseMindConfig(output.config, `stored for the stack ${name}`);
}

export function stageOf(argv: readonly string[]): string | undefined {
  const at = argv.findIndex((arg) => arg === "--stage" || arg.startsWith("--stage="));
  const value = at < 0 ? undefined : argv[at]!.includes("=") ? argv[at]!.slice(8) : argv[at + 1];
  return value || process.env.ALCHEMY_STAGE || undefined;
}

export const resourceNamesOf = (name: string) => {
  const prefix = `iterate-${name}`;
  return {
    boundary: `${prefix}-boundary`,
    secrets: `${prefix}-secrets`,
    auth: `${prefix}-auth`,
    authDb: `${prefix}-auth-db`,
    authKv: `${prefix}-auth-kv`,
    mind: `${prefix}-mind`,
    // Alchemy binds the namespace but does not make it: ../scripts/repos-namespace.ts does.
    repos: `${prefix}-repos`,
    files: `${prefix}-files`,
    // Analytics Engine and Pipelines names take letters, digits and underscores alone.
    telemetry: `${prefix}-telemetry`,
    telemetryBucket: `${prefix}-telemetry`,
    telemetryDataset: `${prefix.replaceAll("-", "_")}_metrics`,
    telemetryTables: `${prefix.replaceAll("-", "_")}_telemetry`,
    // At most 54 characters (Alchemy's state store).
    state: `${prefix}-state`,
  };
};
