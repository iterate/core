import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AuthSettings } from "core-auth-worker/config";
import { appConfigInputOf, configVarNameOf, deepMerge, parseAppConfig } from "iterate/app-config";
import { z } from "zod";
import {
  CLOUDFLARE_REGISTRY,
  DIGEST_PINNED_IMAGE,
  ITERATE_DEV_IMAGE,
  iterateDevImage,
} from "./sandbox-image.ts";

// THE DEPLOY'S ENVIRONMENT sets a field of the mind config by the field's own variable
// (iterate/app-config): `ITERATE_MIND__` and the field's path, `__` before each segment, each in
// SNAKE_CASE. The prefix is the mind config's own: one environment (a Doppler config) also holds
// the old platform's `ITERATE` and `ITERATE__*`, which are no mind's.
const MIND_VARS = { prefix: "ITERATE_MIND" };

// The auth Worker's settings, and the one secret that a deploy alone holds: the Cloudflare OAuth
// client's. It is no field of the Worker's settings: the Worker gets it as its own binding
// (CLOUDFLARE_SIGN_IN_CLIENT_SECRET), and its settings' schema refuses it.
const methods = AuthSettings.shape.login.shape.methods.unwrap();
const DeployAuthSettings = AuthSettings.extend({
  login: AuthSettings.shape.login.extend({
    methods: methods
      .extend({
        cloudflare: methods.shape.cloudflare
          .unwrap()
          .extend({ clientSecret: z.string().trim().min(1).optional() })
          .optional(),
      })
      .default({}),
  }),
});
const CLOUDFLARE_CLIENT_SECRET = ["auth", "login", "methods", "cloudflare", "clientSecret"];

/** One named image, as in Cloudflare's `containers[].images`: exactly one source. */
const NamedImage = z.union([
  // Built with the local Docker at the deploy. Both are paths from core/alchemy, where the deploy
  // runs; with no build context, it is the Dockerfile's folder.
  z.strictObject({ dockerfile: z.string().min(1), buildContext: z.string().min(1).optional() }),
  // Cloudflare starts a Container from an image of the account's own Cloudflare managed registry
  // alone. An image of another registry is pushed there by the deploy (scripts/sandbox-image.ts).
  z.strictObject({
    image: z
      .string()
      .regex(DIGEST_PINNED_IMAGE, "a digest-pinned image: <registry>/<repository>@sha256:<digest>"),
  }),
]);

/** What `mind.sandboxImage` said before `mind.images` and `mind.containers`. */
const BEFORE_IMAGES = {
  built: { images: { [ITERATE_DEV_IMAGE]: iterateDevImage.dockerfile } },
  published: { images: { [ITERATE_DEV_IMAGE]: iterateDevImage.image } },
  managed: { images: {} },
  later: { containers: false as const },
};

// `{ provided: true }`: a mind that runs elsewhere (core/home-lab) and dials `/provide`.
const MindWorker = z
  .strictObject({
    provided: z.literal(true).optional(),
    name: z.string().min(1).optional(),
    template: z.string().min(1).optional(),
    // Cloudflare's `containers[].images`: the named images of the sandboxes' class, each a key of
    // `ctx.container.images`. With none, a sandbox starts the Cloudflare-managed image
    // `cloudflare/debian-trixie`. The name is also the image's resource in the deploy's state: a
    // new name for the same image replaces it.
    images: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "letters, digits, - and _, at most 128")
          // the class's own container, which has no image, has this name in the deploy's state
          .refine((name) => name !== "SandboxContainer", "not SandboxContainer"),
        NamedImage,
      )
      .refine((images) => Object.keys(images).length <= 100, "at most 100 named images")
      .optional(),
    // `false`: no container application yet, for an account without Workers Paid, which
    // Containers need: every sandbox call is refused NO_SANDBOXES_YET. A later deploy without it
    // adds the containers.
    containers: z.literal(false).optional(),
    // The word for both before them. A stack's stored config and an older caller may still say
    // it: it is read and not kept.
    sandboxImage: z.enum(["built", "published", "managed", "later"]).optional(),
  })
  .refine(
    ({ provided, ...worker }) => !provided || Object.keys(worker).length === 0,
    "a provided mind has no Worker here: give { provided: true } alone",
  )
  .refine(
    ({ sandboxImage, images, containers }) => !sandboxImage || (!images && containers !== false),
    "sandboxImage is the older word for images and containers: give those alone",
  )
  .refine(
    ({ images, containers }) => containers !== false || Object.keys(images || {}).length === 0,
    "containers: false leaves no container to start an image in: give the images at the deploy that turns the containers on",
  )
  // A config that passed through here always says its images or `containers: false`, so a stored
  // config that says neither is from before them (`withImageOfBefore`).
  .transform(({ sandboxImage, ...mind }): typeof mind => {
    if (mind.provided || mind.containers === false) return mind;
    return sandboxImage
      ? { ...mind, ...BEFORE_IMAGES[sandboxImage] }
      : { ...mind, images: mind.images || {} };
  });

