-- 014: audit.host is the origin host a standing approval covered (auto_approved).
-- Null for every other action and for rows written before this column.
-- Mirrors HOSTED_SCHEMA_AUDIT_HOST_ALTER_PG in src/store/schema.ts.
-- Applied by scripts/migrate.ts. Expand-only.

ALTER TABLE audit ADD COLUMN IF NOT EXISTS host TEXT;

-- Down (manual): ALTER TABLE audit DROP COLUMN host;
