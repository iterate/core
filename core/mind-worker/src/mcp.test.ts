import { expect, test } from "vitest";
import { shownImages } from "./mcp.ts";

test("a result that names no image is answered as before", async () => {
  for (const value of [{ n: 1 }, "text", { "itx/images": "/shots/a.png" }, { "itx/images": [] }])
    expect(
      await shownImages(
        value,
        // a result that names no image starts no lookup
        () => Promise.reject(new Error("no lookup")),
        read,
      ),
    ).toEqual({
      value,
      namesImages: false,
      images: [],
    });
});

test("the files a result names go out as image blocks, in their order", async () => {
  const value = { note: "two", "itx/images": ["/shots/a.png", "/shots/b.jpg"] };
  expect(await shownImages(value, list, read)).toEqual({
    value,
    namesImages: true,
    images: [
      { type: "image", mimeType: "image/png", data: "AQID" },
      { type: "image", mimeType: "image/jpeg", data: "BAU=" },
    ],
  });
});

test("a file that did not come is named with its reason", async () => {
  const { images, value } = await shownImages(
    {
      "itx/images": [
        "/shots/gone.png",
        "/notes/c.md",
        "/shots/drawing.svg",
        "/shots/empty.png",
        "/shots/a.png",
        "/shots/large.png",
        "/shots/now-text.png",
        "/shots/grew.png",
      ],
    },
    list,
    read,
  );
  expect(images).toEqual([{ type: "image", mimeType: "image/png", data: "AQID" }]);
  expect(value).toMatchObject({
    "itx/images-left-out": {
      "/shots/gone.png": "no such file",
      "/notes/c.md": "not a PNG, JPEG, GIF or WebP image: text/markdown",
      "/shots/drawing.svg": "not a PNG, JPEG, GIF or WebP image: image/svg+xml",
      "/shots/empty.png": "an empty file",
      "/shots/large.png": "more than 5242880 bytes of images in all",
      "/shots/grew.png": "the read failed, or the file changed after the lookup",
      "/shots/now-text.png": "the read failed, or the file changed after the lookup",
    },
  });
});

test("a file named __proto__ keeps its reason, and bytes of a failed read count", async () => {
  const { value } = await shownImages({ "itx/images": ["__proto__"] }, list, read);
  expect(Object.entries(Object(value)["itx/images-left-out"])).toEqual([
    ["__proto__", "no such file"],
  ]);
  // the file that grew used the 5 MiB up: the good file after it does not come
  const after = await shownImages(
    { "itx/images": ["/shots/grew.png", "/shots/a.png"] },
    list,
    read,
  );
  expect(after).toMatchObject({ images: [] });
});

test("a lookup that answers other rows than were asked for leaves every file out", async () => {
  const { images, value } = await shownImages(
    { "itx/images": ["/shots/a.png"] },
    async () => [
      { path: "/shots/a.png", contentType: "image/png", size: 3, url: "signed:/shots/a.png" },
      { path: "/shots/b.jpg", contentType: "image/jpeg", size: 2, url: "signed:/shots/b.jpg" },
    ],
    read,
  );
  expect(images).toEqual([]);
  expect(value).toMatchObject({
    "itx/images-left-out": { "/shots/a.png": "the lookup failed" },
  });
});

test("a link that the reader throws on leaves that file out", async () => {
  const { images, value } = await shownImages({ "itx/images": ["/shots/a.png"] }, list, () => {
    throw new TypeError("Invalid URL");
  });
  expect(images).toEqual([]);
  expect(value).toMatchObject({
    "itx/images-left-out": {
      "/shots/a.png": "the read failed, or the file changed after the lookup",
    },
  });
});

test("a path named twice is looked up once, and a path of more than 1,024 characters is not looked up", async () => {
  const long = `/shots/${"x".repeat(1024)}.png`;
  const lookedUp: string[] = [];
  const { images, value } = await shownImages(
    { "itx/images": ["/shots/a.png", "/shots/a.png", long] },
    (asked) => {
      lookedUp.push(...asked);
      return list(asked);
    },
    read,
  );
  expect(lookedUp).toEqual(["/shots/a.png"]);
  expect(images).toHaveLength(1);
  expect(value).toMatchObject({
    "itx/images-left-out": {
      [`${long.slice(0, 64)}…`]: "a path of more than 1024 characters",
    },
  });
});

