import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Envelope layout: `BPBK` magic, one version byte, then AES-256-GCM nonce (12), tag (16), and
 * ciphertext. The header is authenticated as AAD, so a blob from another tool, a future
 * layout, or an edited header fails closed before any plaintext is produced.
 */
export const BACKUP_MAGIC = Buffer.from("BPBK", "ascii");
export const BACKUP_VERSION = 1;
const HEADER_LEN = BACKUP_MAGIC.length + 1;

/** 32-byte hex key used only for offsite `pg_dump` blobs. Never the vault KEK. */
export function parseBackupKey(raw: string | undefined): Buffer {
  const key = Buffer.from(raw ?? "", "hex");
  if (key.length !== 32) throw new Error("BACKUP_KEY must be 32-byte hex");
  return key;
}

function header(version: number): Buffer {
  return Buffer.concat([BACKUP_MAGIC, Buffer.from([version])]);
}

export function encryptDump(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const head = header(BACKUP_VERSION);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(head);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([head, iv, cipher.getAuthTag(), ct]);
}

export function decryptDump(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < HEADER_LEN + IV_LEN + TAG_LEN) throw new Error("backup blob too short");
  const magic = blob.subarray(0, BACKUP_MAGIC.length);
  if (!magic.equals(BACKUP_MAGIC)) throw new Error("not a Botpasses backup envelope (bad magic)");
  const version = blob[BACKUP_MAGIC.length] ?? 0;
  if (version !== BACKUP_VERSION) throw new Error(`unsupported backup envelope version ${version}`);
  const iv = blob.subarray(HEADER_LEN, HEADER_LEN + IV_LEN);
  const tag = blob.subarray(HEADER_LEN + IV_LEN, HEADER_LEN + IV_LEN + TAG_LEN);
  const ct = blob.subarray(HEADER_LEN + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(header(version));
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
