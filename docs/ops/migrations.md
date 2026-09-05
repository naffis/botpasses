# Schema migrations

`migrations/NNN_name.sql` is the source of truth for the hosted Postgres schema. `scripts/migrate.ts` applies the files in order, each in its own transaction, under `pg_advisory_lock(7419203311)`, and records them in `schema_migrations(version, applied_at)`. It reads `DATABASE_URL_DIRECT` (Neon direct host) and falls back to `DATABASE_URL`.

Both `fly.*.toml` run it as `[deploy] release_command` so DDL happens once per release, before the new Machine takes traffic. A failed migration fails the release and the old image keeps serving.

`src/store/schema.ts` holds the same DDL as string constants. They are the SQLite schema for tests and the bootstrap for a database that has no `schema_migrations` table (local Postgres, CI without the migrate step). `PostgresStore.migrate()` checks for `schema_migrations` first: if it exists the release command owns DDL and boot does nothing; otherwise it runs the constants and logs `schema_bootstrap`. `test/migrations.test.ts` asserts that a database migrated by the files has every table, index, and column that a `schema.ts` bootstrap creates.

The runner sorts the files by name and records each by its three-digit number, so a gap in the numbering is fine: there is no `011_*.sql` (the number was retired before it shipped), and `010` is followed by `012`. Do not fill the gap; pick the next free number after the highest file.

## Adding a migration

1. Create `migrations/00N_short_name.sql` with the next free number (a gap in the sequence is not an error). Expand-only: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Put the down steps in a trailing comment.
2. Mirror the change in `schema.ts` (`HOSTED_SCHEMA_*` constants) so SQLite tests and the bootstrap path stay in parity. SQLite has no `ADD COLUMN IF NOT EXISTS`; follow the existing `_ALTER_SQLITE` / `_ALTER_PG` split.
3. `npm run migrate` twice against local Postgres (second run applies nothing), then `npm run test:pg`.
4. Ship. The release command applies it on staging, then production.

## Operating

```bash
# apply locally
DATABASE_URL=postgres://vault:vault@localhost:5432/vault npm run migrate

# what is applied on a plane (Neon SQL editor or psql on DATABASE_URL_DIRECT)
SELECT version, applied_at FROM schema_migrations ORDER BY version;
```

A release stuck on the advisory lock means another runner is mid-migration; wait, do not kill it. Neon's pooled `-pooler` host can drop session state between statements, which is why the runner uses the direct URL.

### Statement timeouts

The runner connects with `statement_timeout = 60000` (60 s per statement); the app pool runs with 15 s. A single statement that takes longer than 60 s (a backfill over a large table, an index build without `CONCURRENTLY`) fails the release and the old image keeps serving. For such a step, either split the work into batches that each finish well under a minute, or raise the limit for that file only with `SET LOCAL statement_timeout = '10min';` as its first statement (it applies to the file's transaction and nothing else). Do not raise the pool's timeout for a migration.

## First boot after 010 (item AAD rebind)

Migration 010 adds `items.aad_version` (0 for every existing row). The hosted process, not the release command, moves those rows to the item-bound AAD: on every boot it re-encrypts each row still at version 0 (`aad_rebind` in the changelog). This is a data pass, not DDL, so it runs in the app process after `/health` and `/ready` are answering and never gates readiness:

1. The server listens and logs `hosted_listening`. The Fly check (`/ready`, 10 s grace period) passes from here on.
2. The signal handlers are installed.
3. The rebind reads legacy rows in pages of 200 (`REBIND_BATCH_SIZE`, ordered by org and item id, keyset on the last row), opens each under the item-bound AAD (then marks it) or the legacy `orgId` AAD (then re-encrypts it in place), and logs `aad_rebind_progress` after every page with `batch`, `rows`, and the cumulative `rebound`, `verified`, `unreadable`, `ms`. Memory is bounded by one page whatever the table size.
4. `aad_rebind` logs the totals plus `batches`, `stopped`, and `ms`. Then the first expiry sweep runs.

How long: one page is one `SELECT` plus one `UPDATE` per row and one DEK unwrap per org on the page; on Neon that is on the order of a second or two per 200 rows, so 10,000 legacy rows finish within a couple of minutes. The pass is idempotent and resumable: only rows still at version 0 are read, so a second boot (or a restart mid-run) picks up what is left. Once every row is at version 1 the run is one empty `SELECT` and `aad_rebind` reports zeros.

While a row is still at version 0 it is exactly as safe as before the deploy: the console lists it, and an inject on it fails closed (the inject path opens rows under the item-bound AAD only, with no legacy fallback). A `SIGTERM` during the pass ends it at the next page boundary; the drain waits for the page in flight, then closes the pool, so no row is half-written. A rebind that throws (the pool dropped mid-run) logs `aad_rebind_failed` with the message and the process keeps serving; the next boot retries. Rows that open under neither AAD log `aad_rebind_unreadable` and stay at version 0 (see `docs/ops/alerts.md`).

## Before deploying the inject-mode grammar (0.5.0)

Items whose `inject` string is outside the grammar (`bearer`, `basic`, `client_credentials`, `refresh`, `sigv4`, `header:<name>`, `query:<param>`, `cookie:<name>`, `hmac:stripe_sig|slack_sig|github_sig`) fail at send time with `500 inject_unsupported` instead of falling through to Bearer. Find them first:

```sql
SELECT id, name, inject FROM items
WHERE inject NOT IN ('bearer','basic','client_credentials','refresh','sigv4')
  AND inject NOT LIKE 'header:%' AND inject NOT LIKE 'query:%'
  AND inject NOT LIKE 'cookie:%' AND inject NOT LIKE 'hmac:%';
```

Fix each row from the console (Edit, Change how it is sent) before the deploy.
