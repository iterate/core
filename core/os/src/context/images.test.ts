import { errorCode } from "iterate/lib";
import { expect, test } from "vitest";
import { cfImages, IMAGE_MAX_BYTES } from "./images.ts";

// The contract behind itx.images: the binding's own chain, built as a plan and run once per terminal
// verb; every kind of source; a caller's non-image is INVALID_INPUT. The binding is Cloudflare's, so a
// fake records what it was asked, in order.

test("a chain touches no binding until a terminal verb, then runs the binding's own calls in order, once", async () => {
  const { log, images } = fake({ encoded: [1, 2, 3] });
  const result = await images
    .input(new Uint8Array([9, 8, 7]), { encoding: "base64" })
    .transform({ rotate: 90 })
    .draw(new Uint8Array([6]), { opacity: 0.5 })
    .transform({ width: 128 })
    .output({ format: "image/avif", quality: 70 });
  expect(await result.contentType()).toBe("image/avif");
  expect(log).toEqual([]);

  const response = await result.response({ headers: { "x-a": "b" } });
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  expect(log).toEqual([
    ["input", [9, 8, 7], { encoding: "base64" }],
    ["transform", { rotate: 90 }],
    ["draw", [6], { opacity: 0.5 }],
    ["transform", { width: 128 }],
    ["output", { format: "image/avif", quality: 70 }],
    ["response", { headers: { "x-a": "b" } }],
  ]);
});

test("each terminal verb runs the plan again; a builder can branch", async () => {
  const { log, images } = fake({ encoded: [5] });
  const base = images.input(new Uint8Array([1]));
  const small = await base.transform({ width: 10 }).output({ format: "image/webp" });
  const large = await base.transform({ width: 99 }).output({ format: "image/webp" });
  await small.response();
  await large.image();
  await small.image();
  expect(log.filter(([call]) => call === "transform").map(([, t]) => t)).toEqual([
    { width: 10 },
    { width: 99 },
    { width: 10 },
  ]);
});

test("text starts a chain with no source", async () => {
  const { log, images } = fake({ encoded: [1] });
  const result = await images
    .text("hi", { font: { url: "https://f/x.ttf" }, size: 20 })
    .output({ format: "image/png" });
  await result.response();
  expect(log[0]).toEqual(["text", "hi", { font: { url: "https://f/x.ttf" }, size: 20 }]);
});

test("a source is bytes, an ArrayBuffer, a stream, a URL or a file handle", async () => {
  const requested: string[] = [];
  const { log, images } = fake({
    encoded: [0],
    fetch: async (request) => {
      requested.push(request.url);
      return new Response(new Uint8Array([4, 4]), { headers: { "content-length": "2" } });
    },
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([3]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });
  const sources = [
    new Uint8Array([1]),
    new Uint8Array([2, 2]).buffer,
    stream,
    "https://example.com/a.png",
    new URL("https://example.com/b.png"),
    { bytes: async () => new Uint8Array([5, 5, 5]) },
  ];
  for (const source of sources)
    await (await images.input(source).output({ format: "image/png" })).response();
  expect(log.filter(([call]) => call === "input").map(([, bytes]) => bytes)).toEqual([
    [1],
    [2, 2],
    [3, 3],
    [4, 4],
    [4, 4],
    [5, 5, 5],
  ]);
  expect(requested).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
});

test("a stream is locked when it arrives, and read once however often the chain replays or runs", async () => {
  const { log, images } = fake({ encoded: [0] });
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array([7]));
      controller.close();
    },
  });
  const first = images.input(stream); // the platform replays `input(stream)` once per verb
  const second = images.input(stream);
  expect(stream).toMatchObject({ locked: true });
  const result = await second.transform({ width: 1 }).output({ format: "image/png" });
  await result.response();
  await (await first.output({ format: "image/png" })).response();
  expect(log.filter(([call]) => call === "input").map(([, bytes]) => bytes)).toEqual([[7], [7]]);
  expect(pulls).toBe(1);
});

test("info reads any source and answers the binding's answer", async () => {
  const { images } = fake({ encoded: [] });
  expect(await images.info(new Uint8Array([1]))).toEqual({
    format: "image/png",
    fileSize: 1,
    width: 2,
    height: 3,
  });
});

