-- Expand-contract: operator identity, OIDC adapter, access ledger, client OAuth columns.
-- Dual-read clients.oauth_client_id ?? clients.clerk_oauth_user_id. Do not drop clerk_oauth_user_id.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_verified_at TEXT,
  totp_wrapped_iv TEXT,
  totp_wrapped_ciphertext TEXT,
  totp_wrapped_tag TEXT,
  totp_last_step INTEGER,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email);

CREATE TABLE IF NOT EXISTS email_otp_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_scrypt TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_codes (
  user_id TEXT NOT NULL,
  code_scrypt TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS operator_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oidc_payloads (
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (id, kind)
);

CREATE TABLE IF NOT EXISTS access_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT,
  actor_user_id TEXT,
  kind TEXT NOT NULL,
  jti_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS access_events_jti ON access_events (jti_hash);
CREATE INDEX IF NOT EXISTS access_events_org_issued ON access_events (org_id, issued_at);

ALTER TABLE clients ADD COLUMN IF NOT EXISTS oauth_client_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS revoked_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_token_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_seen_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS consented_by_user_id TEXT;

CREATE INDEX IF NOT EXISTS clients_oauth_client_id ON clients (oauth_client_id);
CREATE INDEX IF NOT EXISTS org_members_org ON org_members (org_id);

-- Down: drop new tables and new columns only. Keep clerk_oauth_user_id.
-- DROP TABLE IF EXISTS access_events;
-- DROP TABLE IF EXISTS oidc_payloads;
-- DROP TABLE IF EXISTS operator_sessions;
-- DROP TABLE IF EXISTS backup_codes;
-- DROP TABLE IF EXISTS email_otp_challenges;
-- DROP TABLE IF EXISTS users;
-- ALTER TABLE clients DROP COLUMN IF EXISTS oauth_client_id;
-- ALTER TABLE clients DROP COLUMN IF EXISTS revoked_at;
-- ALTER TABLE clients DROP COLUMN IF EXISTS last_token_at;
-- ALTER TABLE clients DROP COLUMN IF EXISTS last_seen_at;
-- ALTER TABLE clients DROP COLUMN IF EXISTS consented_by_user_id;
