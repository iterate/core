-- THE AUTH WORKER'S PEOPLE (src/users.ts): the `users` and `identities` tables alone, copied
-- from the earlier platform (core/os, removed). Times are epoch ms.

-- email: trimmed and lower-cased. A user is never deleted.
create table users (
  id text primary key,
  email text not null unique
);

-- A sign-in method's stable subject, linked to a person once: one subject per provider per person.
-- provider: the sign-in method, such as `email`. added_at: null for one a sign-in
-- linked by its email, which is every one for now.
create table identities (
  provider text not null,
  subject text not null,
  user_id text not null references users (id),
  added_at integer,
  primary key (provider, subject),
  unique (provider, user_id)
);
