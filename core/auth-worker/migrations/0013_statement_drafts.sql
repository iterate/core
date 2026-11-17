-- A STATEMENT THAT WAITS FOR A MEMBER'S PASSKEY (src/statement-drafts.ts). An agent of the mind
-- proposes it; the link to its page carries only the id. The page shows these values, and the
-- press signs a statement made of them. Times are epoch ms.
create table statement_drafts (
  -- 128 random bits, base64url
  id text primary key,
  path text not null,
  type text not null,
  -- the payload as JSON text
  payload text not null,
  -- the context that asked: its own claim
  asked_from text,
  -- where the page goes once it is signed: a host of this mind
  next text,
  at integer not null,
  expires integer not null
);
