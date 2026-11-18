-- THE STACK'S OWN KEY IS ML-DSA-65 (src/stack-key.ts): the working key that the mind's identity
-- lists for statements (iterate/mind-identity), made on first use. The P-256 key of 0004 goes
-- with its table: no record of an identity lists a P-256 key, so no mind signs with one, and no
-- clean mind was live with one. id is always 1, so two first uses insert one row between them.
-- key: its id (iterate/mind-identity `identityKeyIdOf`). public_key: the raw public key, 1952
-- bytes. seed: the 32 bytes that the key is made from (WebCrypto `raw-seed`). Both base64url.
drop table stack_key;
create table stack_key (
  id integer primary key check (id = 1),
  key text not null,
  public_key text not null,
  seed text not null
);
