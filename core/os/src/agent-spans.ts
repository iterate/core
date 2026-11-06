// agent-spans.ts — AN AGENT'S MODEL CALLS AS CLOUDFLARE'S AGENTS VIEW READS THEM: one `invoke_agent`
// span and one `chat <model>` span inside it for each streamed OpenAI Responses call the platform
// carries, with the OpenTelemetry GenAI attributes the view keys on
// (https://developers.cloudflare.com/agents/runtime/observability/tracing/, "Custom harnesses").
//
// The agent's loop runs in a loaded worker, whose own spans Cloudflare drops, so the platform opens
// these where the call leaves: `ItxAi.run` for a call through the AI Gateway (itx-ai.ts), and egress
// for a project's own key (context/egress.ts), over HTTP or on the agent's Responses WebSocket, whose
// frames egress relays and reads (`traceResponsesSocket`). A socket's responses share the trace of
// the invocation that holds it, which Cloudflare keeps when the socket closes. The platform sees
// a call, not the turn around it, so each call is its own `invoke_agent`; the conversation id, the
// agent's path, groups a conversation's calls. No message is recorded, only the model and the usage.
//
// Both spans stay open until the answer's stream ends: its `response.completed` gives the model and
// the usage, and a failed answer, a non-2xx status or a stream cut short sets `error.type`.
import * as cloudflareWorkers from "cloudflare:workers";
import { z } from "zod";
import { relayedCloseCode, truncateCloseReason } from "./context/websocket-close.ts";

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
  return withModelSpans(tracing, call, async (spans) => {
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      spans.end(error instanceof Error ? error.name : "error");
      throw error;
    }
    if (!response.ok || !response.body) {
      spans.end(response.ok ? "no_body" : String(response.status));
      return response;
    }
    // an answer that is not a stream has no frames to read: the call is done
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      spans.end();
      return response;
    }
    return new Response(response.body.pipeThrough(answerReader(spans)), response);
  });
}

/** A Responses WebSocket's upgrade, its socket relayed through this isolate so that each response
 *  on it gets the two spans (`socketSpans`). Every frame passes through unchanged, and a close or an
 *  error on either side closes the other. */
export function traceResponsesSocket(
  upgrade: Response,
  call: Omit<ModelCall, "model">,
  tracing: SpanTracing | undefined = workersTracing(),
): Response {
  const upstream = upgrade.webSocket;
  if (!tracing || !upstream) return upgrade;
  const pair = new WebSocketPair();
  const [client, agent] = [pair[0], pair[1]];
  upstream.accept();
  agent.accept();
  const spans = socketSpans(tracing, call);
  agent.addEventListener("message", ({ data }) => {
    spans.sent(data);
    upstream.send(data);
  });
  upstream.addEventListener("message", ({ data }) => {
    agent.send(data);
    spans.received(data);
  });
  let closed = false;
  const close = (to: WebSocket, errorType: string, code: number, reason: string) => {
    if (closed) return;
    closed = true;
    spans.closed(errorType);
    try {
      to.close(relayedCloseCode(code), truncateCloseReason(reason));
    } catch {
      // already closed
    }
  };
  agent.addEventListener("close", ({ code, reason }) =>
    close(upstream, "socket_closed", code, reason),
  );
  upstream.addEventListener("close", ({ code, reason }) =>
    close(agent, "socket_closed", code, reason),
  );
  agent.addEventListener("error", () =>
    close(upstream, "socket_error", 1011, "agent socket error"),
  );
  upstream.addEventListener("error", () =>
    close(agent, "socket_error", 1011, "upstream socket error"),
  );
  return new Response(null, { status: 101, headers: upgrade.headers, webSocket: client });
}

/** The spans of one Responses socket's responses, from its frames: the agent's `response.create`
 *  opens them, and the answer's end or failure, or the socket's end, ends them. Only a text frame
 *  that can start a response, or name a model, a usage or a failure, is parsed. OpenAI answers a
 *  socket's responses in the order they were created, so an answer that names no response id yet
 *  belongs to the oldest one open. */
