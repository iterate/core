// responses-keys.ts — the agent's model call with a stack of API keys, for a project that brings its
// own credentials instead of the deployment's AI Gateway (`llm.apiKeys`, contract.ts).
//
// A key is the text that follows `Bearer `: normally a `getSecret("/secrets/…")` placeholder, which
// egress swaps for the secret's value on the way to api.openai.com, so no key is ever in this code.
// Any key a ChatGPT plan or an API key holds works, because every key gets the same body.
//
// Requests go out through the loaded isolate's own `fetch`, which is egress, as the voice agent dials
// GPT-Live: it carries a WebSocket back, where `itx.fetch` (a Workers-RPC call) cannot. A streamed
// request rides the agent's open Responses WebSocket when it can (`viaSocket`): OpenAI accepts a
// plan token's HTTP request after about 1.5 s, and a request on an open socket after about 0.3 s
// (measured 2026-10-10). An API key's HTTP request waits far less: there the socket saves little.

import { z } from "zod";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
/** A server event on the agent's socket, as far as `viaSocket` reads it; anything else is
 *  skipped. */
const SocketEvent = z.looseObject({ type: z.string() });

/** Request fields OpenAI refuses when the key is a ChatGPT plan's token
 *  (https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). An API key
 *  accepts all of them, so dropping them costs nothing there. */
const REFUSED_BY_PLAN_TOKENS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

/** The body every key in the stack takes: the strictest key's rules. A plan's token refuses the
 *  fields above, and an explicit `prompt_cache_breakpoint` ("not supported on this model"); the
 *  implicit breakpoints after each message and result stay. */
export function bodyForKeys(body: Record<string, unknown>): Record<string, unknown> {
  const kept = Object.fromEntries(
    Object.entries(body).filter(([field]) => !REFUSED_BY_PLAN_TOKENS.includes(field)),
  );
  return JSON.parse(
    JSON.stringify(kept, (field, value: unknown) =>
      field === "prompt_cache_breakpoint" ? undefined : value,
    ),
  );
}

/** One Responses API request, sent with each key in turn until one answers 2xx. A key that answers
 *  anything else, or throws (its secret is missing), is logged by its position and skipped. When
 *  none answers 2xx, the last failed answer comes back unread, so the caller reports what OpenAI
 *  said; a stack that only threw rethrows its last error. `signal` is the turn's: once it aborts, the request in
 * flight is abandoned and no later key is sent. `send` is the isolate's `fetch` (egress). */
export async function postResponses(
  send: (request: Request) => Promise<Response>,
  body: Record<string, unknown>,
  apiKeys: readonly string[],
  signal: AbortSignal,
  log: (message: string) => void = console.warn,
): Promise<Response> {
  const forKeys = bodyForKeys(body);
  const json = JSON.stringify(forKeys);
  // A plan's token reads a cached prefix only within a session: without one, an agent's turns read
  // none of the turn before. An API key ignores it. The session also names the agent's socket.
  const session = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined;
  let failure: Response | undefined;
  let thrown: unknown;
  for (const [position, apiKey] of apiKeys.entries()) {
    const label = `API key ${String(position + 1)} of ${String(apiKeys.length)}`;
    // An abort ends the call: no later key is tried for a turn that was cancelled or expired.
    if (signal.aborted) throw signal.reason || new Error("aborted");
    try {
      // anything the socket cannot do, this key's request does over HTTP
      const streamed =
        body.stream === true && session
          ? await viaSocket(send, apiKey, session, forKeys, signal).catch((error: unknown) => {
              if (signal.aborted) throw error;
              return undefined;
            })
          : undefined;
      if (streamed) return streamed;
      const response = await raceAbort(
        signal,
        send(
          new Request(RESPONSES_URL, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
              ...(typeof body.prompt_cache_key === "string" && {
                session_id: body.prompt_cache_key,
              }),
            },
            body: json,
          }),
        ),
      );
      if (response.ok) return response;
      log(`[agent] ${label} answered ${String(response.status)}`);
      await failure?.body?.cancel();
      failure = response;
    } catch (error) {
      if (signal.aborted) throw error;
      log(`[agent] ${label} threw: ${String(error)}`);
      thrown = error;
    }
  }
  if (failure) return failure;
  throw thrown ?? new Error("llm.apiKeys is empty");
}

/** How long an agent's socket stays open after its last answer: the next step of a reply finds it
 *  open, and an idle agent's facet is not kept running by it for longer. */
const SOCKET_IDLE_MS = 60_000;

/** An agent's open Responses WebSocket, and the handlers of the request it carries, if any. */
type AgentSocket = {
  socket: WebSocket;
  /** When it opened, and how many requests it has carried: what a failure reports. */
  openedAt: number;
  requests: number;
  onMessage?: (text: string) => void;
  /** With how it closed: its code and reason, or "error". */
  onClose?: (how: string) => void;
  idle?: ReturnType<typeof setTimeout>;
};

/** Each agent's socket, by key and session (the agent's path), and the keys whose upgrade was
 *  refused, which go over HTTP alone until the time noted. */
const sockets = new Map<string, AgentSocket>();
const refusedUntil = new Map<string, number>();

