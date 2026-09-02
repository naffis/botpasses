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

const cmd = process.argv[2] ?? "";

function usage(): never {
  throw new Error("usage: hosted-backup.ts require-offsite-env | encrypt <in> <out> | decrypt <in> <out>");
}

if (cmd === "require-offsite-env") {
  requireOffsiteEnv(process.env);
} else if (cmd === "encrypt" || cmd === "decrypt") {
  const src = process.argv[3];
  const dest = process.argv[4];
  if (!src || !dest) usage();
  const key = parseBackupKey(process.env.BACKUP_KEY);
  const input = readFileSync(src);
  const out = cmd === "encrypt" ? encryptDump(input, key) : decryptDump(input, key);
  writeFileSync(dest, out);
} else {
  usage();
}
