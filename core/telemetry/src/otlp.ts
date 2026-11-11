import { z } from "zod";

/** An int64 is a string in OTLP JSON, and Cloudflare writes a number; a logged null arrives as
 *  `{}`. */
const AnyValue = z.object({
  stringValue: z.string().optional(),
  boolValue: z.boolean().optional(),
  intValue: z.union([z.string(), z.number()]).optional(),
  doubleValue: z.number().optional(),
  bytesValue: z.string().optional(),
  get arrayValue() {
    return z.object({ values: z.array(AnyValue).optional() }).optional();
  },
  get kvlistValue() {
    return z.object({ values: Attributes }).optional();
  },
});
type AnyValue = z.infer<typeof AnyValue>;
const Attributes = z.array(z.object({ key: z.string(), value: AnyValue })).optional();
const Resource = z.object({ attributes: Attributes }).default({});
/** Any 20 digits is a time a Date holds, so `isoTime` and a span's duration cannot throw. */
const UnixNano = z.string().regex(/^\d{1,20}$/);

/** The lists are required: a body without them, parsed as an empty batch, would be a quiet 200. */
export const OtlpLogs = z.object({
  resourceLogs: z.array(
    z.object({
      resource: Resource,
      scopeLogs: z.array(z.object({ logRecords: z.array(z.unknown()) })),
    }),
  ),
});
const LogRecord = z.object({
  timeUnixNano: UnixNano.default("0"),
  severityNumber: z.number().default(0),
  eventName: z.string().optional(),
  body: AnyValue.default({}),
  attributes: Attributes,
  traceId: z.string().optional(),
  spanId: z.string().optional(),
});

export const OtlpTraces = z.object({
  resourceSpans: z.array(
    z.object({
      resource: Resource,
      scopeSpans: z.array(z.object({ spans: z.array(z.unknown()) })),
    }),
  ),
});
const Span = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  kind: z.number().default(0),
  startTimeUnixNano: UnixNano,
  endTimeUnixNano: UnixNano,
  attributes: Attributes,
  events: z.array(z.object({ name: z.string(), attributes: Attributes })).optional(),
  status: z
    .object({ code: z.number().default(0), message: z.string().optional() })
    .default({ code: 0 }),
});

export type LogRow = ReturnType<typeof logRows>["rows"][number];
export type SpanRow = ReturnType<typeof spanRows>["rows"][number];

// In UTF-16 units, at most six bytes each as JSON: far under the 1 MB a stream takes of a row.
const TEXT_MAX_LENGTH = 96 * 1024;
const EXCEPTION_MAX_LENGTH = 16 * 1024;

/** None per invocation log, whose root span carries the same. */
export function logRows(payload: z.infer<typeof OtlpLogs>) {
  const skipped: string[] = [];
  const rows = payload.resourceLogs.flatMap(({ resource, scopeLogs }) => {
    const records = scopeLogs.flatMap(({ logRecords }) => logRecords);
    const worker = workerOf(resource, records, skipped);
    if (!worker) return [];
    return parsed(LogRecord, records, skipped).flatMap((record) => {
      const attributes = plainAttributes(record.attributes);
      if ("cloudflare.handler_type" in attributes) return [];
      const fields = plainAttributes(record.body.kvlistValue?.values);
      const value = plain(record.body);
      const body = capped(typeof value === "string" ? value : JSON.stringify(value));
      const severity = record.severityNumber;
      const stack = text(attributes["exception.stacktrace"]);
      return [
        {
          timestamp: isoTime(record.timeUnixNano),
          worker: worker.name,
          path: text(fields.path),
          version_id: worker.versionId,
          level:
            severity >= 17 ? "error" : severity >= 13 ? "warn" : severity >= 9 ? "info" : "debug",
          trace_id: record.traceId,
          span_id: record.spanId,
          seq: number(attributes["cloudflare.invocation.sequence.number"]),
          event_name: record.eventName || text(fields.event),
          body: body.text,
          body_bytes: body.bytes,
          exception: exceptionOf(attributes),
          stack: stack && cut(stack, EXCEPTION_MAX_LENGTH),
        },
      ];
    });
  });
  return { rows, skipped };
}

/** `attributes` keeps what no column holds, less what every span repeats and what says who asked:
 *  whereabouts, user agent, headers, and the URL or its query, which can carry a token. */
