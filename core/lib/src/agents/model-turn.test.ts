// model-turn.test.ts — one model turn against a fake `itx`: the request the loop sends, the first
// response frame, and the usage it settles with, priced at the standard tier only. The whole loop
// on the worker is test/vitest/agents/ (e2e) and agents-workers/ (an eviction mid-call).
import { expect, test } from "vitest";
import type { StreamEvent } from "../stream/processor.ts";
import { AgentProcessor } from "./processor.ts";

const PATH = "/agents/a";
const AT = Date.parse("2026-10-10T12:00:00Z");

test.for([
  { tier: undefined, priced: true },
  { tier: "default", priced: true },
  { tier: "priority", priced: false },
])(
  "a turn asks the model with its cache key, shows its first words at once, and settles priced at the standard tier only (served: $tier)",
  async ({ tier, priced }) => {
    const { turn, sent, sleeps } = agentWithModel({ servedTier: tier });
    const appended = await turn("What is the answer?");
    expect(sent).toMatchObject([{ prompt_cache_key: PATH, stream: true }]);
    // the debounce after a person's words, then the first frame's window at once, the next 150 ms
    expect(sleeps).toEqual([250, 0, 150]);
    const settled = appended.find(
      (row) => row.type === "events.iterate.com/agent/llm-request-settled",
    );
    expect(settled?.payload).toMatchObject({
      result: {
        status: "succeeded",
        text: "forty-two",
        usage: { inputTokens: 1_000, outputTokens: 4 },
      },
    });
    const { usage } = (settled!.payload as { result: { usage: { costUsd?: number } } }).result;
    expect(usage.costUsd !== undefined).toBe(priced);
  },
);

test("an agent's service tier is asked for, and an unset one is not sent", async () => {
  for (const serviceTier of ["priority", undefined]) {
    const { turn, sent } = agentWithModel({ serviceTier });
    await turn("hi");
    expect(sent[0]).toMatchObject({ service_tier: serviceTier });
    // on the wire an unset tier is no field at all
    expect(JSON.stringify(sent[0]).includes('"service_tier"')).toBe(Boolean(serviceTier));
  }
});

type Row = { type: string; payload?: unknown };

/** An agent whose `itx` answers the few things a turn asks: who it is, its config repo (an
 *  AGENTS.md), its capability tree (none), and the model, which streams "forty-two" in two deltas
 *  and completes with usage and `servedTier`. `turn` commits a person's words and every intent the
 *  loop asks for, at head, and answers what the loop appended. */
function agentWithModel(options: { servedTier?: string; serviceTier?: string }) {
  const sent: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  const itx = {
    whoami: async () => ({ projectId: "prj_t", path: PATH, projectSlug: "t" }),
    repos: {
      get: async () => ({
        readFile: async (file: string) => (file === "AGENTS.md" ? "Be brief." : null),
      }),
    },
    cd: () => ({ rewriteRules: { list: async () => [] } }),
    ai: {
      run: async (_model: string, body: Record<string, unknown>) => {
        sent.push(body);
        return sse([
          { type: "response.output_text.delta", delta: "forty" },
          { type: "response.output_text.delta", delta: "-two" },
          {
            type: "response.completed",
            response: {
              output: [{ type: "message", content: [{ type: "output_text", text: "forty-two" }] }],
              usage: { input_tokens: 1_000, output_tokens: 4 },
              service_tier: options.servedTier, // unset: no field in the stream's JSON
            },
          },
        ]);
      },
    },
    [Symbol.dispose]: () => undefined,
  };
  const processor = new AgentProcessor({
    getItx: () => itx as never,
    now: () => AT,
    sleep: async (ms: number) => void sleeps.push(ms),
  });
  const events: StreamEvent[] = [];
  let state = processor.contract.initialState();
  const commit = async (row: Row): Promise<Row[]> => {
    const parsed = processor.contract.payloadSchemaFor(row.type)?.safeParse(row.payload || {});
    if (parsed && !parsed.success) throw parsed.error;
    const event = {
      type: row.type,
      payload: parsed ? parsed.data : row.payload,
      offset: events.length + 1,
      createdAt: new Date(AT).toISOString(),
      path: PATH,
      source: { origin: PATH },
    } as StreamEvent;
    events.push(event);
    const previousState = state;
    state = processor.reduce({ event, state } as never) ?? state;
    const appended: Row[] = [];
    const background: Array<() => Promise<unknown>> = [];
    processor.processEvent({
      event,
      state,
      previousState,
      append: async (...rows: Row[]) => void appended.push(...rows),
      blockProcessorWhile: (work: () => Promise<unknown>) => void background.push(work),
      runInBackground: (work: () => Promise<unknown>) => void background.push(work),
      delivery: { caughtUp: true },
    } as never);
    while (background.length > 0) await background.shift()!();
    return appended;
  };
  const turn = async (words: string): Promise<Row[]> => {
    await commit({ type: "events.iterate.com/agent/create-requested", payload: {} });
    await commit({ type: "events.iterate.com/agent/created", payload: { path: PATH } });
    if (options.serviceTier)
      await commit({
        type: "events.iterate.com/agent/configured",
        payload: { config: { llm: { serviceTier: options.serviceTier } } },
      });
    const asked = await commit({
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", content: words, actor: { type: "user" } },
    });
    const intent = asked.find(
      (row) => row.type === "events.iterate.com/agent/llm-request-requested",
    );
    if (!intent) throw new Error("the loop asked for no request");
    return commit(intent);
  };
  return { turn, sent, sleeps };
}

/** `frames` as the Responses API streams them. */
function sse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
