-- ONE ROW PER PASSKEY CREDENTIAL (src/passkey-sign-in.ts finds a passkey's key by its credential's
-- id, which the member's browser names when it is added). Without this, a member who learned
-- another's credential id could add a row that holds it, and that member's sign-in would find the
-- wrong key and be refused.
create unique index keys_by_credential on keys (credential_id) where credential_id is not null;
