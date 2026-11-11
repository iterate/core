// With `mind.sandboxImage: "published"`, copies the published sandbox image (../src/sandbox-image.ts)
// into the mind's own registry, registry.cloudflare.com/<account>/iterate-dev-image, by the
// registry API alone: no Docker. Every blob and the manifest already there is skipped, so a deploy
// after the first copies nothing. The push credentials come from the deploy's own token and last an
// hour.
import { loadMindConfig, stageOf } from "../src/config.ts";
import { PUBLISHED_SANDBOX_IMAGE } from "../src/sandbox-image.ts";

const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
// A Cloudflare request body has a size limit; a layer goes up in parts of this size.
const PART = 64 * 1024 * 1024;

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
  targetToken: string | undefined,
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
  const begun = await call(
    target,
    `/v2/${target.repo}/blobs/uploads/`,
    { method: "POST" },
    targetToken,
  );
  await begun.body?.cancel();
  let location = begun.headers.get("location");
  if (!begun.ok || !location)
    throw new Error(`${target.host} did not start an upload: ${begun.status}`);
  const absolute = (place: string) => new URL(place, `https://${target.host}`).toString();
  location = absolute(location);
  let sent = 0;
  const parts: Uint8Array[] = [];
  let buffered = 0;
  const flush = async () => {
    if (buffered === 0) return;
    const part = Buffer.concat(parts, buffered);
    const answer = await call(
      target,
      location!,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `${sent}-${sent + part.length - 1}`,
          "content-length": String(part.length),
        },
        body: part,
      },
      targetToken,
    );
    await answer.body?.cancel();
    if (!answer.ok)
      throw new Error(`${target.host} refused part of ${digest} at ${sent}: ${answer.status}`);
    location = absolute(answer.headers.get("location") ?? location!);
    sent += part.length;
    parts.length = 0;
    buffered = 0;
  };
  for await (const chunk of read.body as unknown as AsyncIterable<Uint8Array>) {
    parts.push(chunk);
    buffered += chunk.length;
    if (buffered >= PART) await flush();
  }
  await flush();
  if (sent !== size) throw new Error(`the blob ${digest} has ${sent} bytes, not ${size}`);
  const close = new URL(location);
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
}

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
    repo: `${config.accountId}/iterate-dev-image`,
    basic: await pushCredentials(config.accountId, token),
  };
  const targetToken = await tokenFor(target, "pull,push");
  const present = await call(
    target,
    `/v2/${target.repo}/manifests/${digest}`,
    { method: "HEAD", headers: { accept: MANIFEST_TYPES } },
    targetToken,
  );
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
