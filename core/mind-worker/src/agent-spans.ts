// Spans as Cloudflare's Agents view reads them (https://developers.cloudflare.com/agents/runtime/observability/tracing/,
// "Custom harnesses"). A loaded worker's own spans are dropped, so the platform opens them where the call leaves.
import * as cloudflareWorkers from "cloudflare:workers";
import { z } from "zod";
import { relayedCloseCode, truncateCloseReason } from "core-itx";

/** The view lists agents by it, so it never carries a path. */
const AGENT_NAME = "iterate-agent";

type SpanTracing = Pick<Tracing, "startActiveSpan">;

type ModelCall = {
  path: string;
  provider: string;
  model?: string;
};

export function traceModelCall(call: ModelCall, send: () => Promise<Response>): Promise<Response> {
  const tracing = workersTracing();
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
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      spans.end();
      return response;
    }
    return new Response(response.body.pipeThrough(answerReader(spans)), response);
  });
}

function traceResponsesSocket(upgrade: Response, call: Omit<ModelCall, "model">): Response {
  const tracing = workersTracing();
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

/** OpenAI answers a socket's responses in the order they were created, so an answer that names no
 *  response id yet belongs to the oldest one open. */
function socketSpans(tracing: SpanTracing, call: Omit<ModelCall, "model">) {
  const open: { spans: ModelSpans; id?: string }[] = [];
  return {
    sent(data: unknown) {
      if (typeof data !== "string" || !RESPONSE_CREATE.test(data)) return;
      // the model is near the frame's start; the rest is the conversation, never read
      const model = /"model"\s*:\s*"([^"]+)"/.exec(data.slice(0, 2_000))?.[1];
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

/** responses-keys.ts sends `type` first. */
const RESPONSE_CREATE = /^\{\s*"type"\s*:\s*"response\.create"/;

type ModelSpans = {
  read(event: AnswerEvent): boolean;
  /** Later calls do nothing. */
  end(errorType?: string): void;
  ended: Promise<void>;
};

function withModelSpans<T>(
  tracing: SpanTracing,
  call: ModelCall,
  run: (spans: ModelSpans) => T,
): T {
  const identity = {
    "gen_ai.agent.name": AGENT_NAME,
    "gen_ai.agent.id": call.path,
    "gen_ai.conversation.id": call.path,
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

/** Most events are deltas, which are not parsed. */
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

/** A field of another shape is left out rather than failing the event. */
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

/** The Node stand-in for cloudflare:workers has none, though the module's types say it is always there. */
function workersTracing(): SpanTracing | undefined {
  const { tracing }: { tracing?: SpanTracing } = cloudflareWorkers;
  return tracing;
}

function modelCallAt(
  outbound: Pick<Request, "url" | "method" | "headers">,
  path: string,
): { kind: "socket" | "http"; call: ModelCall } | undefined {
  if (outbound.url !== "https://api.openai.com/v1/responses") return;
  const call = { path, provider: "openai" };
  if (outbound.headers.get("upgrade")?.toLowerCase() === "websocket")
    return { kind: "socket", call };
  return outbound.method === "POST" ? { kind: "http", call } : undefined;
}

export function tracedModelCall(
  outbound: Request,
  path: string,
  send: () => Promise<Response>,
): Promise<Response> {
  const model = modelCallAt(outbound, path);
  if (model?.kind === "socket")
    return send().then((upgrade) => traceResponsesSocket(upgrade, model.call));
  if (model?.kind === "http") return traceModelCall(model.call, send);
  return send();
}
