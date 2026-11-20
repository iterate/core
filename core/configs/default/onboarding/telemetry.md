# Telemetry

The owner should come away with: the mind sees every request, error and event of its own, and found their own visit.

## Ready today

- `await itx.telemetry.query(sql, { hours })` runs one `SELECT` over `events`, `logs` or `spans`
  (or `metrics` alone), cut to this mind's rows of the last `hours` (24 by default, 720 at most),
  1,000 rows at most. It answers `{ rows, sql, notice? }`.
- When the mind was deployed without a telemetry API token, `itx.telemetry.query` does not fail:
  it answers `{ rows: [], sql, notice: "telemetry tables are off: add a telemetry token" }`. Show
  that plain sentence to the owner (not as an error) and tell them they can turn telemetry tables
  on later with `npx iterate deploy --telemetry-token` (or with `CLOUDFLARE_TELEMETRY_API_TOKEN`).
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
- The Analytics page: `https://dash.<zone>/analytics`.
- Cloudflare's own logs and traces, when a member has connected the mind to its Cloudflare
  account (`(await itx.secrets.describe("/secrets/cloudflare")).set`; `onboarding/connect.md`):
  `await itx.config.cloudflareLastHour()` answers the mind's own Workers' requests and errors
  of the last hour. `cloudflare.md` has the two queries behind it.

## Not ready

- Telling the owner's visit apart is NOT PROVEN. The helper's check, the screenshot, a crawler
  and the Dash's own page load are requests to `/` too, and one request can show as two spans
  (the boundary's and the mind's) with one `trace_id`. Name a visit only when its minute matches
  when they opened the page.

## How

The visits to `/` in the last hour:

```ts
const { rows, notice } = await itx.telemetry.query(
  "SELECT timestamp, worker, url_path, http_status, outcome, duration_ms, trace_id FROM spans WHERE kind = 'server' AND url_path = '/' ORDER BY timestamp DESC LIMIT 20",
  { hours: 1 },
);
if (notice) return notice;
return rows;
```

What failed in the last day:

```ts
const { rows, notice } = await itx.telemetry.query(
  "SELECT timestamp, worker, name, status_message, exception FROM spans WHERE status = 'error' ORDER BY timestamp DESC LIMIT 20",
);
if (notice) return notice;
return rows;
```

## Say

- "That was you, at 14:02, opening your website. Your mind keeps every request like that:
  https://dash.<zone>/analytics."
- "When something breaks, I can read exactly what happened."
