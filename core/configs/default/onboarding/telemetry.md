# Telemetry

The owner should come away with: the mind sees every request, error and event of its own, and found their own visit.

## Ready today

- `await itx.telemetry.query(sql, { hours })` runs one `SELECT` over `events`, `logs` or `spans`
  (or `metrics` alone), cut to this mind's rows of the last `hours` (24 by default, 720 at most),
  1,000 rows at most. It answers `{ rows, sql, notice?, send? }`. After the turn-on below, the
  mind's own code answers it (`telemetry.ts`), with the same spelling and answer.
- When the tables are off, the query answers `{ rows: [], sql, notice, send }`. A helper of the
  first sitting reports that the tables are off and stops there. The mind's agent turns them on
  when the owner asks, in this order: `await itx.config.telemetryToken()` answers
  `{ makeTheTokenAt, pasteItAt, account, bucket }`; `{ needed: false }` on a stack that holds its
  own token; `{ set: true, wide, bucket }` once it is set (after an interrupted turn-on, call
  `telemetryTurnOn()` directly). `telemetryToken({ again: true })` replaces a wrong token. Give a
  member both links in ONE message: pick `account` at the first link, which fills in five
  permissions for the entire account. Before they create the token, they select "Add policy",
  choose "R2 Buckets" in place of "Entire Account", select `bucket`, and tick "Edit" for
  "Workers R2 Storage Bucket Item": without it the tables stop when the token is narrowed. Then
  they paste the token into the second link. Say plainly: as made, this token
  reads and writes every R2 bucket of the account, the mind's files too, makes and deletes
  buckets and can set one public. WAIT until the member
  says it is done. Then `await itx.config.telemetryTurnOn()` (safe to call again; it answers
  what it made and each pipeline's status). Wait a few minutes and query a recent event before
  you say it works: a table answers a notice until its first rows land. Events the streams got
  before the turn-on are there too.
- Right after the turn-on, ask the member to narrow the token in Cloudflare's dashboard, in one
  message: take "Pipelines Write" and "Workers R2 Storage Write" off the first policy, and leave
  the policy for `bucket` as it is. The token's value stays; they must never delete or roll it. Check with
  `telemetryToken()`: ask again while `wide` is true. A destroy of the stack leaves the token
  in the account: its member deletes it then. A repair needs the two permissions back: `telemetryTurnOn()` then
  fails on a list call with a 403.
- A mind whose `worker.ts` was changed has no `itx.config.telemetryToken` after an update: its
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
