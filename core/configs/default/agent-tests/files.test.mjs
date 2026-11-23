// files.test.mjs: FILES FOR EVERY PROVIDER. A request maker reads the bytes of a file when it sends,
// and each API shape's `filePart` gives the provider's own part for an image or a PDF. A file that
// is not shown is one line that says why. On the in-memory log with a fake `itx`: the model is a
// function, and `itx.files` is a map of bytes. Nothing here reaches a real provider.
//
// Run from the config's root: node --test "agent-tests/*.test.mjs"

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { MAX_INLINE_FILE_BYTES } from "../agent/llm-api.ts";

import { agentOnALog, anthropic, google, openai, sha256, xai } from "./test-support.mjs";

/** The four API shapes: a model of each, its fake answer (silence), and the user message's content
 *  of the newest input in its body. */
const SHAPES = {
  "openai-responses": {
    model: "openai/gpt-6.2-sol",
    answer: () => openai({}),
    content: (body) => body.input.at(-1).content,
  },
  "anthropic-messages": {
    model: "anthropic/claude-opus-5-5",
    answer: () => anthropic({}),
    content: (body) => body.messages.at(-1).content,
  },
  "google-generate-content": {
    model: "google/gemini-3-pro",
    answer: () => google({}),
    content: (body) => body.contents.at(-1).parts,
  },
  "chat-completions": {
    model: "xai/grok-4.3",
    answer: () => xai({}),
    content: (body) => body.messages.at(-1).content,
  },
};

const ALL = Object.keys(SHAPES);

/** A file of `size` bytes, and its reference (`claimed` is the size the reference says). */
function fileOf(name, contentType, size = 11, claimed = size) {
  const bytes = Uint8Array.from({ length: size }, (_, at) => (at * 7 + name.length) % 256);
  const reference = {
    contentType,
    filename: name,
    path: `/agents/test/${name}`,
    size: claimed,
  };
  const sha = createHash("sha256").update(bytes).digest("hex");
  return { reference, bytes, base64: Buffer.from(bytes).toString("base64"), sha };
}

/** An agent of one API shape whose `itx.files` holds `files`; `reads` lists each path it read. */
function agentWith(shape, files) {
  const store = new Map(files.map((file) => [file.reference.path, file.bytes]));
  const reads = [];
  const { model, answer } = SHAPES[shape];
  const roots = {
    files: {
      get: (path) => ({
        bytes: async () => {
          reads.push(path);
          const bytes = store.get(path);
          if (!bytes) throw new Error(`${path}: no such file`);
          return bytes;
        },
      }),
    },
  };
  const agent = agentOnALog({ model: answer, roots, config: { llm: { model } } });
  return { agent, reads };
}

/** One input with `files`, the content of its user message in the body that was sent, and the
 *  paths that were read. */
async function sent(shape, files, stored = files) {
  const { agent, reads } = agentWith(shape, stored);
  await agent.say("see these", { files: files.map((file) => file.reference) });
  return { content: SHAPES[shape].content(agent.calls[0].body), reads };
}

const notShown = (file, reason) =>
  `[file ${file.reference.filename} (${file.reference.contentType}, ${file.reference.size} bytes) is not shown: ${reason}]`;
const dataUrl = (file) => `data:${file.reference.contentType};base64,${file.base64}`;
/** The words as each shape writes its last text part (Anthropic marks the newest block). */
const words = (shape, text) =>
  ({
    "openai-responses": { type: "input_text", text },
    "anthropic-messages": { type: "text", text, cache_control: { type: "ephemeral" } },
    "google-generate-content": { text },
    "chat-completions": { type: "text", text },
  })[shape];

test("a PNG and a PDF: the provider's own part in each API shape, in the request at once, before the words", async () => {
  const png = fileOf("map.png", "image/png");
  const pdf = fileOf("plan.pdf", "application/pdf");
  const parts = {
    "openai-responses": [
      { type: "input_image", image_url: dataUrl(png), detail: "auto" },
      { type: "input_file", filename: "plan.pdf", file_data: dataUrl(pdf) },
    ],
    "anthropic-messages": [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.base64 } },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
      },
    ],
    "google-generate-content": [
      { inline_data: { mime_type: "image/png", data: png.base64 } },
      { inline_data: { mime_type: "application/pdf", data: pdf.base64 } },
    ],
    // xAI takes PNG and JPEG only: a PDF is the line
    "chat-completions": [
      { type: "image_url", image_url: { url: dataUrl(png), detail: "auto" } },
      null,
    ],
  };
  for (const shape of ALL) {
    const [image, document] = parts[shape];
    const { content } = await sent(shape, [png, pdf]);
    const text = document
      ? "see these"
      : `see these\n${notShown(pdf, "this model's API takes no such type")}`;
    assert.deepEqual(content, [image, ...(document ? [document] : []), words(shape, text)], shape);
  }
});