// The fields alone, before the checks across them and the transform: the fields a variable may
// name (`FIELD_VARS`).
const MindConfigFields = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/, "a lowercase name of letters, digits and dashes, at most 40"),
  accountId: z.string().regex(/^[0-9a-f]{32}$/, "a Cloudflare account id: 32 hex characters"),
  // NEVER `iterate.<a domain>`: `iterate.<domain>` is the platform's host of the stack on
  // `<domain>`, where the auth Worker publishes the stack's key and its sign-in. A stack on
  // `iterate.example.co.uk` serves its mind's loaded code on that very host, so that code could
  // answer as the stack of `example.co.uk` (or of `co.uk` from `iterate.co.uk`) to iterate
  // Cloud and to anything else that reads `https://iterate.<domain>/keys/stack.json`.
  // `iterate.com` is a domain like any other: no domain follows its first label.
  // Absent: a stack whose domain is not bought yet. It has no routes, DNS records or mail, so
  // nothing reaches it; a deploy with the domain adds them.
  domain: z
    .string()
    .refine(
      (domain) => !/^iterate\.[^.]+\../i.test(domain),
      "not a domain named iterate.<domain>: that name is the platform's host of <domain>",
    )
    .optional(),
  // `free`: the account has no Workers Paid yet, and no R2. The stack then makes what a Free account
  // takes and leaves out what it refuses: Dynamic Workers (`LOADER`), the mind's CPU and
  // subrequest limits, Artifacts, the files bucket, Pipelines and Analytics Engine (telemetry), and
  // the containers (it needs `mind.containers: false`). Its mind cannot run code yet. A deploy
  // without it, once the account has Workers Paid and R2, adds them to the same stack.
  cloudflarePlan: z.literal("free").optional(),
  // Every stack takes the apex and every name under it. A stack's stored config may still say
  // so with this key: it is read and not kept.
  hostnames: z.literal("all").optional(),
  mind: MindWorker.optional(),
  auth: DeployAuthSettings,
  // `environment`: ITERATE_SECRETS_AT_REST_KEY at every deploy, refused without it: a generated key in
  // its place would make every stored value unreadable.
  atRestKey: z.enum(["generated", "environment"]).optional(),
  // The stack owns the zone's mail: every address reaches the mind. `forwardTo`: each mail is
  // then forwarded there as it arrived (a team's mailbox or group). The address must be a
  // verified destination address of the account's Email Routing, which a person confirms once
  // by the link Cloudflare mails to it.
  mail: z.union([z.literal(true), z.strictObject({ forwardTo: z.email() })]).optional(),
  telemetry: z.literal(true).optional(),
  // The mind's own API token of its account, with which its agents debug and configure the account
  // (./cloudflare-token.ts says what it may do; stack.ts makes it).
  cloudflareToken: z.literal(true).optional(),
  // The Cloud's key, which signs the events it delivers, is one of `auth.keys`.
  cloud: z.strictObject({ origin: z.url({ protocol: /^https$/ }) }).optional(),
  // Workers of the stack's own account, each bound to the mind Worker and called by the mind's code
  // as `itx.services.<name>.<method>(...args)` (core/mind-worker/src/context/services.ts). A
  // service binding resolves in its own account alone: a name is looked up there, and Cloudflare
  // refuses the deploy when no Worker has it.
  services: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/, "a camelCase name, at most 40"),
        worker: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "a Worker's name in the account"),
        // a `WorkerEntrypoint` class the Worker exports; absent: its default export
        entrypoint: z
          .string()
          .regex(/^[A-Za-z_$][\w$]*$/, "a class name")
          .optional(),
        description: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .refine(
      (services) => new Set(services.map(({ name }) => name)).size === services.length,
      "each service's name once",
    )
    .optional(),
});

