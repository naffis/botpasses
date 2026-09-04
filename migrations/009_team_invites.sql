-- 009: team invites, the session org switcher, and member join time.
-- Mirrors HOSTED_SCHEMA_TEAM and HOSTED_SCHEMA_TEAM_ALTER_PG in src/store/schema.ts.
-- Applied by scripts/migrate.ts. Expand-only.

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

ALTER TABLE operator_sessions ADD COLUMN IF NOT EXISTS active_org_id TEXT;
ALTER TABLE org_members ADD COLUMN IF NOT EXISTS joined_at TEXT;

-- Down (manual): DROP TABLE org_invites; ALTER TABLE operator_sessions DROP COLUMN active_org_id;
-- ALTER TABLE org_members DROP COLUMN joined_at;
