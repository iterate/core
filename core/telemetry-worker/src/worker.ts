import type { Pipeline, PipelineRecord } from "cloudflare:pipelines";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { codedError, reportIssue } from "iterate/lib";
import type { StreamEvent } from "iterate/stream/processor";
import type { TelemetryService } from "iterate/workers";
import {
  RETRY_AFTER_MS,
  failureKind,
  isPlatformFailureKind,
  logPlatformFailure,
} from "iterate/platform-retry";
import { type LogRow, logRows, OtlpLogs, OtlpTraces, type SpanRow, spanRows } from "./otlp.ts";
import { scoped } from "./query.ts";

type Env = {
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

// Basin Pipelines takes at most 5 MB a send, and no row over 1 MB: one fails the whole send.
const SEND_MAX_BYTES = 4 * 1024 * 1024;

const ROW_MAX_BYTES = 1_000_000;

export default {
  async fetch(request: Request, env) {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || (pathname !== "/v1/logs" && pathname !== "/v1/traces"))
      return new Response(
        "core/telemetry-worker: Cloudflare's OpenTelemetry export posts to /v1/logs and /v1/traces (docs/telemetry.md)\n",
        { status: pathname === "/" ? 200 : 404 },
      );
    // 503, not 401: the destination sends the batch again, so rotating the secret loses nothing
    if (!bearerMatches(request.headers.get("authorization"), env.TELEMETRY_OTLP_SECRET)) {
      console.warn({ event: "telemetry.secret-refused", pathname });
      return new Response(null, { status: 503 });
    }
    return pathname === "/v1/logs"
      ? land(request, pathname, env.LOGS, "rejectedLogRecords", (payload) =>
          logRows(OtlpLogs.parse(payload)),
        )
      : land(request, pathname, env.SPANS, "rejectedSpans", (payload) =>
          spanRows(OtlpTraces.parse(payload)),
        );
  },
} satisfies ExportedHandler<Env>;

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

