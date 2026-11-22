// rpc.ts — TELEMETRY AS THE BOUNDARY CALLS IT: the `Telemetry` entrypoint, which is
// `TelemetryService` (iterate/workers). It answers a mind's query, lands its events, counts them in
// `metrics` (./event-points.ts) and writes its metrics. A query over Cloudflare's own datasets
// (./store-query.ts) runs on the Analytics SQL binding with no token; one over the telemetry
// tables (./query.ts) needs the stack's token.
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { isTelemetryDatasetQuery } from "iterate/api";
import { codedError, errorCode } from "iterate/lib";
import type { TelemetryService } from "iterate/workers";
import { readBounded, ROW_MAX_BYTES, sends, sized } from "./bounds.ts";
import { telemetryWorkerConfigOf } from "./config.ts";
import type { Env } from "./env.ts";
import { writeEventPoints } from "./event-points.ts";
import { type EventsRow, eventsRow } from "./events-row.ts";
import { MAX_ROWS, scoped } from "./query.ts";
import { type StoreRun, storeQuery } from "./store-query.ts";

/** Plain sentence returned instead of an error when the stack holds no telemetry token. */
const TELEMETRY_TABLES_OFF =
  "telemetry tables are off: your mind can turn them on itself (onboarding/telemetry.md)";

export class Telemetry extends WorkerEntrypoint<Env> implements TelemetryService {
  async query(...[sql, hours]: Parameters<TelemetryService["query"]>) {
    const config = telemetryWorkerConfigOf(this.env);
    const own = config.workerNamesThatQueriesReadWhole;
    const run = isTelemetryDatasetQuery(String(sql))
      ? {
          engine: "store" as const,
          ...storeQuery(sql, { own, metricsDataset: config.metricsDatasetName }, hours),
        }
      : scoped(sql, { own }, hours);
    const started = Date.now();
    let outcome: number | string = "unanswered";
    let cloudflareCode: number | undefined;
    try {
      if (run.engine === "store") {
        const rows = await this.#storeRows(run);
        outcome = rows.length;
        return {
          rows,
          sql: run.query,
          dataset: run.dataset,
          ...(rows.length >= MAX_ROWS && { truncated: true as const }),
        };
      }
      const token = config.catalogToken;
      if (!token) {
        outcome = "off";
        // where this query goes, so the mind's own code can send it (iterate/api `TelemetrySend`)
        const send = {
          engine: "tables" as const,
          accountId: config.accountId,
          bucket: config.telemetryBucketName,
        };
        return { rows: [], sql: run.sql, notice: TELEMETRY_TABLES_OFF, send };
      }
      const rows = await this.#tableRows(run.sql, token.exposeSecret());
      outcome = rows.length;
      return { rows, sql: run.sql, ...(rows.length >= MAX_ROWS && { truncated: true as const }) };
    } catch (error) {
      // the code alone: an error's text may hold Cloudflare's words
      outcome = errorCode(error) ?? "failed";
      cloudflareCode = (error as { cloudflareCode?: number }).cloudflareCode;
      throw error;
    } finally {
      const ms = Date.now() - started;
      const dataset = run.engine === "store" ? run.dataset : undefined;
      console.log({
        event: "telemetry.query",
        engine: run.engine,
        dataset,
        ms,
        outcome,
        cloudflareCode,
      });
    }
  }

  /** A failed send throws and the whole batch comes again, so a row may land twice (dedupe on path
   *  and offset). A row over ROW_MAX_BYTES would hold every later event back: it is dropped from the
   *  stream, and still counted in `metrics`. The points go after the stream's sends, so a batch
   *  that comes again is counted once. */
  async sendEvents(events: Parameters<TelemetryService["sendEvents"]>[0]) {
    const worker = telemetryWorkerConfigOf(this.env).eventsWriterName;
    const all = events.map((event) => eventsRow(event, worker));
    const rows: { row: EventsRow; bytes: number }[] = [];
    let dropped = 0;
    for (const row of all.map(sized)) {
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
    writeEventPoints(this.env.METRICS, all);
  }

  async writeMetrics(points: Parameters<TelemetryService["writeMetrics"]>[0]) {
    for (const point of MetricPoints.parse(points)) this.env.METRICS.writeDataPoint(point);
  }

  /** The binding reads the whole account: `run` holds the cut to the mind's own rows. Cloudflare's
   *  own words never go on (`storeError`), and the answer is held to ANSWER_MAX_BYTES of JSON. */
  async #storeRows(run: StoreRun): Promise<Record<string, unknown>[]> {
    const answer = await this.env.ANALYTICS.query({ query: run.query, params: run.params }).catch(
      (error: unknown) => {
        throw storeError(error);
      },
    );
    const rows = answer.data.slice(0, MAX_ROWS);
    if (new TextEncoder().encode(JSON.stringify(rows)).byteLength > ANSWER_MAX_BYTES)
      throw answerTooLarge();
    return rows;
  }

