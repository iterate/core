// `pnpm run images` — THE IMAGES A DEPLOYMENT'S CONTAINERS START FROM, updated only when someone
// asks (SELF-HOSTING.md, "The sandbox image"):
//
//   pnpm run images [--check]
//
// Each directory `images/<name>/` is an image (`<name>` ends in `-image`): a Dockerfile, and a PIN
// that says which build a deployment runs: `images/<name>/digest` here, for a deployment that
// builds its own. A deploy only READS the pins (`imageReferences`): no registry call, no build, no
// time. Changing the Dockerfile changes nothing until this command runs. It builds the image once
// (Docker, `linux/amd64`) for each account named, pushes it to that account's registry
// (`registry.cloudflare.com/<account>/<name>`), has Cloudflare prepare it for the Containers
// runtime, and answers the account's new digests for the caller to pin: a commit to make. The
// deploy hands the references to the sandbox container's `images` (core/deployer/src/stack.ts), so an image
// is tied to the deployment that references it. `--check` builds nothing: it fails when an
// account's registry does not hold a pinned digest.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readDeployment } from "./iterate-config-file.ts";

const IMAGES_DIR = path.resolve(import.meta.dirname, "..", "images");
const REGISTRY = "registry.cloudflare.com";
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

/** An account to put the images in, with a token that may use its Containers registry. */
export type ImageAccount = { accountId: string; token: string };
/** Which build each image runs in one account: image name ⇒ digest (`sha256:…`). */
export type ImagePins = Record<string, string>;

/** The names of the images in `images/`. */
export function imageNames(): string[] {
  return readdirSync(IMAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** The pins in this checkout: each `images/<name>/digest`, for a deployment that builds its own. */
export function checkoutPins(): ImagePins {
  const pins: ImagePins = {};
  for (const name of imageNames()) {
    const file = path.join(IMAGES_DIR, name, "digest");
    if (existsSync(file)) pins[name] = readFileSync(file, "utf8").trim();
  }
  return pins;
}

const referenceOf = (accountId: string, name: string, digest: string) =>
  `${REGISTRY}/${accountId}/${name}@${digest}`;

/** Each pinned image's digest-pinned reference in the account's registry, and the names of the
 *  images with no pin yet. Reads nothing but the pins. */
export function imageReferences(accountId: string, pins: ImagePins) {
  const found: Record<string, string> = {};
  const unpinned: string[] = [];
  for (const name of imageNames()) {
    const digest = pins[name];
    if (digest) found[name] = referenceOf(accountId, name, digest);
    else unpinned.push(name);
  }
  return { found, unpinned };
}

/** The images a deployment runs: each pinned image as its digest-pinned reference in the account's
 *  registry. The pins are the caller's (`ITERATE_IMAGE_PINS`, a JSON object: iterate's deploy
 *  tooling reads its own), else this checkout's `images/<name>/digest`. Nothing is read from the
 *  registry and nothing is built: this command updates a pin when asked. The Alchemy CLI's entry
 *  (../alchemy.run.ts) takes its images from here. */
export function imagesOfDeployment(accountId: string): Record<string, string> {
  const pins = process.env.ITERATE_IMAGE_PINS
    ? z.record(z.string(), z.string()).parse(JSON.parse(process.env.ITERATE_IMAGE_PINS))
    : checkoutPins();
  const { found, unpinned } = imageReferences(accountId, pins);
  for (const name of unpinned)
    console.warn(
      `⚠ ${name} is pinned to no build: its sandboxes start Cloudflare's managed image. \`pnpm run images\` builds and pins it.`,
    );
  return found;
}

type Registry = ImageAccount & { username: string; password: string };

async function cloudflareApi<Schema extends z.ZodType>(
  account: ImageAccount,
  route: string,
  schema: Schema,
  body: unknown,
): Promise<z.infer<Schema>> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account.accountId}/containers/${route}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const answer = z
    .object({ success: z.boolean(), result: z.unknown(), errors: z.array(z.unknown()) })
    .parse(await response.json());
  if (!answer.success) throw new Error(`Cloudflare ${route}: ${JSON.stringify(answer.errors)}`);
  return schema.parse(answer.result);
}

/** Credentials for the account's registry, good for an hour. */
async function registryOf(account: ImageAccount, push: boolean): Promise<Registry> {
  const credentials = await cloudflareApi(
    account,
    `registries/${REGISTRY}/credentials`,
    z.object({ username: z.string(), password: z.string() }),
    { permissions: push ? ["push", "pull"] : ["pull"], expiration_minutes: 60 },
  );
  return { ...account, ...credentials };
}

