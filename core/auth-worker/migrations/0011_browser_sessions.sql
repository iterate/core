-- A BROWSER'S SESSION AT THE ISSUER (src/cookies.ts `sessionCookie` makes one, `sessionOf` reads
-- it, src/sessions-page.ts lists and ends them). The session cookie holds the id: a cookie whose
-- row is gone, ended or expired is no session. Times are epoch ms.
create table browser_sessions (
  -- `session_<hex>`
  id text primary key,
  user_id text not null,
  -- how it was opened: src/cookies.ts `SignInMethod`, never "cloudflare"
  method text not null,
  -- the id of the passkey that opened it, for the method "passkey": the session ends with the key
  key_id text,
  -- the browser's User-Agent at the sign-in, cut to 300 characters; "" when it sent none
  user_agent text not null,
  created_at integer not null,
  -- written at most once in ten minutes
  last_seen_at integer not null,
  expires_at integer not null,
  ended_at integer
);

create index browser_sessions_by_user on browser_sessions (user_id, created_at);
