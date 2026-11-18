-- A PASSKEY THAT WAS ADDED WHILE ITS OWNER WAS NO MEMBER (src/keys-pages.ts sets it, src/keys.ts
-- reads it). Such a key never becomes a member's: not when a member adds the address, and not when
-- a deploy names it. It signs about its owner alone, at `/people/<address>`, and signs nobody in.
-- The session it opened and every grant of that session are no member's either. A member gets a
-- passkey by the way a new member takes: a mailed code or a member's link, and a new key, which
-- revokes this one.
-- 1: added by someone who was no member then. 0: every key from before this column, and every key
-- a member added.
alter table keys add column outsider integer not null default 0;

-- THE STATEMENTS THAT A NON-MEMBER'S KEY SIGNED IN THE LAST HOUR (src/statements.ts counts them
-- inside the statement that adds one, and deletes the older rows). hash: the statement's
-- (iterate/signed `statementHashOf`), so the same statement sent again counts once. key: the id of
-- the key that signed it. at: epoch ms.
create table outsider_statements (
  hash text primary key,
  key text not null,
  at integer not null
);

create index outsider_statements_by_key on outsider_statements (key, at);
