-- Expand: store-backed org rate limit and the hot-path indexes that schema.ts already
-- creates on the dev/test path. Brings migrations/ into parity with src/store/schema.ts.
-- Everything here is IF NOT EXISTS, so a database bootstrapped by PostgresStore.migrate()
-- (schema.ts constants) applies this file as a no-op.

CREATE TABLE IF NOT EXISTS rate_hits (
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (org_id, kind, window_start)
);

CREATE INDEX IF NOT EXISTS grants_client_item_status ON grants (client_id, item_id, status);
CREATE INDEX IF NOT EXISTS approval_challenges_grant ON approval_challenges (grant_id);
CREATE INDEX IF NOT EXISTS need_items_org_status ON need_items (org_id, status);
CREATE INDEX IF NOT EXISTS operator_sessions_user ON operator_sessions (user_id);
CREATE INDEX IF NOT EXISTS email_otp_challenges_email ON email_otp_challenges (email, sent_at);
CREATE INDEX IF NOT EXISTS backup_codes_user ON backup_codes (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS clients_hashed_secret ON clients (hashed_secret) WHERE hashed_secret IS NOT NULL;
CREATE INDEX IF NOT EXISTS clients_org_oauth ON clients (org_id, oauth_client_id);

-- Down: DROP INDEX IF EXISTS <each name above>; DROP TABLE IF EXISTS rate_hits;
