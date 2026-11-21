// file-urls.test.ts — a signed file link, answered in this Worker: what the MCP tool `run` reads a
// script's named images through (../mcp.ts, ../http.ts). The token is the whole authorization.
import { expect, test } from "vitest";
import { serveMindFileRequest, signedFileUrl } from "./file-urls.ts";

test("a link signed for GET answers the file, with its type and its length", async () => {
  const { url } = await sign({ method: "GET" });
  const answer = await serve(new Request(url));
  expect({ status: answer.status, headers: Object.fromEntries(answer.headers) }).toMatchObject({
    status: 200,
    headers: { "content-type": "image/png", "content-length": "3" },
  });
  expect(new Uint8Array(await answer.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
});

test("a link signed for an upload reads nothing and uploads nothing when it is read", async () => {
  const { url } = await sign({ method: "PUT" });
  expect(await serve(new Request(url))).toMatchObject({ status: 403 });
  expect(uploads).toEqual([]);
});

test("an expired link, a link for another file and a link with no or a wrong token are refused", async () => {
  const expired = await sign({ method: "GET", expiresInSeconds: -1 });
  expect(await serve(new Request(expired.url))).toMatchObject({ status: 403 });
  const other = new URL((await sign({ method: "GET" })).url);
  other.pathname = other.pathname.replace("a.png", "b.png");
  expect(await serve(new Request(other))).toMatchObject({ status: 403 });
  const unsigned = new URL((await sign({ method: "GET" })).url);
  unsigned.searchParams.delete("token");
  expect(await serve(new Request(unsigned))).toMatchObject({ status: 400 });
  unsigned.searchParams.set("token", "not-a-token");
  expect(await serve(new Request(unsigned))).toMatchObject({ status: 403 });
});

const secret = "a-test-signing-secret";
const uploads: unknown[] = [];
const sign = (input: { method: "GET" | "PUT"; expiresInSeconds?: number }) =>
  signedFileUrl({
    secret,
    controlPlaneHostname: "iterate.mind.example",
    key: "shots/a.png",
    ...input,
  });
const serve = (request: Request) =>
  serveMindFileRequest({
    // the two verbs the handler calls, for the one file there is
    bucket: {
      get: async (key: string) =>
        key === "shots/a.png"
          ? {
              size: 3,
              httpEtag: '"etag"',
              body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
              writeHttpMetadata: (headers: Headers) => headers.set("content-type", "image/png"),
            }
          : null,
      put: async () => {
        throw new Error("a read uploads nothing");
      },
    } as unknown as R2Bucket,
    secret,
    recordUpload: async (file) => {
      uploads.push(file);
    },
    request,
  });
