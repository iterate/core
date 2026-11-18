-- The address of the one person whose passkey a draft takes (src/statement-drafts.ts), as the agent
-- named it. Null: any signer the intake takes.
alter table statement_drafts add column signer_email text;
