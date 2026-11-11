-- THE MEMBERS A MEMBER ADDED (src/members.ts). A member is an address the stack config's
-- `login.allow` admits, or a row here; the config's members cannot be removed at run time, and an
-- empty table is a stack as the config alone says. Times are epoch ms.
create table members (
  -- trimmed and lower-cased; matched exactly, its `+tag` included
  email text primary key,
  -- the address of the member who added it
  added_by text not null,
  added_at integer not null
);
