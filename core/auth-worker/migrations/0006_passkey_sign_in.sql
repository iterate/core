-- SIGNING IN WITH A PASSKEY, AND THE FIRST OWNER'S TICKET (src/passkey-sign-in.ts,
-- src/first-owner.ts). Times are epoch ms.

-- A sign-in the page asked for. challenge: what the passkey must sign, the hash of a statement this
-- Worker made (iterate/signed `challengeOf`), so an answer counts for a challenge given here, once:
-- expires_at is set to 0 when it is answered. client: the requester's address (`cf-connecting-ip`),
-- null when unknown. The limits count these rows inside the statement that adds one; rows older
-- than ten minutes are deleted when a new one is written.
create table passkey_challenges (
  challenge text primary key,
  client text,
  created_at integer not null,
  expires_at integer not null
);

create index passkey_challenges_client on passkey_challenges (client, created_at);

-- The first owner's ticket, used: the insert that fails on a repeat is what makes it count once.
-- hash: the SHA-256 of the ticket, in hex, as the Worker's FIRST_OWNER_TICKET variable holds it.
create table spent_tickets (
  hash text primary key,
  spent_at integer not null
);
