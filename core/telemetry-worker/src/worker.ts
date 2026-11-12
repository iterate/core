// worker.ts — THE TELEMETRY WORKER. It composes the answer to Cloudflare's OpenTelemetry export
// (./http.ts) and the entrypoint that the boundary calls (./rpc.ts).
import type { Env } from "./env.ts";
import { otlpResponse } from "./http.ts";

export { Telemetry } from "./rpc.ts";

export default {
  fetch: (request, env) => otlpResponse(request, env),
} satisfies ExportedHandler<Env>;
