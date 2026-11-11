-- THE PEOPLE AN OWNER BLOCKED (src/blocked.ts). A stack whose sign-in is open to anyone
-- (`login.methods.email.anyone`) has people who are not members: its apps' end users. A row here
-- refuses one of them: no code is mailed to the address, and no session or token of it is anyone's.
-- A member is never blocked: a member is removed. Times are epoch ms.
create table blocked (
  -- trimmed and lower-cased; matched exactly
  email text primary key,
  -- the address of the owner who blocked it
  blocked_by text not null,
  blocked_at integer not null
);
