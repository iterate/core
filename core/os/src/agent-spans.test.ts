// agent-spans.test.ts — the spans Cloudflare's Agents view reads for one model call (agent-spans.ts):
// their names, their GenAI attributes, and when they end as the answer streams back. A fake tracer
// records each span; the runtime's own tracer and the view itself are out of reach here.

import { expect, test } from "vitest";
import { AGENT_NAME, traceModelCall, type SpanTracing } from "./agent-spans.ts";

const CALL = { projectId: "prj_1", path: "/agents/support", provider: "openai", model: "gpt-5.5" };
const IDENTITY = {
  "gen_ai.agent.name": AGENT_NAME,
  "gen_ai.agent.id": "prj_1/agents/support",
  "gen_ai.conversation.id": "prj_1/agents/support",
  "iterate.project_id": "prj_1",
  "iterate.path": "/agents/support",
};

test.for([
  {
    name: "a completed answer: the model it named and its usage",
    answer: sse(
      { type: "response.created", response: { id: "resp_1", model: "gpt-5.5-2026-10-01" } },
      { type: "response.output_text.delta", delta: "hi" },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "gpt-5.5-2026-10-01",
          usage: {
            input_tokens: 1200,
            output_tokens: 40,
            input_tokens_details: { cached_tokens: 1024 },
            output_tokens_details: { reasoning_tokens: 12 },
          },
        },
      },
    ),
    chat: {
      name: "chat gpt-5.5-2026-10-01",
      attributes: {
        "gen_ai.response.model": "gpt-5.5-2026-10-01",
        "gen_ai.response.id": "resp_1",
        "gen_ai.usage.input_tokens": 1200,
        "gen_ai.usage.output_tokens": 40,
        "gen_ai.usage.cache_read.input_tokens": 1024,
        "gen_ai.usage.reasoning.output_tokens": 12,
        "gen_ai.response.finish_reasons": "stop",
      },
    },
    errorType: undefined,
  },
  {
    name: "an answer cut off at its token cap, which is not an error",
    answer: sse({
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 9 } },
    }),
    chat: {
      name: "chat gpt-5.5",
      attributes: { "gen_ai.response.finish_reasons": "max_output_tokens" },
    },
    errorType: undefined,
  },
  {
    name: "a failed answer, by the provider's error code",
    answer: sse({ type: "response.failed", response: { error: { code: "server_error" } } }),
    chat: { name: "chat gpt-5.5", attributes: {} },
    errorType: "server_error",
  },
  {
    name: "a stream that ends before the response does",
    answer: sse({ type: "response.output_text.delta", delta: "hal" }),
    chat: { name: "chat gpt-5.5", attributes: {} },
    errorType: "stream_incomplete",
  },
])("$name ends both spans with the stream", async ({ answer, chat, errorType }) => {
  const tracer = fakeTracer();
  const response = await traceModelCall(CALL, async () => streamed(answer), tracer);
  // the caller reads the answer it would have read without the spans
  expect(await response.text()).toEqual(answer);
  expect(tracer.spans).toMatchObject([
    {
      name: `invoke_agent ${AGENT_NAME}`,
      attributes: { "gen_ai.operation.name": "invoke_agent", ...IDENTITY },
      ended: true,
    },
    {
      name: chat.name,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.5",
        ...IDENTITY,
        ...chat.attributes,
      },
      ended: true,
    },
  ]);
  // exact: a span that succeeded carries no error.type at all
  expect(tracer.spans.map((span) => span.attributes["error.type"])).toEqual([errorType, errorType]);
});

test("the spans stay open until the caller has read the answer's end", async () => {
  const tracer = fakeTracer();
  const response = await traceModelCall(
    CALL,
    async () => streamed(sse({ type: "response.completed", response: {} })),
    tracer,
  );
  expect(tracer.spans).toMatchObject([{ ended: false }, { ended: false }]);
  await response.text();
  expect(tracer.spans).toMatchObject([{ ended: true }, { ended: true }]);
});

test.for([
  {
    name: "a non-2xx status",
    send: async () => new Response("rate limited", { status: 429 }),
    errorType: "429",
  },
  {
    name: "a send that throws",
    send: async (): Promise<Response> => {
      throw new TypeError("network lost");
    },
    errorType: "TypeError",
  },
  {
    name: "an answer that is not a stream, which has no frames to read",
    send: async () => Response.json({ id: "resp_1", status: "completed" }),
    errorType: undefined,
  },
])("$name ends both spans at once", async ({ send, errorType }) => {
  const tracer = fakeTracer();
  await traceModelCall(CALL, send, tracer).catch(() => undefined);
  expect(tracer.spans).toMatchObject([{ ended: true }, { ended: true }]);
  // exact: a span that succeeded carries no error.type at all
  expect(tracer.spans.map((span) => span.attributes["error.type"])).toEqual([errorType, errorType]);
});

/** A streamed answer, as OpenAI sends it. */
function streamed(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

/** A Responses API answer: each event an SSE frame, as OpenAI streams it. */
function sse(...events: { type: string; [field: string]: unknown }[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

type RecordedSpan = { name: string; attributes: Record<string, unknown>; ended: boolean };

/** A tracer that records each span it starts, its name as it ends up and its attributes. */
function fakeTracer(): SpanTracing & { spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const startActiveSpan = (name: string, callback: (span: never) => unknown) => {
    const recorded: RecordedSpan = { name, attributes: {}, ended: false };
    spans.push(recorded);
    const span = {
      setAttribute(key: string, value: unknown) {
        recorded.attributes[key] = value;
        return span;
      },
      setAttributes(attributes: Record<string, unknown>) {
        Object.assign(recorded.attributes, attributes);
        return span;
      },
      updateName(next: string) {
        recorded.name = next;
        return span;
      },
      end() {
        recorded.ended = true;
      },
    };
    return callback(span as never);
  };
  // one cast: the fake implements the part of Span the spans use
  return { spans, startActiveSpan: startActiveSpan as SpanTracing["startActiveSpan"] };
}