export function socketSpans(tracing: SpanTracing, call: Omit<ModelCall, "model">) {
  const open: { spans: ModelSpans; id?: string }[] = [];
  return {
    sent(data: unknown) {
      if (typeof data !== "string" || !RESPONSE_CREATE.test(data)) return;
      // the model is near the frame's start; the rest is the conversation, never read
      const model = /"model"\s*:\s*"([^"]+)"/.exec(data.slice(0, 2_000))?.[1];
      // the callback's promise stays pending until the answer ends, and the spans with it
      void withModelSpans(tracing, { ...call, model }, (spans) => {
        open.push({ spans });
        return spans.ended;
      });
    },
    received(data: unknown) {
      const event = typeof data === "string" ? parseAnswerEvent(data) : undefined;
      if (!event) return;
      const id = event.response?.id;
      const entry =
        (id && open.find((candidate) => candidate.id === id)) ||
        open.find((candidate) => !candidate.id) ||
        open[0];
      if (!entry) return;
      entry.id ||= id;
      if (entry.spans.read(event)) open.splice(open.indexOf(entry), 1);
    },
    closed(errorType: string) {
      for (const entry of open.splice(0)) entry.spans.end(errorType);
    },
  };
}

/** A frame the agent sends to start a response (responses-keys.ts sends `type` first). */
const RESPONSE_CREATE = /^\{\s*"type"\s*:\s*"response\.create"/;

/** One call's two spans, open until `end`. */
type ModelSpans = {
  /** Reads one answer event into the spans; true when it ended them. */
  read(event: AnswerEvent): boolean;
  /** Ends both spans, with `error.type` when the call failed; later calls do nothing. */
  end(errorType?: string): void;
  /** Settles once `end` has run. */
  ended: Promise<void>;
};

/** `invoke_agent` and, inside it, `chat <model>`, both active while `run` runs and open until its
 *  `end`. */
function withModelSpans<T>(
  tracing: SpanTracing,
  call: ModelCall,
  run: (spans: ModelSpans) => T,
): T {
  const identity = {
    "gen_ai.agent.name": AGENT_NAME,
    "gen_ai.agent.id": `${call.projectId}${call.path}`,
    "gen_ai.conversation.id": `${call.projectId}${call.path}`,
    "iterate.project_id": call.projectId,
    "iterate.path": call.path,
  };
  return tracing.startActiveSpan(`invoke_agent ${AGENT_NAME}`, (agent) => {
    agent.setAttributes({ "gen_ai.operation.name": "invoke_agent", ...identity });
    return tracing.startActiveSpan(`chat ${call.model || call.provider}`, (chat) => {
      chat.setAttributes({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": call.provider,
        "gen_ai.request.model": call.model,
        ...identity,
      });
      let settle = () => {};
      const ended = new Promise<void>((resolve) => (settle = resolve));
      let done = false;
      const end = (errorType?: string) => {
        if (done) return;
        done = true;
        if (errorType) {
          chat.setAttribute("error.type", errorType);
          agent.setAttribute("error.type", errorType);
        }
        chat.end();
        agent.end();
        settle();
      };
      const read = (event: AnswerEvent) => {
        const model = event.response?.model;
        if (model) {
          chat.updateName(`chat ${model}`);
          chat.setAttribute("gen_ai.response.model", model);
        }
        if (event.type === "response.completed" || event.type === "response.incomplete") {
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
          return true;
        }
        if (event.type === "response.failed" || event.type === "error") {
          end(event.response?.error?.code || event.error?.code || event.code || event.type);
          return true;
        }
        return false;
      };
      return run({ read, end, ended });
    });
  });
}

/** Passes the SSE answer through unchanged, reading its events into the spans, and ends them when
 *  the stream does. */
function answerReader(spans: ModelSpans): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffered = "";
  let finished = false;
  const frame = (text: string) => {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    const event = parseAnswerEvent(data);
    if (event && spans.read(event)) finished = true;
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
      spans.end(finished ? undefined : "stream_incomplete");
    },
    cancel() {
      spans.end(finished ? undefined : "cancelled");
    },
  });
}

/** One event's JSON, when it is one of the few that name a model, a usage or a failure; most
 *  events are deltas, which are not parsed. */
function parseAnswerEvent(json: string): AnswerEvent | undefined {
  if (!/"type":\s*"(response\.(created|completed|incomplete|failed)|error)"/.test(json)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return;
  }
  const parsed = AnswerEvent.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The fields of a Responses stream event the spans read; any other field, or a field of another
 *  shape, is left out rather than failing the event. */
const ErrorCode = z.looseObject({ code: z.string().optional().catch(undefined) });
const TokenCount = z.number().optional().catch(undefined);
type AnswerEvent = z.infer<typeof AnswerEvent>;
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
