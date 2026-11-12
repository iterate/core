// rpc.ts — TELEMETRY AS THE BOUNDARY CALLS IT: the `Telemetry` entrypoint, which is
// `TelemetryService` (iterate/workers). It answers a mind's query, lands its events and writes its
// metrics.
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { codedError } from "iterate/lib";
import type { TelemetryService } from "iterate/workers";
import { readBounded, ROW_MAX_BYTES, sends, sized } from "./bounds.ts";
import type { Env } from "./env.ts";
import { type EventsRow, eventsRow } from "./events-row.ts";
import { scoped } from "./query.ts";

export class Telemetry extends WorkerEntrypoint<Env> implements TelemetryService {
  async query(...[sql, hours]: Parameters<TelemetryService["query"]>) {
    const run = scoped(
      sql,
      { own: this.env.OWN_WORKERS.split(","), metricsDataset: this.env.METRICS_DATASET },
      hours,
    );
    const started = Date.now();
    let outcome: number | string = "unanswered";
    try {
      const rows = await this.#rows(run);
      outcome = rows.length;
      return { rows, sql: run.sql };
    } catch (error) {
      outcome = String(error);
      throw error;
    } finally {
      const ms = Date.now() - started;
      console.log({ event: "telemetry.query", engine: run.engine, ms, outcome });
    }
  }

  /** A failed send throws and the whole batch comes again, so a row may land twice (dedupe on path
   *  and offset). A row over ROW_MAX_BYTES would hold every later event back: it is dropped. */
  async sendEvents(events: Parameters<TelemetryService["sendEvents"]>[0]) {
    const worker = this.env.MIND_WORKER;
    const rows: { row: EventsRow; bytes: number }[] = [];
    let dropped = 0;
    for (const event of events) {
      const row = sized(eventsRow(event, worker));
      if (row.bytes > ROW_MAX_BYTES) dropped++;
      else rows.push(row);
    }
    if (dropped > 0)
      console.warn({
        event: "telemetry.events-dropped",
        message: "rows over 1 MB, which no stream takes, never reach the events table",
        count: dropped,
      });
    for (const chunk of sends(rows)) await this.env.EVENTS.send(chunk);
  }

  async writeMetrics(points: Parameters<TelemetryService["writeMetrics"]>[0]) {
    for (const point of MetricPoints.parse(points)) this.env.METRICS.writeDataPoint(point);
  }

  async #rows(run: ReturnType<typeof scoped>): Promise<Record<string, unknown>[]> {
    const account = this.env.ACCOUNT_ID;
    const bucket = this.env.TELEMETRY_BUCKET;
    if (run.engine === "metrics") {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${this.env.TELEMETRY_ANALYTICS_TOKEN}` },
          body: run.sql,
          signal: AbortSignal.timeout(30_000),
        },
      );
      const text = await boundedText(response);
      // a refusal is plain text, not JSON
      const answer = MetricsAnswer.safeParse(jsonOrUndefined(text));
      if (response.ok && answer.success) return answer.data.data;
      const why = `Analytics Engine SQL ${response.status}: ${text.slice(0, 300)}`;
      throw response.status === 422 || response.status === 400
        ? codedError("INVALID_INPUT", why)
        : new Error(why);
    }
    const response = await fetch(
      `https://api.sql.cloudflarestorage.com/api/v1/accounts/${account}/basin-sql/query/${bucket}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.env.TELEMETRY_CATALOG_TOKEN}` },
        body: JSON.stringify({ query: run.sql }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = BasinAnswer.safeParse(jsonOrUndefined(await boundedText(response)));
    if (response.ok && body.data?.result) return body.data.result.rows;
    const why = `Basin SQL ${response.status}: ${body.data?.errors?.map((e) => e.message).join("; ")}`;
    // a 400 is the query's own (Basin's `invalid query`): it fails the same asked again
    throw response.status === 400 ? codedError("INVALID_INPUT", why) : new Error(why);
  }
}

// 1,000 rows of the widest table, each cut at 96 KiB of text (otlp.ts), stay under it
const ANSWER_MAX_BYTES = 8 * 1024 * 1024;

async function boundedText(response: Response): Promise<string> {
  const read = await readBounded(response.body, ANSWER_MAX_BYTES);
  if (!read)
    throw codedError(
      "INVALID_INPUT",
      `itx.telemetry.query: the answer is over ${ANSWER_MAX_BYTES} bytes: select fewer columns or rows`,
    );
  return read.text;
}

const MetricsAnswer = z.object({ data: z.array(z.record(z.string(), z.unknown())) });

// at most what one Analytics Engine data point takes
const MetricPoints = z.array(
  z.object({
    indexes: z.array(z.string().max(96)).max(1).optional(),
    blobs: z.array(z.string()).max(20).optional(),
    doubles: z.array(z.number()).max(20).optional(),
  }),
);

const BasinAnswer = z.object({
  result: z.object({ rows: z.array(z.record(z.string(), z.unknown())) }).optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

function jsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
