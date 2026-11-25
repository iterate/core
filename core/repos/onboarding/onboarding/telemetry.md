# Telemetry

The owner should come away with: the mind sees every request, error and event of its own, and found their own visit.

## Ready today

- `await itx.telemetry.query(sql, { hours })` reads Cloudflare's own datasets with no token, on
  every mind: `logs.workersLogs` (log lines and requests), `logs.traces` (spans), `logs.issues`
  (errors, unsampled), `events.workersInvocations` (invocations) and `metrics` (the stack's own
  Analytics Engine data, with the mind's events counted as `event.committed` points). It is
  Cloudflare's Analytics SQL, cut to this mind's rows of the last `hours`: 24 by default, 168 at
  most over the three logs, 768 over the other two. Start there.
- Cloudflare samples: the logs and traces when they are read, `metrics` and the invocations when
  they are written (docs/telemetry.md, "Sampling"). A count is close, but one real request can be
  missing from an answer.
- It answers `{ rows, sql, dataset?, notice?, truncated? }`, 1,000 rows at most
  (`truncated: true` says the answer is full and more may match: aggregate, or page with `LIMIT`
  and `OFFSET`). A refused query throws a fixed sentence that says why.
- The SQL: one `SELECT` over one dataset. No JOIN, UNION, subquery, CTE, comment, `;` or `$`.
  Column names are case-sensitive (`scriptName`); never alias a column `message`. A sampled
  dataset refuses `max()` and `min()`: use `APPROX_MAX` and `APPROX_MIN`. Compare a time as ISO
  text or as `NOW() - INTERVAL '10' MINUTE`.
- Count rows of `logs.workersLogs` and `logs.traces` with `count()`, which is already weighted.
  Count `metrics` and `events.workersInvocations` with `sum(sampleInterval)`.
- The columns you need most: `logs.workersLogs` has `timestamp`, `scriptName`, `level`,
  `message`, `error`, `url`, `httpStatus`, `invocationType` and `logType` (a request's own row
  has `logType = 'cf-worker-event'`). `logs.traces` has `startTime`, `serviceName`, `spanName`,
  `traceId`, `spanId`, `parentSpanId`, `durationMs` and `spanStatus`.
- Every row of the logs carries the full URL with its query string, in `url`, `message` and
  `error`. Cut it at the `?` before you show it, as the examples below do.
- The tables `events`, `logs` and `spans` are there only on a stack whose deploy made them with
  a telemetry token. The same call reads them (R2 SQL, 720 hours at most). On a stack with none, a
  query over them answers `{ rows: [], sql, notice }`: read Cloudflare's datasets instead. Where
  they are: `events` holds every event of the mind (`type`, `path`, `payload` as text; write
  `"offset"` in quotes); `logs` has `event_name` and `body`; `spans` has `timestamp`, `worker`,
  `trace_id`, `name`, `kind`, `status`, `duration_ms`, `http_status`, and for the mind's own
  Workers `url_path` and `exception` (a request that came in has `kind = 'server'`). They keep no
  country, no browser, no full URL and no query string. A JSON function works in the `SELECT`
  list alone: filter text with `LIKE` or `regexp_match`.
- A request can take a few minutes to show up. Ask again before you say it is not there.
- The Analytics page: `https://dash.<zone>/analytics`.
- Cloudflare's own logs and traces, when a member has connected the mind to its Cloudflare
  account (`(await itx.secrets.describe("/secrets/cloudflare")).set`; `onboarding/connect.md`):
  `await itx.config.cloudflareLastHour()` answers the mind's own Workers' requests and errors
  of the last hour. `cloudflare.md` has the two queries behind it.

## Not ready

- Telling the owner's visit apart is NOT PROVEN. The subagent's check, the screenshot, a crawler
  and the Dash's own page load are requests to `/` too, and one request can show as two spans
  (the boundary's and the mind's) with one `traceId`. Name a visit only when its minute matches
  when they opened the page.

## How

The requests of the last hour, newest first:

```ts
const { rows } = await itx.telemetry.query(
  "SELECT timestamp, scriptName, CASE WHEN position(url, '?') > 0 THEN substring(url, 1, position(url, '?') - 1) ELSE url END AS route, httpStatus FROM logs.workersLogs WHERE invocationType = 'fetch' AND logType = 'cf-worker-event' ORDER BY timestamp DESC LIMIT 20",
  { hours: 1 },
);
return rows;
```

What went wrong in the last hour, by kind (`level` is `error`, `warn` or `info`; `error` is often
empty):

```ts
const { rows } = await itx.telemetry.query(
  "SELECT level, substring(message, 1, 80) AS kind, count() AS times FROM logs.workersLogs WHERE level IN ('error', 'warn') OR error <> '' GROUP BY level, kind ORDER BY times DESC LIMIT 20",
  { hours: 1 },
);
return rows;
```

The mind's events of the day, by type:

```ts
const { rows } = await itx.telemetry.query(
  "SELECT blob3 AS type, sum(double1 * sampleInterval) AS events FROM metrics WHERE blob1 = 'event.committed' GROUP BY type ORDER BY events DESC LIMIT 20",
  { hours: 24 },
);
return rows;
```

## Say

- "That was you, at 14:02, opening your website. Your mind sees its requests like that:
  https://dash.<zone>/analytics."
- "When something breaks, I can read exactly what happened."
