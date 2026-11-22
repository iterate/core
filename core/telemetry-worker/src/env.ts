// env.ts — THE TELEMETRY WORKER'S BINDINGS, as core/alchemy/src/stack.ts makes them.
import type { Pipeline } from "cloudflare:pipelines";
import type { EventsRow } from "./events-row.ts";
import type { LogRow, SpanRow } from "./otlp.ts";

export type Env = {
  /** The config that every Worker of the mind gets, with this Worker's own fields, as JSON, and
   *  its secrets beside it (./config.ts reads them all). A secret is never returned or logged. */
  ITERATE: string;
  ITERATE__OTLP_SECRET: string;
  ITERATE__CATALOG_TOKEN?: string;
  /** Cloudflare's Analytics SQL over the whole account, with no token (./store-query.ts cuts it). */
  ANALYTICS: AnalyticsSQLBinding;
  LOGS: Pipeline<LogRow>;
  SPANS: Pipeline<SpanRow>;
  EVENTS: Pipeline<EventsRow>;
  METRICS: AnalyticsEngineDataset;
};
