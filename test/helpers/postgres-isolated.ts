import { randomUUID } from "node:crypto";
import { Client, Pool, type ClientBase } from "pg";
import { PostgresStore } from "../../src/store/postgres.ts";

/**
 * Identity keys belong to a deployment, not an org. Give tests that create or rotate
 * them a private schema so concurrent test processes never overwrite each other's DEK.
 * pg-pool awaits onConnect for every new connection, including replacements after a
 * rejected query. This prevents a reconnect from falling back to the public schema.
 */
export async function isolatedPostgres(url: string): Promise<{ store: PostgresStore; done: () => Promise<void> }> {
  const schema = `bp_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  // pg-pool awaits this hook, although @types/pg currently declares its return as void.
  const config = {
    ...PostgresStore.poolOptions(url),
    onConnect: async (client: ClientBase): Promise<void> => { await client.query(`SET search_path TO "${schema}"`); },
  };
  const pool = new Pool(config);
  const store = new PostgresStore(pool);
  const done = async (): Promise<void> => {
    try {
      await store.close();
    } finally {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await store.migrate();
    return { store, done };
  } catch (err) {
    await done();
    throw err;
  }
}
