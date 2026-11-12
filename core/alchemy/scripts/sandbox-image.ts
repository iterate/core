// With `mind.sandboxImage: "published"`, copies the published sandbox image (../src/sandbox-image.ts)
// into the mind's own registry, registry.cloudflare.com/<account>/<SANDBOX_IMAGE_REPOSITORY>, by
// the registry API alone: no Docker. Every blob and the manifest already there is skipped, so a deploy
// after the first copies nothing. The push credentials come from the deploy's own token and last an
// hour.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { loadMindConfig, stageOf } from "../src/config.ts";
import { PUBLISHED_SANDBOX_IMAGE, SANDBOX_IMAGE_REPOSITORY } from "../src/sandbox-image.ts";

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

async function copySandboxImage() {
  const config = await loadMindConfig(stageOf(process.argv));
  if (config.mind?.provided || config.mind?.sandboxImage !== "published") return;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token)
    throw new Error("CLOUDFLARE_API_TOKEN is not set: the sandbox image is copied with it");
  const { digest } = PUBLISHED_SANDBOX_IMAGE;
  const [host, ...path] = PUBLISHED_SANDBOX_IMAGE.source.split("/");
  const source: Registry = { host: host!, repo: path.join("/") };
  const target: Registry = {
    host: "registry.cloudflare.com",
    repo: `${config.accountId}/${SANDBOX_IMAGE_REPOSITORY}`,
    basic: await pushCredentials(config.accountId, token),
  };
  const targetToken = (await tokenFor(target, "pull,push")) || "";
  // A GET, not a HEAD: Cloudflare's registry can answer a HEAD with 200 for a manifest whose content
  // and layers it has lost, and a GET with 404.
  const present = await call(
    target,
    `/v2/${target.repo}/manifests/${digest}`,
    { headers: { accept: MANIFEST_TYPES } },
    targetToken,
  );
  await present.body?.cancel();
  if (present.ok) return console.log(`the sandbox image ${digest} is in the mind's registry`);
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
      `${copied ? "copied" : "present"} ${blob.digest} (${Math.round(blob.size / 1e6)} MB)`,
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
  console.log(`copied the sandbox image ${digest} into the mind's registry`);
}

try {
  await copySandboxImage();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
