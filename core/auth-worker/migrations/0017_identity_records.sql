-- THE MIND'S IDENTITY LOG (src/identity.ts): every signed record of the mind's identity
-- (iterate/mind-identity) that this stack accepted, one row each. THESE ROWS ARE THE AUTHORITY:
-- a row decides which of two records is the next, whether the stack may sign, and what
-- `GET /.well-known/iterate` serves. The event `events.iterate.com/mind/identity-record-accepted`
-- on `/` is a copy of the row on the mind's own log, and the row is delivered there. A row's record is never changed and no row is deleted: a mind
-- that gets a new id keeps the rows of the id before.
create table identity_records (
  -- SHA-256 of the record's text, lowercase hex
  hash text primary key not null,
  -- the mind id: the hash of the log's genesis, the config's `mindId` when the row was written
  mind text not null,
  -- the hash of the record before it; null in a genesis
  prev text,
  -- 1 is the genesis
  position integer not null check (position >= 1),
  -- the exact text that was signed
  record text not null,
  -- JSON array of { key, sig }, as they came with the record
  signatures text not null,
  -- JSON array of the root keys whose signatures verified, as the event names them
  signed_by text not null,
  -- what the record takes in a published page, in bytes: its entry as JSON, and one comma
  page_bytes integer not null check (page_bytes > 0),
  -- epoch ms
  accepted_at integer not null,
  -- THE DELIVERY TO `/`: epoch ms at which the boundary said that the row's event is stored
  -- there; null until then. The event has one key for ever, so it may be appended again.
  delivered_at integer,
  -- one record at each place of a log, and one record after each record
  unique (mind, position),
  unique (mind, prev),
  -- a genesis is the first record, has no record before it, and its hash is the mind id
  check ((position = 1) = (prev is null)),
  check (position > 1 or hash = mind)
);
-- the rows that `/` does not hold yet: few, whatever the log's length
create index identity_records_undelivered on identity_records (mind, position)
  where delivered_at is null;

-- THE RECORDS THAT WERE REFUSED WITH AN EVENT (src/identity.ts): a record that a current root key
-- signed and that did not continue the log gets one `events.iterate.com/mind/identity-record-refused`
-- on `/`. This row is why it gets no second one, and it holds what the event says, so that the
-- same event is delivered until it is stored, whatever a later request sends. Every such record
-- is public once it is sent, so anyone can send it again.
create table identity_refusals (
  hash text primary key not null,
  -- the mind id whose log refused it
  mind text not null,
  -- the check's reason and its sentence
  reason text not null,
  message text not null,
  -- the envelope as it came with the request that was refused: the text and the JSON array of
  -- { key, sig }
  record text not null,
  signatures text not null,
  -- epoch ms
  refused_at integer not null,
  -- epoch ms at which the event was said to be stored on `/`; null until then
  delivered_at integer
);
create index identity_refusals_undelivered on identity_refusals (refused_at)
  where delivered_at is null;