export function spanRows(payload: z.infer<typeof OtlpTraces>) {
  const skipped: string[] = [];
  const rows = payload.resourceSpans.flatMap(({ resource, scopeSpans }) => {
    const records = scopeSpans.flatMap(({ spans }) => spans);
    const worker = workerOf(resource, records, skipped);
    if (!worker) return [];
    const repeated = new Set(resource.attributes?.map(({ key }) => key));
    return parsed(Span, records, skipped).map((span) => {
      // Cloudflare documents `cloudflare.cpu_time_ms` and `cloudflare.wall_time_ms`, and sends
      // them without the prefix
      const {
        "iterate.path": path,
        "cloudflare.invocation.sequence.number": seq,
        "cloudflare.cpu_time_ms": cpuTimeMs,
        cpu_time_ms: unprefixedCpuTimeMs,
        "cloudflare.wall_time_ms": wallTimeMs,
        wall_time_ms: unprefixedWallTimeMs,
        "cloudflare.outcome": outcome,
        "cloudflare.entrypoint": entrypoint,
        "cloudflare.durable_object.id": durableObjectId,
        "jsrpc.method": rpcMethod,
        "http.response.status_code": httpStatus,
        "url.path": urlPath,
        ...rest
      } = plainAttributes(span.attributes);
      const thrown = span.events?.find((event) => event.name === "exception");
      const kept = Object.entries(rest).filter(
        ([key]) => !repeated.has(key) && !DROPPED_SPAN_ATTRIBUTE.test(key),
      );
      const attributes = capped(JSON.stringify(Object.fromEntries(kept)));
      return {
        timestamp: isoTime(span.startTimeUnixNano),
        worker: worker.name,
        path: text(path),
        version_id: worker.versionId,
        trace_id: span.traceId,
        span_id: span.spanId,
        parent_span_id: span.parentSpanId || undefined,
        seq: number(seq),
        name: span.name,
        kind: SPAN_KINDS[span.kind] ?? String(span.kind),
        status: STATUS_CODES[span.status.code] ?? String(span.status.code),
        status_message: span.status.message || undefined,
        duration_ms: Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1e6,
        cpu_time_ms: number(cpuTimeMs ?? unprefixedCpuTimeMs),
        wall_time_ms: number(wallTimeMs ?? unprefixedWallTimeMs),
        outcome: text(outcome),
        entrypoint: text(entrypoint),
        durable_object_id: text(durableObjectId),
        rpc_method: text(rpcMethod),
        http_status: number(httpStatus),
        url_path: text(urlPath),
        exception: thrown && exceptionOf(plainAttributes(thrown.attributes)),
        attributes: attributes.text,
        attributes_bytes: attributes.bytes,
      };
    });
  });
  return { rows, skipped };
}

const DROPPED_SPAN_ATTRIBUTE =
  /^(scope\.name|geo\..*|cloudflare\.asn|user_agent\.original|http\.(request|response)\.header\..*|url\.full|url\.query)$/;

const SPAN_KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"];
const STATUS_CODES = ["unset", "ok", "error"];

/** None for the destinations' pre-flight check, whose records are no Worker's. */
function workerOf(resource: z.infer<typeof Resource>, records: unknown[], skipped: string[]) {
  const attributes = plainAttributes(resource.attributes);
  if (attributes["telemetry.sdk.name"] === "pre-flight-check") return;
  const name = text(attributes["cloudflare.script_name"]) || text(attributes["service.name"]);
  if (!name) {
    skipped.push(...records.map(() => "resource: no cloudflare.script_name or service.name"));
    return;
  }
  return { name, versionId: text(attributes["cloudflare.script_version.id"]) };
}

function parsed<T>(schema: z.ZodType<T>, records: unknown[], skipped: string[]) {
  return records.flatMap((record) => {
    const result = schema.safeParse(record);
    if (result.success) return [result.data];
    const issue = result.error.issues[0]!;
    skipped.push(`${issue.path.join(".")}: ${issue.message}`);
    return [];
  });
}

function exceptionOf(attributes: Record<string, unknown>) {
  const type = text(attributes["exception.type"]);
  return type && cut(`${type}: ${text(attributes["exception.message"])}`, EXCEPTION_MAX_LENGTH);
}

function plainAttributes(attributes: z.infer<typeof Attributes>): Record<string, unknown> {
  return Object.fromEntries((attributes || []).map(({ key, value }) => [key, plain(value)]));
}

// one of its keys, whose value may be falsy, or none for null
function plain(value: AnyValue): unknown {
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("bytesValue" in value) return value.bytesValue;
  if (value.arrayValue) return (value.arrayValue.values || []).map(plain);
  if (value.kvlistValue) return plainAttributes(value.kvlistValue.values);
  return null;
}

function capped(value: string) {
  return { text: cut(value, TEXT_MAX_LENGTH), bytes: new TextEncoder().encode(value).byteLength };
}

// a lone surrogate's escape is JSON a stream may refuse
const cut = (value: string, length: number) => value.slice(0, length).toWellFormed();

const isoTime = (unixNano: string) => new Date(Number(BigInt(unixNano) / 1_000_000n)).toISOString();

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const number = (value: unknown) => (typeof value === "number" ? value : undefined);
