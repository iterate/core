// responses-keys.test.ts — the key stack's spec: the body every key takes, which key answers, and
// when a request rides the agent's socket.

import { expect, test } from "vitest";
import {
  bodyForKeys,
  postResponses,
  type StreamAttempt,
  wellFormedBody,
} from "./responses-keys.ts";

const live = new AbortController().signal;
const IDLE_MS = 60_000;

test("the body drops what a plan's token refuses, and the explicit cache breakpoint", () => {
  expect(
    bodyForKeys({
      model: "gpt-test",
      temperature: 1,
      max_output_tokens: 5,
      previous_response_id: "resp_a",
      store: false,
      input: [
        {
          role: "developer",
          content: [
            { type: "input_text", text: "head", prompt_cache_breakpoint: { mode: "explicit" } },
          ],
        },
      ],
    }),
  ).toEqual({
    model: "gpt-test",
    store: false,
    input: [{ role: "developer", content: [{ type: "input_text", text: "head" }] }],
  });
});

test("a lone UTF-16 surrogate anywhere in the body is sent as U+FFFD, and a whole emoji is kept", () => {
  const { body, repaired } = wellFormedBody({
    input: [
      { role: "user", content: [{ type: "input_text", text: "cut mid-emoji \uD83C" }] },
      { type: "function_call", name: "run", arguments: '{"script":"\uDF89 alone"}' },
      { role: "user", content: [{ type: "input_text", text: "whole 🎉" }] },
    ],
  });
  expect(body).toEqual({
    input: [
      { role: "user", content: [{ type: "input_text", text: "cut mid-emoji \uFFFD" }] },
      { type: "function_call", name: "run", arguments: '{"script":"\uFFFD alone"}' },
      { role: "user", content: [{ type: "input_text", text: "whole 🎉" }] },
    ],
  });
  expect(repaired).toBe(2);
  // what OpenAI refuses: JSON.stringify's escape of a lone surrogate
  expect(JSON.stringify(body)).not.toMatch(/\\ud[89a-f]/i);
});

test("the first key whose answer is read to its end serves the request, and the others are never sent", async () => {
  const { send, seen } = egress(200);
  expect(await postResponses(send, { model: "gpt-test" }, KEYS, live, IDLE_MS, readText)).toBe(
    "answer 200",
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]?.authorization).toBe(`Bearer ${KEYS[0]}`);
});

test("every key is sent the prompt-cache key as the session, which a plan's token caches under", async () => {
  const { send, seen } = egress(429, 200);
  await postResponses(
    send,
    { prompt_cache_key: "/agents/a" },
    KEYS,
    live,
    IDLE_MS,
    readText,
    () => undefined,
  );
  expect(seen.map((one) => one.session)).toEqual(["/agents/a", "/agents/a"]);
  const bare = egress(200);
  await postResponses(bare.send, {}, KEYS, live, IDLE_MS, readText);
  expect(bare.seen[0]).toMatchObject({ session: null });
});

test("a key that answers an error, or throws, hands the same body to the next key", async () => {
  for (const first of [429, new Error("no such secret")]) {
    const { send, seen } = egress(first, 200);
    const log: unknown[] = [];
    const answer = await postResponses(
      send,
      { model: "gpt-test", temperature: 1 },
      KEYS,
      live,
      IDLE_MS,
      readText,
      (line) => log.push(line),
    );
    expect(answer).toBe("answer 200");
    expect(seen.map((one) => one.authorization)).toEqual(KEYS.map((key) => `Bearer ${key}`));
    expect(seen[1]?.body).toEqual({ model: "gpt-test" });
    expect(log).toEqual([{ key: 1, keys: 2, error: expect.any(String) }]);
    expect(JSON.stringify(log)).not.toContain("secrets/");
  }
});

test("when no key succeeds, the last failure is thrown, and an empty stack says so", async () => {
  const quiet = () => undefined;
  await expect(
    postResponses(egress(401, 503).send, {}, KEYS, live, IDLE_MS, readText, quiet),
  ).rejects.toThrow("503: answer 503");
  await expect(
    postResponses(
      egress(new Error("a"), new Error("b")).send,
      {},
      KEYS,
      live,
      IDLE_MS,
      readText,
      quiet,
    ),
  ).rejects.toThrow("b");
  await expect(
    postResponses(egress().send, {}, [], live, IDLE_MS, readText, quiet),
  ).rejects.toThrow("llm.apiKeys is empty");
});

