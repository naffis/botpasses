#!/usr/bin/env node
/**
 * Write decrypted inboxes back into `users.email` and `org_invites.email` before
 * reverting an email-at-rest image. Counts only; never prints addresses.
 *
 * Uses the same KEK resolution as `src/hosted/main.ts` (`selectKekProvider`).
 */
import { EmailDirectory, restorePlaintextEmails } from "../src/hosted/email-directory.ts";
import { IdentityKeyring } from "../src/hosted/identity-keys.ts";
import { selectKekProvider } from "../src/hosted/kms.ts";
import { PostgresStore } from "../src/store/postgres.ts";

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required");
  const kek = await selectKekProvider(env).unwrap();
  const store = await PostgresStore.open(url);
  try {
    const emails = new EmailDirectory(new IdentityKeyring(store, kek, () => new Date()));
    const result = await restorePlaintextEmails(store, emails, () => false);
    console.error(`email_restore users=${result.users} invites=${result.invites}`);
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