export const MindConfig = MindConfigFields.refine(
  ({ auth, cloud }) => !auth.login.methods.google || cloud,
  {
    path: ["auth", "login", "methods", "google"],
    error:
      "the sign-in with Google goes through an iterate Cloud's Google client: add cloud: { origin }, or sign in another way",
  },
)
  .refine(({ mind, services }) => !(mind?.provided && services), {
    path: ["services"],
    error: "a provided mind runs elsewhere: its stack has no mind Worker to bind the services to",
  })
  .refine(({ mind, cloudflareToken }) => !(mind?.provided && cloudflareToken), {
    path: ["cloudflareToken"],
    error: "a provided mind runs elsewhere: its stack has no mind Worker to hold the token",
  })
  .refine(({ domain, mail }) => domain || !mail, {
    path: ["mail"],
    error: "the stack's mail is the mail of its domain: give the domain, or leave mail out",
  })
  .refine(({ domain, mind }) => domain || !mind?.provided, {
    path: ["domain"],
    error: "a provided mind dials its stack at iterate.<domain>: give the domain",
  })
  .refine(({ cloudflarePlan, telemetry }) => !(cloudflarePlan && telemetry), {
    path: ["telemetry"],
    error:
      'telemetry needs Pipelines and R2, which a Free account does not have: leave it out until the account has Workers Paid (no cloudflarePlan: "free")',
  })
  .refine(({ cloudflarePlan, mind }) => !(cloudflarePlan && mind?.provided), {
    path: ["mind", "provided"],
    error:
      "a provided mind's boundary needs the CPU and subrequest limits of Workers Paid for its long /provide session",
  })
  // Said, not implied: the deploy after the card drops `cloudflarePlan`, and it must not make the
  // containers by that alone. They come by a deploy that drops `containers: false`.
  .refine(({ cloudflarePlan, mind }) => !cloudflarePlan || mind?.containers === false, {
    path: ["mind", "containers"],
    error: "a Free account has no Containers: its sandboxes come later (mind.containers: false)",
  })
  .refine(
    ({ accountId, mind }) =>
      Object.values(mind?.images || {}).every(
        (source) =>
          !("image" in source) ||
          !source.image.startsWith(`${CLOUDFLARE_REGISTRY}/`) ||
          source.image.startsWith(`${CLOUDFLARE_REGISTRY}/${accountId}/`),
      ),
    {
      path: ["mind", "images"],
      error: `an image of ${CLOUDFLARE_REGISTRY} must be in the stack's own account (${CLOUDFLARE_REGISTRY}/<accountId>/…): a Container does not start from another account's registry`,
    },
  )
  .refine(
    ({ domain, mail }) =>
      !(mail instanceof Object) ||
      !domain ||
      !`.${mail.forwardTo.split("@")[1]}`.toLowerCase().endsWith(`.${domain.toLowerCase()}`),
    {
      path: ["mail", "forwardTo"],
      error:
        "not an address of the stack's own domain: its mail comes to the stack, so the forward would come back",
    },
  )
  .refine(({ auth, mail }) => !auth.login.methods.email || mail, {
    path: ["auth", "login", "methods", "email"],
    error: "a mailed sign-in code needs the stack's mail: add mail: true, or sign in another way",
  })
  // A mind Worker with no word about it has no named image. The type keeps `mind` optional, so a
  // config file that leaves it out is still a `MindConfig`.
  .transform(({ hostnames: _, ...config }): typeof config => ({
    ...config,
    mind: config.mind || { images: {} },
  }));

export type MindConfig = z.infer<typeof MindConfig>;

