// test-support.mjs: THE AGENT ON AN IN-MEMORY LOG, for the agent's tests. It holds the platform's
// own stand-ins (iterate/stream/test-support), the agent's processor and the four request makers
// (one for each API shape, as agent/facet.ts hosts them) as separate engines that share only the
// log, a fake `itx` whose model is a function, any processors the test hosts beside the agent, and
// the two things the platform does and the in-memory log does not: it runs scripts, and it fires
// schedules. Every script REALLY RUNS, envelope and all, against the log, as soon as it is asked
// for (or when the test says, with `runScriptsByHand`). The hosts can be killed: after that they
// append nothing and hear nothing, as dead facets.
//
// These tests are not in agent/. That folder is the facets' source: `import agentFiles from
// "./agent/"` takes every file under it, and its hash is the facets' code version. A test file there
// would ship with the facets, and each edit of a test would restart every agent.
//
// Run from the config's root: node --test "agent-tests/*.test.mjs"

import { createHash } from "node:crypto";
import { ProcessorEngine } from "iterate/stream/processor";
import { memoryStorage, memoryStream, settle } from "iterate/stream/test-support";
import { AgentContract } from "../agent/contract.ts";
import { LlmApiProcessor } from "../agent/llm-api.ts";
import { anthropicMessages } from "../agent/llm-apis/anthropic-messages.ts";
import { chatCompletions } from "../agent/llm-apis/chat-completions.ts";
import { googleGenerateContent } from "../agent/llm-apis/google-generate-content.ts";
import { openaiResponses } from "../agent/llm-apis/openai-responses.ts";
import { Agent } from "../agent/processor.ts";

// A DIGEST THAT IS NOT DONE IS WORK THAT IS NOT DONE. The agent's code hashes each file and each
// request body with `crypto.subtle.digest`, which answers from a pool thread. A test waits until
// the log has stopped growing for 15 ms (`quiet`, below). On a loaded computer a pool thread can
// answer later than that, and the test then reads the log before the request went out. So the
// digests in flight are counted here, and `quiet` waits for them too. The digest itself is the
// real one.
let digestsInFlight = 0;
const subtleDigest = crypto.subtle.digest.bind(crypto.subtle);
Object.defineProperty(crypto.subtle, "digest", {
  value: async (algorithm, data) => {
    digestsInFlight += 1;
    try {
      return await subtleDigest(algorithm, data);
    } finally {
      digestsInFlight -= 1;
    }
  },
});

