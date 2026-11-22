import { expect, test, vi } from "vitest";
import { requestWithOwnedBody } from "./request-body.ts";

test("a request with no body is the same request", () => {
  withIdentityStream();
  const get = new Request("https://example.com/", { method: "GET" });
  const emptyPost = new Request("https://example.com/", { method: "POST" });
  expect(requestWithOwnedBody(get, "test")).toBe(get);
  expect(requestWithOwnedBody(emptyPost, "test")).toBe(emptyPost);
});

test("the body, its method, URL and headers go on", async () => {
  withIdentityStream();
  const request = new Request("https://example.com/statements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
  });
  const owned = requestWithOwnedBody(request, "test");
  expect(owned).not.toBe(request);
  expect({
    method: owned.method,
    url: owned.url,
    type: owned.headers.get("content-type"),
    body: await owned.text(),
  }).toEqual({
    method: "POST",
    url: "https://example.com/statements",
    type: "application/json",
    body: '{"a":1}',
  });
});

test("a body cut off because the answer was sent ends where it was cut, with no error", () =>
  watched(async (info) => {
    const message = "Can't read from request stream after response has been sent.";
    const owned = requestWithOwnedBody(bodyThatFails(message), "test");
    expect(await readAll(owned)).toEqual(["first"]);
    expect(info).toHaveBeenCalledWith({
      event: "request-body-unread",
      where: "test",
      afterAnswer: true,
      message,
    });
  }));

test("any other failure goes on as that error, so a cut upload never looks whole", () =>
  watched(async (info) => {
    const message = "Can't read from request stream because client disconnected.";
    const owned = requestWithOwnedBody(bodyThatFails(message), "test");
    await expect(readAll(owned)).rejects.toThrow(message);
    expect(info).toHaveBeenCalledWith({
      event: "request-body-unread",
      where: "test",
      afterAnswer: false,
      message,
    });
  }));

// Node has no IdentityTransformStream: a TransformStream passes bytes through as it does.
function withIdentityStream() {
  vi.stubGlobal("IdentityTransformStream", TransformStream);
}

// the runtime's request body: its first part, then the error a read meets
function bodyThatFails(message: string) {
  const encoder = new TextEncoder();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls === 1) return controller.enqueue(encoder.encode("first"));
      controller.error(new TypeError(message));
    },
  });
  return new Request("https://example.com/", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
}

// what the other Worker's side reads, as the runtime's pump reads it
async function readAll(request: Request) {
  const reader = request.body!.getReader();
  const parts: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(new TextDecoder().decode(value));
  }
}

// no rejection that nobody handled, whatever the test reads
async function watched(run: (info: ReturnType<typeof vi.spyOn>) => Promise<void>) {
  withIdentityStream();
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    await run(info);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
}
