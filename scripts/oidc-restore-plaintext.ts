#!/usr/bin/env node
/**
 * Write inner `{ id, body }` back onto `oidc_payloads` before reverting an
 * OAuth-token-at-rest image. Counts only; never prints tokens.
 *
 * Uses the same KEK resolution as `src/hosted/main.ts` (`selectKekProvider`).
 */
import { IdentityKeyring } from "../src/hosted/identity-keys.ts";
import { selectKekProvider } from "../src/hosted/kms.ts";
import { OidcDirectory } from "../src/hosted/oidc-directory.ts";
import { PostgresStore } from "../src/store/postgres.ts";

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");
  const kek = await selectKekProvider(env).unwrap();
  const store = await PostgresStore.open(url);
  try {
    const oidc = new OidcDirectory(new IdentityKeyring(store, kek, () => new Date()), store);
    const result = await oidc.restorePlaintext(() => false);
    console.error(`oidc_restore restored=${result.restored}`);
  } finally {
    await store.close();
  }
}

try {
  await main(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
