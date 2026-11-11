-- THE OPEN ENDPOINTS' ADMISSIONS (src/device/limits.ts): one row per device authorization or client
-- registration let through, which the limits count. Anyone on the internet may call both, so each is
-- counted per client address and for the whole stack, inside the statement that adds the row, and
-- two requests at once are counted one after the other. Rows older than the window, ten minutes,
-- are deleted when a new one is written. Times are epoch ms.
create table admissions (
  -- `device`: POST /oauth2/device_authorization; `registration`: POST /oauth2/register
  kind text not null,
  -- the requester's address (`cf-connecting-ip`); null when unknown, then counted for the stack alone
  client text,
  created_at integer not null
);

-- At most 240 rows: 120 a kind, the stack's limit, within the window. The stack's count and the
-- deletion read them all.
create index admissions_client on admissions (kind, client, created_at);
