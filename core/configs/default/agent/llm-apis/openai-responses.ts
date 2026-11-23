// llm-apis/openai-responses.ts — OPENAI'S RESPONSES API (https://platform.openai.com/docs/api-reference/
// responses): through the mind's AI Gateway, straight to a server that speaks it (`baseUrl`), or over
// a WebSocket that stays open between requests, which answers a later request sooner (first event
// after 0.30 to 0.40 s against 0.41 to 0.51 s over HTTP, measured on a real mind on 22 November 2026).
//
// THE WEBSOCKET is this API's own way to its model, configured on the provider:
//   agent/configured { config: { llmProviders: { openai: { api: "openai-responses", webSocket: {
//     url: "https://cloud.iterate.com/ai-ws/openai/responses",
//     authorization: 'Bearer getSecret("/secrets/iterate-cloud")' } } } } }
// The host dials it (facet.ts: the facet's own `fetch`, whose egress swaps the secret in). One
// request rides the socket at a time; a second one at the same time goes the provider's other way.
// Two facts of this API's own say what the socket did: `openai-responses/websocket-connected` when it
// was dialled, `openai-responses/websocket-closed` when it closed. A close while no attempt runs is
// written by the next attempt.

import { z } from "zod";
import {
  LlmRequestFailure,
  modelNameOf,
  ownItemsOf,
  parsedJson,
  streamFailure,
  unlessIdleOrAborted,
  type LlmApi,
  type ProviderEvent,
} from "../llm-api.ts";

/** What a socket's event holds: a message's data, a close's code and reason, an error's message
 *  (Cloudflare's and Node's `MessageEvent`, `CloseEvent` and `ErrorEvent`). */
type SocketEvent = { data?: unknown; code?: number; reason?: string; message?: string };

/** The part of a WebSocket this API uses: Cloudflare's, Node's, or a test's. */
export type ResponsesWebSocket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: SocketEventType, listener: (event: SocketEvent) => void): void;
  removeEventListener(type: SocketEventType, listener: (event: SocketEvent) => void): void;
};
type SocketEventType = "message" | "close" | "error";

export type OpenaiResponsesHost = {
  /** Dials the WebSocket. Absent: every request goes the provider's other way. */
  openWebSocket?: (url: string, headers: Record<string, string>) => Promise<ResponsesWebSocket>;
  report?: (event: Record<string, unknown>) => void;
};

/** How an attempt writes one of this API's own facts (llm-api.ts). */
type RecordFact = Parameters<NonNullable<LlmApi["transport"]>>[0]["record"];

export function openaiResponses(host: OpenaiResponsesHost = {}): LlmApi {
  // The kept socket and how many requests it carried, and the `record` of the attempt that rides it
  // now (OpenAI answers one at a time on a socket). A close that no attempt could write waits for
  // the next one. All of it is gone with the host, like any connection.
  let kept: { url: string; socket: ResponsesWebSocket; requests: number } | null = null;
  let riding: RecordFact | null = null;
  let closesUnwritten: Record<string, unknown>[] = [];
  const close = () => {
    kept?.socket.close();
    kept = null;
  };

  return {
    name: "openai-responses",
    direct: { path: () => "/responses", modelInBody: true },
    filePart,
    events: {
      "websocket-connected": {
        description:
          "The kept WebSocket to OpenAI's Responses API was dialled: its URL and how long the dial took. The requests after it ride it until `websocket-closed`.",
        payloadSchema: z.object({ url: z.string().min(1), dialMs: z.number().nonnegative() }),
      },
      "websocket-closed": {
        description:
          "The kept WebSocket closed: by its peer, or by this request maker after a failure or for another URL. `requests` is how many requests it carried. A close while no attempt ran is written by the next attempt.",
        payloadSchema: z.object({
          url: z.string().min(1),
          requests: z.number().int().nonnegative(),
          code: z.number().int().optional(),
          reason: z.string().optional(),
        }),
      },
    },

    body({ model, instructions, items, cacheKey, reasoningEffort, maxOutputTokens }) {
      const input = items.flatMap((item): unknown[] => {
        if (item.tag !== "llm-response") {
          const { parts, text } = item;
          const content = parts.length > 0 ? [...parts, { type: "input_text", text }] : text;
          return [{ role: item.role, content }];
        }
        return (
          ownItemsOf(item, model) ?? (item.text ? [{ role: "assistant", content: item.text }] : [])
        );
      });
      const bodyWithoutInput = {
        instructions,
        stream: true,
        // nothing is kept on OpenAI's side: the log is the memory, and the encrypted reasoning
        // comes back in the output items for the next request
        store: false,
        include: ["reasoning.encrypted_content"],
        // routes every request of this agent to the same cache
        prompt_cache_key: cacheKey,
        ...(reasoningEffort && { reasoning: { effort: reasoningEffort, summary: "auto" } }),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- the provider's body: an absent field is the provider's default, and it takes no null
        ...(maxOutputTokens && { max_output_tokens: maxOutputTokens }),
      };
      return { bodyWithoutInput, inputField: "input", input };
    },

    read(response, event) {
      const e = ResponsesEvent.parse(event);
      const delta = typeof e.delta === "string" ? e.delta : "";
      // a reasoning item opens before its words, and with encrypted reasoning it has none
      const reasoningItem = e.item?.type === "reasoning";
      if (e.type === "response.output_text.delta") {
        response.text += delta;
        response.isThinking = false;
      } else if (REASONING_DELTAS.includes(e.type)) {
        response.thinking += delta;
        response.isThinking = true;
      } else if (e.type === "response.output_item.added" && e.item)
        response.isThinking = reasoningItem;
      else if (e.type === "response.output_item.done" && e.item) {
        response.providerItems.push(e.item);
        if (reasoningItem) response.isThinking = false;
      } else if (e.type === "response.completed" || e.type === "response.incomplete") {
        response.isThinking = false;
        const usage = e.response?.usage;
        if (usage)
          response.usage = {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
            reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
          };
        response.done = true;
      } else if (e.type === "response.failed" || e.type === "error")
        throw streamFailure(e.response?.error?.message || e.error?.message || e.message);
    },

    async transport({ model, provider, path, signal, idleMs, now, record }) {
      // a close that no attempt could write: this attempt writes it, whatever way it goes
      for (const closed of closesUnwritten) record("websocket-closed", closed);
      closesUnwritten = [];
      const webSocket = provider.webSocket;
      if (!webSocket || !host.openWebSocket || riding) return null;
      riding = record;
      if (kept?.url !== webSocket.url) close();
      let held = kept;
      try {
        if (!held) {
          const dialStartedAtMs = now();
          const dialled = await host.openWebSocket(webSocket.url, {
            authorization: webSocket.authorization,
            // iterate Cloud stamps these on the gateway's log (internal-packages/cloud-ai)
            "x-iterate-stream-path": path,
            "x-iterate-context": "agent-turn",
          });
          const socket = { url: webSocket.url, socket: dialled, requests: 0 };
          dialled.addEventListener("close", ({ code, reason }) => {
            if (kept === socket) kept = null;
            const closed = {
              url: socket.url,
              requests: socket.requests,
              code,
              reason,
            };
            if (riding) riding("websocket-closed", closed);
            else closesUnwritten.push(closed);
          });
          record("websocket-connected", { url: webSocket.url, dialMs: now() - dialStartedAtMs });
          kept = socket;
          held = socket;
        }
      } catch (error) {
        riding = null;
        host.report?.({ event: "agent.websocket-not-opened", path, error: String(error) });
        return null; // the provider's other way carries the request
      }
      const open = held;
      return {
        name: "websocket",
        // OpenAI's own protocol: a `response.create` frame out, the events of the HTTP stream back
        events: (body) => {
          open.requests += 1;
          const frame = { type: "response.create", ...body, model: modelNameOf(model) };
          return socketEvents(open.socket, { ...frame, stream: undefined }, idleMs, signal);
        },
        // its state is unknown after a failure: the next request dials a new one
        failed: close,
        done: () => {
          riding = null;
        },
      };
    },
  };
}

