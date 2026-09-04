-- 006: MFA at sign-in, TOTP lockout, store-backed pending enrollment, identity DEK.
-- Mirrors HOSTED_SCHEMA_IDENTITY (identity_keys) and HOSTED_SCHEMA_IDENTITY_ALTER2_PG in src/store/schema.ts.
-- Applied by scripts/migrate.ts. Expand-only.

ALTER TABLE operator_sessions ADD COLUMN IF NOT EXISTS mfa_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_locked_until TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_wrapped_iv TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_wrapped_ciphertext TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_wrapped_tag TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_at TEXT;

CREATE TABLE IF NOT EXISTS identity_keys (
  id TEXT PRIMARY KEY,
  wrapped_iv TEXT NOT NULL,
  wrapped_ciphertext TEXT NOT NULL,
  wrapped_tag TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Down (manual): DROP TABLE identity_keys; ALTER TABLE users DROP COLUMN totp_failures, ...; ALTER TABLE operator_sessions DROP COLUMN mfa_at;
