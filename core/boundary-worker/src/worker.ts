// worker.ts — THE BOUNDARY: the one Worker with routes, one build for every topology. It composes
// the request policy (./http.ts), the mail handlers (./mail.ts, ./mail-outcomes.ts), the repos'
// events (./artifacts-events.ts) and the way to the mind that the config's topology names
// (./mind-transport.ts): the mind Worker, or a mind that runs elsewhere and handed itself in
// (./provided-mind.ts).
import { requestWithOwnedBody } from "core-itx/request-body";
import type { Env } from "./env.ts";
import { boundaryResponse } from "./http.ts";
import { receivedMail } from "./mail.ts";
import { artifactsRows } from "./artifacts-events.ts";
import { cloudflareEvents } from "./cloudflare-events.ts";
import { mailRows } from "./mail-outcomes.ts";
import { mindTransportOf } from "./mind-transport.ts";

// A Durable Object binding names a class that the Worker's main module exports.
export { ProvidedMind } from "./provided-mind.ts";
export { Door } from "./rpc.ts";

export default {
  // The body goes on to the mind or the auth Worker, which may answer without reading it: this
  // invocation reads it itself (core-itx/request-body).
  fetch: (request, env, ctx) =>
    boundaryResponse(requestWithOwnedBody(request, "boundary"), env, ctx, mindTransportOf(env)),
  // The mind stores the mail, then its config's `email` hook runs (./mail.ts says the order). A
  // failure to store throws, so Cloudflare delivers the mail again: a mind that runs elsewhere and
  // is not connected is such a failure. The fact's idempotency key keeps a retry after a committed
  // append from landing twice. Nothing the hook does fails the delivery.
  email: (message, env) => receivedMail(message, env, mindTransportOf(env)),
  // The stack's one queue of Cloudflare events (./cloudflare-events.ts): a row for each kind. An
  // event for a mind that is not connected is retried until it is, or the consumer's retries run
  // out. A mind that runs elsewhere keeps its repos where it runs, so no event of a repo comes.
  queue: (batch, env) =>
    cloudflareEvents(batch, mindTransportOf(env), { ...mailRows, ...artifactsRows }),
} satisfies ExportedHandler<Env>;
