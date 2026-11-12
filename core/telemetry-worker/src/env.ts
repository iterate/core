// env.ts — THE TELEMETRY WORKER'S BINDINGS, as core/alchemy/src/stack.ts `telemetryPart` makes them.
import type { Pipeline } from "cloudflare:pipelines";
import type { EventsRow } from "./events-row.ts";
import type { LogRow, SpanRow } from "./otlp.ts";

export type Env = {
  ACCOUNT_ID: string;
  TELEMETRY_BUCKET: string;
  METRICS_DATASET: string;
  /** Comma-separated: the mind's own Workers, whose rows its queries read whole. */
  OWN_WORKERS: string;
  MIND_WORKER: string;
  TELEMETRY_OTLP_SECRET: string;
  TELEMETRY_CATALOG_TOKEN: string;
  TELEMETRY_ANALYTICS_TOKEN: string;
  LOGS: Pipeline<LogRow>;
  SPANS: Pipeline<SpanRow>;
  EVENTS: Pipeline<EventsRow>;
  METRICS: AnalyticsEngineDataset;
};
