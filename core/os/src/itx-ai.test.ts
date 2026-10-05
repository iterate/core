// itx-ai.test.ts — what `ItxAi` makes plain for a call across RPC (itx-ai.ts): a file's bytes or text
// into the Blob `toMarkdown` takes, and the Response `websearch` and a gateway's `run` answer into
// its body, each bounded. Cloudflare's binding cannot be dialed from the unit suite, so a fake records
// what it was handed. `run` and `models` pass straight through and are not tested here.

import { expect, test } from "vitest";
import type { ItxMarkdownDocument } from "iterate/api";
import { settle } from "./context/test-support.ts";
import {
  ANSWER_MAX_BYTES,
  ItxAiGatewayTarget,
  ItxToMarkdown,
  TO_MARKDOWN_MAX_BYTES,
  websearch,
} from "./itx-ai.ts";

test.for([
  {
    name: "bytes, one file answering one result",
    files: { name: "invoice.pdf", blob: new TextEncoder().encode("%PDF-1.7") },
    sent: [{ name: "invoice.pdf", text: "%PDF-1.7", type: "application/octet-stream" }],
    answer: { name: "invoice.pdf", format: "markdown", data: "md:invoice.pdf" },
  },
  {
    name: "an ArrayBuffer",
    files: { name: "a.xlsx", blob: new Uint8Array([0x50, 0x4b]).buffer },
    sent: [{ name: "a.xlsx", text: "PK", type: "application/octet-stream" }],
    answer: { name: "a.xlsx", data: "md:a.xlsx" },
  },
  {
    name: "a text, as UTF-8 with its type",
    files: { name: "page.html", blob: "<p>café</p>", type: "text/html" },
    sent: [{ name: "page.html", text: "<p>café</p>", type: "text/html" }],
    answer: { name: "page.html", data: "md:page.html" },
  },
  {
    name: "base64 data",
    files: { name: "rows.csv", data: btoa("a,b\n1,2") },
    sent: [{ name: "rows.csv", text: "a,b\n1,2", type: "application/octet-stream" }],
    answer: { name: "rows.csv", data: "md:rows.csv" },
  },
  {
    name: "a list answering a list",
    files: [
      { name: "a.csv", blob: "x" },
      { name: "b.csv", data: btoa("y") },
    ],
    sent: [
      { name: "a.csv", text: "x", type: "application/octet-stream" },
      { name: "b.csv", text: "y", type: "application/octet-stream" },
    ],
    answer: [
      { name: "a.csv", data: "md:a.csv" },
      { name: "b.csv", data: "md:b.csv" },
    ],
  },
])("toMarkdown sends $name to the binding as Blobs", async ({ files, sent, answer }) => {
  const ai = fakeAi();
  const options = { conversionOptions: { pdf: { metadata: false } } };
  const result = await new ItxToMarkdown(ai).transform(files, options);
  expect({ result, sent: await ai.sent(), options: ai.options }).toMatchObject({
    result: answer,
    sent,
    options,
  });
});

test.for([
  { name: "a file with no name", files: untyped({ blob: "x" }) },
  { name: "a number for the bytes", files: untyped({ name: "a.pdf", blob: 5 }) },
  { name: "data that is not base64", files: { name: "a.pdf", data: "not base64!" } },
  {
    name: "files over the bound together",
    files: [
      { name: "a.pdf", blob: new Uint8Array(TO_MARKDOWN_MAX_BYTES) },
      { name: "b.csv", blob: "x" },
    ],
  },
  {
    name: "base64 over the bound",
    files: { name: "a.pdf", data: "A".repeat((TO_MARKDOWN_MAX_BYTES / 3) * 4 + 4) },
  },
  // Under the bound in characters, over it in UTF-8: each "é" is two bytes.
  {
    name: "a text over the bound",
    files: { name: "a.html", blob: "é".repeat(TO_MARKDOWN_MAX_BYTES / 2 + 1) },
  },
])("toMarkdown refuses $name before the binding sees it", async ({ files }) => {
  const ai = fakeAi();
  const outcome = await settle(() => new ItxToMarkdown(ai).transform(files));
  expect({ ...outcome, sent: await ai.sent() }).toMatchObject({
    error: { code: "INVALID_INPUT", message: expect.stringMatching(/^toMarkdown/) },
    sent: [],
  });
});

test("toMarkdown().supported() is the binding's list", async () => {
  expect(await new ItxToMarkdown(fakeAi()).supported()).toMatchObject([
    { extension: ".pdf", mimeType: "application/pdf" },
  ]);
});

test.for([
  {
    name: "the JSON answer, whole",
    answer: () =>
      Response.json({
        items: [{ url: "https://example.com/stone", title: "Bath stone", description: "Oolitic" }],
        metadata: { query: "bath stone", requestId: "req-1", latencyMs: 612 },
      }),
    expected: {
      value: {
        items: [{ url: "https://example.com/stone", title: "Bath stone", description: "Oolitic" }],
        metadata: { query: "bath stone", requestId: "req-1", latencyMs: 612 },
      },
    },
  },
  {
    name: "a 400 as the request's refusal, with the body",
    answer: () => new Response("gateway has no credits", { status: 400 }),
    expected: {
      error: {
        code: "INVALID_INPUT",
        data: { status: 400 },
        message: "Web Search answered HTTP 400: gateway has no credits",
      },
    },
  },
  {
    name: "a 429 as an overload",
    answer: () => new Response("slow down", { status: 429 }),
    expected: { error: { code: "UNAVAILABLE", data: { kind: "overloaded" } } },
  },
  {
    name: "a 502 as a lost connection",
    answer: () => new Response("bad gateway", { status: 502 }),
    expected: { error: { code: "UNAVAILABLE", data: { kind: "disconnected" } } },
  },
])("websearch answers $name", async ({ answer, expected }) => {
  const request = { gatewayId: "default", query: "bath stone", provider: "exa", limit: 3 };
  const seen: unknown[] = [];
  const ai = {
    websearch: async (r: AiWebSearchRequest) => {
      seen.push(r);
      return answer();
    },
  };
  expect({ ...(await settle(() => websearch(ai, request))), seen }).toMatchObject({
    ...expected,
    seen: [request],
  });
});

