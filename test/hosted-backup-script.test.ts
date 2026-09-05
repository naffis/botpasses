/**
 * `scripts/hosted-backup.ts` is run by the backup workflow; a usage slip or a bad BACKUP_KEY
 * must read as one line on stderr and exit 1, like migrate.ts, not as a stack trace.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/hosted-backup.ts", import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("hosted-backup.ts answers a usage error or a short BACKUP_KEY with one stderr line and exit 1", async () => {
  const usage = await run([], {});
  assert.equal(usage.code, 1);
  assert.equal(usage.stderr.trim(), "usage: hosted-backup.ts require-offsite-env | encrypt <in> <out> | decrypt <in> <out>");
  const missingArgs = await run(["encrypt", "only-one"], {});
  assert.equal(missingArgs.code, 1);
  assert.equal(missingArgs.stderr.trim().split("\n").length, 1, missingArgs.stderr);
  const badKey = await run(["encrypt", "in.dump", "out.enc"], { BACKUP_KEY: "abcd" });
  assert.equal(badKey.code, 1);
  assert.equal(badKey.stderr.trim(), "BACKUP_KEY must be 32-byte hex");
  assert.doesNotMatch(badKey.stderr, /^\s+at /m, "no stack frames");
  assert.equal(badKey.stdout, "");
});
