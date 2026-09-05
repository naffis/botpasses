-- 013: a need_items row is either a secret the operator types on the collect page
-- (kind 'secret') or a provider user account the operator connects in the console
-- (kind 'connect'); provider and source_item_id describe a connect need.
-- Mirrors HOSTED_SCHEMA_NEED_CONNECT_ALTER_PG in src/store/schema.ts.
-- Applied by scripts/migrate.ts. Expand-only.

ALTER TABLE need_items ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'secret';
ALTER TABLE need_items ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE need_items ADD COLUMN IF NOT EXISTS source_item_id TEXT;

-- Down (manual): ALTER TABLE need_items DROP COLUMN source_item_id, DROP COLUMN provider, DROP COLUMN kind;