test("a source that is not an image source, a bad URL, an answer that is not ok, and anything over 20 MB are INVALID_INPUT", async () => {
  const { images } = fake({
    encoded: [],
    fetch: async () => new Response("nope", { status: 404 }),
  });
  const refused = async (run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      return errorCode(error);
    }
    return "answered";
  };
  expect(await refused(() => images.input(12 as never))).toBe("INVALID_INPUT");
  expect(await refused(() => images.input("file:///etc/passwd"))).toBe("INVALID_INPUT");
  expect(await refused(() => images.input("/a/path.png"))).toBe("INVALID_INPUT");
  expect(await refused(() => images.input(new Uint8Array(IMAGE_MAX_BYTES + 1)))).toBe(
    "INVALID_INPUT",
  );
  expect(await refused(() => images.info("https://example.com/missing.png"))).toBe("INVALID_INPUT");
  expect(
    await refused(() => images.info({ bytes: async () => new Uint8Array(IMAGE_MAX_BYTES + 1) })),
  ).toBe("INVALID_INPUT");
});

test("a binding's input fault (numeric ImagesError.code) is INVALID_INPUT; any other failure is left as it was", async () => {
  const notAnImage = Object.assign(new Error("not an image"), { code: 9412 });
  const overloaded = Object.assign(new Error("busy"), { code: 9529 });
  for (const [failure, code] of [
    [notAnImage, "INVALID_INPUT"],
    [overloaded, 9529],
  ] as const) {
    const { images } = fake({ encoded: [], failure });
    const result = await images.input(new Uint8Array([0])).output({ format: "image/png" });
    const error = await result.response().then(
      () => undefined,
      (caught) => caught,
    );
    expect(errorCode(error)).toBe(code);
    expect(error.message).toContain(failure.message);
  }
});

test("writeTo puts the encoded image, with its content type, into the file", async () => {
  const { images } = fake({ encoded: [1, 2], contentType: "image/webp" });
  const puts: unknown[] = [];
  const record = { path: "/o.webp", contentType: "image/webp", size: 2 };
  const result = await images.input(new Uint8Array([0])).output({ format: "image/webp" });
  expect(
    await result.writeTo({
      put: async (input) => {
        puts.push(input);
        return record;
      },
    }),
  ).toEqual(record);
  expect(puts).toEqual([{ contentType: "image/webp", data: new Uint8Array([1, 2]) }]);
});

function fake(options: {
  encoded: number[];
  contentType?: string;
  failure?: Error;
  fetch?: (request: Request) => Promise<Response>;
}) {
  const log: unknown[][] = [];
  const read = async (stream: ReadableStream<Uint8Array>) => [
    ...new Uint8Array(await new Response(stream).arrayBuffer()),
  ];
  const chain = (): unknown => {
    const transformer = {
      transform: (transform: unknown) => {
        log.push(["transform", transform]);
        return transformer;
      },
      draw: (overlay: ReadableStream<Uint8Array>, drawOptions: unknown) => {
        log.push(["draw", "pending", drawOptions]);
        const entry = log.at(-1)!;
        pending.push(read(overlay).then((bytes) => (entry[1] = bytes)));
        return transformer;
      },
      output: async (output: unknown) => {
        await Promise.all(pending);
        if (options.failure) throw options.failure;
        log.push(["output", output]);
        return {
          response: (responseOptions: unknown) => {
            log.push(["response", responseOptions]);
            return new Response(new Uint8Array(options.encoded));
          },
          image: () => {
            log.push(["image"]);
            return new Response(new Uint8Array(options.encoded)).body;
          },
          contentType: () => options.contentType || "image/png",
        };
      },
    };
    const pending: Promise<unknown>[] = [];
    return Object.assign(transformer, { pending });
  };
  const binding = {
    input(stream: ReadableStream<Uint8Array>, inputOptions: unknown) {
      const transformer = chain() as { pending: Promise<unknown>[] };
      log.push(["input", "pending", inputOptions]);
      const entry = log.at(-1)!;
      transformer.pending.push(read(stream).then((bytes) => (entry[1] = bytes)));
      return transformer;
    },
    text(content: string, textOptions: unknown) {
      log.push(["text", content, textOptions]);
      return chain();
    },
    async info(stream: ReadableStream<Uint8Array>) {
      await read(stream);
      return { format: "image/png", fileSize: 1, width: 2, height: 3 };
    },
  } as unknown as ImagesBinding;
  return {
    log,
    images: cfImages(binding, {
      fetch: options.fetch || (async () => new Response("no fetch expected", { status: 500 })),
    }),
  };
}