// The config is stored in the state store, which every holder of the state token reads: a field joins
// this list only once it is shown to be no secret. An array's items are `[]`. A config file and the
// stored config hold these fields alone; a field not listed (a secret) comes from the deploy's
// environment at every deploy, and the stack stores it nowhere (`storedConfigOf`).
const PUBLIC_FIELDS = new Set([
  "name",
  "accountId",
  "domain",
  "cloudflarePlan",
  "mind.provided",
  "mind.name",
  "mind.template",
  // empty: sandboxes start the Cloudflare-managed image
  "mind.images",
  // a named image's fields, its name as `*`: a path on the deploy's machine, and an image's address
  "mind.images.*.dockerfile",
  "mind.images.*.buildContext",
  "mind.images.*.image",
  "mind.containers",
  // the older word for the two, from the deploy's environment: no secret, and never stored
  "mind.sandboxImage",
  // empty: a mind whose one way to sign in is a passkey
  "auth.login.methods",
  "auth.login.methods.email",
  "auth.login.methods.email.anyone",
  "auth.login.methods.google",
  "auth.login.methods.google.signsInAlone",
  // a Cloudflare OAuth client's id, in every consent URL; its `clientSecret` is no public field
  "auth.login.methods.cloudflare.clientId",
  // a switch: the sign-in keeps Cloudflare's tokens as a secret of the mind
  "auth.login.methods.cloudflare.keepAccess",
  "auth.login.allow[].email",
  "auth.login.allow[].subaddresses",
  "auth.login.allow[].emailDomain",
  "auth.login.allow[].everyone",
  "auth.trustedClients[]",
  // a switch, and the key with no switch in it
  "auth.devices",
  "auth.devices.passkey",
  // a key's public half, who it speaks for, and where it may add events: nothing a holder could sign with
  "auth.keys[].actor",
  "auth.keys[].email",
  "auth.keys[].publicKey",
  "auth.keys[].label",
  "auth.keys[].paths[]",
  "cloud.origin",
  "atRestKey",
  "mail",
  // an address mail is forwarded to: it is in every forwarded mail's headers
  "mail.forwardTo",
  "telemetry",
  "cloudflareToken",
  // a Worker's name in the account, and the line the mind's capability list shows
  "services[].name",
  "services[].worker",
  "services[].entrypoint",
  "services[].description",
]);

/** Whether the field at `path` is listed. A named image's name is the config's own word, so its
 *  fields are listed under `*`. */
const isPublic = (path: string) =>
  PUBLIC_FIELDS.has(path.replace(/^mind\.images\.[^.]+\./, "mind.images.*."));

/** A group of fields in the config's tree: an object with a key. An empty object (`methods: {}`)
 *  is a field itself, and an array is a list of items. */
const isFieldGroup = (value: unknown): value is Record<string, unknown> =>
  value instanceof Object && !Array.isArray(value) && Object.keys(value).length > 0;

function unlistedFields(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => unlistedFields(item, `${path}[]`));
  if (isFieldGroup(value))
    return Object.entries(value).flatMap(([key, child]) =>
      unlistedFields(child, path ? `${path}.${key}` : key),
    );
  return isPublic(path) ? [] : [path];
}

/** The listed fields of `value` alone; undefined when it has none. */
function publicPartOf(value: unknown, path = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => publicPartOf(item, `${path}[]`));
  if (isFieldGroup(value)) {
    const kept = Object.entries(value).flatMap(([key, child]) => {
      const part = publicPartOf(child, path ? `${path}.${key}` : key);
      return part === undefined ? [] : [[key, part]];
    });
    return kept.length > 0 ? Object.fromEntries(kept) : undefined;
  }
  return isPublic(path) ? value : undefined;
}

/** `value` without each object that holds secrets alone: a secret given for a part that the config
 *  does not have (the client's secret of a stack with no sign-in with Cloudflare). One environment
 *  (a Doppler config) deploys stacks with that part and stacks without it. */
function withoutLoneSecrets(value: unknown, path = ""): unknown {
  if (!isFieldGroup(value)) return value;
  if (publicPartOf(value, path) === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const kept = withoutLoneSecrets(child, path ? `${path}.${key}` : key);
      return kept === undefined ? [] : [[key, kept]];
    }),
  );
}

/** The config as the stack stores it: its public fields alone, so no secret the deploy's
 *  environment gave. */
export const storedConfigOf = (config: MindConfig): MindConfig =>
  MindConfig.parse(publicPartOf(config));

/** The auth Worker's settings (its AUTH_SETTINGS), from the stored config: no secret is in them. */
export const authSettingsOf = (config: MindConfig) => ({
  ...storedConfigOf(config).auth,
  ...(config.mind?.provided && { provide: true as const }),
});

/** Why a deploy of `config` is refused for a secret that its environment did not give, or
 *  undefined. Without the client's secret, an app that takes Cloudflare alone would let nobody in. */
export function deployRefusalOf(config: MindConfig): string | undefined {
  const cloudflare = config.auth.login.methods.cloudflare;
  if (cloudflare && !cloudflare.clientSecret)
    return `auth.login.methods.cloudflare is set, but ${configVarNameOf(CLOUDFLARE_CLIENT_SECRET, MIND_VARS)} is not: an app that takes Cloudflare alone would let nobody in`;
  return undefined;
}

