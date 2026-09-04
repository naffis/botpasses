/** Hosted schema. TEXT timestamps. SQLite and Postgres share this DDL except noted. */

export const HOSTED_SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  wrapped_dek_iv TEXT NOT NULL,
  wrapped_dek_ciphertext TEXT NOT NULL,
  wrapped_dek_tag TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (vault_id, name)
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (environment_id, name)
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  folder_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  last4 TEXT NOT NULL,
  username TEXT,
  allowed_hosts_json TEXT NOT NULL,
  inject TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (environment_id, name)
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  hashed_secret TEXT,
  clerk_oauth_user_id TEXT,
  environment TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  item_id TEXT,
  folder_id TEXT,
  environment_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS policies_item
  ON policies (org_id, client_id, item_id) WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS policies_folder
  ON policies (org_id, client_id, folder_id, environment_id) WHERE kind = 'folder_standing';

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  item_id TEXT,
  folder_id TEXT,
  environment_id TEXT NOT NULL,
  policy TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT,
  task_id TEXT,
  task_description TEXT
);

CREATE TABLE IF NOT EXISTS approval_challenges (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  item_name TEXT,
  client_id TEXT,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS grants_org_status ON grants (org_id, status);
CREATE INDEX IF NOT EXISTS audit_org_at ON audit (org_id, at);
CREATE INDEX IF NOT EXISTS items_env ON items (environment_id);
CREATE INDEX IF NOT EXISTS grants_client_item_status ON grants (client_id, item_id, status);
CREATE INDEX IF NOT EXISTS approval_challenges_grant ON approval_challenges (grant_id);

CREATE TABLE IF NOT EXISTS agentpass_passes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  status TEXT NOT NULL,
  holder_cnf TEXT,
  scope_json TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS need_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  suggested_name TEXT NOT NULL,
  host TEXT NOT NULL,
  task_description TEXT,
  status TEXT NOT NULL,
  item_id TEXT,
  grant_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  fulfilled_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS need_items_pending
  ON need_items (org_id, client_id, environment_id, suggested_name, host)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS need_items_org_status ON need_items (org_id, status);

CREATE TABLE IF NOT EXISTS rate_hits (
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (org_id, kind, window_start)
);
`;

export const HOSTED_SCHEMA_IDENTITY = `
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

CREATE TABLE IF NOT EXISTS identity_keys (
  id TEXT PRIMARY KEY,
  wrapped_iv TEXT NOT NULL,
  wrapped_ciphertext TEXT NOT NULL,
  wrapped_tag TEXT NOT NULL,
  created_at TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS operator_sessions_user ON operator_sessions (user_id);
CREATE INDEX IF NOT EXISTS email_otp_challenges_email ON email_otp_challenges (email, sent_at);
CREATE INDEX IF NOT EXISTS backup_codes_user ON backup_codes (user_id);
`;

/** Indexes on columns added by the identity ALTERs. Run after those ALTERs on both stores. */
export const HOSTED_SCHEMA_IDENTITY_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS clients_hashed_secret ON clients (hashed_secret) WHERE hashed_secret IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clients_org_oauth ON clients (org_id, oauth_client_id) WHERE oauth_client_id IS NOT NULL;
`;

/**
 * Indexed copies of oidc-provider payload fields so the adapter never scans a kind.
 * Columns are derived from the payload JSON on every upsert; the backfill UPDATE
 * covers rows written before the columns existed and is a no-op afterwards.
 * Run after HOSTED_SCHEMA_IDENTITY on both stores (SQLite splits on ";" and
 * tolerates "duplicate column").
 */
export const HOSTED_SCHEMA_OAUTH_ALTER_SQLITE = `
ALTER TABLE oidc_payloads ADD COLUMN uid TEXT;
ALTER TABLE oidc_payloads ADD COLUMN user_code TEXT;
ALTER TABLE oidc_payloads ADD COLUMN grant_id TEXT;
ALTER TABLE oidc_payloads ADD COLUMN client_id TEXT;
ALTER TABLE oidc_payloads ADD COLUMN account_id TEXT;
CREATE INDEX IF NOT EXISTS oidc_payloads_uid ON oidc_payloads (kind, uid) WHERE uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS oidc_payloads_user_code ON oidc_payloads (kind, user_code) WHERE user_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS oidc_payloads_grant ON oidc_payloads (kind, grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS oidc_payloads_client ON oidc_payloads (kind, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS oidc_payloads_expires ON oidc_payloads (expires_at) WHERE expires_at IS NOT NULL;
UPDATE oidc_payloads SET
  uid = json_extract(payload, '$.uid'),
  user_code = json_extract(payload, '$.userCode'),
  grant_id = json_extract(payload, '$.grantId'),
  client_id = json_extract(payload, '$.clientId'),
  account_id = json_extract(payload, '$.accountId')
  WHERE kind IN ('Session', 'Grant', 'RefreshToken', 'AuthorizationCode', 'DeviceCode')
    AND uid IS NULL AND grant_id IS NULL AND client_id IS NULL AND account_id IS NULL
    AND json_valid(payload);
`;

export const HOSTED_SCHEMA_OAUTH_ALTER_PG = `
DO $$
BEGIN
  -- clients_org_oauth shipped once as a plain index; CREATE UNIQUE ... IF NOT EXISTS would keep it.
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'clients_org_oauth' AND NOT i.indisunique
  ) THEN
    DROP INDEX clients_org_oauth;
  END IF;
END $$;
ALTER TABLE oidc_payloads ADD COLUMN IF NOT EXISTS uid TEXT;
ALTER TABLE oidc_payloads ADD COLUMN IF NOT EXISTS user_code TEXT;
ALTER TABLE oidc_payloads ADD COLUMN IF NOT EXISTS grant_id TEXT;
ALTER TABLE oidc_payloads ADD COLUMN IF NOT EXISTS client_id TEXT;
ALTER TABLE oidc_payloads ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS oidc_payloads_uid ON oidc_payloads (kind, uid) WHERE uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS oidc_payloads_user_code ON oidc_payloads (kind, user_code) WHERE user_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS oidc_payloads_grant ON oidc_payloads (kind, grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS oidc_payloads_client ON oidc_payloads (kind, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS oidc_payloads_expires ON oidc_payloads (expires_at) WHERE expires_at IS NOT NULL;
UPDATE oidc_payloads SET
  uid = payload::jsonb->>'uid',
  user_code = payload::jsonb->>'userCode',
  grant_id = payload::jsonb->>'grantId',
  client_id = payload::jsonb->>'clientId',
  account_id = payload::jsonb->>'accountId'
  WHERE kind IN ('Session', 'Grant', 'RefreshToken', 'AuthorizationCode', 'DeviceCode')
    AND uid IS NULL AND grant_id IS NULL AND client_id IS NULL AND account_id IS NULL;
`;

export const HOSTED_SCHEMA_IDENTITY_ALTER_SQLITE = `
ALTER TABLE clients ADD COLUMN oauth_client_id TEXT;
ALTER TABLE clients ADD COLUMN revoked_at TEXT;
ALTER TABLE clients ADD COLUMN last_token_at TEXT;
ALTER TABLE clients ADD COLUMN last_seen_at TEXT;
ALTER TABLE clients ADD COLUMN consented_by_user_id TEXT;
ALTER TABLE clients ADD COLUMN last4 TEXT;
`;

export const HOSTED_SCHEMA_IDENTITY_ALTER_PG = `
ALTER TABLE clients ADD COLUMN IF NOT EXISTS oauth_client_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS revoked_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_token_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_seen_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS consented_by_user_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last4 TEXT;
`;

/**
 * Second identity expansion: MFA-at-sign-in (`mfa_at`), the TOTP failure counter and lockout,
 * and the in-flight enrollment secret. Expand-only; run after `HOSTED_SCHEMA_IDENTITY_ALTER_*`.
 */
export const HOSTED_SCHEMA_IDENTITY_ALTER2_SQLITE = `
ALTER TABLE operator_sessions ADD COLUMN mfa_at TEXT;
ALTER TABLE users ADD COLUMN totp_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_locked_until TEXT;
ALTER TABLE users ADD COLUMN totp_pending_wrapped_iv TEXT;
ALTER TABLE users ADD COLUMN totp_pending_wrapped_ciphertext TEXT;
ALTER TABLE users ADD COLUMN totp_pending_wrapped_tag TEXT;
ALTER TABLE users ADD COLUMN totp_pending_at TEXT;
`;

export const HOSTED_SCHEMA_IDENTITY_ALTER2_PG = `
ALTER TABLE operator_sessions ADD COLUMN IF NOT EXISTS mfa_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_locked_until TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_wrapped_iv TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_wrapped_ciphertext TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_wrapped_tag TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_at TEXT;
`;

/**
 * Team (task 3.7): email invites. `token_hash` is sha256 of the 32-byte token in the accept
 * link; the token itself is never stored. Expand-only; mirrored by migrations/009_team_invites.sql.
 */
export const HOSTED_SCHEMA_TEAM = `
CREATE TABLE IF NOT EXISTS org_invites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS org_invites_token ON org_invites (token_hash);
CREATE INDEX IF NOT EXISTS org_invites_org ON org_invites (org_id, accepted_at);
`;

/**
 * `operator_sessions.active_org_id`: the org the session chose in the switcher; null means the
 * user's first membership. `org_members.joined_at` is null for rows written before this column.
 * SQLite splits on ";" and tolerates "duplicate column".
 */
export const HOSTED_SCHEMA_TEAM_ALTER_SQLITE = `
ALTER TABLE operator_sessions ADD COLUMN active_org_id TEXT;
ALTER TABLE org_members ADD COLUMN joined_at TEXT;
`;

export const HOSTED_SCHEMA_TEAM_ALTER_PG = `
ALTER TABLE operator_sessions ADD COLUMN IF NOT EXISTS active_org_id TEXT;
ALTER TABLE org_members ADD COLUMN IF NOT EXISTS joined_at TEXT;
`;
