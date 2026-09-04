-- 007: tenant-scoped OAuth clients and indexed oidc_payloads.
-- Mirrors HOSTED_SCHEMA_OAUTH_ALTER_PG and the unique clients_org_oauth index in src/store/schema.ts.
-- Applied by scripts/migrate.ts. Expand-only except the index rebuild.
--
-- Pre-check before deploying to a database with existing OAuth clients:
--   SELECT org_id, oauth_client_id, count(*) FROM clients
--   WHERE oauth_client_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
-- Duplicates must be resolved (revoke the extras) or the unique index creation fails.

DROP INDEX IF EXISTS clients_org_oauth;
CREATE UNIQUE INDEX IF NOT EXISTS clients_org_oauth
  ON clients (org_id, oauth_client_id) WHERE oauth_client_id IS NOT NULL;

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

-- Down (manual): DROP INDEX oidc_payloads_*; ALTER TABLE oidc_payloads DROP COLUMN uid, user_code, grant_id, client_id, account_id;
