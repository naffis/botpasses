import assert from "node:assert/strict";
import { test } from "node:test";
import { hashToken } from "../src/hosted/operator-identity.ts";
import {
  api,
  cookieJar,
  enrollTotp,
  expectStatus,
  identityServer,
  logout,
  otpSignIn,
  readJson,
  signUpAndEnroll,
  totpCode,
} from "./identity-harness.ts";

test("S1: enrolled user signing in gets a pending session; operator API is 403 until the authenticator step", async () => {
  const ctx = await identityServer();
  try {
    const email = "mfa@example.com";
    const first = await signUpAndEnroll(ctx, email);
    // The pre-MFA session used for enrollment is gone once the authenticator is confirmed (D9).
    assert.equal(await ctx.store.getSession(hashToken(first.pendingJar.token)), undefined);
    const readySession = await ctx.store.getSession(hashToken(first.jar.token));
    assert.ok(readySession?.mfaAt, "confirmed session carries mfa_at");
    assert.equal((await api(ctx, "/api/items?environment=staging", { jar: first.jar })).status, 200);

    await logout(ctx, first.jar);
    assert.equal((await api(ctx, "/api/items?environment=staging", { jar: first.jar })).status, 401);

    const second = await otpSignIn(ctx, email);
    assert.deepEqual({ enroll: second.body.enroll, verify: second.body.verify }, { enroll: false, verify: true });
    const pending = await ctx.store.getSession(hashToken(second.jar.token));
    assert.equal(pending?.mfaAt, null);

    const denied = await api(ctx, "/api/items?environment=staging", { jar: second.jar });
    assert.equal(denied.status, 403);
    const deniedBody = await readJson<{ error: string; enroll_url?: string; verify_url?: string }>(denied);
    assert.equal(deniedBody.error, "mfa_required");
    assert.ok(deniedBody.verify_url === "/verify-totp" || deniedBody.enroll_url === "/enroll-totp");

    const me = await api(ctx, "/api/auth/me", { jar: second.jar });
    assert.equal(me.status, 403);

    for (const path of ["/sign-in", "/sign-up", "/enroll-totp"]) {
      const r = await api(ctx, path, { jar: second.jar });
      assert.equal(r.status, 302, path);
      assert.equal(r.headers.get("location"), "/verify-totp", path);
    }
    const page = await api(ctx, "/verify-totp", { jar: second.jar });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-testid="verify-totp"/);
    const anon = await api(ctx, "/verify-totp");
    assert.equal(anon.headers.get("location"), "/sign-in");

    // An enrolled user cannot restart enrollment from a pending session.
    const restart = await api(ctx, "/api/auth/totp/start", { jar: second.jar, csrf: true, body: {} });
    assert.equal(restart.status, 403);
    assert.equal((await readJson<{ error: string }>(restart)).error, "mfa_required");

    // Enrollment consumed the current step; move to the next one for a fresh code.
    ctx.clock.now += 30_000;
    const wrong = await api(ctx, "/api/auth/totp/verify", {
      jar: second.jar,
      csrf: true,
      body: { code: totpCode(first.secret, ctx.clock.now) === "000000" ? "000001" : "000000" },
    });
    assert.equal(wrong.status, 401);
    assert.equal((await readJson<{ attempts_remaining: number }>(wrong)).attempts_remaining, 9);

    const noCsrf = await api(ctx, "/api/auth/totp/verify", {
      jar: second.jar,
      body: { code: totpCode(first.secret, ctx.clock.now) },
    });
    assert.equal(noCsrf.status, 403);

    const verified = await api(ctx, "/api/auth/totp/verify", {
      jar: second.jar,
      csrf: true,
      body: { code: totpCode(first.secret, ctx.clock.now) },
    });
    await expectStatus(verified, 200);
    const ready = cookieJar(verified);
    assert.notEqual(ready.token, second.jar.token, "session id rotates on the authenticator step");
    assert.equal(await ctx.store.getSession(hashToken(second.jar.token)), undefined);
    assert.ok((await ctx.store.getSession(hashToken(ready.token)))?.mfaAt);
    assert.equal((await api(ctx, "/api/items?environment=staging", { jar: ready })).status, 200);
    assert.equal((await api(ctx, "/verify-totp", { jar: ready })).headers.get("location"), "/console");

    // Same step again is a replay.
    const replay = await api(ctx, "/api/auth/totp/verify", {
      jar: ready,
      csrf: true,
      body: { code: totpCode(first.secret, ctx.clock.now) },
    });
    assert.equal(replay.status, 401);
  } finally {
    await ctx.close();
  }
});

