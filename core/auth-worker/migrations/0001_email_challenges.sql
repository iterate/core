-- THE MAILED CODE'S CHALLENGES (src/email-sign-in.ts): one row per code asked for. The row is the
-- challenge while its code lives (`expires_at`, ten minutes; 0 once it is spent or ended), and the
-- record the sending limits count for an hour after (`created_at`). A try is spent in one statement
-- before the check (`tries < 5`), and every limit is counted inside the statement that adds a row.
-- Rows older than an hour are deleted when a new one is written. Times are epoch ms.
create table email_challenges (
  id text primary key,
  -- the address as typed, trimmed and lower-cased: the one the code proves
  email text not null,
  -- the address without its `+tag`, which the per-address limits count
  inbox text not null,
  -- the requester's address (`cf-connecting-ip`), which the per-client cap counts; null when unknown
  client text,
  -- the SHA-256 of `<id>:<code>`: the id salts it
  hash text not null,
  tries integer not null default 0,
  -- where the browser goes once signed in: a path on the issuer's origin
  next text not null,
  -- 1 when an `email` rule names the address
  named integer not null,
  -- 1 when a code was mailed
  mailed integer not null,
  created_at integer not null,
  expires_at integer not null
);

create index email_challenges_inbox on email_challenges (inbox, created_at);
create index email_challenges_client on email_challenges (client, created_at);
create index email_challenges_created on email_challenges (created_at);
