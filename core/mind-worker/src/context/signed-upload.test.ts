// signed-upload.test.ts — a signed file upload through the Boundary and the Mind, in workerd. Each
// hop gives the body a pipe of its own (core-itx/request-body), and the file route pipes the body
// into a FixedLengthStream for R2. workerd does not pipe one native transform stream into another
// ("Inter-TransformStream ReadableStream.pipeTo() is not implemented."), so the pipes must be JS.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { expect, test } from "vitest";
import { signedFileUrl } from "./file-urls.ts";

test.each([
  ["1 kB", 1000],
  ["1 MiB", 1 << 20],
])("a signed upload of %s reaches R2 whole", { timeout: 30_000 }, async (_, size) => {
  await using runtime = await uploadPath();
  const body = new Uint8Array(size).map((_, index) => index % 251);
  const key = `uploads/${String(size)}.bin`;
  const { url } = await signedFileUrl({
    secret,
    controlPlaneHostname: "iterate.mind.example",
    key,
    method: "PUT",
  });
  const answer = await runtime.dispatchFetch(url, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
  expect({ status: answer.status, json: await answer.json() }).toEqual({
    status: 200,
    json: { path: `/${key}`, contentType: "application/octet-stream", size },
  });
  const stored = await (await runtime.getR2Bucket("BUCKET", "mind")).get(key);
  expect(Buffer.from(await stored!.arrayBuffer()).equals(Buffer.from(body))).toBe(true);
});

const secret = "a-test-signing-secret";

// fixtures/signed-upload.ts as two Workers: "boundary" hands each request to "mind"
async function uploadPath() {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/signed-upload.ts", import.meta.url).href)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd"],
    external: ["cloudflare:*", "node:*"],
  });
  const script = {
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    manifest: {
      mainModule: "worker.js",
      modules: { "worker.js": { type: "esm" as const, contents: bundled.outputFiles[0]!.text } },
    },
  };
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          ...script,
          name: "boundary",
          env: { MIND: { type: "worker", worker: "mind", exportName: "Mind" } },
        },
      },
      {
        config: {
          ...script,
          name: "mind",
          env: { BUCKET: { type: "r2" }, SECRET: { type: "text", value: secret } },
        },
      },
    ],
  });
  await runtime.ready;
  return Object.assign(runtime, { [Symbol.asyncDispose]: () => runtime.dispose() });
}