/** The digest the registry holds `<name>:<reference>` as (a tag or a digest), or null when none. */
async function digestOf(registry: Registry, name: string, reference: string) {
  const response = await fetch(
    `https://${REGISTRY}/v2/${registry.accountId}/${name}/manifests/${reference}`,
    {
      method: "HEAD",
      headers: {
        authorization: `Basic ${Buffer.from(`${registry.username}:${registry.password}`).toString("base64")}`,
        accept: MANIFEST_TYPES,
      },
    },
  );
  if (response.status === 404) return null;
  const digest = response.headers.get("docker-content-digest");
  if (!response.ok || !digest)
    throw new Error(`registry ${name}@${reference}: HTTP ${response.status}`);
  return digest;
}

/** Build `images/<name>` and push it to the registry. With `DEPOT_PROJECT_ID` set, Depot builds it
 *  (a laptop has no amd64 engine); otherwise Docker does. One platform, and no attestation
 *  manifests: the Containers runtime cannot start an image that has them. The login is the
 *  account's: Docker keeps one credential per registry host, so accounts take turns. */
function buildAndPush(registry: Registry, name: string, tag: string) {
  console.log(`$ docker login ${REGISTRY} (${registry.accountId})`);
  execFileSync("docker", ["login", REGISTRY, "-u", registry.username, "--password-stdin"], {
    input: registry.password,
    stdio: ["pipe", "inherit", "inherit"],
  });
  const project = process.env.DEPOT_PROJECT_ID;
  const command = project
    ? ["depot", "build", "--project", project]
    : ["docker", "buildx", "build"];
  const args = [
    ...command.slice(1),
    "--platform",
    "linux/amd64",
    "--provenance=false",
    "--sbom=false",
    "--push",
    "-t",
    `${REGISTRY}/${registry.accountId}/${name}:${tag}`,
    path.join(IMAGES_DIR, name),
  ];
  console.log(`$ ${command[0]} ${args.join(" ")}`);
  execFileSync(command[0]!, args, { stdio: "inherit" });
}

async function prepare(account: ImageAccount, reference: string): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const { status } = await cloudflareApi(
      account,
      "image-preparations",
      z.object({ status: z.string() }),
      { image: reference },
    );
    console.log(`${reference}: ${status}`);
    if (status === "ready") return;
    if (status === "error") throw new Error(`Cloudflare could not prepare ${reference}`);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
  }
  throw new Error(`${reference} was not prepared in 10 minutes`);
}

/** Build each image for each account (the second build is the first's, cached), push it to the
 *  account's registry, and have Cloudflare prepare it there. Answers each account's digests to
 *  pin: account id ⇒ image name ⇒ digest. */
export async function buildImages(accounts: ImageAccount[], names = imageNames()) {
  const built: Record<string, ImagePins> = {};
  for (const account of accounts) {
    const registry = await registryOf(account, true);
    built[account.accountId] = {};
    for (const name of names) {
      const tag = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).toLowerCase();
      buildAndPush(registry, name, tag);
      const digest = await digestOf(registry, name, tag);
      if (!digest) throw new Error(`${name}:${tag} is not in the registry after its push`);
      await prepare(account, referenceOf(account.accountId, name, digest));
      built[account.accountId]![name] = digest;
    }
  }
  return built;
}

/** Fail when an account's registry does not hold a digest its pins name, or an image has no pin.
 *  `pins` is account id ⇒ image name ⇒ digest. */
export async function checkImages(accounts: ImageAccount[], pins: Record<string, ImagePins>) {
  const problems: string[] = [];
  for (const account of accounts) {
    const registry = await registryOf(account, false);
    for (const name of imageNames()) {
      const digest = pins[account.accountId]?.[name];
      if (!digest)
        problems.push(
          `${name} has no pin for account ${account.accountId}: \`pnpm run images\` builds it`,
        );
      else if ((await digestOf(registry, name, digest)) !== digest)
        problems.push(`account ${account.accountId} does not hold ${name}@${digest}`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

if (import.meta.main)
  await (async () => {
    const deployment = await readDeployment();
    const accountId = deployment?.config.cloudflare?.accountId;
    // the config's token, as the deploy runs with (SELF-HOSTING.md "The API token"), unless the
    // environment names one
    const token =
      process.env.CLOUDFLARE_API_TOKEN || deployment?.config.cloudflare?.apiToken.exposeSecret();
    if (!accountId || !token)
      throw new Error(
        "an account to build for (the iterate config's cloudflare.accountId) and its token (cloudflare.apiToken, or CLOUDFLARE_API_TOKEN)",
      );
    const accounts = [{ accountId, token }];
    if (process.argv.includes("--check"))
      return checkImages(accounts, { [accountId]: checkoutPins() });
    for (const [name, digest] of Object.entries((await buildImages(accounts))[accountId]!)) {
      writeFileSync(path.join(IMAGES_DIR, name, "digest"), `${digest}\n`);
      console.log(`✅ ${name} pinned at ${digest} (images/${name}/digest): commit it`);
    }
  })().catch((error: unknown) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
