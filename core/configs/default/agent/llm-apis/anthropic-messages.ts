// llm-apis/anthropic-messages.ts — ANTHROPIC'S MESSAGES API
// (https://docs.anthropic.com/en/api/messages-streaming), through the mind's AI Gateway or straight
// to a server that speaks it (`baseUrl`, with an `x-api-key` header that names a secret).
//
// Three things are this API's own. The conversation is turns: neighbours of one role are one
// message, so a response's script result joins the user message after it. The prompt cache is
// read up to a marked block and written from there, so the instructions and the newest block are
// marked (https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching). And cached tokens are
// counted beside `input_tokens`, where `LlmUsage.inputTokens` is all of them.

import { z } from "zod";
import type { LlmUsage } from "../llm-request.ts";
import { modelNameOf, ownItemsOf, streamFailure, type LlmApi } from "../llm-api.ts";

/** The images it takes; a PDF is a document. */
const IMAGES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export const anthropicMessages: LlmApi = {
  name: "anthropic-messages",
  // the model is named in the body on every route
  direct: {
    path: () => "/messages",
    modelInBody: false,
    headers: { "anthropic-version": "2023-06-01" },
  },
  filePart({ contentType }, base64) {
    const source = { type: "base64", media_type: contentType, data: base64 };
    if (IMAGES.includes(contentType)) return { type: "image", source };
    return contentType === "application/pdf" ? { type: "document", source } : null;
  },

  body({ model, instructions, items, reasoningEffort, maxOutputTokens }) {
    const messages: { role: "user" | "assistant"; content: unknown[] }[] = [];
    const add = (role: "user" | "assistant", blocks: unknown[]) => {
      const last = messages.at(-1);
      if (last?.role === role) last.content.push(...blocks);
      else if (blocks.length > 0) messages.push({ role, content: [...blocks] });
    };
    for (const item of items) {
      if (item.tag !== "llm-response") {
        // images and documents before the words, as Anthropic asks
        add("user", [...item.parts, { type: "text", text: item.text }]);
      } else
        add(
          "assistant",
          ownItemsOf(item, model) ?? (item.text ? [{ type: "text", text: item.text }] : []),
        );
    }
    if (messages[0]?.role !== "user")
      messages.unshift({ role: "user", content: [{ type: "text", text: "(start)" }] });
    const newest = messages.at(-1)?.content;
    if (newest) newest.push({ ...Object(newest.pop()), ...EPHEMERAL });
    const thinkingTokens = reasoningEffort ? (THINKING_TOKENS[reasoningEffort] ?? 4_096) : 0;
    const bodyWithoutInput = {
      model: modelNameOf(model),
      stream: true,
      // Anthropic refuses a request with no limit
      max_tokens: (maxOutputTokens ?? 8_192) + thinkingTokens,
      system: [{ type: "text", text: instructions, ...EPHEMERAL }],
      ...(thinkingTokens > 0 && { thinking: { type: "enabled", budget_tokens: thinkingTokens } }),
    };
    return { bodyWithoutInput, inputField: "messages", input: messages };
  },

  read(response, event) {
    const e = MessagesEvent.parse(event);
    const block = e.index === undefined ? undefined : response.providerItems[e.index];
    if (e.type === "message_start") response.usage = usageOf(e.message?.usage || {});
    else if (e.type === "content_block_start" && e.index !== undefined && e.content_block) {
      response.providerItems[e.index] = { ...e.content_block };
      // a redacted thinking block gives no words: the model reasons all the same
      response.isThinking = THINKING_BLOCKS.includes(e.content_block.type);
    } else if (e.type === "content_block_stop" && block && THINKING_BLOCKS.includes(block.type))
      response.isThinking = false;
    else if (e.type === "content_block_delta" && block && e.delta) {
      const { text, thinking, signature } = e.delta;
      if (text) block.text = `${String(block.text ?? "")}${text}`;
      if (thinking) block.thinking = `${String(block.thinking ?? "")}${thinking}`;
      if (signature) block.signature = signature;
      response.text += text || "";
      response.thinking += thinking || "";
    } else if (e.type === "message_delta" && response.usage && e.usage?.output_tokens != null)
      response.usage.outputTokens = e.usage.output_tokens;
    else if (e.type === "message_stop") {
      response.isThinking = false;
      response.done = true;
    } else if (e.type === "error") throw streamFailure(e.error?.message);
  },
};

const THINKING_BLOCKS: unknown[] = ["thinking", "redacted_thinking"];
const THINKING_TOKENS: Record<string, number> = { low: 2_048, medium: 8_192, high: 24_576 };
const EPHEMERAL = { cache_control: { type: "ephemeral" } };

const Usage = z
  .looseObject({
    input_tokens: z.number().nullable(),
    output_tokens: z.number().nullable(),
    cache_read_input_tokens: z.number().nullable(),
    cache_creation_input_tokens: z.number().nullable(),
  })
  .partial();

const MessagesEvent = z.looseObject({
  type: z.string(),
  index: z.number().optional(),
  message: z.looseObject({ usage: Usage.optional() }).optional(),
  content_block: z.looseObject({ type: z.string() }).optional(),
  delta: z
    .looseObject({
      text: z.string(),
      thinking: z.string(),
      signature: z.string(),
    })
    .partial()
    .optional(),
  usage: Usage.optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

function usageOf(usage: z.infer<typeof Usage>): LlmUsage {
  const read = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (usage.input_tokens ?? 0) + read + written,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: read,
    cacheWriteInputTokens: written,
  };
}