test("a type the API does not take, a file over the limit, and a file that cannot be read: each is the line with its reason, and the request goes out", async () => {
  const docx = fileOf(
    "memo.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  const big = fileOf("big.png", "image/png", 11, MAX_INLINE_FILE_BYTES + 1);
  const gone = fileOf("gone.png", "image/png");
  const kept = fileOf("kept.png", "image/png");
  for (const shape of ALL) {
    const { content, reads } = await sent(shape, [docx, big, gone, kept], [docx, big, kept]);
    const lines = [
      notShown(docx, "this model's API takes no such type"),
      notShown(big, `it is larger than the limit of ${MAX_INLINE_FILE_BYTES} bytes`),
      notShown(gone, "it could not be read"),
    ];
    // the one file shown is the kept one; the words name the three others
    assert.equal(content.length, 2, shape);
    assert.ok(JSON.stringify(content[0]).includes(kept.base64), shape);
    assert.deepEqual(content[1], words(shape, ["see these", ...lines].join("\n")), shape);
    // a type it takes not and a file over the limit are never read
    assert.deepEqual(reads, [gone.reference.path, kept.reference.path], shape);
  }
});

test("a second request with one more file begins with the bytes of the first", async () => {
  const [a, b] = ["a.png", "b.png"].map((name) => fileOf(name, "image/png"));
  const { agent } = agentWith("openai-responses", [a, b]);
  await agent.say("first", { files: [a.reference] });
  await agent.say("second", { files: [b.reference] });
  const [first, second] = agent.calls.map((call) => JSON.stringify(call.body.input));
  assert.ok(second.startsWith(`${first.slice(0, -1)},`), "the first conversation is a prefix");
  assert.deepEqual(SHAPES["openai-responses"].content(agent.calls[1].body), [
    { type: "input_image", image_url: dataUrl(b), detail: "auto" },
    words("openai-responses", "second"),
  ]);
});

test("`request-started` holds `$file:<path>:<sha256>` where the base64 was, and no base64; its hash is the real body's", async () => {
  const png = fileOf("map.png", "image/png");
  const pdf = fileOf("plan.pdf", "application/pdf");
  for (const shape of ALL) {
    const { agent } = agentWith(shape, [png, pdf]);
    await agent.say("see these", { files: [png.reference, pdf.reference] });
    const [fact] = agent.durable(`events.iterate.com/${shape}/request-started`);
    const stored = JSON.stringify(fact.payload);
    for (const file of [png, pdf]) assert.ok(!stored.includes(file.base64), shape);
    const marker = (file) => `$file:${file.reference.path}:${file.sha}`;
    assert.ok(stored.includes(marker(png)), shape);
    // the stored body is the real body with the marker in place of each file's base64
    const body = agent.calls[0].body;
    const payload = fact.payload;
    const rebuilt = { ...payload.bodyWithoutInput, [payload.inputField]: payload.inputItemsAdded };
    let real = JSON.stringify(rebuilt).replaceAll(marker(png), png.base64);
    if (shape !== "chat-completions") real = real.replaceAll(marker(pdf), pdf.base64);
    assert.equal(real, JSON.stringify(body), shape);
    assert.equal(payload.bodySha256, sha256(JSON.stringify(body)), shape);
  }
});

test("`attempt-started` names `inputFileBytes`: the bytes of the files it inlined", async () => {
  const png = fileOf("map.png", "image/png", 11);
  const pdf = fileOf("plan.pdf", "application/pdf", 4);
  const { agent } = agentWith("google-generate-content", [png, pdf]);
  await agent.say("see these", { files: [png.reference, pdf.reference] });
  await agent.say("no file");
  const started = agent.durable("events.iterate.com/llm-request/attempt-started");
  // the second request sends the first input's files again
  assert.deepEqual(
    started.map((fact) => fact.payload?.inputFileBytes),
    [11 + 4, 11 + 4],
  );
  assert.deepEqual(agent.invalidFacts(), []);
});
