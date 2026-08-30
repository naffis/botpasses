import { PostgresStore } from "../../src/store/postgres.ts";

const grantId = process.argv[2];
const consumedAt = process.argv[3] ?? new Date().toISOString();
if (!grantId) {
  console.error("usage: cas-worker GRANT_ID");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(2);
}
const store = await PostgresStore.open(url);
const won = await store.consumeGrant(grantId, consumedAt);
await store.close();
process.stdout.write(won ? "1" : "0");
