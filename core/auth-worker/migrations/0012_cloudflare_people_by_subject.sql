-- A PERSON WHOM ONLY CLOUDFLARE SIGNS IN KEEPS NO ADDRESS HERE (src/users.ts `linkBySubject`).
-- Cloudflare does not say that it checked the address it gives, so that address must not link a
-- later sign-in to this person. Such a person's row takes `cloudflare:<subject>` in `email`, the
-- key that the sign-in uses from now on, and keeps its id. A person with another way as well keeps
-- the address: that way checked it.
update users
set email = 'cloudflare:' || lower((select i.subject from identities i where i.user_id = users.id))
where id in (
  select user_id from identities
  group by user_id
  having count(*) = 1 and min(provider) = 'cloudflare'
);
