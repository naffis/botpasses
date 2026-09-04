#!/usr/bin/env node
/**
 * Offsite dump envelope. Encrypt and decrypt `pg_dump` blobs.
 * Upload stays in the workflow after this script has required R2 env.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  decryptDump,
  encryptDump,
  parseBackupKey,
  requireOffsiteEnv,
} from "../src/hosted/backup-envelope.ts";

const USAGE = "usage: hosted-backup.ts require-offsite-env | encrypt <in> <out> | decrypt <in> <out>";

function main(argv: string[]): void {
  const cmd = argv[0] ?? "";
  if (cmd === "require-offsite-env") {
    requireOffsiteEnv(process.env);
    return;
  }
  if (cmd === "encrypt" || cmd === "decrypt") {
    const src = argv[1];
    const dest = argv[2];
    if (!src || !dest) throw new Error(USAGE);
    const key = parseBackupKey(process.env.BACKUP_KEY);
    const input = readFileSync(src);
    const out = cmd === "encrypt" ? encryptDump(input, key) : decryptDump(input, key);
    writeFileSync(dest, out);
    return;
  }
  throw new Error(USAGE);
}

// One line on stderr and exit 1, like migrate.ts; a usage slip or a short BACKUP_KEY is not a crash.
try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
