// llm-apis/chat-completions.ts — THE OLD-SCHOOL CHAT COMPLETIONS API, which most servers speak:
// xAI's Grok through the mind's AI Gateway (`xai/grok-4.3`, unified billing; Cloudflare's model page,
// read 22 November 2026: https://developers.cloudflare.com/ai/models/xai/grok-4.3/), and any server
// of its own with a `baseUrl` (vLLM, Ollama, llama.cpp, an inference box in a basement):
//
//   agent/configured { config: { llmProviders: { basement: { api: "chat-completions",
//     baseUrl: "https://llm.example/v1" } } } }          then the model `basement/llama-5`
//
// This is also the shortest whole API shape: three functions, and where its requests go.

import { z } from "zod";
import { ownItemsOf, streamFailure, type LlmApi } from "../llm-api.ts";

export const chatCompletions: LlmApi = {
  name: "chat-completions",
  direct: { path: () => "/chat/completions", modelInBody: true },

  /** PNG and JPEG only, the types xAI takes. A PDF is a line: a `file` part on servers that speak
   *  Chat Completions is not confirmed (v3/files-research.md, section 2). */
  filePart({ contentType }, base64) {
    if (contentType !== "image/png" && contentType !== "image/jpeg") return null;
    return {
      type: "image_url",
      image_url: { url: `data:${contentType};base64,${base64}`, detail: "auto" },
    };
  },

  /** The instructions are the first message; every other item is a user message, but a response,
   *  which is the assistant's. No cache key: the gateway refuses a field it does not list for the model,
   *  `prompt_cache_key` among them for xAI (HTTP 400, code 7003, on a real mind on 22 November
   *  2026). A server caches the start of a prompt on its own. */
  body({ model, instructions, items, reasoningEffort, maxOutputTokens }) {
    const conversation = items.flatMap((item): unknown[] => {
      if (item.tag !== "llm-response") {
        const { parts, text } = item;
        const content = parts.length > 0 ? [...parts, { type: "text", text }] : text;
        return [{ role: "user", content }];
      }
      if (!item.text) return [];
      return ownItemsOf(item, model) ?? [{ role: "assistant", content: item.text }];
    });
    const bodyWithoutInput = {
      stream: true,
      stream_options: { include_usage: true },
      // oxlint-disable-next-line iterate/simple-truthiness-check -- the provider's body: an absent field is the provider's default, and it takes no null
      ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
      // oxlint-disable-next-line iterate/simple-truthiness-check -- the provider's body: an absent field is the provider's default, and it takes no null
      ...(maxOutputTokens && { max_completion_tokens: maxOutputTokens }),
    };
    const input = [{ role: "system", content: instructions }, ...conversation];
    return { bodyWithoutInput, inputField: "messages", input };
  },

  /** One chunk of the stream. The assistant message is built in `providerItems[0]`: that is what
   *  the model is given back in later requests. */
  read(response, event) {
    const chunk = Chunk.parse(event);
    if (chunk.error) throw streamFailure(chunk.error.message);
    const message = (response.providerItems[0] ??= { role: "assistant", content: "" });
    const [choice] = chunk.choices || [];
    const { content, reasoning_content: reasoning } = choice?.delta || {};
    response.text += content || "";
    response.thinking += reasoning || "";
    // the model reasons while the chunks carry its reasoning, until its first words or its end
    if (reasoning) response.isThinking = true;
    if (content || choice?.finish_reason) response.isThinking = false;
    message.content = response.text;
    if (choice?.finish_reason) response.done = true;
    // the last chunk carries the counts; reasoning is counted beside `completion_tokens`
    const usage = chunk.usage;
    if (usage) {
      const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
      response.usage = {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens + reasoning,
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        reasoningOutputTokens: reasoning,
      };
    }
  },
};

const Chunk = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        delta: z
          .looseObject({
            content: z.string().nullish(),
            reasoning_content: z.string().nullish(),
          })
          .optional(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
  usage: z
    .looseObject({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      prompt_tokens_details: z.looseObject({ cached_tokens: z.number().optional() }).optional(),
      completion_tokens_details: z
        .looseObject({ reasoning_tokens: z.number().optional() })
        .optional(),
    })
    .nullish(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});
