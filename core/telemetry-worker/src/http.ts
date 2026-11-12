// http.ts — THE TELEMETRY WORKER'S ANSWER TO A REQUEST: Cloudflare's OpenTelemetry export posts a
// batch of logs or spans, and its rows land in their pipeline.
import type { Pipeline, PipelineRecord } from "cloudflare:pipelines";
import { reportIssue } from "iterate/lib";
import {
  RETRY_AFTER_MS,
  failureKind,
  isPlatformFailureKind,
  logPlatformFailure,
} from "iterate/platform-retry";
import { readBounded, ROW_MAX_BYTES, sends, sized } from "./bounds.ts";
import type { Env } from "./env.ts";
import { logRows, OtlpLogs, OtlpTraces, spanRows } from "./otlp.ts";

export async function otlpResponse(request: Request, env: Env) {
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
}

// decompressed: one batch made huge by a mind's own logging, or a gzip bomb, is not parsed
const BATCH_MAX_BYTES = 16 * 1024 * 1024;

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
