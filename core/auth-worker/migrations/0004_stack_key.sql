-- THE STACK'S OWN KEY (src/stack-key.ts): one P-256 key pair, made on first use. id is always 1, so
-- two first uses insert one row between them. private_key: PKCS#8 DER, base64url. public_key:
-- SubjectPublicKeyInfo DER, base64url. key: its id (iterate/signed `keyIdOf`).
create table stack_key (
  id integer primary key check (id = 1),
  key text not null,
  public_key text not null,
  private_key text not null
);
