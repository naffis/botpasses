import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey } from "../src/crypto.ts";
import {
  BACKUP_MAGIC,
  BACKUP_VERSION,
  backupObjectUrl,
  decryptDump,
  encryptDump,
  parseBackupKey,
  requireOffsiteEnv,
} from "../src/hosted/backup-envelope.ts";

test("the envelope starts with the BPBK magic and a version byte that decryptDump checks (G12)", () => {
  const key = parseBackupKey(generateMasterKey());
  const blob = encryptDump(Buffer.from("pg-dump-fixture"), key);
  assert.equal(blob.subarray(0, 4).toString("ascii"), "BPBK");
  assert.equal(blob[4], BACKUP_VERSION);
  assert.equal(BACKUP_MAGIC.toString("ascii"), "BPBK");
  const wrongMagic = Buffer.from(blob);
  wrongMagic.write("PGDM", 0, "ascii");
  assert.throws(() => decryptDump(wrongMagic, key), /bad magic/);
  const futureVersion = Buffer.from(blob);
  futureVersion[4] = 9;
  assert.throws(() => decryptDump(futureVersion, key), /unsupported backup envelope version 9/);
  const headerless = blob.subarray(5);
  assert.throws(() => decryptDump(headerless, key), /bad magic|too short/);
});

test("backup envelope round-trips and rejects the wrong key", () => {
  const key = parseBackupKey(generateMasterKey());
  const plain = Buffer.from("pg-dump-fixture");
  const blob = encryptDump(plain, key);
  assert.deepEqual(decryptDump(blob, key), plain);
  const other = parseBackupKey(generateMasterKey());
  assert.throws(() => decryptDump(blob, other), /Unsupported state|unable to authenticate|unable to authenticate data|auth/i);
});

test("parseBackupKey refuses a short secret", () => {
  assert.throws(() => parseBackupKey("ab"), /BACKUP_KEY must be 32-byte hex/);
});

test("requireOffsiteEnv fails closed when any R2 field is missing", () => {
  const full = {
    R2_ACCOUNT_ID: "acct",
    R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "bucket",
  };
  assert.equal(requireOffsiteEnv(full).bucket, "bucket");
  assert.throws(() => requireOffsiteEnv({ ...full, R2_ACCOUNT_ID: "" }), /R2_/);
  assert.throws(() => requireOffsiteEnv({ ...full, R2_BUCKET: "  " }), /R2_/);
});

test("backup-prod workflow requires offsite env and does not skip R2", () => {
  const yml = readFileSync(join(process.cwd(), ".github/workflows/backup-prod.yml"), "utf8");
  assert.match(yml, /hosted-backup\.ts require-offsite-env/);
  assert.match(yml, /hosted-backup\.ts encrypt/);
  assert.doesNotMatch(yml, /if \[ -n "\$\{R2_ACCOUNT_ID/);
  assert.match(yml, /workflow_dispatch/);
  assert.match(yml, /cron: "0 4 \* \* \*"/);
});

test("backup object key is stamped and not a pooled host", () => {
  const url = backupObjectUrl({ accountId: "acct", bucket: "bkt", stamp: "20260101T000000Z" });
  assert.equal(url, "https://acct.r2.cloudflarestorage.com/bkt/botpasses-20260101T000000Z.dump.enc");
});

test("the envelope is versioned AES-GCM: tampering with any byte, header included, fails to open", () => {
  const key = parseBackupKey(generateMasterKey());
  const blob = encryptDump(Buffer.from("pg-dump-fixture"), key);
  assert.ok(blob.length > 5 + 16 + 12, "carries a header, a nonce, and a tag beyond the ciphertext");
  for (const offset of [0, Math.floor(blob.length / 2), blob.length - 1]) {
    const tampered = Buffer.from(blob);
    tampered[offset] = (tampered[offset] ?? 0) ^ 0x01;
    assert.throws(() => decryptDump(tampered, key), `byte ${offset}`);
  }
  assert.throws(() => decryptDump(blob.subarray(0, blob.length - 1), key), "truncated");
});
