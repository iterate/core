// Every request a container makes is the project's own `itx.fetch`, as a call, never a request to
// the context's `fetch`: that one routes on headers, and a container controls every header it sends.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  contextAt,
  DurableObjectNameCodec,
  encodeFetchExpression,
  ITX_EXPRESSION_FETCH_HEADER,
  stampCallerHeaders,
} from "core-itx";
import type { Env } from "../env.ts";

/** Its props name the sandbox's context, which the container cannot reach. */
export class SandboxEgress extends WorkerEntrypoint<Env, { iterateContextName: string }> {
  override async fetch(request: Request): Promise<Response> {
    const { path } = DurableObjectNameCodec.parse(this.ctx.props.iterateContextName);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket")
      return this.#upgrade(request, path);
    const answer = await contextAt(path).invoke(["itx", ["fetch", request]], [], {
      principal: null,
      path,
    });
    // the context's `fetch` answers the `Response` it was given
    return withKnownLength(answer as Response, request);
  }

  /** workerd's RPC cannot carry a Response that holds a socket, so a handshake takes the context's
   *  `fetch`. That one believes `x-itx-*` stamps, so the container's are dropped and ours set. */
  async #upgrade(request: Request, path: string): Promise<Response> {
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()])
      if (/^x-(itx|iterate)-/i.test(name)) headers.delete(name);
    stampCallerHeaders(headers, { principal: null, path });
    headers.set(ITX_EXPRESSION_FETCH_HEADER, encodeFetchExpression(["itx"]));
    const answer = await contextAt(path).fetch(new Request(request, { headers }));
    if (answer.status !== 101 || !answer.webSocket) return answer;
    // The interception adds its own hop-by-hop `Upgrade` and `Connection`; two of each is refused by
    // a strict client such as Node's WebSocket.
    const answered = new Headers(answer.headers);
    answered.delete("upgrade");
    answered.delete("connection");
    return new Response(null, { status: 101, webSocket: answer.webSocket, headers: answered });
  }
}

const BUFFER_UP_TO_BYTES = 32 * 1024 * 1024;

/** The interception answers a response of unknown length close-delimited, which `apt` reads as an
 *  empty file, so the length is learned, up to BUFFER_UP_TO_BYTES; an event stream must not wait.
 *  `fetch` decodes gzip and Brotli but keeps the compressed `Content-Length`, so a decoded body has no
 *  known length. */
async function withKnownLength(response: Response, request: Request): Promise<Response> {
  const { status, headers, body } = response;
  const bodiless =
    !body || request.method === "HEAD" || status === 101 || status === 204 || status === 304;
  if (bodiless) return response;
  const decoded = /^(gzip|br)$/i.test(headers.get("content-encoding") ?? "");
  const answer = (bytes: BodyInit) => {
    const plain = new Response(bytes, response);
    if (decoded) {
      plain.headers.delete("content-encoding");
      plain.headers.delete("content-length");
    }
    return plain;
  };
  const declared = Number(headers.get("content-length"));
  if (
    !decoded &&
    headers.has("content-length") &&
    Number.isSafeInteger(declared) &&
    declared >= 0
  ) {
    const { readable, writable } = new FixedLengthStream(declared);
    void body.pipeTo(writable).catch(() => undefined);
    return new Response(readable, response);
  }
  if (headers.get("content-type")?.startsWith("text/event-stream")) return response;
  const reader = body.getReader();
  const held: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      const whole = new Uint8Array(size);
      let at = 0;
      for (const chunk of held) {
        whole.set(chunk, at);
        at += chunk.byteLength;
      }
      const known = answer(whole);
      known.headers.set("content-length", String(size));
      return known;
    }
    held.push(value);
    size += value.byteLength;
    if (size > BUFFER_UP_TO_BYTES) {
      const rest = new ReadableStream<Uint8Array>({
        start: (controller) => {
          for (const chunk of held) controller.enqueue(chunk);
        },
        pull: async (controller) => {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel: () => reader.cancel(),
      });
      return answer(rest);
    }
  }
}