/** Images, and a PDF as a file. `detail` stays `auto`, so the bytes of a request do not change and
 *  the cache holds. `.docx` and the like: OpenAI takes them, but they are lines for now
 *  (v3/files-research.md, section 3). */
const IMAGES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const filePart: LlmApi["filePart"] = ({ contentType, filename }, base64) => {
  const url = `data:${contentType};base64,${base64}`;
  if (IMAGES.includes(contentType)) return { type: "input_image", image_url: url, detail: "auto" };
  if (contentType !== "application/pdf") return null;
  return { type: "input_file", filename, file_data: url };
};

const ResponsesEvent = z.looseObject({
  type: z.string(),
  delta: z.unknown().optional(),
  item: z.looseObject({ type: z.string() }).optional(),
  response: z
    .looseObject({
      usage: z
        .looseObject({
          input_tokens: z.number(),
          output_tokens: z.number(),
          input_tokens_details: z.looseObject({ cached_tokens: z.number().optional() }).optional(),
          output_tokens_details: z
            .looseObject({ reasoning_tokens: z.number().optional() })
            .optional(),
        })
        .nullish(),
      error: z.looseObject({ message: z.string().optional() }).nullish(),
    })
    .optional(),
  message: z.string().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

const REASONING_DELTAS = ["response.reasoning_summary_text.delta", "response.reasoning_text.delta"];

const ENDS_A_RESPONSE = ["response.completed", "response.incomplete", "response.failed", "error"];

/** One request on the kept socket: the frame out, then every message as an event until the one
 *  that ends the response. The socket stays open after it. */
async function* socketEvents(
  socket: ResponsesWebSocket,
  frame: unknown,
  idleMs: number,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const queue: (ProviderEvent | Error)[] = [];
  let arrived = () => {};
  const push = (item: ProviderEvent | Error) => {
    queue.push(item);
    arrived();
  };
  const noJson = new LlmRequestFailure("transport", "the WebSocket sent no JSON");
  const onMessage = (message: { data?: unknown }) =>
    push(parsedJson(String(message.data)) ?? noJson);
  const onClose = () => push(new LlmRequestFailure("transport", "the WebSocket closed"));
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onClose);
  try {
    socket.send(JSON.stringify(frame));
    for (;;) {
      const next = new Promise<void>((resolve) => (arrived = resolve));
      if (queue.length === 0) await unlessIdleOrAborted(next, idleMs, signal);
      const item = queue.shift();
      if (item instanceof Error) throw item;
      if (!item) continue;
      yield item;
      if (ENDS_A_RESPONSE.includes(String(item.type))) return;
    }
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onClose);
  }
}
