// worker.provided.ts — THE BOUNDARY, for a stack whose mind runs elsewhere (core/home-lab): the
// same request policy (./http.ts) and mail handlers (./mail.ts, ./mail-outcomes.ts) as ./worker.ts, with the mind
// reached through the session it dials at `/provide` (./transport/provided.ts). A build of its
// own, so that the kernel this one runs stays out of the other.
import { IterateContextDurableObject } from "core-itx";
import { boundaryResponse } from "./http.ts";
import { receivedMail } from "./mail.ts";
import { cloudflareEvents } from "./cloudflare-events.ts";
import { mailRows } from "./mail-outcomes.ts";
import { providedMind, serveProvide } from "./transport/provided.ts";

// A Durable Object binding names a class the Worker's main module exports.
export { IterateContextDurableObject };
export { Door } from "./rpc.ts";

export default {
  fetch: (request, env, ctx) =>
    boundaryResponse(request, env, ctx, providedMind(ctx), (upgrade, domain) =>
      serveProvide(upgrade, env, ctx, domain),
    ),
  // A failure throws, so Cloudflare delivers the mail again: with no mind provided, the root finds
  // no stub. The fact's idempotency key keeps a retry from landing twice.
  email: (message, env, ctx) => receivedMail(message, env, providedMind(ctx)),
  // With no mind provided, each event is retried until it is or the consumer's retries run out.
  // Mail's rows alone: a provided mind keeps its repos where it runs, not in Artifacts.
  queue: (batch, _env, ctx) => cloudflareEvents(batch, providedMind(ctx), mailRows),
} satisfies ExportedHandler<Cloudflare.Env>;