export function agentOnALog(options) {
  const AGENT_PATH = options.path ?? "/agents/test";
  const log = memoryStream(AGENT_PATH);
  const storage = memoryStorage();
  /** Each request maker's own facet storage, by API name: it outlives its hosts. */
  const apiStorage = new Map();
  /** The storage of each processor beside the agent, by its place in `beside`. */
  const besideStorage = [];
  const calls = [];
  const reports = [];
  /** Every commit, as the kinds it held: what went in ONE append. */
  const appends = [];
  let incarnation = 0;
  let commits = 0;
  let engine;

  /** One commit to the log, by the test or by a host. The commit after which the host is to die is
   *  heard by no engine: a new host reads it from the log. */
  const commit = (events) => {
    appends.push(events.map((event) => event.type.replace("events.iterate.com/", "")));
    if (events.every((event) => event.ephemeral)) return log.stream.append(...events);
    commits += 1;
    if (commits !== options.dieAfterCommit) return log.stream.append(...events);
    log.engines.length = 0;
    const committed = log.stream.append(...events);
    void wake().revive();
    return committed;
  };

  function wake() {
    incarnation += 1;
    const mine = incarnation;
    const alive = () => mine === incarnation;
    const never = new Promise(() => {});
    const itx = {
      ...options.roots,
      ai: {
        run: async (model, body, runOptions) => {
          if (!alive()) return never;
          const call = { model, body, options: runOptions };
          calls.push(call);
          return options.model(call, calls);
        },
      },
      [Symbol.dispose]: () => undefined,
    };
    const Hosted = options.agent ?? Agent;
    const report = (event) => void reports.push(event);
    const processor = new Hosted({ getItx: () => itx, now: () => 0, report });
    const stream = {
      ...log.stream,
      append: (...events) => {
        if (!alive()) return never;
        const dying = commits + 1 === options.dieAfterCommit && events.some((e) => !e.ephemeral);
        const committed = commit(events);
        return dying ? never : committed;
      },
    };
    engine = new ProcessorEngine(processor, { stream, storage });
    // as agent/facet.ts hosts them: a new host has a new OpenAI maker, so no socket of the dead one
    const apis = [
      openaiResponses({ openWebSocket: options.openWebSocket, report }),
      anthropicMessages,
      chatCompletions,
      googleGenerateContent,
    ]
      .filter((api) => !options.withoutApis?.includes(api.name))
      .concat(options.apis ?? []);
    const makers = apis.map((api) => {
      if (!apiStorage.has(api.name)) apiStorage.set(api.name, memoryStorage());
      const fetch = async (request) => {
        if (!alive()) return never;
        if (!options.fetch) throw new Error("this test has no egress");
        return options.fetch(request);
      };
      const maker = new LlmApiProcessor({
        api,
        getItx: () => itx,
        fetch,
        now: () => 0,
        report,
        readEvents: (after, limit) => log.stream.read(after, limit),
      });
      return new ProcessorEngine(maker, { stream, storage: apiStorage.get(api.name) });
    });
    const others = (options.beside?.() ?? []).map((other, index) => {
      besideStorage[index] ??= memoryStorage();
      return new ProcessorEngine(other, { stream, storage: besideStorage[index] });
    });
    log.engines.splice(0, log.engines.length, engine, ...makers, ...others);
    // a new host of a request maker reads what it missed, as a revived facet does
    for (const maker of [...makers, ...others]) void maker.revive();
    return engine;
  }
  wake();
  if (options.config)
    commit([{ type: "events.iterate.com/agent/configured", payload: { config: options.config } }]);

  const durable = (type) => log.events.filter((event) => event.type === type);

  /** What a script reaches of its context: the log, to read and to append to, and the test's own
   *  functions. An append takes a moment, as a real one does: a script that does not await it
   *  returns first, and only the envelope makes the run wait for it. A script's append to ANOTHER
   *  context lands in `elsewhere`, stamped with the agent's path as its origin, as the platform
   *  stamps it, with the newest offset of the agent's log when it landed. */
  const elsewhere = new Map();
  const appended = async (path, events) => {
    await settle(5);
    if (path === AGENT_PATH) return commit(events);
    const stamped = events.map((event) => ({ ...event, source: { origin: AGENT_PATH } }));
    const afterOffset = log.pushedEvents.at(-1)?.offset ?? 0;
    const landed = stamped.map((event) => ({ event, afterOffset }));
    elsewhere.set(path, [...(elsewhere.get(path) ?? []), ...landed]);
    return stamped;
  };

  const contextAt = (path) => ({
    append: (...events) => appended(path, events),
    cd: contextAt,
    // (a read of a path the test names no log for is of the agent's own log)
    readEvents: async (after, limit) => ({
      events: (options.logsOf?.[path]?.() ?? log.events)
        .filter((event) => event.offset > after)
        .slice(0, limit),
    }),
    // the agent's own log, looked at until the fact is there or the time is over
    waitForEvent: async ({ type, payload, afterOffset, timeoutMs }) => {
      const matches = (event) =>
        event.type === type &&
        event.offset > afterOffset &&
        Object.entries(payload).every(([key, value]) => event.payload?.[key] === value);
      for (let waitedMs = 0; waitedMs <= timeoutMs; waitedMs += 5) {
        const found = log.events.find(matches);
        if (found) return found;
        await settle(5);
      }
      throw new Error(`no ${type} came within ${timeoutMs} ms`);
    },
  });
  const scriptItx = { ...options.itx, ...contextAt(AGENT_PATH) };
  /** THE PLATFORM'S RUNNER: each script that is asked for runs once, as the platform runs it: a
   *  module's strict code, and a result that is JSON. A script that does not load, or throws, has
   *  failed. Its settlement is written when it ends, however long that takes. */
  const started = new Set();
  const startRuns = () => {
    const open = durable("events.iterate.com/itx/run-requested").filter(
      (run) => !started.has(run.offset),
    );
    for (const run of open) {
      started.add(run.offset);
      void (async () => {
        let settlement;
        try {
          const script = (0, eval)(`"use strict";(${String(run.payload?.code)})`);
          const result = await script(scriptItx);
          settlement = {
            status: "succeeded",
            ...(result !== undefined && { result: JSON.parse(JSON.stringify(result)) }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          settlement = { status: "failed", error: message, failureKind: "runtime" };
        }
        const type = "events.iterate.com/itx/run-settled";
        await commit([{ type, payload: { requestOffset: run.offset, settlement } }]);
      })();
    }
    return open.length;
  };

  /** Wait until the log has stopped growing and no digest is in flight (and, unless by hand, every
   *  script asked for runs). */
  const quiet = async () => {
    for (let length = -1; length !== log.pushedEvents.length || digestsInFlight > 0;) {
      length = log.pushedEvents.length;
      if (!options.runScriptsByHand) startRuns();
      await settle(15);
    }
  };
  const append = async (...events) => {
    const committed = await commit(events);
    await quiet();
    return committed;
  };

  return {
    log,
    storage,
    calls,
    reports,
    /** How many commits the log has taken, by the test and by every host. */
    commits: () => commits,
    /** Every commit, ephemeral ones included, as the kinds of its events: what went in one append. */
    appends: () => appends,
    append,
    quiet,
    wake,
    /** A person's words to the agent: one `agent/context-added` of role `user`. Wait until all that
     *  follows from it is done. It answers the input. */
    async say(message, more = {}) {
      const payload = { role: "user", content: message, ...more };
      await append({ type: "events.iterate.com/agent/context-added", payload });
      return durable("events.iterate.com/agent/context-added").slice(-1);
    },
    /** The agent's own input, written directly. */
    add: (content, more = {}) =>
      append({
        type: "events.iterate.com/agent/context-added",
        payload: { role: "user", content, ...more },
      }),
    /** The platform's runner, by hand (`runScriptsByHand`): run every script that is asked for and
     *  not yet run, and wait until all that follows is done. How many it started. */
    async runScripts() {
      const count = startRuns();
      await quiet();
      return count;
    },
    /** What the agent's scripts appended to another context, by its path, each with the newest
     *  offset of the agent's own log when it landed. */
    appendedTo: (path) => elsewhere.get(path) ?? [],
    /** The words the agent's scripts said on the web. */
    said: () =>
      durable("events.iterate.com/agent-ui/message-sent").map((words) => words.payload?.message),
    /** The model's own code of every script that was asked to run, out of its envelope. */
    scripts: () =>
      durable("events.iterate.com/itx/run-requested").map((run) => {
        const code = String(run.payload?.code);
        const [open, close] = ["//#region your script", "//#endregion your script"];
        return code.slice(code.indexOf(open) + open.length, code.lastIndexOf(close)).trim();
      }),
    /** The head of result `index` as the model reads it: its number is its settled fact's offset. */
    resultHead: (index) =>
      `[result ${durable("events.iterate.com/itx/run-settled")[index].offset}]`,
    /** The platform's scheduler: append what the newest schedule under a key (or a key prefix)
     *  was set to append. */
    async fire(keyPrefix) {
      const set = durable("events.iterate.com/itx/schedule-set").findLast((event) =>
        String(event.payload?.key).startsWith(keyPrefix),
      );
      if (!set) throw new Error(`no schedule is set under ${keyPrefix}`);
      return append(...set.payload?.events);
    },
    state: async () => (await engine.snapshot()).state,
    /** The agent facet's `snapshot()`: its state, and the offset it has reduced through. */
    snapshot: () => engine.snapshot(),
    /** The durable facts, by their type without `events.iterate.com/`. */
    kinds: () => log.events.map((event) => event.type.replace("events.iterate.com/", "")),
    durable,
    /** Every durable fact of the agent's own types parses as its contract says. A fact that did
     *  not would be skipped by the reducer, silently. */
    invalidFacts: () =>
      log.events.filter(
        (event) =>
          AgentContract.payloadSchemaFor(event.type)?.safeParse(event.payload || {}).success ===
          false,
      ),
  };
}

// ── fake provider answers ──

/** A provider's answer as server-sent events. */
export function sse(events) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** A stream the test feeds by hand: `send` an event, `end` it. */
export function heldSse() {
  let controller;
  const body = new ReadableStream({ start: (c) => void (controller = c) });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    send: (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    end: () => controller.close(),
  };
}

/** What a model writes for an answer: one `<codemode>` block whose script says the words, then
 *  does the rest. Nothing to say or do: the empty response, silence. */
export function written({ say, script, raw }) {
  if (raw !== undefined) return raw;
  const words =
    say &&
    `itx.append({ type: "events.iterate.com/agent-ui/message-sent", payload: { message: ${JSON.stringify(say)} } });`;
  const lines = [words, script].filter(Boolean);
  return lines.length > 0 ? `<codemode>\n${lines.join("\n")}\n</codemode>` : "";
}

/** OpenAI's Responses stream for one answer, as its events. */
export function openaiEvents(answer, _id = "1") {
  const { usage = {} } = answer;
  const text = written(answer);
  const message = { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
  return [
    ...(text
      ? [
          { type: "response.output_text.delta", delta: text.slice(0, 3) },
          { type: "response.output_text.delta", delta: text.slice(3) },
          { type: "response.output_item.done", item: message },
        ]
      : []),
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: usage.input ?? 100,
          output_tokens: usage.output ?? 10,
          input_tokens_details: { cached_tokens: usage.cached ?? 0 },
        },
      },
    },
  ];
}
export const openai = (answer, id) => sse(openaiEvents(answer, id));

