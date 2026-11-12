// worker.ts — THE BOUNDARY, for a stack whose mind is a Worker: the one Worker with routes. It
// composes the request policy (./http.ts), the mail handlers (./mail.ts, ./mail-outcomes.ts), the
// repos' events (./artifacts-events.ts) and the mind's service binding (./transport/bound.ts).
// ./worker.provided.ts is the build for a mind that runs elsewhere.
import type { Env } from "./env.ts";
import { boundaryResponse } from "./http.ts";
import { receivedMail } from "./mail.ts";
import { artifactsRows } from "./artifacts-events.ts";
import { cloudflareEvents } from "./cloudflare-events.ts";
import { mailRows } from "./mail-outcomes.ts";
import { boundMind } from "./transport/bound.ts";

export { Door } from "./rpc.ts";

export default {
  fetch: (request, env, ctx) => boundaryResponse(request, env, ctx, boundMind(env)),
  // A failure throws, so Cloudflare delivers the mail again; the fact's idempotency key keeps a retry
  // after a committed append from landing twice.
  email: (message, env) => receivedMail(message, env, boundMind(env)),
  // The stack's one queue of Cloudflare events (./cloudflare-events.ts): a row for each kind.
  queue: (batch, env) =>
    cloudflareEvents(batch, boundMind(env), {
      ...mailRows,
      ...artifactsRows({ namespace: env.REPOS_NAMESPACE }),
    }),
} satisfies ExportedHandler<Env>;
