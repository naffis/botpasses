-- 012: the OAuth grant an issued token belongs to, so revoking a refresh token
-- (RFC 7009 or reuse detection) also marks its sibling access tokens in the ledger.
-- Mirrors HOSTED_SCHEMA_LEDGER_GRANT_ALTER_PG and HOSTED_SCHEMA_LEDGER_GRANT_INDEXES
-- in src/store/schema.ts. Applied by scripts/migrate.ts. Expand-only.

ALTER TABLE access_events ADD COLUMN IF NOT EXISTS grant_id TEXT;
CREATE INDEX IF NOT EXISTS access_events_grant ON access_events (grant_id) WHERE grant_id IS NOT NULL;

-- Down (manual): DROP INDEX access_events_grant; ALTER TABLE access_events DROP COLUMN grant_id;
