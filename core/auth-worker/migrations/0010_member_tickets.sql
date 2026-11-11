-- A MEMBER'S ONE-USE SIGN-IN LINK (src/members.ts makes one, src/first-owner.ts takes it). On a
-- stack with no mailed codes, a member an owner added has no way to a first passkey. An owner makes
-- a link for that member and passes it on. Only the hash is kept. Times are epoch ms.
create table member_tickets (
  -- the SHA-256 of the ticket, in hex
  hash text primary key,
  -- the member it signs in: trimmed and lower-cased
  email text not null,
  -- the address of the owner who made it
  made_by text not null,
  expires_at integer not null,
  -- set by the one use; the update that finds it null is what makes it count once
  spent_at integer
);
