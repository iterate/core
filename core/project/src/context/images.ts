// The builders are plans, not binding objects: workerd's transformer is a class capnweb cannot carry,
// and the platform replays a returned RpcTarget's expression on every later verb. So a builder holds
// only its source and steps, and touches the binding once per terminal verb.
import { RpcTarget } from "capnweb";
import { codedError } from "iterate/lib";
import type { ItxHostRootContext } from "core-itx";
import type {
  CfImageSource,
  FileHandle,
  CfImageTransformationResult,
  CfImageTransformer,
  CfImagesApi,
  IterateContextApi,
} from "iterate/api";

// the binding's own limit for one input: an image, an overlay, a font
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

// `ImagesError` codes that say the caller's image or options are wrong (Cloudflare's troubleshooting table)
const INPUT_FAULT_CODES: ReadonlySet<number> = new Set([9401, 9402, 9412, 9413, 9520, 9523]);

type Deps = {
  fetch: (request: Request) => Promise<Response>;
  file: (path: string) => Pick<FileHandle, "bytes" | "head" | "put">;
};

type Bytes = () => Promise<Uint8Array>;

type Step = { transform: ImageTransform } | { draw: Bytes; options: ImageDrawOptions | undefined };

type Plan = {
  start:
    | { image: Bytes; options: ImageInputOptions | undefined }
    | { text: string; options: TextOptions };
  steps: readonly Step[];
};

function cfImages(binding: ImagesBinding, deps: Deps): CfImagesApi {
  return {
    info: (image, options) =>
      refusingBadInput(async () => binding.info(streamOf(await bytesOf(image, deps)()), options)),
    input: (image, options) =>
      new ImageTransformerTarget(binding, deps, {
        start: { image: bytesOf(image, deps), options },
        steps: [],
      }),
    text: (content, options) =>
      new ImageTransformerTarget(binding, deps, { start: { text: content, options }, steps: [] }),
  };
}

class ImageTransformerTarget extends RpcTarget implements CfImageTransformer {
  readonly #binding: ImagesBinding;
  readonly #deps: Deps;
  readonly #plan: Plan;
  constructor(binding: ImagesBinding, deps: Deps, plan: Plan) {
    super();
    this.#binding = binding;
    this.#deps = deps;
    this.#plan = plan;
  }
  transform(transform: Parameters<CfImageTransformer["transform"]>[0]) {
    return this.#with({ transform });
  }
  draw(...[image, options]: Parameters<CfImageTransformer["draw"]>) {
    return this.#with({ draw: bytesOf(image, this.#deps), options });
  }
  async output(options: Parameters<CfImageTransformer["output"]>[0]) {
    return new ImageResultTarget(this.#binding, this.#deps, this.#plan, options);
  }
  #with(step: Step) {
    return new ImageTransformerTarget(this.#binding, this.#deps, {
      ...this.#plan,
      steps: [...this.#plan.steps, step],
    });
  }
}

class ImageResultTarget extends RpcTarget implements CfImageTransformationResult {
  readonly #binding: ImagesBinding;
  readonly #deps: Deps;
  readonly #plan: Plan;
  readonly #output: ImageOutputOptions;
  constructor(binding: ImagesBinding, deps: Deps, plan: Plan, output: ImageOutputOptions) {
    super();
    this.#binding = binding;
    this.#deps = deps;
    this.#plan = plan;
    this.#output = output;
  }
  async contentType() {
    return this.#output.format;
  }
  async response(options?: Parameters<CfImageTransformationResult["response"]>[0]) {
    return (await this.#run()).response(options);
  }
  async image(options?: Parameters<CfImageTransformationResult["image"]>[0]) {
    return (await this.#run()).image(options);
  }
  async writeTo(file: Parameters<CfImageTransformationResult["writeTo"]>[0]) {
    const run = await this.#run();
    return (typeof file === "string" ? this.#deps.file(projectPath(file)) : file).put({
      contentType: run.contentType(),
      data: new Uint8Array(await run.response().arrayBuffer()),
    });
  }
  #run() {
    return refusingBadInput(async () => {
      const { start, steps } = this.#plan;
      let chain =
        "text" in start
          ? this.#binding.text(start.text, start.options)
          : this.#binding.input(streamOf(await start.image()), start.options);
      for (const step of steps)
        chain =
          "transform" in step
            ? chain.transform(step.transform)
            : chain.draw(streamOf(await step.draw()), step.options);
      return chain.output(this.#output);
    });
  }
}

async function refusingBadInput<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "number" &&
      INPUT_FAULT_CODES.has(error.code)
    )
      throw codedError("INVALID_INPUT", `Images ${error.code}: ${error.message}`);
    throw error;
  }
}

// Locked the moment it arrives: capnweb cancels an unread stream argument when its call returns, and
// a replayed chain hands the same stream again.
const streamsSeen = new WeakMap<
  ReadableStream<Uint8Array>,
  { held: ReadableStream<Uint8Array>; bytes?: Promise<Uint8Array> }
>();

