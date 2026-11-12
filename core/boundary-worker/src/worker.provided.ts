// worker.provided.ts — THE BOUNDARY, for a stack whose mind runs elsewhere (core/home-lab): the
// same request policy (./http.ts) and mail handler (./mail.ts) as ./worker.ts, with the mind
// reached through the session it dials at `/provide` (./transport/provided.ts). A build of its
// own, so that the kernel this one runs stays out of the other.
import { IterateContextDurableObject } from "core-itx";
import { boundaryResponse } from "./http.ts";
import { receivedMail } from "./mail.ts";
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
} satisfies ExportedHandler<Cloudflare.Env>;
