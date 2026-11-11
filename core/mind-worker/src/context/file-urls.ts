import { signClaims, verifyClaims } from "core-itx";
import { mindApiUrlOf } from "iterate/mind-api";
import { z } from "zod";

export const FILES_PATH = "/api/files/";

const FileUrlClaims = z.object({
  kind: z.literal("file-url"),
  key: z.string().min(1),
  method: z.enum(["GET", "PUT"]),
  exp: z.number().int().positive(),
});

const DEFAULT_FILE_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function signedFileUrl(input: {
  secret: string;
  domain: string;
  key: string;
  method: "GET" | "PUT";
  expiresInSeconds?: number;
}): Promise<{ url: string; expiresAt: string }> {
  const url = new URL(
    `${mindApiUrlOf(input.domain)}/files/${input.key.split("/").map(encodeURIComponent).join("/")}`,
  );
  const exp = Math.floor(
    Date.now() / 1000 + (input.expiresInSeconds ?? DEFAULT_FILE_URL_TTL_SECONDS),
  );
  const token = await signClaims(
    { kind: "file-url", key: input.key, method: input.method, exp },
    input.secret,
  );
  url.searchParams.set("token", token);
  return { url: url.href, expiresAt: new Date(exp * 1000).toISOString() };
}

// The token is the whole authorization, so every refusal is terse. The URL is on the platform's
// origin, so a stored HTML or SVG file runs sandboxed: an opaque origin, no cookie to spend.
export async function serveMindFileRequest(input: {
  bucket: R2Bucket;
  secret: string;
  recordUpload: (file: {
    path: string;
    size: number;
    contentType: string;
    etag: string;
  }) => Promise<unknown>;
  request: Request;
}): Promise<Response> {
  const answer = await fileAnswer(input);
  answer.headers.set(
    "content-security-policy",
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
  );
  return answer;
}

async function fileAnswer(input: Parameters<typeof serveMindFileRequest>[0]) {
  const { request } = input;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return new Response("a signed file URL carries ?token=…\n", { status: 400 });
  const parsed = FileUrlClaims.safeParse(await verifyClaims(token, input.secret));
  if (!parsed.success) return new Response("Forbidden\n", { status: 403 });
  const claims = parsed.data;
  const requestKey = decodeURIComponent(url.pathname.slice(FILES_PATH.length));
  const method = request.method === "HEAD" ? "GET" : request.method;
  if (claims.key !== requestKey || claims.method !== method || claims.exp * 1000 <= Date.now())
    return new Response("Forbidden\n", { status: 403 });
  const { key } = claims;

  if (claims.method === "PUT") {
    const contentType = request.headers.get("content-type") || "application/octet-stream";
    // R2 takes a stream only at a known length, and a body that crossed a provided mind's
    // session has none: the request's own length gives it one.
    const length = Number(request.headers.get("content-length") ?? NaN);
    const body =
      request.body && Number.isSafeInteger(length)
        ? request.body.pipeThrough(new FixedLengthStream(length))
        : request.body;
    const object = await input.bucket.put(key, body, { httpMetadata: { contentType } });
    const path = `/${claims.key}`;
    await input.recordUpload({ path, size: object.size, contentType, etag: object.etag });
    return Response.json({ path, contentType, size: object.size });
  }
  // Handed the headers regardless, the bucket reports a range on a whole-object read too.
  const rangeHeader = request.headers.get("range");
  const object = await input.bucket.get(key, rangeHeader ? { range: request.headers } : {});
  if (!object) return new Response("Not found\n", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  let status = 200;
  const range = rangeHeader ? object.range : undefined;
  if (range && "offset" in range) {
    const offset = range.offset ?? 0;
    const length = range.length ?? object.size - offset;
    headers.set(
      "content-range",
      `bytes ${String(offset)}-${String(offset + length - 1)}/${String(object.size)}`,
    );
    headers.set("content-length", String(length));
    status = 206;
  } else if (range && "suffix" in range) {
    const length = Math.min(range.suffix, object.size);
    headers.set(
      "content-range",
      `bytes ${String(object.size - length)}-${String(object.size - 1)}/${String(object.size)}`,
    );
    headers.set("content-length", String(length));
    status = 206;
  } else headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
}
