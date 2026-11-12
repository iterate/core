// worker.ts — THE AUTH WORKER. It composes the entrypoint that the stack's other Workers call
// (./rpc.ts), which answers requests through ./http.ts. It has no route of its own.
import type { Env } from "./env.ts";

export { Auth } from "./rpc.ts";

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;
