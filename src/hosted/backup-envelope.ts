import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

/** 32-byte hex key used only for offsite `pg_dump` blobs. Never the vault KEK. */
export function parseBackupKey(raw: string | undefined): Buffer {
  const key = Buffer.from(raw ?? "", "hex");
  if (key.length !== 32) throw new Error("BACKUP_KEY must be 32-byte hex");
  return key;
}

export function encryptDump(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptDump(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error("backup blob too short");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export type OffsiteEnv = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

/** Fail closed. A dump that never leaves the runner is not a backup. */
export function requireOffsiteEnv(env: NodeJS.ProcessEnv): OffsiteEnv {
  const accountId = env.R2_ACCOUNT_ID?.trim() ?? "";
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim() ?? "";
  const bucket = env.R2_BUCKET?.trim() ?? "";
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET are required");
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function backupObjectUrl(opts: { accountId: string; bucket: string; stamp: string }): string {
  return `https://${opts.accountId}.r2.cloudflarestorage.com/${opts.bucket}/botpasses-${opts.stamp}.dump.enc`;
}
