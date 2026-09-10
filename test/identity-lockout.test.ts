import assert from "node:assert/strict";
import { test } from "node:test";
import { isHttpError } from "../src/hosted/errors.ts";
import { TOTP_LOCK_MS, TOTP_MAX_FAILURES } from "../src/hosted/identity-totp.ts";
import { hashToken } from "../src/hosted/operator-identity.ts";
import {
  api,
  codeFromEmail,
  expectStatus,
  identityServer,
  logout,
  otpSignIn,
  readJson,
  signUpAndEnroll,
  totpCode,
  wrongTotpCode,
} from "./identity-harness.ts";

const OTP_WINDOW_MS = 15 * 60 * 1000;

test("R1-4: verifies with no live code do not spend the per-email budget; a correct sign-in from another address still works", async () => {
  const clock = { now: Date.now() };
  const ctx = await identityServer({ clock });
  try {
    const email = "victim@example.com";
    const cookies = { secure: false };
    // 25 bogus verifies for an address that never asked for a code (the per-email budget).
    for (let i = 0; i < 25; i += 1) {
      await assert.rejects(ctx.identity.verifyOtp(email, "00000000", cookies, `198.51.100.${i}`), (e: unknown) =>
        e instanceof Error && e.message === "Invalid code",
      );
    }
    const sent = await api(ctx, "/api/auth/otp/send", { body: { email } });
    await expectStatus(sent, 200, "otp/send");
    const otp = codeFromEmail(ctx.emails.filter((e) => e.to === email).at(-1)?.html ?? "");
    const issued = await ctx.identity.verifyOtp(email, otp, cookies, "203.0.113.7");
    assert.equal(issued.user.email, email, "the owner signs in from another address");

    // Wrong codes against a live challenge are what the per-email key counts.
    const other = "counted@example.com";
    await expectStatus(await api(ctx, "/api/auth/otp/send", { body: { email: other } }), 200, "otp/send");
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(ctx.identity.verifyOtp(other, "00000000", cookies, `198.51.100.${40 + i}`));
    }
    assert.equal(
      ctx.identity.ipLimiter.allow(`verify-email:${other}`, 3, OTP_WINDOW_MS, clock.now),
      false,
      "three wrong codes are three hits on the per-email key",
    );
  } finally {
    await ctx.close();
  }
});

test("R1-6: two concurrent confirms of the same enrollment code succeed exactly once and mint one backup-code set", async () => {
  const clock = { now: Date.now() };
  const ctx = await identityServer({ clock });
  try {
    const email = "twice@example.com";
    const pending = await otpSignIn(ctx, email);
    const start = await api(ctx, "/api/auth/totp/start", { jar: pending.jar, csrf: true, body: {} });
    await expectStatus(start, 200, "totp/start");
    const secret = new URL((await readJson<{ otpauth_url: string }>(start)).otpauth_url).searchParams.get("secret") ?? "";
    const code = totpCode(secret, clock.now);
    const before = await ctx.identity.userByEmail(email);
    assert.ok(before);
    // Driven in-process so both confirms read the pending secret before either writes; over
    // HTTP the synchronous SQLite path finishes the first before the second is parsed.
    const confirm = () => ctx.identity.confirmTotp(before.id, hashToken(pending.jar.token), code, { secure: false });
    const outcomes = await Promise.allSettled([confirm(), confirm()]);
    const wins = outcomes.filter((o) => o.status === "fulfilled");
    assert.equal(wins.length, 1, `exactly one confirm wins: ${outcomes.map((o) => o.status).join(",")}`);
    for (const o of outcomes) {
      if (o.status === "rejected") assert.ok(isHttpError(o.reason) && (o.reason.status === 400 || o.reason.status === 401), String(o.reason));
    }
    const winner = wins[0];
    assert.ok(winner && winner.status === "fulfilled");
    const shown = winner.value.backup_codes;
    const user = await ctx.identity.userByEmail(email);
    assert.ok(user);
    const unused = (await ctx.store.listBackupCodes(user.id)).filter((c) => c.usedAt === null);
    assert.equal(unused.length, shown.length, "one backup-code set exists");
    assert.equal(user.totpPendingWrappedIv, null, "the pending secret is consumed");
    // The set the winner showed is the live one: its first code passes the authenticator step.
    await ctx.identity.verifyTotp(user.id, hashToken(winner.value.sessionToken), shown[0] ?? "", { secure: false });
    const left = (await ctx.store.listBackupCodes(user.id)).filter((c) => c.usedAt === null);
    assert.equal(left.length, shown.length - 1, "the winner's code was the one consumed");
  } finally {
    await ctx.close();
  }
});

