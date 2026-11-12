// worker.ts — THE BOUNDARY, for a stack whose mind is a Worker: the one Worker with routes. It
// composes the request policy (./http.ts), the mail handler (./mail.ts) and the mind's service
// binding (./transport/bound.ts). ./worker.provided.ts is the build for a mind that runs elsewhere.
import type { Env } from "./env.ts";
import { boundaryResponse } from "./http.ts";
import { receivedMail } from "./mail.ts";
import { boundMind } from "./transport/bound.ts";

export { Door } from "./rpc.ts";

export default {
  fetch: (request, env, ctx) => boundaryResponse(request, env, ctx, boundMind(env)),
  // A failure throws, so Cloudflare delivers the mail again; the fact's idempotency key keeps a retry
  // after a committed append from landing twice.
  email: (message, env) => receivedMail(message, env, boundMind(env)),
} satisfies ExportedHandler<Env>;