test("S1: a backup code passes the authenticator step once", async () => {
  const ctx = await identityServer();
  try {
    const email = "backup@example.com";
    const { backupCodes, jar } = await signUpAndEnroll(ctx, email);
    assert.equal(backupCodes.length, 10);
    await logout(ctx, jar);
    const pending = await otpSignIn(ctx, email);
    const used = await api(ctx, "/api/auth/totp/verify", {
      jar: pending.jar,
      csrf: true,
      body: { code: backupCodes[0]!.toLowerCase() },
    });
    assert.equal(used.status, 200);
    const ready = cookieJar(used);
    const me = await readJson<{ backup_codes_remaining: number; totp_enabled: boolean; email: string }>(
      await api(ctx, "/api/auth/me", { jar: ready }),
    );
    assert.equal(me.backup_codes_remaining, 9);
    assert.equal(me.totp_enabled, true);
    assert.equal(me.email, email);
    await logout(ctx, ready);
    const again = await otpSignIn(ctx, email);
    const reused = await api(ctx, "/api/auth/totp/verify", {
      jar: again.jar,
      csrf: true,
      body: { code: backupCodes[0] },
    });
    assert.equal(reused.status, 401);
  } finally {
    await ctx.close();
  }
});

test("S1: re-enroll needs a current code, drops unused backup codes, and kills other pre-MFA sessions", async () => {
  const ctx = await identityServer();
  try {
    const email = "reenroll@example.com";
    const first = await signUpAndEnroll(ctx, email);
    const noCode = await api(ctx, "/api/auth/totp/start", { jar: first.jar, csrf: true, body: {} });
    assert.equal(noCode.status, 403);
    assert.equal((await readJson<{ error: string }>(noCode)).error, "current_code_required");
    const badCode = await api(ctx, "/api/auth/totp/start", {
      jar: first.jar,
      csrf: true,
      body: { current_code: "000000" === totpCode(first.secret, ctx.clock.now) ? "000001" : "000000" },
    });
    assert.equal(badCode.status, 401);
    // The pending secret was never written for a refused start.
    const user = await ctx.store.getUserByEmail(email);
    assert.equal(user?.totpPendingWrappedIv, null);

    // A stray pre-MFA session for the same user (a second tab that only did the email step).
    const stray = await otpSignIn(ctx, email);
    assert.ok(await ctx.store.getSession(hashToken(stray.jar.token)));

    ctx.clock.now += 30_000;
    const second = await enrollTotp(ctx, first.jar, totpCode(first.secret, ctx.clock.now));
    assert.notEqual(second.secret, first.secret);
    assert.equal(await ctx.store.getSession(hashToken(stray.jar.token)), undefined, "pre-MFA session deleted");
    assert.equal(await ctx.store.getSession(hashToken(first.jar.token)), undefined, "confirming session rotated");
    const me = await readJson<{ backup_codes_remaining: number }>(await api(ctx, "/api/auth/me", { jar: second.jar }));
    assert.equal(me.backup_codes_remaining, 10);

    await logout(ctx, second.jar);
    const pending = await otpSignIn(ctx, email);
    const oldBackup = await api(ctx, "/api/auth/totp/verify", {
      jar: pending.jar,
      csrf: true,
      body: { code: first.backupCodes[0] },
    });
    assert.equal(oldBackup.status, 401, "old backup codes are rejected after re-enroll");
    const oldSecret = await api(ctx, "/api/auth/totp/verify", {
      jar: pending.jar,
      csrf: true,
      body: { code: totpCode(first.secret, ctx.clock.now + 60_000) },
    });
    assert.equal(oldSecret.status, 401, "old authenticator secret is rejected after re-enroll");
    const newBackup = await api(ctx, "/api/auth/totp/verify", {
      jar: pending.jar,
      csrf: true,
      body: { code: second.backupCodes[0] },
    });
    assert.equal(newBackup.status, 200);
  } finally {
    await ctx.close();
  }
});

