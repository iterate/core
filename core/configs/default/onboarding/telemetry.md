# Telemetry

The owner should come away with: the mind sees every request, error and event of its own, and found their own visit.

## Ready today

- Only on a mind whose stack has telemetry. Check first:
  `Boolean((await itx.rewriteRules.get("itx.telemetry"))?.target)`.
- `await itx.telemetry.query(sql, { hours })` runs one `SELECT` over `events`, `logs` or `spans`
  (or `metrics` alone), cut to this mind's rows of the last `hours` (24 by default, 720 at most),
  1,000 rows at most. It answers `{ rows, sql }`.
- `spans` has `timestamp, worker, path, version_id, trace_id, span_id, parent_span_id, seq, name,
kind, status, duration_ms, cpu_time_ms, wall_time_ms, outcome, entrypoint, durable_object_id,
rpc_method, http_status`, and for the mind's own Workers (`iterate-<slug>-mind`,
  `iterate-<slug>-boundary`) also `status_message, url_path, exception, attributes`. A request
  that came in has `kind = 'server'`. `events` holds every event of the mind (`type`, `path`,
  `payload` as text; write `"offset"` in quotes). `logs` has `event_name` and `body`.
- No country, no browser, no full URL, no query string: they are dropped before they are stored.
  The host is no column.
- A request shows up a few minutes later, usually one to four. Ask again before you say it is not
  there.
- The Analytics page: `https://dash.<domain>/?page=analytics`.
- Cloudflare's own logs and traces: `await itx.config.cloudflare("execute", { code })`, with the
  mind's Cloudflare token (`(await itx.secrets.describe("/secrets/cloudflare")).set`).
  `cloudflare.md` has the two queries: the newest log lines, and invocations by outcome.

## Not ready

- On a mind without telemetry, `itx.telemetry` does not exist: the call throws, and the
  Analytics page says it is off. Leave the whole subject out, and say nothing about it.
- Telling the owner's visit apart is NOT PROVEN. The helper's check, the screenshot, a crawler
  and the Dash's own page load are requests to `/` too, and one request can show as two spans
  (the boundary's and the mind's) with one `trace_id`. Name a visit only when its minute matches
  when they opened the page.

## How

The visits to `/` in the last hour:

```ts
const { rows } = await itx.telemetry.query(
  "SELECT timestamp, worker, url_path, http_status, outcome, duration_ms, trace_id FROM spans WHERE kind = 'server' AND url_path = '/' ORDER BY timestamp DESC LIMIT 20",
  { hours: 1 },
);
return rows;
```

What failed in the last day:

```ts
return (
  await itx.telemetry.query(
    "SELECT timestamp, worker, name, status_message, exception FROM spans WHERE status = 'error' ORDER BY timestamp DESC LIMIT 20",
  )
).rows;
```

## Say

- "That was you, at 14:02, opening your website. Your mind keeps every request like that:
  https://dash.<domain>/?page=analytics."
- "When something breaks, I can read exactly what happened."
