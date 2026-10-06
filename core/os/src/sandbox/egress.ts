// src/sandbox/egress.ts — THE SANDBOX'S WAY OUT: every HTTP and HTTPS request a container makes is
// answered by `SandboxEgress`, which is the project's own `itx.fetch` (context/egress.ts, through the
// project's rewrite rules): `getSecret("/secrets/…")` placeholders are substituted there, a project
// that rewrote `itx.fetch` answers its sandbox's requests with that, and the platform's own checks
// apply as to any other fetch of the project. The container starts with `enableInternet: false`, so
// nothing leaves any other way (container.ts `#intercept`); DNS answers only for the names this
// handler is registered for, which is every one of them.
//
// THE CALL IS A CALL, never a request to the context's own `fetch`: that one routes on headers
// (`x-itx-expression` names an itx expression and runs it as the caller; a lend header asks for a
// borrowed secret), and a container controls every header it sends. `invoke(["itx", ["fetch", …]])` takes
// the request as an argument and nothing else from it.
import { WorkerEntrypoint } from "cloudflare:workers";
import { contextStub } from "../context-stub.ts";
import { DurableObjectNameCodec } from "../context/paths.ts";
import type { Env } from "../iterate-context-durable-object.ts";

/** What a request from a sandbox's container is answered by. Minted from the container's Durable
 *  Object (`ctx.exports.SandboxEgress({ props })`) with the sandbox's context as props, which the
 *  container cannot reach. */
export class SandboxEgress extends WorkerEntrypoint<Env, { iterateContextName: string }> {
  override async fetch(request: Request): Promise<Response> {
    const address = DurableObjectNameCodec.parse(this.ctx.props.iterateContextName);
    // the platform's own call, as the project's code: no principal speaks for it
    const answer = await contextStub(this.env.ITERATE_CONTEXT, address, "sandbox-egress").invoke(
      ["itx", ["fetch", request]],
      [],
      { principal: null, path: address.path },
    );
    // `invoke` is untyped over RPC; the context's `fetch` answers the `Response` it was given
    return withKnownLength(answer as Response, request);
  }
}

/** The most of a body this entrypoint holds in memory to learn its length. */
const BUFFER_UP_TO_BYTES = 32 * 1024 * 1024;

/** A response the container's HTTP clients can frame. Cloudflare's interception answers a response of
 *  unknown length close-delimited (`Connection: close`, no `Content-Length`), which Node's `fetch`
 *  reads and `apt` does not: it saves an empty file and says "NOSPLIT" (measured on a preview). So a
 *  body of a known length is passed through a `FixedLengthStream`, still streaming; one of no known
 *  length is read, up to BUFFER_UP_TO_BYTES, to learn it, unless it is a stream by nature
 *  (`text/event-stream`), which must not wait for its end. A body past the limit streams on, as it
 *  came: an unknown length, as before. */
async function withKnownLength(response: Response, request: Request): Promise<Response> {
  const { status, headers, body } = response;
  const bodiless =
    !body || request.method === "HEAD" || status === 101 || status === 204 || status === 304;
  if (bodiless) return response;
  const declared = Number(headers.get("content-length"));
  if (headers.has("content-length") && Number.isSafeInteger(declared) && declared >= 0) {
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
      const known = new Response(whole, response);
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
      return new Response(rest, response);
    }
  }
}
