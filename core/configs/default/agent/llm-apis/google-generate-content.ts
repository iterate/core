// llm-apis/google-generate-content.ts — GOOGLE'S generateContent
// (https://ai.google.dev/api/generate-content), through the mind's AI Gateway or straight to a
// server that speaks it (`baseUrl`).
//
// Two things are this API's own. Through the gateway it answers one JSON object, not a stream
// (measured 21 November 2026), so the whole answer is one event here. And a model's own parts are
// given back with their thought signatures; a thought with no signature is not given back.

import { z } from "zod";
import { ownItemsOf, streamFailure, type LlmApi } from "../llm-api.ts";

/** Images and a PDF, each as `inline_data`. (Google takes audio and video too; they are lines for
 *  now: v3/files-research.md, section 3.) */
const INLINED = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"];

export const googleGenerateContent: LlmApi = {
  name: "google-generate-content",
  // straight to a server, the model is named in the path
  direct: { path: (modelName) => `/models/${modelName}:generateContent`, modelInBody: false },

  filePart: ({ contentType }, base64) =>
    INLINED.includes(contentType)
      ? { inline_data: { mime_type: contentType, data: base64 } }
      : null,

  body({ model, instructions, items, reasoningEffort, maxOutputTokens }) {
    const contents: { role: "user" | "model"; parts: unknown[] }[] = [];
    const add = (role: "user" | "model", parts: unknown[]) => {
      const last = contents.at(-1);
      if (last?.role === role) last.parts.push(...parts);
      else if (parts.length > 0) contents.push({ role, parts: [...parts] });
    };
    for (const item of items)
      if (item.tag !== "llm-response") {
        add("user", [...item.parts, { text: item.text }]);
      } else add("model", ownItemsOf(item, model) ?? (item.text ? [{ text: item.text }] : []));
    const generationConfig = {
      // oxlint-disable-next-line iterate/simple-truthiness-check -- the provider's body: an absent field is the provider's default, and it takes no null
      ...(maxOutputTokens && { maxOutputTokens }),
      ...(reasoningEffort && { thinkingConfig: { thinkingLevel: reasoningEffort } }),
    };
    const bodyWithoutInput = {
      systemInstruction: { parts: [{ text: instructions }] },
      ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
    };
    return { bodyWithoutInput, inputField: "contents", input: contents };
  },

  read(response, event) {
    const e = GenerateContentEvent.parse(event);
    if (e.error) throw streamFailure(e.error.message);
    const candidate = e.candidates?.[0];
    for (const part of candidate?.content?.parts || []) {
      response.isThinking = part.thought === true;
      if (part.thought && !part.thoughtSignature) {
        response.thinking += part.text || "";
        continue;
      }
      response.providerItems.push(part);
      if (!part.thought) response.text += part.text || "";
    }
    const usage = e.usageMetadata;
    if (usage) {
      const thoughts = usage.thoughtsTokenCount ?? 0;
      response.usage = {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: (usage.candidatesTokenCount ?? 0) + thoughts,
        cachedInputTokens: usage.cachedContentTokenCount ?? 0,
        reasoningOutputTokens: thoughts,
      };
    }
    if (candidate?.finishReason) {
      response.isThinking = false;
      response.done = true;
    }
  },
};

const GenerateContentEvent = z.looseObject({
  candidates: z
    .array(
      z.looseObject({
        content: z
          .looseObject({
            parts: z
              .array(
                z.looseObject({
                  text: z.string().optional(),
                  thought: z.boolean().optional(),
                  thoughtSignature: z.string().optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .looseObject({
      promptTokenCount: z.number(),
      cachedContentTokenCount: z.number(),
      candidatesTokenCount: z.number(),
      thoughtsTokenCount: z.number(),
    })
    .partial()
    .optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});
