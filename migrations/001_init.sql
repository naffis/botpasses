-- Hosted grant vault schema (Neon Postgres).
-- Applied in order by scripts/migrate.ts (Fly release_command, DATABASE_URL_DIRECT) and
-- recorded in schema_migrations. src/store/schema.ts holds the same DDL as string constants
-- for SQLite and for the dev/test bootstrap path; test/migrations.test.ts checks parity.
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
