#!/usr/bin/env node
/**
 * Apply migrations/NNN_*.sql in order to Postgres and record them in schema_migrations.
 *
 * Runs as the Fly release_command before a new image serves traffic, over
 * DATABASE_URL_DIRECT (Neon direct host; the pooler does not support session-level
 * advisory locks reliably). Falls back to DATABASE_URL for local and CI.
 *
 * Safe to run concurrently: a session advisory lock serialises runners, each file is
 * applied inside its own transaction, and applied versions are skipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/** Arbitrary constant; every runner takes the same lock. */
export const MIGRATION_LOCK_KEY = 7_419_203_311;

/**
 * `version` is the file name without `.sql` and is what `schema_migrations.version` records;
 * `prefix` is the three-digit number that identifies the migration regardless of its name.
 */
export type MigrationFile = { version: string; prefix: string; path: string; sql: string };

export function migrationPrefix(version: string): string {
  return version.slice(0, 3);
}

export function listMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/i.test(f))
    .sort((a, b) => a.localeCompare(b));
  const seen = new Set<string>();
  return files.map((f) => {
    const prefix = migrationPrefix(f);
    if (seen.has(prefix)) throw new Error(`duplicate migration version ${prefix}`);
    seen.add(prefix);
    const path = resolve(dir, f);
    return { version: f.replace(/\.sql$/i, ""), prefix, path, sql: readFileSync(path, "utf8") };
  });
}

export function migrationDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL_DIRECT?.trim() || env.DATABASE_URL?.trim() || "";
  if (!url) throw new Error("migrate: set DATABASE_URL_DIRECT (preferred) or DATABASE_URL");
  return url;
}

export type MigrateResult = { applied: string[]; skipped: string[] };

export async function runMigrations(
  client: Client,
  migrations: MigrationFile[],
  log: (line: string) => void = () => undefined,
): Promise<MigrateResult> {
  const result: MigrateResult = { applied: [], skipped: [] };
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL
       )`,
    );
    const done = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    // Applied migrations are identified by their number, so a file that was renamed after it ran
    // is neither applied twice nor silently accepted: it is refused with both names.
    const applied = new Map(done.rows.map((r) => [migrationPrefix(r.version), r.version] as const));
    for (const m of migrations) {
      const recorded = applied.get(m.prefix);
      if (recorded === m.version) {
        result.skipped.push(m.version);
        continue;
      }
      if (recorded !== undefined) {
        throw new Error(
          `migration ${m.prefix} was applied as ${recorded} but the file is now ${m.version}; a migration file cannot be renamed after it was applied`,
        );
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)", [
          m.version,
          new Date().toISOString(),
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`migration ${m.version} failed: ${message}`, { cause: err });
      }
      result.applied.push(m.version);
      log(`applied ${m.version}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
  }
  return result;
}

export async function migrate(env: NodeJS.ProcessEnv = process.env, dir?: string): Promise<MigrateResult> {
  const migrationsDir = dir ?? resolve(fileURLToPath(new URL("../migrations/", import.meta.url)));
  const client = new Client({
    connectionString: migrationDatabaseUrl(env),
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    application_name: "botpasses-migrate",
  });
  await client.connect();
  try {
    return await runMigrations(client, listMigrations(migrationsDir), (line) => console.error(line));
  } finally {
    await client.end();
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  migrate().then(
    (r) => {
      console.error(JSON.stringify({ event: "schema_migrate", applied: r.applied, skipped: r.skipped.length }));
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
