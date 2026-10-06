// images.ts — the `itx.images` built-in root: Cloudflare's Images binding, with the binding's own
// spelling (iterate/api `CfImagesApi`): `info(image)`, `input(image).transform(…).draw(…).output(…)`
// and `.response()` / `.contentType()` / `.image()` on the result, plus `text(…)`.
//
// THE BUILDERS ARE PLANS, NOT BINDING OBJECTS. workerd's own transformer and result are plain classes
// capnweb cannot carry, and the platform answers a returned `RpcTarget` with the expression that made
// it, replaying that expression on every later verb (context/dispatch.ts
// `itxAnswerDetachedFromSession`). So a builder holds only what it was given — the source, the steps —
// and touches the binding when a terminal verb runs (`info`, `response`, `image`, `writeTo`): once per
// terminal call, however often the chain was replayed. `cfArtifacts.get` is the same shape. This
// root is resolved at the edge for a capnweb session (rpc.ts `statelessResolverOf`), so the chain's
// arguments stay live objects in one isolate and `await itx.images.input(x).transform(t).output(o)
// .response()` is one round trip.
//
// SOURCES (`CfImagesSource`): bytes, a `ReadableStream`, an http(s) URL (fetched here, through the
// project's egress, so no image bytes visit the caller), or a file handle (`itx.files.get(path)`).

import { RpcTarget } from "capnweb";
import { codedError } from "iterate/lib";
import type {
  CfImageSource,
  CfImageTransformationResult,
  CfImageTransformer,
  CfImagesApi,
} from "iterate/api";

/** The binding's own limit for one input, and so ours: an image, an overlay, a font. */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** `ImagesError` codes that say the CALLER's image or options are wrong (Cloudflare's troubleshooting
 *  table): too large or interrupted, bad arguments, not an image, too many pixels, unsupported format,
 *  a format that could not be decoded. Everything else stays what the binding made it. */
const INPUT_FAULT_CODES: ReadonlySet<number> = new Set([9401, 9402, 9412, 9413, 9520, 9523]);

type Deps = { fetch: (request: Request) => Promise<Response> };

/** One image's bytes, read when a terminal verb needs them. */
type Bytes = () => Promise<Uint8Array>;

type Step = { transform: ImageTransform } | { draw: Bytes; options: ImageDrawOptions | undefined };

type Plan = {
  start:
    | { image: Bytes; options: ImageInputOptions | undefined }
    | { text: string; options: TextOptions };
  steps: readonly Step[];
};

/** Cloudflare Images, as `itx.images`. */
export function cfImages(binding: ImagesBinding, deps: Deps): CfImagesApi {
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
    return new ImageResultTarget(this.#binding, this.#plan, options);
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
  readonly #plan: Plan;
  readonly #output: ImageOutputOptions;
  constructor(binding: ImagesBinding, plan: Plan, output: ImageOutputOptions) {
    super();
    this.#binding = binding;
    this.#plan = plan;
    this.#output = output;
  }
  /** The binding answers its output format; so does the plan, without running it. */
  async contentType() {
    return this.#output.format;
  }
  async response(options?: Parameters<CfImageTransformationResult["response"]>[0]) {
    return (await this.#run()).response(options);
  }
  async image(options?: Parameters<CfImageTransformationResult["image"]>[0]) {
    return (await this.#run()).image(options);
  }
  /** The result's bytes into a file (`itx.files.get(path)`), without visiting the caller. */
  async writeTo(file: Parameters<CfImageTransformationResult["writeTo"]>[0]) {
    const run = await this.#run();
    return file.put({
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

/** A caller's wrong image is `INVALID_INPUT`, not a platform failure (numeric `ImagesError.code`). */
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

/** A stream the caller sent, locked THE MOMENT it arrives (capnweb cancels an unread stream argument
 *  when its call returns, and the platform replays a chain's `input(stream)` once per verb: the same
 *  stream, seen again), and read once, at the first terminal verb. */
const streamsSeen = new WeakMap<
  ReadableStream<Uint8Array>,
  { held: ReadableStream<Uint8Array>; bytes?: Promise<Uint8Array> }
>();

/** Where an image's bytes come from, read when asked — never at `input` time, which a replayed chain
 *  runs once per verb. A URL is fetched per terminal verb. */
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
    "an image is bytes, a ReadableStream, an http(s) URL, or a file handle (itx.files.get(path))",
  );
}

type FileSource = { bytes(): Promise<Uint8Array>; dup?: () => FileSource };

/** A capnweb stub is a Proxy over a function, which no `typeof` or `in` test on the stub itself can
 *  read; asking for `bytes` is what a caller does, and what a file handle answers. */
function isFileSource(value: unknown): value is FileSource {
  return typeof Reflect.get(Object(value), "bytes") === "function";
}
const filesSeen = new WeakMap<object, FileSource>();

/** A file handle a caller sent is a capnweb stub, disposed when the call that carried it returns:
 *  duplicated THE MOMENT it arrives, and remembered by the stub it arrived as (the platform replays a
 *  chain's `input(file)` once per verb, with that same stub, by then disposed). The duplicate lives
 *  until the session ends. */
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

function parsedUrl(text: string): URL {
  const url = URL.canParse(text) ? new URL(text) : undefined;
  if (url?.protocol !== "http:" && url?.protocol !== "https:")
    throw codedError("INVALID_INPUT", `${JSON.stringify(text)} is not an http(s) URL`);
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

/** The one-shot stream the binding reads. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body!;
}