function parseMindConfig(value: unknown, source: string): MindConfig {
  const parsed = MindConfig.safeParse(value);
  if (parsed.success) {
    const unlisted = unlistedFields(parsed.data).map((path) =>
      path.includes("[]") ? path : `${path} (${configVarNameOf(path.split("."), MIND_VARS)})`,
    );
    if (unlisted.length > 0)
      throw new Error(
        `The mind config ${source} has fields not shown to be public, which the stored config may not hold: ${unlisted.join(", ")}. A field shown to be no secret joins src/config.ts PUBLIC_FIELDS; a secret is given by the deploy's environment, by the variable named.`,
      );
    return parsed.data;
  }
  throw new Error(
    `The mind config ${source} is invalid: ${parsed.error.issues.map(({ path, message }) => (path.length > 0 ? `${path.join(".")}: ${message}` : message)).join("; ")}`,
  );
}

/** Each path `schema` names: every field, and every field of an object or a union's object. An
 *  array is set whole, so its items have none. */
function fieldPathsOf(schema: z.core.$ZodType, path: string[] = []): string[][] {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)
    return fieldPathsOf(schema.unwrap(), path);
  // a transform's fields are those it reads
  if (schema instanceof z.ZodPipe) return fieldPathsOf(schema.in, path);
  if (schema instanceof z.ZodUnion)
    return schema.options.flatMap((option) => fieldPathsOf(option, path));
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.entries(schema.shape).flatMap(([key, child]) => [
    [...path, key],
    ...fieldPathsOf(child, [...path, key]),
  ]);
}

/** The variable of `mind.sandboxImage`, the older word for `mind.images` and `mind.containers`. */
export const SANDBOX_IMAGE_VAR = configVarNameOf(["mind", "sandboxImage"], MIND_VARS);

const CONTAINERS_VAR = configVarNameOf(["mind", "containers"], MIND_VARS);

/** The variable of each field: `ITERATE_MIND__AUTH__LOGIN__METHODS__CLOUDFLARE__CLIENT_SECRET`. */
const FIELD_VARS = new Set(
  fieldPathsOf(MindConfigFields).map((path) => configVarNameOf(path, MIND_VARS)),
);

/** `config` with each `ITERATE_MIND__*` variable of `env` on top. A variable that names no field
 *  is warned about and ignored, as iterate/app-config does: another branch's field, or a typo, in
 *  an environment that deploys every stack never fails a deploy. A field's bad value does, naming
 *  its variable. A secret for a part the config does not have is ignored (`withoutLoneSecrets`).
 *  `ITERATE_MIND` alone is no config object here: it names a mind (internal-packages/*-bridge). */
function withEnvironment(config: MindConfig, env: NodeJS.ProcessEnv): MindConfig {
  const given = Object.entries(env).filter(([key]) => key.startsWith(`${MIND_VARS.prefix}__`));
  for (const [key] of given)
    if (!FIELD_VARS.has(key)) console.warn(`${key}: names no field of the mind config, ignored`);
  const vars = given.filter(([key]) => FIELD_VARS.has(key));
  if (vars.length === 0) return config;
  // `mind.sandboxImage` from the environment sets what `images` and `containers` say: the three
  // are one setting, and `config` always says one of the two (`MindWorker`).
  const { images: _images, containers: _containers, ...mind } = config.mind || {};
  const under = vars.some(([key]) => key === SANDBOX_IMAGE_VAR) ? { ...config, mind } : config;
  const merged = deepMerge(under, appConfigInputOf(Object.fromEntries(vars), MIND_VARS));
  return parseAppConfig(withoutLoneSecrets(merged), MindConfig, MIND_VARS);
}

// A file named but missing is an error, never a fall back to the stored config. The deploy's
// environment then sets fields on top (`withEnvironment`).
export async function loadMindConfig(stage: string | undefined): Promise<MindConfig> {
  const file = await mindConfigFile();
  if (file) return withEnvironment(parseMindConfig(file.config, `at ${file.path}`), process.env);
  if (!stage)
    throw new Error(
      `No mind config at ${CONFIG_FILE}, and no --stage <name> to read a stored one by. Copy mind.config.example.ts to mind.config.local.ts, or name a config file in ITERATE_MIND_CONFIG.`,
    );
  return withEnvironment(storedMindConfig(stage), process.env);
}

const CONFIG_FILE = resolve(`${import.meta.dirname}/../mind.config.local.ts`);

