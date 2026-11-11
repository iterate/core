-- THE KEYS AND THE STATEMENTS THEY SIGNED (src/keys.ts). Times are epoch ms.

-- A key added at run time. Root keys are the stack config's (src/config.ts `keys`) and have no
-- row. A row is either a person's key (`user_id`: a passkey they added on /keys) or a service's
-- (`actor` and `paths`: a key a member allowed on /keys/enrol, such as the Cloud's).
-- id: the key's id, the SHA-256 of its public key (iterate/signed `keyIdOf`). public_key:
-- SubjectPublicKeyInfo DER, base64url. format: 'webauthn' or 'p256'. credential_id: the WebAuthn
-- credential's id, base64url, when it has one. paths: a service key's path prefixes, as a JSON
-- array. added_via: how it was added ('keys-page', 'enrol-page'). added_by: the member who added
-- it. A revoked key signs nothing from revoked_at on, and its row stays, so it is never added again.
create table keys (
  id text primary key,
  user_id text references users (id),
  actor text,
  paths text,
  public_key text not null,
  format text not null,
  credential_id text,
  label text not null,
  added_via text not null,
  added_by text not null references users (id),
  added_at integer not null,
  revoked_at integer,
  check ((user_id is null) <> (actor is null)),
  check (actor is null or paths is not null)
);

create index keys_by_user on keys (user_id);
create index keys_by_adder on keys (added_by);

-- Each statement a key signed that `verify` took, by its hash (iterate/signed `statementHashOf`):
-- the insert that fails on a repeat is what makes a statement count once. A row goes once the
-- statement has expired, since an expired statement is refused anyway.
create table statements (
  hash text primary key,
  expires integer not null
);
