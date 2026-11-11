-- WHAT A SERVICE'S KEY MAY LEND, AND WHEN IT LAST ASKED FOR A TOKEN (src/key-tokens.ts).
-- provide: the one capability name, `itx.<provide>`, that the key's token may lend to the mind
-- (`iterate provide --key`); null for a key that only adds events under its `paths`. A key that
-- only lends has `paths` '[]'.
-- last_used_at: when the key last got a token, epoch ms. `/keys` shows it.
alter table keys add column provide text;
alter table keys add column last_used_at integer;