/** The deploy's config file as it is written, when the deploy has one: the file that
 *  `ITERATE_MIND_CONFIG` names, else mind.config.local.ts here. */
export async function mindConfigFile(): Promise<{ path: string; config: unknown } | undefined> {
  const named = process.env.ITERATE_MIND_CONFIG;
  const path = named ? resolve(named) : CONFIG_FILE;
  if (!existsSync(path)) {
    if (named) throw new Error(`ITERATE_MIND_CONFIG names ${path}, and there is no such file`);
    return undefined;
  }
  const config: unknown = path.endsWith(".json")
    ? JSON.parse(readFileSync(path, "utf8"))
    : (await import(pathToFileURL(path).href)).default;
  return { path, config };
}

/** Alchemy's words for a state store that is not there: the stack was never deployed. Any other
 *  failed read (a refused token, a lost connection) says nothing about what the stack has. */
export const isNoStateStore = (reason: string) => /State Store '[^']+' not found/.test(reason);

/** The stack has no stored config: no state store, or a store with no output of the stack yet. */
class NoStoredConfig extends Error {}

/** The stack's stored config, or undefined for a stack that has none yet (a first deploy). A read
 *  that failed, and a stored config that does not parse, throw as in `storedMindConfig`. */
export function storedMindConfigIfAny(name: string): MindConfig | undefined {
  try {
    return storedMindConfig(name);
  } catch (error) {
    if (error instanceof NoStoredConfig) return undefined;
    throw error;
  }
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
    const message = `No stored config for the stack ${name}: reading ${store} failed: ${reason}`;
    throw isNoStateStore(reason) ? new NoStoredConfig(message) : new Error(message);
  }
  // Alchemy's CLI writes log lines to stdout before the value (and, on a checkout with no store
  // credentials yet, a refresh notice). The value is pretty-printed JSON, from the first `{` line.
  const at = read.stdout.search(/^\{$/m);
  const output = (at < 0 ? null : JSON.parse(read.stdout.slice(at))) as {
    config?: unknown;
  } | null;
  if (!output?.config)
    throw new NoStoredConfig(
      `No config is stored for the stack ${name} in ${store}: deploy it once with a config file (ITERATE_MIND_CONFIG=<file>)`,
    );
  return parseMindConfig(withImageOfBefore(output.config), `stored for the stack ${name}`);
}

const StoredMind = z.looseObject({ mind: z.looseObject({}).optional() });
/** The keys of `mind` that say what images and containers the stack has. */
const IMAGE_WORDS = ["provided", "images", "containers", "sandboxImage"];

/** Whether a config file `file` and the deploy's environment `env` say nothing about the mind's
 *  images, which means none. A file that says `images: {}` says so on purpose, and so does a
 *  variable for `sandboxImage` or `containers`. */
export function saysNothingOfImages(file: unknown, env: Record<string, string | undefined>) {
  const read = StoredMind.safeParse(file);
  const mind = (read.success && read.data.mind) || {};
  return !IMAGE_WORDS.some((key) => key in mind) && !env[SANDBOX_IMAGE_VAR] && !env[CONTAINERS_VAR];
}

/** The named images that the stack has (`stored`) and a deploy from the config file `file` would
 *  take off it without a word. */
export function imagesAFileLeavesOut(
  file: unknown,
  stored: MindConfig,
  env: Record<string, string | undefined>,
) {
  return saysNothingOfImages(file, env) ? Object.keys(stored.mind?.images || {}) : [];
}

/** NO WORD IN A STORED CONFIG MEANS THE BUILT IMAGE. A deploy stores a config that says `images`
 *  or `containers` (`MindWorker`). So a stored config that says neither, nor `sandboxImage`, is
 *  one of a release that knew `sandboxImage` alone, where no word meant iterate's image built with
 *  Docker at the deploy. Read so, that stack keeps its image. */
export function withImageOfBefore(stored: unknown): unknown {
  const read = StoredMind.safeParse(stored);
  if (!read.success) return stored;
  const { mind = {} } = read.data;
  if (IMAGE_WORDS.some((key) => key in mind)) return stored;
  return { ...read.data, mind: { ...mind, sandboxImage: "built" } };
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
    cloudflareToken: `${prefix}-cloudflare`,
    // At most 54 characters (Alchemy's state store).
    state: `${prefix}-state`,
    // At most 63 characters (a Queue's name): 55 with the longest stack name.
    cloudflareEvents: `${prefix}-events`,
  };
};
