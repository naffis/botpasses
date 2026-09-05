import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client, Pool } from "pg";
import { listMigrations, MIGRATION_LOCK_KEY, migrationDatabaseUrl, runMigrations } from "../scripts/migrate.ts";
import { PostgresStore } from "../src/store/postgres.ts";

const dbUrl = process.env.DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

function schemaName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

async function withSchema<T>(schema: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: dbUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const client = new Client({ connectionString: dbUrl, options: `-c search_path=${schema}` });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
    const drop = new Client({ connectionString: dbUrl });
    await drop.connect();
    await drop.query(`DROP SCHEMA "${schema}" CASCADE`);
    await drop.end();
  }
}

async function objects(client: Client, schema: string): Promise<{ tables: string[]; indexes: string[]; columns: string[] }> {
  const tables = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY 1",
    [schema],
  );
  const indexes = await client.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY 1",
    [schema],
  );
  const columns = await client.query<{ c: string }>(
    "SELECT table_name || '.' || column_name || ':' || data_type AS c FROM information_schema.columns WHERE table_schema = $1 ORDER BY 1",
    [schema],
  );
  return {
    tables: tables.rows.map((r) => r.tablename),
    indexes: indexes.rows.map((r) => r.indexname),
    columns: columns.rows.map((r) => r.c),
  };
}

test("listMigrations returns NNN_*.sql in order with unique versions", () => {
  const files = listMigrations(migrationsDir);
  assert.ok(files.length >= 5);
  assert.equal(files[0]?.version, "001_init");
  const versions = files.map((f) => f.version.slice(0, 3));
  assert.deepEqual(versions, [...versions].sort());
  assert.equal(new Set(versions).size, versions.length);
  assert.deepEqual(files.map((f) => f.prefix), versions, "prefix is the three-digit number of the file");
});

test("migrationDatabaseUrl prefers DATABASE_URL_DIRECT", () => {
  assert.equal(migrationDatabaseUrl({ DATABASE_URL_DIRECT: "postgres://direct", DATABASE_URL: "postgres://pooled" }), "postgres://direct");
  assert.equal(migrationDatabaseUrl({ DATABASE_URL: "postgres://pooled" }), "postgres://pooled");
  assert.throws(() => migrationDatabaseUrl({}), /DATABASE_URL_DIRECT/);
});

test("migrator applies once, is idempotent, and matches the schema.ts bootstrap", async (t) => {
  if (!dbUrl) {
    t.skip("DATABASE_URL not set");
    return;
  }
  const migrated = schemaName("mig");
  const bootstrapped = schemaName("boot");
  await withSchema(migrated, async (client) => {
    const files = listMigrations(migrationsDir);
    const first = await runMigrations(client, files);
    assert.deepEqual(first.applied, files.map((f) => f.version));
    assert.deepEqual(first.skipped, []);
    const second = await runMigrations(client, files);
    assert.deepEqual(second.applied, []);
    assert.equal(second.skipped.length, files.length);
    const recorded = await client.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
    assert.deepEqual(recorded.rows.map((r) => r.version), files.map((f) => f.version));
    const lockFree = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1",
      [MIGRATION_LOCK_KEY % 2 ** 32],
    );
    assert.equal(lockFree.rows[0]?.n, "0", "advisory lock released");

    const fromFiles = await objects(client, migrated);
    await withSchema(bootstrapped, async (bootClient) => {
      const pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${bootstrapped}`, max: 2 });
      const store = new PostgresStore(pool);
      try {
        await store.migrate();
      } finally {
        await store.close();
      }
      const fromSchemaTs = await objects(bootClient, bootstrapped);
      assert.ok(fromSchemaTs.tables.length > 10, "bootstrap created tables");
      const missingTables = fromSchemaTs.tables.filter((x) => !fromFiles.tables.includes(x));
      const missingIndexes = fromSchemaTs.indexes.filter((x) => !fromFiles.indexes.includes(x));
      const missingColumns = fromSchemaTs.columns.filter((x) => !fromFiles.columns.includes(x));
      assert.deepEqual(missingTables, [], "tables in schema.ts but not in migrations/");
      assert.deepEqual(missingIndexes, [], "indexes in schema.ts but not in migrations/");
      assert.deepEqual(missingColumns, [], "columns in schema.ts but not in migrations/");
      // The other direction for indexes: a migration must not create an index the bootstrap lacks.
      const extraIndexes = fromFiles.indexes.filter((x) => !fromSchemaTs.indexes.includes(x) && !x.startsWith("schema_migrations"));
      assert.deepEqual(extraIndexes, [], "indexes in migrations/ but not in schema.ts");
      assert.ok(fromFiles.tables.includes("schema_migrations"));
    });
  });
});

test("PostgresStore.migrate() is a no-op when schema_migrations exists", async (t) => {
  if (!dbUrl) {
    t.skip("DATABASE_URL not set");
    return;
  }
  const schema = schemaName("noop");
  await withSchema(schema, async (client) => {
    await client.query("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}`, max: 2 });
    const store = new PostgresStore(pool);
    try {
      await store.migrate();
    } finally {
      await store.close();
    }
    const after = await objects(client, schema);
    assert.deepEqual(after.tables, ["schema_migrations"], "boot did not run DDL");
  });
});

test("a migration file renamed after it was applied is refused, not applied a second time", async (t) => {
  if (!dbUrl) {
    t.skip("DATABASE_URL not set");
    return;
  }
  const schema = schemaName("rename");
  await withSchema(schema, async (client) => {
    const files = listMigrations(migrationsDir);
    await runMigrations(client, files);
    const renamed = files.map((f, i) => (i === 0 ? { ...f, version: `${f.prefix}_init_renamed` } : f));
    await assert.rejects(runMigrations(client, renamed), /migration 001 was applied as 001_init but the file is now 001_init_renamed/);
    const recorded = await client.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
    assert.deepEqual(recorded.rows.map((r) => r.version), files.map((f) => f.version), "nothing was re-applied or re-recorded");
    const lockFree = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1",
      [MIGRATION_LOCK_KEY % 2 ** 32],
    );
    assert.equal(lockFree.rows[0]?.n, "0", "advisory lock released after the refusal");
  });
});

test("two migrators racing on a fresh schema both finish without error", async (t) => {
  if (!dbUrl) {
    t.skip("DATABASE_URL not set");
    return;
  }
  const schema = schemaName("race");
  await withSchema(schema, async (client) => {
    const other = new Client({ connectionString: dbUrl, options: `-c search_path=${schema}` });
    await other.connect();
    try {
      const files = listMigrations(migrationsDir);
      const [a, b] = await Promise.all([runMigrations(client, files), runMigrations(other, files)]);
      assert.equal(a.applied.length + b.applied.length, files.length);
      assert.equal(a.skipped.length + b.skipped.length, files.length);
    } finally {
      await other.end();
    }
  });
});
