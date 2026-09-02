import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey } from "../src/crypto.ts";
import {
  backupObjectUrl,
  decryptDump,
  encryptDump,
  parseBackupKey,
  requireOffsiteEnv,
} from "../src/hosted/backup-envelope.ts";

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

test("README does not claim a live nightly dump without the restore runbook", () => {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  assert.match(readme, /docs\/ops\/restore\.md/);
  assert.doesNotMatch(
    readme,
    /Nightly `backup-prod\.yml` \(`0 4 \* \* \*` UTC\) dumps via `DATABASE_URL_DIRECT`/,
  );
});
