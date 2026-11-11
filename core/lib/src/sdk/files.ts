// files.ts — AN APP'S FILES, SERVED WITH NO BUILD. A config's module imports them (`import index
// from "./index.html"`, `import files from "./public/"`: the loader makes a file its text or its
// bytes, and a folder every file under it by path) and hands them here from its `fetch`.

const CONTENT_TYPES: Record<string, string> = {
  avif: "image/avif",
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  md: "text/markdown; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  wav: "audio/wav",
  webm: "video/webm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
};

/** A file as the loader hands it over: its text, or its bytes when it is not text. */
export type FileContent = string | Uint8Array;

/** One tag per content, worked out once: a file is the same object for the isolate's life. */
const tagsByBytes = new WeakMap<Uint8Array, string>();
const tagsByText = new Map<string, string>();

function tagOf(content: FileContent): string {
  const known = typeof content === "string" ? tagsByText.get(content) : tagsByBytes.get(content);
  if (known) return known;
  let djb2 = 5381;
  let fnv1a = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    const code = typeof content === "string" ? content.charCodeAt(i) : content[i]!;
    djb2 = ((djb2 << 5) + djb2 + code) | 0;
    fnv1a = Math.imul(fnv1a ^ code, 0x01000193);
  }
  const tag = `"${(djb2 >>> 0).toString(36)}-${(fnv1a >>> 0).toString(36)}-${content.length.toString(36)}"`;
  if (typeof content === "string") tagsByText.set(content, tag);
  else tagsByBytes.set(content, tag);
  return tag;
}

/** THE ANSWER TO A REQUEST FOR ONE OF AN APP'S FILES. A path that names a file of `files` gets that
 *  file, typed by its extension. A page navigation to any other path gets `index`, so the page's
 *  own script can read the URL. Anything else is a 404. Every answer carries an ETag and asks the
 *  browser to check back, so a commit shows on the next load and an unchanged file costs a 304. */
export function serveFiles(
  request: Request,
  app: { index?: string; files?: Record<string, FileContent> },
): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url).pathname).slice(1);
  } catch {
    return new Response("Not found\n", { status: 404 });
  }
  const named = Boolean(app.files && Object.hasOwn(app.files, path));
  const navigation =
    request.headers.get("sec-fetch-mode") === "navigate" ||
    (request.headers.get("accept") || "").includes("text/html");
  const content = named ? app.files![path] : navigation || !path ? app.index : undefined;
  // an empty file is a file, and an empty page a page
  if (typeof content !== "string" && !(content instanceof Uint8Array))
    return new Response("Not found\n", { status: 404 });
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const headers = {
    // `index` answers for a path that names no file, whatever the path's extension
    "content-type": named
      ? CONTENT_TYPES[extension] || "application/octet-stream"
      : CONTENT_TYPES.html!,
    etag: tagOf(content),
    "cache-control": "no-cache",
  };
  if (request.headers.get("if-none-match") === headers.etag)
    return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : (content as BodyInit), { headers });
}