test.for([
  {
    name: "a JSON body parsed",
    answer: () => Response.json({ choices: [{ message: { content: "hi" } }] }),
    expected: { value: { choices: [{ message: { content: "hi" } }] } },
  },
  {
    name: "a text body as a string",
    answer: () =>
      new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }),
    expected: { value: "data: {}\n\n" },
  },
  {
    name: "any other body as bytes",
    answer: () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
    expected: { value: new Uint8Array([1, 2, 3]) },
  },
  {
    name: "a 401 as the request's refusal",
    answer: () => new Response('{"error":"unauthorized"}', { status: 401 }),
    expected: {
      error: {
        code: "INVALID_INPUT",
        message: 'AI Gateway run answered HTTP 401: {"error":"unauthorized"}',
      },
    },
  },
])("a gateway's run answers $name", async ({ answer, expected }) => {
  const gateway = fakeGateway(answer);
  expect(await settle(() => gateway.target.run(UNIVERSAL_REQUEST))).toMatchObject(expected);
});

test("a gateway's run stops reading an answer past the bound and refuses it", async () => {
  const body = { cancelled: false };
  const gateway = fakeGateway(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(ANSWER_MAX_BYTES / 4));
          },
          cancel() {
            body.cancelled = true;
          },
        }),
      ),
  );
  expect({ ...(await settle(() => gateway.target.run(UNIVERSAL_REQUEST))), body }).toMatchObject({
    error: { code: "INVALID_INPUT", message: expect.stringMatching(/more than one call carries/) },
    body: { cancelled: true },
  });
});

test("a gateway's getLog of an id it holds no log for is refused, coded", async () => {
  const gateway = fakeGateway(() => Response.json({}));
  expect(await settle(() => gateway.target.getLog("01J0NONE"))).toMatchObject({
    error: { code: "INVALID_INPUT", message: "AI Gateway has no log 01J0NONE: Log not found" },
  });
});

test("a gateway's getLog, patchLog and getUrl are the binding's", async () => {
  const gateway = fakeGateway(() => Response.json({}));
  const answers = [
    await gateway.target.getLog("01J0LOG"),
    await gateway.target.patchLog("01J0LOG", { feedback: 1 }),
    await gateway.target.getUrl("openai"),
  ];
  expect({ answers, calls: gateway.calls }).toMatchObject({
    answers: [{ id: "01J0LOG" }, undefined, "https://gateway.ai.cloudflare.com/v1/acct/g/openai"],
    calls: [
      ["getLog", "01J0LOG"],
      ["patchLog", "01J0LOG", { feedback: 1 }],
      ["getUrl", "openai"],
    ],
  });
});

const UNIVERSAL_REQUEST = {
  provider: "openai",
  endpoint: "chat/completions",
  headers: {},
  query: { model: "gpt-x" },
};

/** The binding's `toMarkdown`, answering each file with `md:<name>` and recording the Blobs. */
function fakeAi() {
  const files: { name: string; blob: Blob }[] = [];
  const fake = {
    options: undefined as ConversionRequestOptions | undefined,
    async sent() {
      return Promise.all(
        files.map(async ({ name, blob }) => ({ name, text: await blob.text(), type: blob.type })),
      );
    },
    toMarkdown(documents?: { name: string; blob: Blob }[], options?: ConversionRequestOptions) {
      if (!documents)
        return { supported: async () => [{ extension: ".pdf", mimeType: "application/pdf" }] };
      files.push(...documents);
      fake.options = options;
      return Promise.resolve(
        documents.map(({ name, blob }, i) => ({
          id: String(i),
          name,
          mimeType: blob.type,
          format: "markdown",
          tokens: 1,
          data: `md:${name}`,
        })),
      );
    },
  };
  // The binding's `toMarkdown` is overloaded on whether files are passed; one function answers both.
  return fake as typeof fake & Pick<Ai, "toMarkdown">;
}

/** The binding's `AiGateway`, answering `run` with `answer()` and recording every call. */
function fakeGateway(answer: () => Response) {
  const calls: unknown[][] = [];
  const gateway = {
    getLog: async (logId: string) => {
      calls.push(["getLog", logId]);
      if (logId === "01J0NONE")
        throw Object.assign(new Error("Log not found"), { name: "AiGatewayLogNotFound" });
      return { id: logId };
    },
    patchLog: async (logId: string, data: AiGatewayPatchLog) => {
      calls.push(["patchLog", logId, data]);
    },
    getUrl: async (provider?: string) => {
      calls.push(["getUrl", provider]);
      return `https://gateway.ai.cloudflare.com/v1/acct/g/${provider}`;
    },
    run: async () => answer(),
  };
  // A log's other fields are Cloudflare's; the target only hands the log back.
  return { calls, target: new ItxAiGatewayTarget(gateway as unknown as AiGateway) };
}

/** A file as a caller across RPC may send it, which no type checks. */
function untyped(value: unknown) {
  return value as ItxMarkdownDocument;
}
