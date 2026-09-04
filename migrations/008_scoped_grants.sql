-- 008: scoped approvals (plan 3.1).
-- Mirrors HOSTED_SCHEMA_SCOPE_ALTER_PG in src/store/schema.ts. Applied by scripts/migrate.ts.
-- Expand-only: every column is nullable or defaulted, so rows written before this migration
-- read as unrestricted grants and policies (the previous behaviour).
--
-- grants:   methods, path_prefixes, hosts are JSON arrays (TEXT); max_calls with its calls_used
--           counter; requested_scope_json is the {host, method, path} the agent asked for.
-- policies: the same limits plus expires_at (item_standing approvals may now expire).

ALTER TABLE grants ADD COLUMN IF NOT EXISTS methods TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS path_prefixes TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS hosts TEXT;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS max_calls INTEGER;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS calls_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS requested_scope_json TEXT;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS methods TEXT;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS path_prefixes TEXT;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS hosts TEXT;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS max_calls INTEGER;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS calls_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS expires_at TEXT;

-- Down (manual):
--   ALTER TABLE grants DROP COLUMN methods, DROP COLUMN path_prefixes, DROP COLUMN hosts,
--     DROP COLUMN max_calls, DROP COLUMN calls_used, DROP COLUMN requested_scope_json;
--   ALTER TABLE policies DROP COLUMN methods, DROP COLUMN path_prefixes, DROP COLUMN hosts,
--     DROP COLUMN max_calls, DROP COLUMN calls_used, DROP COLUMN expires_at;
