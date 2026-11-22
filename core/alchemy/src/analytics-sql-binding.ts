// analytics-sql-binding.ts — THE ANALYTICS SQL BINDING OF A WORKER: Cloudflare's Analytics SQL over
// the Worker's whole account, with no API token (https://developers.cloudflare.com/analytics/sql-api/workers-binding/).
// Alchemy 2.0.0-beta.87 has no form of it, so it goes into the Worker's metadata as Wrangler
// 4.166.0 writes the config key `analytics`: `{ type: "analytics", name }`, and nothing else. The
// Worker's own `bind` adds it beside what its `env` declares. Remove this file once Alchemy
// declares the binding itself.
import type * as Cloudflare from "@alchemy.run/cloudflare";

export const bindAnalyticsSql = (worker: Cloudflare.Worker, name: string) =>
  worker.bind(name, {
    // The SDK's binding union is generated from Cloudflare's API schema, which does not list this
    // type yet; the upload schema passes a binding's fields through as they are.
    bindings: [{ type: "analytics", name } as unknown as Cloudflare.WorkerBinding],
  });
