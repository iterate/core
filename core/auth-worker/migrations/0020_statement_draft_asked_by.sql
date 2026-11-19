-- Who asked for a draft (src/statement-drafts.ts), as the platform stamped the call that proposed
-- it: the JSON of iterate/workers `ProposedBy`. Null: the mind's own code asked, with nobody's
-- call behind it, or the draft is older than this column.
alter table statement_drafts add column asked_by text;