test("a file whose Content-Length is past what is left is not read, and the bytes of a stream that breaks count", async () => {
  const lookup = async (paths: string[]) =>
    paths.map((path) => ({ path, contentType: "image/png", size: 3, url: path }));
  // as R2 answers: with its length. Nothing of it is read, so the file after it still comes.
  const tooLong = await shownImages(
    { "itx/images": ["/shots/long.png", "/shots/a.png"] },
    lookup,
    async (url) =>
      url === "/shots/long.png"
        ? new Response(new Uint8Array(3), {
            headers: { "content-type": "image/png", "content-length": "6000000" },
          })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
  );
  expect(tooLong).toMatchObject({
    images: [{ type: "image", mimeType: "image/png", data: "AQID" }],
  });
  // a stream that gives 5 MiB and then breaks used the 5 MiB up
  let gave = false;
  const broke = await shownImages(
    { "itx/images": ["/shots/breaks.png", "/shots/a.png"] },
    lookup,
    async (url) =>
      new Response(
        url === "/shots/breaks.png"
          ? new ReadableStream({
              pull(controller) {
                // the first pull gives 5 MiB, the second one breaks
                if (gave) controller.error(new Error("the stream broke"));
                else controller.enqueue(new Uint8Array(5 * 1024 * 1024));
                gave = true;
              },
            })
          : new Uint8Array([1, 2, 3]),
        { headers: { "content-type": "image/png" } },
      ),
  );
  expect(broke).toMatchObject({
    images: [],
    value: {
      "itx/images-left-out": {
        "/shots/breaks.png": "the read failed, or the file changed after the lookup",
        "/shots/a.png": "more than 5242880 bytes of images in all",
      },
    },
  });
});

test("at most 8 files are looked up", async () => {
  const paths = Array.from({ length: 10 }, (_, index) => `/shots/missing-${index}.png`);
  const lookedUp: string[] = [];
  const { images, value } = await shownImages(
    { "itx/images": paths },
    (asked) => {
      lookedUp.push(...asked);
      return list(asked);
    },
    read,
  );
  expect(images).toEqual([]);
  expect(lookedUp).toEqual(paths.slice(0, 8));
  expect(value).toMatchObject({
    "itx/images-left-out": {
      "(2 more paths)": "not looked up: at most 8 files",
    },
  });
});

test("a lookup that fails leaves every file out", async () => {
  const { images, value } = await shownImages(
    { "itx/images": ["/shots/a.png"] },
    () => Promise.reject(new Error("the run failed")),
    read,
  );
  expect(images).toEqual([]);
  expect(value).toMatchObject({
    "itx/images-left-out": { "/shots/a.png": "the lookup failed" },
  });
});

// What the lookup script answers, and what a signed link answers.
const files: Record<
  string,
  { contentType: string; size: number; bytes: Uint8Array; readAs?: string }
> = {
  "/shots/a.png": { contentType: "image/png", size: 3, bytes: new Uint8Array([1, 2, 3]) },
  "/shots/b.jpg": {
    contentType: "IMAGE/JPEG; charset=binary",
    size: 2,
    bytes: new Uint8Array([4, 5]),
  },
  "/notes/c.md": { contentType: "text/markdown", size: 1, bytes: new Uint8Array([6]) },
  "/shots/drawing.svg": { contentType: "image/svg+xml", size: 1, bytes: new Uint8Array([7]) },
  "/shots/empty.png": { contentType: "image/png", size: 0, bytes: new Uint8Array() },
  "/shots/large.png": { contentType: "image/png", size: 5 * 1024 * 1024, bytes: new Uint8Array() },
  // its size was 3 at the lookup, and it is past the limit at the read
  "/shots/grew.png": {
    contentType: "image/png",
    size: 3,
    bytes: new Uint8Array(5 * 1024 * 1024 + 1),
  },
  // an image at the lookup, text at the read
  "/shots/now-text.png": {
    contentType: "image/png",
    size: 3,
    bytes: new Uint8Array([8, 9, 10]),
    readAs: "text/plain",
  },
};
const list = async (paths: string[]) =>
  paths.map((path) =>
    Object.hasOwn(files, path)
      ? {
          path,
          contentType: files[path].contentType,
          size: files[path].size,
          url: `signed:${path}`,
        }
      : { path, error: "no such file" },
  );
const read = async (url: string) => {
  const file = files[url.slice("signed:".length)];
  // no content-length, as a stream has none: the read itself must stop
  return new Response(new Blob([file.bytes]).stream(), {
    headers: { "content-type": file.readAs || file.contentType },
  });
};