test("account endpoints: /api/auth/me and backup-code regeneration need a ready session and CSRF", async () => {
  const ctx = await identityServer();
  try {
    const email = "account@example.com";
    const { secret, backupCodes, jar } = await signUpAndEnroll(ctx, email);
    assert.equal((await api(ctx, "/api/auth/me")).status, 401);
    const me = await readJson<{ email: string; totp_enabled: boolean; backup_codes_remaining: number; created_at: string }>(
      await api(ctx, "/api/auth/me", { jar }),
    );
    assert.equal(me.email, email);
    assert.equal(me.totp_enabled, true);
    assert.equal(me.backup_codes_remaining, 10);
    assert.ok(Date.parse(me.created_at) > 0);

    ctx.clock.now += 30_000;
    const noCsrf = await api(ctx, "/api/auth/backup-codes/regenerate", { jar, body: { code: totpCode(secret, ctx.clock.now) } });
    assert.equal(noCsrf.status, 403);
    const wrong = await api(ctx, "/api/auth/backup-codes/regenerate", { jar, csrf: true, body: { code: backupCodes[1] + "X" } });
    assert.equal(wrong.status, 401);
    const regen = await api(ctx, "/api/auth/backup-codes/regenerate", {
      jar,
      csrf: true,
      body: { code: totpCode(secret, ctx.clock.now) },
    });
    await expectStatus(regen, 200);
    const fresh = await readJson<{ backup_codes: string[] }>(regen);
    assert.equal(fresh.backup_codes.length, 10);
    assert.equal(fresh.backup_codes.some((c) => backupCodes.includes(c)), false);
    const unused = (await ctx.store.listBackupCodes((await ctx.store.getUserByEmail(email))!.id)).filter((c) => !c.usedAt);
    assert.equal(unused.length, 10, "old unused codes are deleted, not kept alongside");

    await logout(ctx, jar);
    const pending = await otpSignIn(ctx, email);
    assert.equal(
      (await api(ctx, "/api/auth/totp/verify", { jar: pending.jar, csrf: true, body: { code: backupCodes[2] } })).status,
      401,
    );
    assert.equal(
      (await api(ctx, "/api/auth/totp/verify", { jar: pending.jar, csrf: true, body: { code: fresh.backup_codes[2] } })).status,
      200,
    );
  } finally {
    await ctx.close();
  }
});

test("logout, totp/start and totp/confirm check the CSRF token for cookie sessions", async () => {
  const ctx = await identityServer();
  try {
    const pending = await otpSignIn(ctx, "csrf@example.com");
    assert.equal((await api(ctx, "/api/auth/totp/start", { jar: pending.jar, body: {} })).status, 403);
    assert.equal((await api(ctx, "/api/auth/totp/start", { jar: pending.jar, csrf: true, body: {} })).status, 200);
    assert.equal((await api(ctx, "/api/auth/totp/confirm", { jar: pending.jar, body: { code: "123456" } })).status, 403);
    const logoutNoCsrf = await api(ctx, "/api/auth/logout", { jar: pending.jar, body: {} });
    assert.equal(logoutNoCsrf.status, 403);
    assert.ok(await ctx.store.getSession(hashToken(pending.jar.token)), "session survives a CSRF-less logout");
    await logout(ctx, pending.jar);
    assert.equal(await ctx.store.getSession(hashToken(pending.jar.token)), undefined);
    // Without a session there is nothing to forge; clearing cookies stays a plain 200.
    assert.equal((await api(ctx, "/api/auth/logout", { body: {} })).status, 200);
  } finally {
    await ctx.close();
  }
});