  async #tableRows(sql: string, token: string): Promise<Record<string, unknown>[]> {
    const config = telemetryWorkerConfigOf(this.env);
    const response = await fetch(
      `https://api.sql.cloudflarestorage.com/api/v1/accounts/${config.accountId}/basin-sql/query/${config.telemetryBucketName}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const text = await boundedText(response);
    const body = BasinAnswer.safeParse(jsonOrUndefined(text));
    if (response.ok && body.data?.result) return body.data.result.rows;
    throw tablesError(response.status, body.data?.errors?.[0]?.code);
  }
}

// 1,000 rows of the widest table, each cut at 96 KiB of text (otlp.ts), stay under it
const ANSWER_MAX_BYTES = 8 * 1024 * 1024;

const answerTooLarge = () =>
  codedError(
    "INVALID_INPUT",
    `itx.telemetry.query: the answer is over ${ANSWER_MAX_BYTES} bytes: select fewer columns or rows`,
  );

async function boundedText(response: Response): Promise<string> {
  const read = await readBounded(response.body, ANSWER_MAX_BYTES);
  if (!read) throw answerTooLarge();
  return read.text;
}

/** The refusals of Cloudflare's Analytics SQL that the proofs met (22 Nov 2026), each read off
 *  Cloudflare's words and said in a fixed sentence of our own. */
const STORE_REFUSALS: [RegExp, string][] = [
  [
    /\bMAX is not supported on sampled datasets/i,
    "MAX is not supported on a sampled dataset: use APPROX_MAX",
  ],
  [
    /\bMIN is not supported on sampled datasets/i,
    "MIN is not supported on a sampled dataset: use APPROX_MIN",
  ],
  [/unknown column/i, "a column that the dataset does not have (docs/telemetry.md lists them)"],
  [/function .* is not supported/i, "a function that Cloudflare's Analytics SQL does not support"],
  [
    /time range exceeds the maximum duration/i,
    "a time range over what one query of this dataset reads: ask fewer hours",
  ],
  [/subquer/i, "a subquery is not supported"],
];

/** The Analytics SQL binding's error as ours, with none of Cloudflare's words: they may name what
 *  the cut keeps out. A refusal, which fails the same asked again (`retryable: false`,
 *  https://developers.cloudflare.com/workers/runtime-apis/bindings/analytics-sql/#errors), is
 *  INVALID_INPUT; a failure that may pass asked again keeps workerd's `retryable` stamp, so the
 *  hop reads it as the platform's (iterate/lib `failureKind`). */
function storeError(error: unknown): Error {
  const { retryable, message } = StoreError.parse(error instanceof Object ? error : {});
  const code = cloudflareCodeOf(error);
  const coded = code === undefined ? "" : ` (Cloudflare's code ${code})`;
  const withCode = <T extends Error>(ours: T) =>
    code === undefined ? ours : Object.assign(ours, { cloudflareCode: code });
  if (retryable === false) {
    const known = STORE_REFUSALS.find(([words]) => words.test(message || ""));
    return withCode(
      codedError(
        "INVALID_INPUT",
        known
          ? `itx.telemetry.query: ${known[1]} (docs/telemetry.md)`
          : `itx.telemetry.query: Cloudflare's Analytics SQL refused the query${coded} (docs/telemetry.md)`,
      ),
    );
  }
  return withCode(
    Object.assign(
      new Error(`itx.telemetry.query: Cloudflare's Analytics SQL did not answer${coded}`),
      retryable === true && { retryable: true },
    ),
  );
}

/** R2 SQL's error as ours, in a fixed sentence with its HTTP status and Cloudflare's numeric code:
 *  none of its words go on, as none of the Analytics SQL's do (`storeError`). A 400 is the query's
 *  own (R2 SQL's `invalid query`): it fails the same asked again. */
function tablesError(status: number, code: number | undefined): Error {
  const coded = `(HTTP ${status}${code === undefined ? "" : `, Cloudflare's code ${code}`})`;
  const error =
    status === 400
      ? codedError(
          "INVALID_INPUT",
          `itx.telemetry.query: R2 SQL refused the query ${coded} (docs/telemetry.md)`,
        )
      : new Error(`itx.telemetry.query: R2 SQL did not answer ${coded}`);
  return code === undefined ? error : Object.assign(error, { cloudflareCode: code });
}

const StoreError = z.object({
  retryable: z.boolean().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
});

/** Cloudflare's numeric error code on an error, when it has one. */
function cloudflareCodeOf(error: unknown): number | undefined {
  const code = error instanceof Object ? (error as { code?: unknown }).code : undefined;
  return typeof code === "number" && Number.isInteger(code) ? code : undefined;
}

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
  errors: z.array(z.object({ code: z.number().optional().catch(undefined) })).optional(),
});

function jsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
