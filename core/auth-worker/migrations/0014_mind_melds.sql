-- THE MINDS THIS MIND LETS IN (src/minds.ts): the copy of each mind's latest
-- `events.iterate.com/mind-meld/configured` rule, which a member's passkey signed on the context
-- `/minds/<domain>`. The event is the record; this row is its copy for the check of a statement.
-- domain: the other mind's, lowercase. append: JSON array of the context paths under which it may
-- add events; '[]' once the meld ended (the row stays, so an older rule sent again cannot start it
-- again). key: the one key id that counts, or null to follow the keys the mind publishes.
-- configured_at: the rule statement's `at`, epoch ms; a rule older than the row's is not taken.
-- configured_by: the user id of the member who signed it.
create table mind_melds (
  domain text primary key,
  append text not null,
  key text,
  configured_at integer not null,
  configured_by text not null
);
