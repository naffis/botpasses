# Schema migrations

`migrations/NNN_name.sql` is the source of truth for the hosted Postgres schema. `scripts/migrate.ts` applies the files in order, each in its own transaction, under `pg_advisory_lock(7419203311)`, and records them in `schema_migrations(version, applied_at)`. It reads `DATABASE_URL_DIRECT` (Neon direct host) and falls back to `DATABASE_URL`.

Both `fly.*.toml` run it as `[deploy] release_command` so DDL happens once per release, before the new Machine takes traffic. A failed migration fails the release and the old image keeps serving.

`src/store/schema.ts` holds the same DDL as string constants. They are the SQLite schema for tests and the bootstrap for a database that has no `schema_migrations` table (local Postgres, CI without the migrate step). `PostgresStore.migrate()` checks for `schema_migrations` first: if it exists the release command owns DDL and boot does nothing; otherwise it runs the constants and logs `schema_bootstrap`. `test/migrations.test.ts` asserts that a database migrated by the files has every table, index, and column that a `schema.ts` bootstrap creates.

## Adding a migration

1. Create `migrations/00N_short_name.sql`. Expand-only: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Put the down steps in a trailing comment.
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