// never read at `input` time, which a replayed chain runs once per verb
function bytesOf(image: CfImageSource, deps: Deps): Bytes {
  if (image instanceof Uint8Array) return fits(image);
  if (image instanceof ArrayBuffer) return fits(new Uint8Array(image));
  if (image instanceof ReadableStream) {
    let seen = streamsSeen.get(image);
    if (!seen) {
      seen = { held: image.pipeThrough(new TransformStream()) };
      streamsSeen.set(image, seen);
    }
    const held = seen;
    return () => (held.bytes ||= boundedBytesOf("the stream", held.held));
  }
  if (typeof image === "string" && image.startsWith("/")) {
    const file = deps.file(projectPath(image));
    return async () => {
      const record = await file.head();
      if (!record) throw codedError("INVALID_INPUT", `there is no file at ${image}`);
      if (record.size > IMAGE_MAX_BYTES) throw tooLarge(image);
      return fits(await file.bytes())();
    };
  }
  if (typeof image === "string" || image instanceof URL) {
    const url = image instanceof URL ? image : parsedUrl(image);
    return async () => {
      const response = await deps.fetch(new Request(url));
      if (!response.ok)
        throw codedError("INVALID_INPUT", `${url.href} answered ${response.status}, not an image`);
      const length = Number(response.headers.get("content-length"));
      if (length > IMAGE_MAX_BYTES) throw tooLarge(url.href);
      return response.body ? boundedBytesOf(url.href, response.body) : new Uint8Array();
    };
  }
  if (isFileSource(image)) {
    const file = heldFile(image);
    return async () => fits(await file.bytes())();
  }
  throw codedError(
    "INVALID_INPUT",
    'an image is bytes, a ReadableStream, an http(s) URL, a project file path ("/images/photo.jpg"), or a file handle (itx.files.get(path))',
  );
}

type FileSource = { bytes(): Promise<Uint8Array>; dup?: () => FileSource };

// A capnweb stub is a Proxy over a function, which no `typeof` or `in` test on the stub can read.
function isFileSource(value: unknown): value is FileSource {
  return typeof Reflect.get(Object(value), "bytes") === "function";
}
const filesSeen = new WeakMap<object, FileSource>();

// A file handle stub is disposed when the call that carried it returns, and a replayed chain hands
// the same stub again: duplicated the moment it arrives.
function heldFile(file: FileSource): FileSource {
  let held = filesSeen.get(file);
  if (!held) {
    held = typeof file.dup === "function" ? file.dup() : file;
    filesSeen.set(file, held);
  }
  return held;
}

function fits(bytes: Uint8Array): Bytes {
  if (bytes.byteLength > IMAGE_MAX_BYTES) throw tooLarge("the image");
  return async () => bytes;
}

function projectPath(path: string): string {
  if (!path.startsWith("/") || path.length < 2 || path.endsWith("/"))
    throw codedError(
      "INVALID_INPUT",
      `${JSON.stringify(path)} is not a file path like "/images/photo.jpg"`,
    );
  return path;
}

function parsedUrl(text: string): URL {
  const url = URL.canParse(text) ? new URL(text) : undefined;
  if (url?.protocol !== "http:" && url?.protocol !== "https:")
    throw codedError(
      "INVALID_INPUT",
      `${JSON.stringify(text)} is not an http(s) URL or a file path like "/images/photo.jpg"`,
    );
  return url;
}

function tooLarge(what: string) {
  return codedError(
    "INVALID_INPUT",
    `${what} is larger than ${IMAGE_MAX_BYTES} bytes, the most Images takes`,
  );
}

async function boundedBytesOf(what: string, body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > IMAGE_MAX_BYTES) {
      await reader.cancel();
      throw tooLarge(what);
    }
    chunks.push(read.value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body!;
}

export const IMAGES_ROOT_DESCRIPTION =
  'Cloudflare Images, the binding\'s own chain: `images.input(src).transform({ width: 800 }).draw(overlay, opts).output({ format: "image/webp" }).response()` (one round trip; also `.image()`, `.contentType()`, and `.writeTo(itx.files.get(path))`), `images.text(content, { font: { url } })`, `images.info(src)` (free). A `src` is bytes, a ReadableStream, an http(s) URL (fetched by the platform through egress), or a project file: its path `"/images/a.jpg"` (in a script) or `itx.files.get(path)`; `writeTo` takes the same; at most 20 MB. Each transformation is billed once per month per unique image and parameters';

// A file's key is its path without the leading slash, as library.ts `fileKey` makes it.
export function projectImages(
  binding: ImagesBinding,
  context: Pick<ItxHostRootContext, "egress">,
  r2: IterateContextApi["r2"],
): CfImagesApi {
  const record = (
    key: string,
    object: { size: number; httpMetadata?: { contentType?: string } },
  ) => ({
    path: `/${key}`,
    contentType: object.httpMetadata?.contentType || "application/octet-stream",
    size: object.size,
  });
  return cfImages(binding, {
    fetch: context.egress,
    file: (path) => {
      const key = path.replace(/^\/+/, "");
      return {
        bytes: async () => {
          const object = await r2.get(key);
          if (!object) throw new Error(`files: nothing at "/${key}"`);
          return object.data;
        },
        head: async () => {
          const object = await r2.head(key);
          return object ? record(key, object) : null;
        },
        put: async ({ contentType, data }) => {
          if (typeof data === "string")
            throw new Error("images: a file is written from bytes, never a string");
          const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
          const options = {
            httpMetadata: { contentType: contentType || "application/octet-stream" },
          };
          return record(key, await r2.put(key, bytes, options));
        },
      };
    },
  });
}