/** Null once `body` passes `max` bytes: the rest is cancelled, never held. */
async function readBounded(
  body: ReadableStream<Uint8Array> | null | undefined,
  max: number,
): Promise<{ text: string } | null> {
  const reader = body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (let next = await reader?.read(); next && !next.done; next = await reader!.read()) {
    bytes += next.value.byteLength;
    if (bytes > max) {
      await reader!.cancel();
      return null;
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return { text: text + decoder.decode() };
}

// decompressed: one batch made huge by a mind's own logging, or a gzip bomb, is not parsed
const BATCH_MAX_BYTES = 16 * 1024 * 1024;

const MetricsAnswer = z.object({ data: z.array(z.record(z.string(), z.unknown())) });

// at most what one Analytics Engine data point takes
const MetricPoints = z.array(
  z.object({
    indexes: z.array(z.string().max(96)).max(1).optional(),
    blobs: z.array(z.string()).max(20).optional(),
    doubles: z.array(z.number()).max(20).optional(),
  }),
);

// escaped as JSON, at most 6 bytes each: far under the 1 MB a row may take
const EVENTS_PAYLOAD_MAX_BYTES = 96 * 1024;

// its actor, never an email
function eventsRow(event: StreamEvent, worker: string) {
  // oxlint-disable-next-line iterate/simple-truthiness-check -- only an event with no payload gets {}: a falsy payload off the wire (0, false, "") is stored as itself
  const payload = JSON.stringify(event.payload === undefined ? {} : event.payload);
  const utf8 = new TextEncoder().encode(payload);
  const { principal, cause } = event.source;
  return {
    timestamp: event.createdAt,
    worker,
    path: event.path,
    offset: event.offset,
    type: event.type,
    actor: principal?.actor || null,
    cause_chain: cause?.chain || null,
    cause_depth: cause?.depth ?? null,
    cause_parent: cause?.parent || null,
    // decoded, not sliced: a slice would keep the whole payload alive with the row
    payload:
      utf8.length > EVENTS_PAYLOAD_MAX_BYTES
        ? new TextDecoder().decode(utf8.subarray(0, EVENTS_PAYLOAD_MAX_BYTES))
        : payload,
    payload_bytes: utf8.length,
  };
}
type EventsRow = ReturnType<typeof eventsRow>;

const BasinAnswer = z.object({
  result: z.object({ rows: z.array(z.record(z.string(), z.unknown())) }).optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/** Answered as OTLP answers an export. A destination sends a batch again on a 5xx, and is disabled
 *  after a day of 4xx: a 5xx is only for what another delivery can mend. */
async function land<Row extends PipelineRecord>(
  request: Request,
  pathname: string,
  stream: Pipeline<Row>,
  rejected: "rejectedLogRecords" | "rejectedSpans",
  rowsOf: (payload: unknown) => { rows: Row[]; skipped: string[] },
) {
  const body =
    request.headers.get("content-encoding") === "gzip"
      ? request.body?.pipeThrough(new DecompressionStream("gzip"))
      : request.body;
  // a batch past BATCH_MAX_BYTES is dropped with a 200: its records are not counted
  let read: { text: string } | null;
  try {
    read = await readBounded(body, BATCH_MAX_BYTES);
  } catch (error) {
    console.warn({ event: "telemetry.batch-unreadable", pathname, message: String(error) });
    return new Response(null, { status: 400 });
  }
  if (!read) {
    console.warn({
      event: "telemetry.batch-too-large",
      pathname,
      sentBytes: Number(request.headers.get("content-length")) || null,
      decompressedOver: BATCH_MAX_BYTES,
    });
    return Response.json({
      partialSuccess: {
        [rejected]: 0,
        errorMessage: `a batch over ${BATCH_MAX_BYTES} bytes decompressed is not read`,
      },
    });
  }
  // a batch that does not parse fails the same on every delivery: 400
  let batch: { rows: Row[]; skipped: string[] } | undefined;
  try {
    batch = rowsOf(JSON.parse(read.text));
  } catch (error) {
    console.warn({
      event: "telemetry.batch-unreadable",
      pathname,
      message: String(error).slice(0, 1000),
    });
  }
  if (!batch) return new Response(null, { status: 400 });
  const { skipped } = batch;
  const rows: { row: Row; bytes: number }[] = [];
  for (const row of batch.rows.map(sized)) {
    if (row.bytes > ROW_MAX_BYTES) skipped.push("a row over 1 MB, which no stream takes");
    else rows.push(row);
  }
  if (skipped.length > 0)
    console.warn({
      event: "telemetry.records-skipped",
      pathname,
      skipped: skipped.length,
      landed: rows.length,
      first: skipped[0],
    });
  try {
    for (const chunk of sends(rows)) await stream.send(chunk);
  } catch (error) {
    const kind = failureKind(error);
    if (isPlatformFailureKind(kind)) {
      logPlatformFailure("telemetry", "send", kind, { pathname, message: String(error) });
      const retryAfter = String(RETRY_AFTER_MS[kind] / 1000);
      return new Response(null, { status: 503, headers: { "retry-after": retryAfter } });
    }
    // a refusal fails the same on every delivery
    reportIssue("telemetry.send", error, { pathname, rows: rows.length });
    return new Response(null, { status: 400 });
  }
  return Response.json(
    skipped.length > 0
      ? { partialSuccess: { [rejected]: skipped.length, errorMessage: skipped[0] } }
      : {},
  );
}

/** In constant time. A loop: tsconfig.app.json's DOM lib types `crypto.subtle.timingSafeEqual`
 *  away. */
function bearerMatches(authorization: string | null, secret: string | undefined) {
  if (!secret) return false;
  const encoder = new TextEncoder();
  const [a, b] = [encoder.encode(authorization || ""), encoder.encode(`Bearer ${secret}`)];
  let difference = a.byteLength ^ b.byteLength;
  for (let i = 0; i < b.byteLength; i++) difference |= (a[i] ?? 0) ^ b[i]!;
  return difference === 0;
}

/** A row and its size in a send's JSON array, its comma included. */
function sized<Row>(row: Row) {
  return { row, bytes: new TextEncoder().encode(JSON.stringify(row)).byteLength + 1 };
}

function jsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function* sends<Row>(rows: { row: Row; bytes: number }[]) {
  let chunk: Row[] = [];
  let chunkBytes = 0;
  for (const { row, bytes } of rows) {
    if (chunk.length > 0 && chunkBytes + bytes > SEND_MAX_BYTES) {
      yield chunk;
      [chunk, chunkBytes] = [[], 0];
    }
    chunk.push(row);
    chunkBytes += bytes;
  }
  if (chunk.length > 0) yield chunk;
}
