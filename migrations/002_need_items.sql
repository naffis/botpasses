-- Expand-only. Applied via HOSTED_SCHEMA_SQLITE at boot (CREATE TABLE IF NOT EXISTS).
-- Down: DROP TABLE IF EXISTS need_items;

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