/** Anthropic's Messages stream for one answer. */
export function anthropic(answer, _id = "1") {
  const { usage = {} } = answer;
  const text = written(answer);
  // the text in two pieces, as a stream gives it
  const deltas = [text.slice(0, 4), text.slice(4)].map((piece) => ({
    type: "text_delta",
    text: piece,
  }));
  const blocks = text ? [{ start: { type: "text", text: "" }, deltas }] : [];
  const start = {
    input_tokens: (usage.input ?? 100) - (usage.cached ?? 0),
    cache_read_input_tokens: usage.cached ?? 0,
    cache_creation_input_tokens: 0,
    output_tokens: 1,
  };
  return sse([
    { type: "message_start", message: { usage: start } },
    ...blocks.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block.start },
      ...block.deltas.map((delta) => ({ type: "content_block_delta", index, delta })),
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: usage.output ?? 10 },
    },
    { type: "message_stop" },
  ]);
}

/** Google's generateContent answer: one JSON object. */
export function google(answer) {
  const { usage = {} } = answer;
  const text = written(answer);
  const parts = text ? [{ text, thoughtSignature: "sig" }] : [];
  return Response.json({
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: usage.input ?? 100,
      cachedContentTokenCount: usage.cached ?? 0,
      candidatesTokenCount: usage.output ?? 10,
    },
  });
}

