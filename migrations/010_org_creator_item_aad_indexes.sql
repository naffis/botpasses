-- 010: org creator, item AAD version, and grant sweep index.
-- Mirrors HOSTED_SCHEMA_V10_ALTER_PG and HOSTED_SCHEMA_V10_INDEXES in src/store/schema.ts.
-- Applied by scripts/migrate.ts. Expand-only.
--
-- orgs.created_by: the user who provisioned the org. A user with no memberships reclaims an
--   org they created only while it has zero members (a crash between org and owner insert);
--   a removed owner never regains a personal org through a deterministic id.
-- items.aad_version: 0 for rows written before this migration (bound to orgId alone, or to the
--   item-bound AAD but unrecorded); 1 once the boot-time rebind has verified or re-encrypted
--   the envelope under orgId|itemId|allowed_hosts_json|inject. New rows are written as 1.
-- grants_status_settled: the hourly sweep deletes revoked, consumed, and expired grants whose
--   settlement time is more than 30 days old.

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS aad_version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS orgs_created_by ON orgs (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_aad_legacy ON items (aad_version) WHERE aad_version = 0;
CREATE INDEX IF NOT EXISTS grants_status_settled ON grants (status, created_at);

-- Down (manual): DROP INDEX IF EXISTS grants_status_settled; DROP INDEX IF EXISTS items_aad_legacy;
-- DROP INDEX IF EXISTS orgs_created_by; ALTER TABLE items DROP COLUMN aad_version;
-- ALTER TABLE orgs DROP COLUMN created_by;
