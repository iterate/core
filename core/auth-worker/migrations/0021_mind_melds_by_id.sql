-- A MIND IS LET IN BY ITS ID (src/minds.ts). Additive: the Worker of before still selects and
-- upserts by `domain` on this table, so a rollback to an earlier version runs on it.
-- domain: from now on the hostname that the rule names (`name`), a label and where the log is
-- read. It stays the row's primary key: one row for each hostname.
-- mind: the id of the mind that this row lets in. A rule by id sets it. A row from before has
-- none until a statement uses it: then the id that the hostname's log proves is written here
-- (trust on first use, and the /minds page says so).
-- state: the identity state that this Worker last read for `mind` (iterate/mind-identity-log
-- `PublishedMind`, JSON): the next read goes on from its head, and takes only a log that
-- continues it.
-- pinned_at: when a row from before was pinned at first use, epoch ms; null for a rule by id.
-- refused: JSON { mind, at }: the last other id that `domain` was seen to serve, for the owner.
alter table mind_melds add column mind text;
alter table mind_melds add column state text;
alter table mind_melds add column pinned_at integer;
alter table mind_melds add column refused text;
create unique index mind_melds_mind on mind_melds (mind) where mind is not null;