/** xAI's Chat Completions stream for one answer: the text in pieces, and the counts in a last
 *  chunk with no choice. */
export function xai(answer, _id = "1") {
  const { usage = {} } = answer;
  const text = written(answer);
  const chunk = (delta, finish_reason = null) => ({
    choices: [{ index: 0, delta, finish_reason }],
  });
  return sse([
    ...(text
      ? [chunk({ role: "assistant", content: text.slice(0, 5) }), chunk({ content: text.slice(5) })]
      : []),
    chunk({}, "stop"),
    {
      choices: [],
      usage: {
        prompt_tokens: usage.input ?? 100,
        completion_tokens: usage.output ?? 10,
        prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
      },
    },
  ]);
}

/** A WebSocket that answers each `response.create` frame with the events `answer` gives. */
export function fakeWebSocket(answer) {
  const listeners = {
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };
  const frames = [];
  const socket = {
    send(data) {
      const frame = JSON.parse(data);
      frames.push(frame);
      queueMicrotask(() => {
        for (const event of answer(frame))
          for (const listener of listeners.message) listener({ data: JSON.stringify(event) });
      });
    },
    close: () => listeners.close.forEach((listener) => listener({})),
    addEventListener(type, listener) {
      listeners[type].add(listener);
    },
    removeEventListener(type, listener) {
      listeners[type].delete(listener);
    },
  };
  return { socket, frames };
}

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** A value as the platform's log holds it: JSON. A key whose value is undefined is not there. The
 *  log of these tests is in memory and keeps such a key, so a test that compares a whole payload
 *  reads it through this. */
export const logged = (value) => JSON.parse(JSON.stringify(value));