/** `body` on the agent's socket for `apiKey` (wss://api.openai.com/v1/responses, opened on first
 *  use), answered as the HTTP request would be: a Response whose body is the same server-sent
 *  events. Undefined when the socket cannot carry it: the upgrade refused, a request already in
 *  flight on it, an error before the response began (HTTP then answers with its status, and
 *  egress refreshes an expired token on a 401), or a socket that closed first. */
async function viaSocket(
  send: (request: Request) => Promise<Response>,
  apiKey: string,
  session: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response | undefined> {
  if ((refusedUntil.get(apiKey) ?? 0) > Date.now()) return undefined;
  const name = `${apiKey}\n${session}`;
  let held = sockets.get(name);
  if (held?.onMessage) return undefined;
  if (!held) {
    const upgrade = await raceAbort(
      signal,
      send(
        new Request(RESPONSES_URL, {
          headers: { upgrade: "websocket", authorization: `Bearer ${apiKey}`, session_id: session },
        }),
      ),
    );
    if (!upgrade.webSocket) {
      refusedUntil.set(apiKey, Date.now() + SOCKET_IDLE_MS);
      await upgrade.body?.cancel();
      return undefined;
    }
    const opened: AgentSocket = { socket: upgrade.webSocket, openedAt: Date.now(), requests: 0 };
    const gone = (how: string) => {
      if (sockets.get(name) === opened) sockets.delete(name);
      if (opened.idle !== undefined) clearTimeout(opened.idle);
      opened.onClose?.(how);
    };
    opened.socket.accept();
    opened.socket.addEventListener("message", (message) =>
      opened.onMessage?.(String(message.data)),
    );
    opened.socket.addEventListener("close", (event) =>
      gone(`${String(event.code)}${event.reason ? ` ${event.reason}` : ""}`),
    );
    opened.socket.addEventListener("error", () => gone("error"));
    sockets.set(name, (held = opened));
  }
  const socket = held;
  if (socket.idle !== undefined) clearTimeout(socket.idle);
  socket.requests += 1;
  let released = false;
  const release = (keep: boolean) => {
    if (released) return;
    released = true;
    socket.onMessage = socket.onClose = undefined;
    signal.removeEventListener("abort", drop);
    if (keep) socket.idle = setTimeout(() => closeQuietly(socket.socket), SOCKET_IDLE_MS);
    else {
      if (sockets.get(name) === socket) sockets.delete(name);
      closeQuietly(socket.socket);
    }
  };
  const drop = () => release(false);
  signal.addEventListener("abort", drop, { once: true });
  let began: (served: boolean) => void = () => undefined;
  const beginning = new Promise<boolean>((resolve) => (began = resolve));
  let streaming = false;
  const encoder = new TextEncoder();
  const events = new ReadableStream<Uint8Array>({
    start(controller) {
      socket.onMessage = (text) => {
        let type: string;
        try {
          ({ type } = SocketEvent.parse(JSON.parse(text)));
        } catch {
          return;
        }
        if (!streaming) {
          streaming = type !== "error";
          if (!streaming) release(false);
          began(streaming);
          if (!streaming) return;
        }
        controller.enqueue(encoder.encode(`data: ${text}\n\n`));
        const last =
          type === "response.completed" ||
          type === "response.incomplete" ||
          type === "response.failed" ||
          type === "error";
        if (last) {
          controller.close();
          release(type !== "error");
        }
      };
      // the close code says whose side closed: 1006 a hop on the way, 1000/1001/1011 OpenAI
      socket.onClose = (how) => {
        release(false);
        const age = ((Date.now() - socket.openedAt) / 1000).toFixed(1);
        if (streaming)
          controller.error(
            new Error(
              `openai: the socket closed during the answer (${how}; open ${age} s, request ${String(socket.requests)} on it)`,
            ),
          );
        else began(false);
      };
    },
    cancel: () => release(false),
  });
  try {
    // a socket's request is the HTTP body without the transport's own field. It resends the whole
    // input: only the new items, with `previous_response_id`, measured no faster, since the prompt
    // cache covers the rest.
    socket.socket.send(JSON.stringify({ type: "response.create", ...body, stream: undefined }));
  } catch {
    release(false);
    return undefined;
  }
  if (!(await raceAbort(signal, beginning))) return undefined;
  return new Response(events, { headers: { "content-type": "text/event-stream" } });
}

/** Close `socket`, which may be closed already. */
function closeQuietly(socket: WebSocket) {
  try {
    socket.close();
  } catch {
    // already closed
  }
}

/** Race an un-abortable dial against the caller's signal: the caller regains control the moment it
 *  aborts (an interruption, the expiry, the idle watchdog). A Response or stream the orphaned dial
 *  answers after that is cancelled, so the provider stops and no unread body holds the edge's
 *  invocation open; a stream already open is cancelled by `drainSse` itself. */
export function raceAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  const cancelLateBody = () =>
    void work.then(
      (late) => {
        const body = late instanceof Response ? late.body : late;
        if (body instanceof ReadableStream) void body.cancel(signal.reason).catch(() => undefined);
      },
      () => undefined,
    );
  if (signal.aborted) {
    cancelLateBody();
    return Promise.reject(signal.reason || new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason || new Error("aborted"));
      cancelLateBody();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // The listener goes in the same turn the dial settles: an answer handed over is its reader's.
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