test("an abort before the call sends nothing, and an abort during a key's request ends the call without trying the next key", async () => {
  const early = new AbortController();
  early.abort(new Error("expired"));
  const idle = egress(200);
  await expect(
    postResponses(idle.send, {}, KEYS, early.signal, IDLE_MS, readText, () => undefined),
  ).rejects.toThrow("expired");
  expect(idle).toMatchObject({ seen: [] });

  const controller = new AbortController();
  let sent = 0;
  const hung = () => {
    sent += 1;
    return new Promise<Response>(() => undefined);
  };
  const call = postResponses(hung, {}, KEYS, controller.signal, IDLE_MS, readText, () => undefined);
  controller.abort(new Error("interrupted"));
  await expect(call).rejects.toThrow("interrupted");
  expect(sent).toBe(1);
});

test("a key whose accepted answer goes silent past the idle budget is cancelled, and the next key answers", async () => {
  const stalled = held(["data: {}\n\n"]);
  const answers = [stalled.response, new Response("the backup's answer")];
  const seen: string[] = [];
  const log: unknown[] = [];
  const answer = await postResponses(
    async (request) => {
      seen.push(request.headers.get("authorization") || "");
      return answers[seen.length - 1]!;
    },
    {},
    KEYS,
    live,
    50,
    readText,
    (line) => log.push(line),
  );
  expect(answer).toBe("the backup's answer");
  expect(seen).toEqual(KEYS.map((key) => `Bearer ${key}`));
  expect(String(stalled.cancelled)).toContain("the model stream stalled: nothing for 0.05 s");
  expect(log).toEqual([
    expect.objectContaining({ key: 1, error: expect.stringContaining("stalled") }),
  ]);
});

test("the idle budget starts with the request: a key that never answers stalls too", async () => {
  let sent = 0;
  const answer = await postResponses(
    async () => (++sent === 1 ? new Promise<Response>(() => undefined) : new Response("second")),
    {},
    KEYS,
    live,
    50,
    readText,
    () => undefined,
  );
  expect({ answer, sent }).toEqual({ answer: "second", sent: 2 });
});

test("every chunk an answer sends keeps it alive past the idle budget, and the caller's abort mid-answer tries no other key", async () => {
  const chunks = held([]);
  let sent = 0;
  const controller = new AbortController();
  const call = postResponses(
    async () => {
      sent += 1;
      return chunks.response;
    },
    {},
    KEYS,
    controller.signal,
    50,
    readText,
    () => undefined,
  );
  // 150 ms, three budgets, with a keepalive every 30 ms: never idle
  for (let tick = 0; tick < 5; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    chunks.push(": keepalive\n\n");
  }
  expect(chunks.cancelled).toBeUndefined();
  controller.abort(new Error("interrupted"));
  await expect(call).rejects.toThrow("interrupted");
  expect({ sent, cancelled: String(chunks.cancelled) }).toEqual({
    sent: 1,
    cancelled: "Error: interrupted",
  });
});