test("S8: ten wrong authenticator codes lock the account for 15 minutes; the lock survives a correct code", async () => {
  const clock = { now: Date.now() };
  const ctx = await identityServer({ clock });
  try {
    const email = "lock@example.com";
    const { secret, jar } = await signUpAndEnroll(ctx, email);
    await logout(ctx, jar);
    const pending = await otpSignIn(ctx, email);
    for (let i = 1; i < TOTP_MAX_FAILURES; i += 1) {
      const r = await api(ctx, "/api/auth/totp/verify", {
        jar: pending.jar,
        csrf: true,
        body: { code: wrongTotpCode(secret, clock.now) },
      });
      assert.equal(r.status, 401, `attempt ${i}`);
      assert.equal((await readJson<{ attempts_remaining: number }>(r)).attempts_remaining, TOTP_MAX_FAILURES - i);
    }
    const tenth = await api(ctx, "/api/auth/totp/verify", {
      jar: pending.jar,
      csrf: true,
      body: { code: wrongTotpCode(secret, clock.now) },
    });
    assert.equal(tenth.status, 429);
    const lockBody = await readJson<{ error: string; retry_after: number }>(tenth);
    assert.ok(lockBody.retry_after > 14 * 60 && lockBody.retry_after <= 15 * 60, String(lockBody.retry_after));
    const user = await ctx.identity.userByEmail(email);
    assert.ok(user?.totpLockedUntil, "lock is persisted in the store");

    const correctWhileLocked = await api(ctx, "/api/auth/totp/verify", {
      jar: pending.jar,
      csrf: true,
      body: { code: totpCode(secret, clock.now) },
    });
    assert.equal(correctWhileLocked.status, 429);

    clock.now += TOTP_LOCK_MS + 1000;
    const afterLock = await api(ctx, "/api/auth/totp/verify", {
      jar: pending.jar,
      csrf: true,
      body: { code: totpCode(secret, clock.now) },
    });
    await expectStatus(afterLock, 200);
    const reset = await ctx.identity.userByEmail(email);
    assert.equal(reset?.totpFailures, 0);
    assert.equal(reset?.totpLockedUntil, null);
  } finally {
    await ctx.close();
  }
});

test("S8: totp/confirm is bounded by the same counter and 429s while locked; an expired pending secret is refused", async () => {
  const clock = { now: Date.now() };
  const ctx = await identityServer({ clock });
  try {
    const email = "confirm-lock@example.com";
    const pending = await otpSignIn(ctx, email);
    const start = await api(ctx, "/api/auth/totp/start", { jar: pending.jar, csrf: true, body: {} });
    const secret = new URL((await readJson<{ otpauth_url: string }>(start)).otpauth_url).searchParams.get("secret")!;
    let last = 0;
    for (let i = 0; i < TOTP_MAX_FAILURES; i += 1) {
      const r = await api(ctx, "/api/auth/totp/confirm", {
        jar: pending.jar,
        csrf: true,
        body: { code: wrongTotpCode(secret, clock.now) },
      });
      last = r.status;
    }
    assert.equal(last, 429);
    const correctWhileLocked = await api(ctx, "/api/auth/totp/confirm", {
      jar: pending.jar,
      csrf: true,
      body: { code: totpCode(secret, clock.now) },
    });
    assert.equal(correctWhileLocked.status, 429);
    // Lock expires after 15 minutes, which also outlives the 10-minute pending secret.
    clock.now += TOTP_LOCK_MS + 1000;
    const stale = await api(ctx, "/api/auth/totp/confirm", {
      jar: pending.jar,
      csrf: true,
      body: { code: totpCode(secret, clock.now) },
    });
    assert.equal(stale.status, 400);
    const restart = await api(ctx, "/api/auth/totp/start", { jar: pending.jar, csrf: true, body: {} });
    assert.equal(restart.status, 200);
    const fresh = new URL((await readJson<{ otpauth_url: string }>(restart)).otpauth_url).searchParams.get("secret")!;
    const ok = await api(ctx, "/api/auth/totp/confirm", {
      jar: pending.jar,
      csrf: true,
      body: { code: totpCode(fresh, clock.now) },
    });
    await expectStatus(ok, 200);
  } finally {
    await ctx.close();
  }
});
