// agent-spans.ts — AN AGENT'S MODEL CALLS AS CLOUDFLARE'S AGENTS VIEW READS THEM: one `invoke_agent`
// span and one `chat <model>` span inside it for each streamed OpenAI Responses call the platform
// carries, with the OpenTelemetry GenAI attributes the view keys on
// (https://developers.cloudflare.com/agents/runtime/observability/tracing/, "Custom harnesses").
//
// The agent's loop runs in a loaded worker, whose own spans Cloudflare drops, so the platform opens
// these where the call leaves: `ItxAi.run` for a call through the AI Gateway (itx-ai.ts), and egress
// for a project's own key over HTTP (context/egress.ts). A call on the agent's open Responses
// WebSocket is frames on one upgrade, which egress does not read: it has no span. The platform sees
// a call, not the turn around it, so each call is its own `invoke_agent`; the conversation id, the
// agent's path, groups a conversation's calls. No message is recorded, only the model and the usage.
//
// Both spans stay open until the answer's stream ends: its `response.completed` gives the model and
// the usage, and a failed answer, a non-2xx status or a stream cut short sets `error.type`.
import * as cloudflareWorkers from "cloudflare:workers";
import { z } from "zod";

/** One name for every iterate agent: the view lists agents by it, so it never carries a path. */
export const AGENT_NAME = "iterate-agent";

/** The part of the Workers tracing API these spans use, which a test fakes. */
export type SpanTracing = Pick<Tracing, "startActiveSpan">;

/** A model call: who makes it, and what is known before the answer. */
export type ModelCall = {
  projectId: string;
  /** The agent's path in the project, the agent instance and its conversation. */
  path: string;
  /** `gen_ai.provider.name`. */
  provider: string;
  /** The requested model, when the caller names it outside the body. */
  model?: string;
};

/** `send`'s answer, its body read through on the way back so both spans end with the stream. */
export function traceModelCall(
  call: ModelCall,
  send: () => Promise<Response>,
  tracing: SpanTracing | undefined = workersTracing(),
): Promise<Response> {
  if (!tracing) return send();
  const identity = {
    "gen_ai.agent.name": AGENT_NAME,
    "gen_ai.agent.id": `${call.projectId}${call.path}`,
    "gen_ai.conversation.id": `${call.projectId}${call.path}`,
    "iterate.project_id": call.projectId,
    "iterate.path": call.path,
  };
  return tracing.startActiveSpan(`invoke_agent ${AGENT_NAME}`, (agent) => {
    agent.setAttributes({ "gen_ai.operation.name": "invoke_agent", ...identity });
    return tracing.startActiveSpan(`chat ${call.model || call.provider}`, async (chat) => {
      chat.setAttributes({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": call.provider,
        "gen_ai.request.model": call.model,
        ...identity,
      });
      let ended = false;
      const end = (errorType?: string) => {
        if (ended) return;
        ended = true;
        if (errorType) {
          chat.setAttribute("error.type", errorType);
          agent.setAttribute("error.type", errorType);
        }
        chat.end();
        agent.end();
      };
      let response: Response;
      try {
        response = await send();
      } catch (error) {
        end(error instanceof Error ? error.name : "error");
        throw error;
      }
      if (!response.ok || !response.body) {
        end(response.ok ? "no_body" : String(response.status));
        return response;
      }
      // an answer that is not a stream has no frames to read: the call is done
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        end();
        return response;
      }
      return new Response(response.body.pipeThrough(answerReader(chat, end)), response);
    });
  });
}

/** Passes the SSE answer through unchanged, reading the events that name the model, the usage or a
 *  failure, and ends the spans when the stream does. */
function answerReader(
  chat: Pick<Span, "setAttribute" | "setAttributes" | "updateName" | "end">,
  end: (errorType?: string) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffered = "";
  let finished = false;
  const frame = (text: string) => {
    // most frames are deltas: parse only the few that can matter
    if (!/"type":\s*"(response\.(created|completed|incomplete|failed)|error)"/.test(text)) return;
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = AnswerEvent.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    const model = event.response?.model;
    if (model) {
      chat.updateName(`chat ${model}`);
      chat.setAttribute("gen_ai.response.model", model);
    }
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      finished = true;
      const usage = event.response?.usage;
      chat.setAttributes({
        "gen_ai.response.id": event.response?.id,
        "gen_ai.usage.input_tokens": usage?.input_tokens,
        "gen_ai.usage.output_tokens": usage?.output_tokens,
        "gen_ai.usage.cache_read.input_tokens": usage?.input_tokens_details?.cached_tokens,
        "gen_ai.usage.reasoning.output_tokens": usage?.output_tokens_details?.reasoning_tokens,
        "gen_ai.response.finish_reasons":
          event.type === "response.incomplete"
            ? event.response?.incomplete_details?.reason || "incomplete"
            : "stop",
      });
      end();
    } else if (event.type === "response.failed" || event.type === "error") {
      end(event.response?.error?.code || event.error?.code || event.code || event.type);
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffered += decoder.decode(chunk, { stream: true });
      const frames = buffered.split(/\r?\n\r?\n/);
      buffered = frames.pop() || "";
      frames.forEach(frame);
    },
    flush() {
      if (buffered) frame(buffered);
      end(finished ? undefined : "stream_incomplete");
    },
    cancel() {
      end(finished ? undefined : "cancelled");
    },
  });
}

/** The fields of a Responses stream event the spans read; any other field, or a field of another
 *  shape, is left out rather than failing the event. */
const ErrorCode = z.looseObject({ code: z.string().optional().catch(undefined) });
const TokenCount = z.number().optional().catch(undefined);
const AnswerEvent = z.looseObject({
  type: z.string().optional().catch(undefined),
  code: z.string().optional().catch(undefined),
  error: ErrorCode.optional().catch(undefined),
  response: z
    .looseObject({
      id: z.string().optional().catch(undefined),
      model: z.string().optional().catch(undefined),
      error: ErrorCode.optional().catch(undefined),
      incomplete_details: z
        .looseObject({ reason: z.string().optional().catch(undefined) })
        .optional()
        .catch(undefined),
      usage: z
        .looseObject({
          input_tokens: TokenCount,
          output_tokens: TokenCount,
          input_tokens_details: z
            .looseObject({ cached_tokens: TokenCount })
            .optional()
            .catch(undefined),
          output_tokens_details: z
            .looseObject({ reasoning_tokens: TokenCount })
            .optional()
            .catch(undefined),
        })
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});

/** The runtime's tracing API. The Node stand-in for cloudflare:workers, where the unit suite runs,
 *  has none, though the module's types say it is always there. */
function workersTracing(): SpanTracing | undefined {
  const { tracing }: { tracing?: SpanTracing } = cloudflareWorkers;
  return tracing;
}