test("a streamed request rides the agent's socket, opened once and kept for the next, and reads as the HTTP stream would", async () => {
  const key = 'getSecret("/secrets/socket")';
  const { send, upgrades, posts, sockets } = openAi(() => [
    { type: "response.created" },
    { type: "response.output_text.delta", delta: "hi" },
    { type: "response.completed", response: { output: [] } },
  ]);
  const body = { model: "gpt-test", temperature: 1, stream: true, prompt_cache_key: "/agents/s" };
  const first = await postResponses(send, body, [key], live, IDLE_MS, readText);
  expect(first).toBe(
    [
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.completed", response: { output: [] } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
  );
  await postResponses(send, body, [key], live, IDLE_MS, readText);
  expect({ upgrades, posts }).toEqual({
    upgrades: [{ authorization: `Bearer ${key}`, session: "/agents/s" }],
    posts: 0,
  });
  // the HTTP body less the transport's own field, as the socket protocol takes it
  expect(sockets[0]?.sent).toEqual([
    { type: "response.create", model: "gpt-test", prompt_cache_key: "/agents/s" },
    { type: "response.create", model: "gpt-test", prompt_cache_key: "/agents/s" },
  ]);
  sockets[0]?.close();
});

test("a refused upgrade, or an error before the answer begins, sends the request over HTTP", async () => {
  const body = { stream: true, prompt_cache_key: "/agents/h" };
  const refused = openAi("refuse");
  const key = 'getSecret("/secrets/refused")';
  expect(await postResponses(refused.send, body, [key], live, IDLE_MS, readText)).toBe(
    "answered over HTTP",
  );
  // a refused key goes over HTTP alone for a while: no second upgrade
  await postResponses(refused.send, body, [key], live, IDLE_MS, readText);
  expect({ upgrades: refused.upgrades.length, posts: refused.posts }).toEqual({
    upgrades: 1,
    posts: 2,
  });

  const failing = openAi(() => [{ type: "error", status: 401, error: { message: "expired" } }]);
  const answer = await postResponses(
    failing.send,
    body,
    ['getSecret("/secrets/e")'],
    live,
    IDLE_MS,
    readText,
  );
  expect({ answer, posts: failing.posts }).toEqual({ answer: "answered over HTTP", posts: 1 });
  expect(failing.sockets[0]?.closed).toBe(true);
});

test("a socket that closes during the answer fails that key's attempt, and the next request opens another", async () => {
  const { send, upgrades, sockets } = openAi((socket) => {
    setTimeout(() => socket.close()); // after the answer has begun
    return [{ type: "response.created" }];
  });
  const body = { stream: true, prompt_cache_key: "/agents/c" };
  const key = 'getSecret("/secrets/closing")';
  // its code, its age (whatever the clock read) and which of its requests it carried
  await expect(
    postResponses(send, body, [key], live, IDLE_MS, readText, () => undefined),
  ).rejects.toThrow(
    /the socket closed during the answer \(1006; open \d+\.\d s, request 1 on it\)/,
  );
  await postResponses(send, body, [key], live, IDLE_MS, readText, () => undefined).catch(
    () => undefined,
  );
  expect({ upgrades: upgrades.length, closed: sockets[0]?.closed }).toEqual({
    upgrades: 2,
    closed: true,
  });
});

const KEYS = ['getSecret("/secrets/plan", { field: "accessToken" })', 'getSecret("/secrets/key")'];

/** OpenAI behind egress: an upgrade answers a socket whose every request `reply` answers with
 *  events ("refuse": no socket), and a POST answers 200. */
function openAi(reply: ((socket: FakeSocket) => unknown[]) | "refuse") {
  const upgrades: Array<{ authorization: string | null; session: string | null }> = [];
  const sockets: FakeSocket[] = [];
  const counts = { posts: 0 };
  const send = async (request: Request) => {
    if (request.headers.get("upgrade") !== "websocket") {
      counts.posts += 1;
      return new Response("answered over HTTP", { status: 200 });
    }
    upgrades.push({
      authorization: request.headers.get("authorization"),
      session: request.headers.get("session_id"),
    });
    if (reply === "refuse") return new Response("no upgrade", { status: 426 });
    const socket = new FakeSocket(reply);
    sockets.push(socket);
    return Object.assign(new Response(null, { status: 200 }), { webSocket: socket });
  };
  return {
    send,
    upgrades,
    sockets,
    get posts() {
      return counts.posts;
    },
  };
}

type SocketEvent = { data?: string; code?: number; reason?: string };

/** The part of a Workers WebSocket the key stack uses: each request it is sent is answered with
 *  `reply`'s events, one message each. */
class FakeSocket {
  sent: unknown[] = [];
  closed = false;
  readonly #listeners = new Map<string, Array<(event: SocketEvent) => void>>();
  readonly #reply: (socket: FakeSocket) => unknown[];
  constructor(reply: (socket: FakeSocket) => unknown[]) {
    this.#reply = reply;
  }
  accept() {}
  addEventListener(type: string, listener: (event: SocketEvent) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
    const events = this.#reply(this);
    queueMicrotask(() => {
      for (const event of events) this.#emit("message", { data: JSON.stringify(event) });
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.#emit("close", { code: 1006, reason: "" });
  }
  #emit(type: string, event: SocketEvent) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

/** An egress that answers each request with the next of `answers` (a status, or a throw). */
function egress(...answers: Array<number | Error>) {
  const seen: Array<{ authorization: string | null; session: string | null; body: unknown }> = [];
  return {
    seen,
    send: async (request: Request) => {
      seen.push({
        authorization: request.headers.get("authorization"),
        session: request.headers.get("session_id"),
        body: JSON.parse(await request.text()),
      });
      const answer = answers[seen.length - 1];
      if (answer instanceof Error) throw answer;
      return new Response(`answer ${String(answer)}`, { status: answer });
    },
  };
}

/** A reader cut to the contract the processor's keeps with the key stack: a non-2xx answer fails the
 *  attempt, and every chunk of a 2xx one is a sign of life until the body ends. */
async function readText(response: Response, { signal, alive }: StreamAttempt): Promise<string> {
  if (!response.ok) throw new Error(`${String(response.status)}: ${await response.text()}`);
  const reader = response.body!.getReader();
  signal.addEventListener("abort", () => void reader.cancel(signal.reason).catch(() => undefined));
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read().catch((error: unknown) => {
      throw signal.aborted ? signal.reason : error;
    });
    if (signal.aborted) throw signal.reason;
    if (done) return text;
    alive();
    text += decoder.decode(value, { stream: true });
  }
}

/** A 200 whose body sends `chunks`, then whatever `push` adds, and never ends; `cancelled` is the
 *  reason its reader cancelled it with. */
function held(chunks: string[]) {
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const watch: { cancelled?: unknown } = {};
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      },
      cancel(reason) {
        watch.cancelled = reason;
      },
    }),
  );
  return {
    response,
    push: (chunk: string) => stream.enqueue(encoder.encode(chunk)),
    get cancelled() {
      return watch.cancelled;
    },
  };
}
