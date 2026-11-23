# Telemetry

The owner should come away with: the mind sees every request, error and event of its own, and found their own visit.

## Ready today

- `await itx.telemetry.query(sql, { hours })` over Cloudflare's own datasets needs no token:
  `logs.workersLogs`, `logs.traces`, `logs.issues`, `events.workersInvocations` and `metrics`, in
  Cloudflare's Analytics SQL, cut to this mind's rows (168 hours at most over the three logs, 768
  over the rest). Start there: it answers rows on every mind, tables on or off.
- `await itx.telemetry.query(sql, { hours })` runs one `SELECT` over `events`, `logs` or `spans`,
  cut to this mind's rows of the last `hours` (24 by default, 720 at most),
  1,000 rows at most (`truncated: true` says the answer is full and more may match: aggregate,
  or page with `LIMIT` and `OFFSET`). It answers `{ rows, sql, notice?, truncated?, send? }`. A
  refused query throws a fixed sentence with Cloudflare's code. A JSON function works in the
  `SELECT` list alone: filter text with `LIKE` or `regexp_match`. After the turn-on below, read
  the tables with `await itx.config.telemetryQuery(sql, { hours })`, the mind's own code
  (`telemetry.ts`): the same SQL and answer, sent with the mind's token. `itx.telemetry.query`
  stays the platform's, under that one name.
- When the tables are off, the query answers `{ rows: [], sql, notice, send }`. A subagent of the
  first sitting reports that the tables are off and stops there. The mind's agent turns them on
  when the owner asks, in this order: `await itx.config.telemetryToken()` answers
  `{ makeTheTokenAt, pasteItAt, account, bucket }`; `{ needed: false }` on a stack that holds its
  own token; `{ set: true, wide, bucket }` once it is set (after an interrupted turn-on, call
  `telemetryTurnOn()` directly). `telemetryToken({ again: true })` replaces a wrong token. Give a
  member both links in ONE message: pick `account` at the first link, which fills in four
  permissions for the entire account. Before they create the token, they select "Add policy",
  choose "R2 Buckets" in place of "Entire Account", select `bucket`, and tick "Edit" for
  "Workers R2 Storage Bucket Item": without it the tables stop when the token is narrowed. Then
  they paste the token into the second link. Say plainly: as made, this token
  reads and writes every R2 bucket of the account, the mind's files too, makes and deletes
  buckets and can set one public. WAIT until the member
  says it is done. Then `await itx.config.telemetryTurnOn()` (safe to call again; it answers
  what it made and each pipeline's status). Wait a few minutes and query a recent event with
  `itx.config.telemetryQuery` before you say it works: a table answers a notice until its first rows land. Events the streams got
  before the turn-on are there too.
- Right after the turn-on, ask the member to narrow the token in Cloudflare's dashboard, in one
  message: take "Pipelines Write" and "Workers R2 Storage Write" off the first policy, and leave
  the policy for `bucket` as it is. The token's value stays; they must never delete or roll it. Check with
  `telemetryToken()`: ask again while `wide` is true. A destroy of the stack leaves the token
  in the account: its member deletes it then. A repair needs the two permissions back: `telemetryTurnOn()` then
  fails on a list call with a 403.
- A mind whose `api.ts` was changed, or whose `worker.ts` does not extend `ConfigApi`, has no `itx.config.telemetryToken` after an update: its
  owner takes the new lines as `template-updates.md` says.
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

- Telling the owner's visit apart is NOT PROVEN. The subagent's check, the screenshot, a crawler
  and the Dash's own page load are requests to `/` too, and one request can show as two spans
  (the boundary's and the mind's) with one `trace_id`. Name a visit only when its minute matches
  when they opened the page.

## How

On a mind that turned its tables on itself, write `itx.config.telemetryQuery` where these write
`itx.telemetry.query`. The visits to `/` in the last hour:

```ts
const { rows, notice } = await itx.telemetry.query(
  "SELECT timestamp, worker, url_path, http_status, outcome, duration_ms, trace_id FROM spans WHERE kind = 'server' AND url_path = '/' ORDER BY timestamp DESC LIMIT 20",
  { hours: 1 },
);
if (notice) return notice;
return rows;
```

What failed in the last day: the errors logged, by kind, and the requests that failed. Do not
ask for `status = 'error'` over all spans: an outbound `fetch` that got a 404 is one too.

```ts
const errors = await itx.telemetry.query(
  "SELECT worker, exception, count(*) AS times, max(timestamp) AS last, min(body) AS example FROM logs WHERE level = 'error' GROUP BY worker, exception ORDER BY times DESC LIMIT 20",
);
if (errors.notice) return errors.notice;
const failed = await itx.telemetry.query(
  "SELECT timestamp, worker, url_path, rpc_method, http_status, outcome, status_message, trace_id FROM spans WHERE kind IN ('server', 'consumer') AND (outcome NOT IN ('ok', 'canceled', 'responseStreamDisconnected', 'aborted') OR http_status >= 500) ORDER BY timestamp DESC LIMIT 20",
);
return { errors: errors.rows, failed: failed.rows };
```

## Say

- "That was you, at 14:02, opening your website. Your mind keeps every request like that:
  https://dash.<zone>/analytics."
- "When something breaks, I can read exactly what happened."
