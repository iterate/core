-- THE iterate Cloud THAT PUBLISHED A KEY (src/keys-pages.ts writes it, `/keys` shows it). origin:
-- the `https:` origin whose `/.well-known/iterate-cloud` published the key when a member allowed
-- it on /keys/enrol, for a key with the actor `iterate-cloud`; null for every other key.
alter table keys add column origin text;
