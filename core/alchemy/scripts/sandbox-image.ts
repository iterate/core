// Pushes each named image of the stack's config (`mind.images`) that is in another registry to the
// Cloudflare managed registry of the account, registry.cloudflare.com/<account>/<SANDBOX_IMAGE_REPOSITORY>,
// by the registry API alone: no Docker. Cloudflare does not pull a Durable Object's Container from
// another registry. Every blob and manifest already there is skipped, so a deploy after the first
// pushes nothing. The push credentials come from the deploy's own token and last an hour.
//
// Before that, two checks of the config's images against what the stack has. A config file that
// says nothing about images, over a stack that has named images, would take them off the stack:
// the deploy stops. And a stack whose iterate image is not at this checkout's pin is told so.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import {
  imagesAFileLeavesOut,
  loadMindConfig,
  type MindConfig,
  mindConfigFile,
  SANDBOX_IMAGE_VAR,
  saysNothingOfImages,
  stageOf,
  storedMindConfigIfAny,
} from "../src/config.ts";
import {
  CLOUDFLARE_REGISTRY,
  digestsOffPin,
  ITERATE_DEV_IMAGE,
  partsOfImage,
  SANDBOX_IMAGE_REPOSITORY,
} from "../src/sandbox-image.ts";

const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type Registry = { host: string; repo: string; basic?: string };

/** A registry answers 401 with the place to get a token from; the token is cached per registry. */
async function call(registry: Registry, path: string, init: RequestInit = {}, token?: string) {
  const url = path.startsWith("https://") ? path : `https://${registry.host}${path}`;
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", token);
  return fetch(url, { ...init, headers, redirect: "follow" });
}

async function tokenFor(registry: Registry, actions: string): Promise<string | undefined> {
  const probe = await fetch(`https://${registry.host}/v2/`, {
    headers: registry.basic ? { authorization: `Basic ${registry.basic}` } : {},
  });
  await probe.body?.cancel();
  if (probe.ok) return registry.basic ? `Basic ${registry.basic}` : undefined;
  const challenge = probe.headers.get("www-authenticate") ?? "";
  if (/^basic/i.test(challenge)) return `Basic ${registry.basic}`;
  const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
  if (!realm) throw new Error(`${registry.host} asks for an authentication it does not name`);
  const service = /service="([^"]+)"/.exec(challenge)?.[1];
  const url = new URL(realm);
  if (service) url.searchParams.set("service", service);
  url.searchParams.set("scope", `repository:${registry.repo}:${actions}`);
  const answer = await fetch(url, {
    headers: registry.basic ? { authorization: `Basic ${registry.basic}` } : {},
  });
  if (!answer.ok) throw new Error(`${registry.host} refused a token: ${answer.status}`);
  const body = (await answer.json()) as { token?: string; access_token?: string };
  return `Bearer ${body.token || body.access_token}`;
}

/** A PATCH of the `size` bytes of `file`, with no time limit. */
function streamTo(url: string, size: number, file: string, token: string) {
  return new Promise<{ status: number; location: string }>((resolve, reject) => {
    const sending = request(
      url,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(size),
          authorization: token,
        },
      },
      (answer) => {
        answer.resume();
        answer.on("end", () =>
          resolve({
            status: answer.statusCode || 0,
            location: String(answer.headers.location || ""),
          }),
        );
      },
    );
    sending.on("error", reject);
    createReadStream(file).on("error", reject).pipe(sending);
  });
}

