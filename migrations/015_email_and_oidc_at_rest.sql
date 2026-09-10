-- 015: email wrap columns and oidc consume stamp.
-- users.email / org_invites.email are overwritten with a keyed HMAC after rebind;
-- the inbox lives in the wrap. oidc consume must not jsonb_set ciphertext.
-- Mirrors HOSTED_SCHEMA_EMAIL_AND_OIDC_AT_REST_ALTER_PG in src/store/schema.ts.
-- Applied by scripts/migrate.ts. Expand-only.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_wrapped_iv TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_wrapped_ciphertext TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_wrapped_tag TEXT;

ALTER TABLE org_invites ADD COLUMN IF NOT EXISTS email_wrapped_iv TEXT;
ALTER TABLE org_invites ADD COLUMN IF NOT EXISTS email_wrapped_ciphertext TEXT;
ALTER TABLE org_invites ADD COLUMN IF NOT EXISTS email_wrapped_tag TEXT;

ALTER TABLE oidc_payloads ADD COLUMN IF NOT EXISTS consumed_at INTEGER;

-- Down (manual): drop the eight new columns.
