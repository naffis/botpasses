/** Identity queries against a real Postgres. Skips without DATABASE_URL, like hosted-postgres.test.ts. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { test } from "node:test";
import * as OTPAuth from "otpauth";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { IDENTITY_KEY_ID } from "../src/hosted/identity-keys.ts";
import { TOTP_LOCK_MS, TOTP_MAX_FAILURES } from "../src/hosted/identity-totp.ts";
import { OperatorIdentity, hashToken } from "../src/hosted/operator-identity.ts";
import { PostgresStore } from "../src/store/postgres.ts";
import { TEST_SESSION_SECRET } from "./helpers.ts";

const dbUrl = process.env.DATABASE_URL;

function code(secret: string, at: number): string {
  return new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate({ timestamp: at });
}

async function statusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    return (err as { status?: number }).status ?? 500;
  }
}

test("identity on Postgres: enroll, pending session rotation, lockout, backup codes, KEK rotation", async (t) => {
  if (!dbUrl) {
    t.skip("DATABASE_URL not set");
    return;
  }
  const store = await PostgresStore.open(dbUrl);
  // The identity DEK is a singleton row; each run uses a fresh random KEK, so a row left by a
  // previous run on a shared database cannot unwrap. Clearing it here mirrors a first boot.
  {
    const admin = new Client({ connectionString: dbUrl });
    await admin.connect();
    await admin.query("DELETE FROM identity_keys WHERE id = 'identity'");
    await admin.end();
  }
  await store.migrate(); // the ALTER2 statements must be idempotent
  const clock = { now: Date.now() };
  const now = (): Date => new Date(clock.now);
  const kekA = parseMasterKey(generateMasterKey());
  const kekB = parseMasterKey(generateMasterKey());
  const emails: string[] = [];
  const identityA = new OperatorIdentity({
    store,
    sessionSecret: TEST_SESSION_SECRET,
    kek: kekA,
    now,
    sendEmail: async (_to, _s, html) => {
      emails.push(html);
    },
  });
  const email = `pg-${randomUUID()}@example.com`;
  const otpFor = async (ip: string): Promise<string> => {
    await identityA.sendOtp(email, ip);
    const m = />(\d{8})</.exec(emails.at(-1) ?? "");
    assert.ok(m?.[1]);
    return m[1];
  };
  try {
    const pending = await identityA.verifyOtp(email, await otpFor("203.0.113.1"), { secure: false }, "203.0.113.1");
    const pendingHash = hashToken(pending.sessionToken);
    assert.equal((await store.getSession(pendingHash))?.mfaAt, null);

    const started = await identityA.startTotp(pending.user.id, { sessionReady: false });
    const secret = new URL(started.otpauth_url).searchParams.get("secret");
    assert.ok(secret);
    assert.ok((await store.getUser(pending.user.id))?.totpPendingWrappedIv, "pending secret persisted");
    const confirmed = await identityA.confirmTotp(pending.user.id, pendingHash, code(secret, clock.now), { secure: false });
    assert.equal(confirmed.backup_codes.length, 10);
    assert.equal(await store.getSession(pendingHash), undefined, "pending session rotated away");
    const readyHash = hashToken(confirmed.sessionToken);
    assert.ok((await store.getSession(readyHash))?.mfaAt);
    assert.equal((await store.getUser(pending.user.id))?.totpPendingWrappedIv, null);

    // Lockout is persisted in the users row.
    clock.now += 30_000;
    const stray = await identityA.verifyOtp(email, await otpFor("203.0.113.2"), { secure: false }, "203.0.113.2");
    const strayHash = hashToken(stray.sessionToken);
    let last = 0;
    for (let i = 0; i < TOTP_MAX_FAILURES; i += 1) {
      last = await statusOf(identityA.verifyTotp(pending.user.id, strayHash, "000000", { secure: false }));
    }
    assert.equal(last, 429);
    assert.ok((await store.getUser(pending.user.id))?.totpLockedUntil);
    clock.now += TOTP_LOCK_MS + 1000;
    const upgraded = await identityA.verifyTotp(pending.user.id, strayHash, code(secret, clock.now), { secure: false });
    assert.equal((await store.getUser(pending.user.id))?.totpFailures, 0);
    assert.ok((await store.getSession(hashToken(upgraded.sessionToken)))?.mfaAt);
    assert.equal(await store.getSession(strayHash), undefined);

    // Backup codes and the account summary.
    clock.now += 30_000;
    const regen = await identityA.regenerateBackupCodes(pending.user.id, code(secret, clock.now));
    assert.equal(regen.backup_codes.length, 10);
    const summary = await identityA.accountSummary(pending.user.id);
    assert.equal(summary.email, email);
    assert.equal(summary.totp_enabled, true);
    assert.equal(summary.backup_codes_remaining, 10);
    assert.equal(
      await statusOf(identityA.verifyTotp(pending.user.id, readyHash, confirmed.backup_codes[0]!, { secure: false })),
      401,
      "old backup codes were deleted",
    );

    // KEK rotation re-wraps the identity DEK row; a new process under the new KEK verifies.
    await identityA.rotateKek(kekA, kekB);
    const identityB = new OperatorIdentity({ store, sessionSecret: TEST_SESSION_SECRET, kek: kekB, now });
    clock.now += 30_000;
    const afterRotate = await identityB.verifyTotp(
      pending.user.id,
      hashToken(upgraded.sessionToken),
      code(secret, clock.now),
      { secure: false },
    );
    assert.ok(afterRotate.sessionToken);
    assert.ok(await store.getIdentityKey(IDENTITY_KEY_ID));
    assert.ok((await store.listUsersWithTotp()).some((u) => u.id === pending.user.id));
    await store.deleteUnusedBackupCodes(pending.user.id);
    assert.equal((await identityB.accountSummary(pending.user.id)).backup_codes_remaining, 0);
  } finally {
    try {
      // Do not leave a rotation KEK on the shared CI database for later files.
      const admin = new Client({ connectionString: dbUrl });
      await admin.connect();
      await admin.query("DELETE FROM identity_keys WHERE id = 'identity'");
      await admin.end();
    } finally {
      await store.close();
    }
  }
});