async function pushCredentials(accountId: string, token: string) {
  const answer = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/registries/registry.cloudflare.com/credentials`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ expiration_minutes: 60, permissions: ["pull", "push"] }),
    },
  );
  const body = (await answer.json()) as {
    result?: { username?: string; user?: string; password?: string };
  };
  const username = body.result?.username || body.result?.user;
  if (!answer.ok || !username || !body.result?.password)
    throw new Error(`Cloudflare gave no registry credentials: ${answer.status}`);
  return Buffer.from(`${username}:${body.result.password}`).toString("base64");
}

async function copyBlob(
  source: Registry,
  sourceToken: string | undefined,
  target: Registry,
  targetToken: string,
  digest: string,
  size: number,
) {
  const there = await call(
    target,
    `/v2/${target.repo}/blobs/${digest}`,
    { method: "HEAD" },
    targetToken,
  );
  if (there.ok) return false;
  const read = await call(source, `/v2/${source.repo}/blobs/${digest}`, {}, sourceToken);
  if (!read.ok || !read.body)
    throw new Error(`${source.host} did not give the blob ${digest}: ${read.status}`);
  // Read whole first: a download held back by a slow upload is closed by the source's storage.
  const folder = await mkdtemp(join(tmpdir(), "sandbox-image-"));
  const file = join(folder, "blob");
  try {
    const hash = createHash("sha256");
    await pipeline(
      Readable.fromWeb(read.body as ReadableStream),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(file),
    );
    if (`sha256:${hash.digest("hex")}` !== digest)
      throw new Error(`the blob read from ${source.host} is not ${digest}`);
    const begun = await call(
      target,
      `/v2/${target.repo}/blobs/uploads/`,
      { method: "POST" },
      targetToken,
    );
    await begun.body?.cancel();
    const started = begun.headers.get("location");
    if (!begun.ok || !started)
      throw new Error(`${target.host} did not start an upload: ${begun.status}`);
    // One streamed PATCH, as Docker pushes: Cloudflare's registry refuses a second part (416). Sent
    // with node:https, which has no time limit: fetch gives up on a request whose answer takes more
    // than five minutes, and a large layer takes longer than that to send.
    const sent = await streamTo(absolute(target, started), size, file, targetToken);
    if (sent.status < 200 || sent.status > 299)
      throw new Error(`${target.host} refused the blob ${digest}: ${sent.status}`);
    const close = new URL(absolute(target, sent.location || started));
    close.searchParams.set("digest", digest);
    const closed = await call(
      target,
      close.toString(),
      { method: "PUT", headers: { "content-length": "0" } },
      targetToken,
    );
    await closed.body?.cancel();
    if (!closed.ok)
      throw new Error(`${target.host} did not take the blob ${digest}: ${closed.status}`);
    return true;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const absolute = (registry: Registry, place: string) =>
  new URL(place, `https://${registry.host}`).toString();

/** Stops a deploy from a config file that says nothing about images when the stack has named
 *  images. A stack with no stored config yet (a first deploy) has none to lose. A stored config
 *  that cannot be read stops the deploy too: nothing then says what the stack has. */
async function refuseImagesLeftOut(config: MindConfig) {
  const file = await mindConfigFile();
  if (!file || !saysNothingOfImages(file.config, process.env)) return;
  let stored: MindConfig | undefined;
  try {
    stored = storedMindConfigIfAny(config.name);
  } catch (error) {
    throw new Error(
      `Stopped: the config file ${file.path} says nothing about the mind's images, and the config that the stack ${config.name} keeps could not be read, so nothing says whether this deploy would take images off the stack (${error instanceof Error ? error.message : String(error)}). Nothing was changed. Run the deploy again, or say the images in the file: "images": {} for none.`,
      { cause: error },
    );
  }
  if (!stored) return;
  const left = imagesAFileLeavesOut(file.config, stored, process.env);
  if (left.length > 0)
    throw new Error(
      `Stopped: the config file ${file.path} says nothing about the mind's images, and the stack ${config.name} has ${left.join(", ")}. This deploy would take ${left.length > 1 ? "them" : "it"} off the stack, and its sandboxes would then start cloudflare/debian-trixie. Nothing was changed. Say the stack's images in the file ("pnpm run config --stage ${config.name}" prints them, under mind.images), or say "images": {} there to take them off.`,
    );
}

async function pushImages() {
  const config = await loadMindConfig(stageOf(process.argv));
  await refuseImagesLeftOut(config);
  // a stack keeps the digest of its config: said when iterate's image there is not at the pin
  const offPin = digestsOffPin(config.mind?.images || {});
  if (offPin)
    console.log(
      `Note: this stack's ${ITERATE_DEV_IMAGE} is at ${offPin.has}, and this checkout's pin is ${offPin.pin}. The stack keeps its image. To move it to the pin, deploy once with ${SANDBOX_IMAGE_VAR}=published: a snapshot taken on the old image does not restore on the new one.`,
    );
  const elsewhere = Object.values(config.mind?.images || {}).flatMap((source) =>
    "image" in source && partsOfImage(source.image).host !== CLOUDFLARE_REGISTRY
      ? [source.image]
      : [],
  );
  if (elsewhere.length === 0) return;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set: an image is pushed with it");
  const target: Registry = {
    host: CLOUDFLARE_REGISTRY,
    repo: `${config.accountId}/${SANDBOX_IMAGE_REPOSITORY}`,
    basic: await pushCredentials(config.accountId, token),
  };
  const targetToken = (await tokenFor(target, "pull,push")) || "";
  for (const image of new Set(elsewhere)) await pushImage(image, target, targetToken);
}

async function pushImage(image: string, target: Registry, targetToken: string) {
  const { host, repository, digest } = partsOfImage(image);
  const source: Registry = { host, repo: repository };
  // A GET, not a HEAD: Cloudflare's registry can answer a HEAD with 200 for a manifest whose content
  // and layers it has lost, and a GET with 404.
  const present = await call(
    target,
    `/v2/${target.repo}/manifests/${digest}`,
    { headers: { accept: MANIFEST_TYPES } },
    targetToken,
  );
  await present.body?.cancel();
  if (present.ok) return console.log(`the image ${digest} is in the account's registry`);
  const sourceToken = await tokenFor(source, "pull");
  const read = await call(
    source,
    `/v2/${source.repo}/manifests/${digest}`,
    { headers: { accept: MANIFEST_TYPES } },
    sourceToken,
  );
  if (!read.ok)
    throw new Error(`${source.host} did not give the manifest ${digest}: ${read.status}`);
  const type = read.headers.get("content-type") ?? MANIFEST_TYPES.split(", ")[0]!;
  const bytes = Buffer.from(await read.arrayBuffer());
  const manifest = JSON.parse(bytes.toString("utf8")) as {
    config: { digest: string; size: number };
    layers: { digest: string; size: number }[];
  };
  if (!manifest.layers) throw new Error(`the manifest ${digest} is a list, not one image`);
  for (const blob of [manifest.config, ...manifest.layers]) {
    const copied = await copyBlob(source, sourceToken, target, targetToken, blob.digest, blob.size);
    console.log(
      `${copied ? "pushed" : "present"} ${blob.digest} (${Math.round(blob.size / 1e6)} MB)`,
    );
  }
  const put = await call(
    target,
    `/v2/${target.repo}/manifests/${digest}`,
    { method: "PUT", headers: { "content-type": type }, body: bytes },
    targetToken,
  );
  await put.body?.cancel();
  if (!put.ok) throw new Error(`${target.host} did not take the manifest: ${put.status}`);
  console.log(`pushed the image ${digest} to the account's registry`);
}

try {
  await pushImages();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
