// worker.ts — THE SECRETS WORKER. It composes the two entrypoints that the stack's other Workers
// call (./rpc.ts, which answers requests through ./http.ts) and the classes that Cloudflare makes by
// name. It has no route of its own.
import type { Env } from "./env.ts";

// A Durable Object binding names a class the main module exports, and `ctx.exports` mints the
// jail's egress only for an export.
export { ActsGate } from "./acts-gate.ts";
export { ApprovalsIndex } from "./approvals-index.ts";
export { Secrets, SecretUse } from "./rpc.ts";
export { SecretDurableObject } from "./secret/durable-object.ts";
export { PinnedOutbound } from "./secret/exchange-jail.ts";

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;
