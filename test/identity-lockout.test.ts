import assert from "node:assert/strict";
import { test } from "node:test";
import { TOTP_LOCK_MS, TOTP_MAX_FAILURES } from "../src/hosted/identity-totp.ts";
import {
  api,
  expectStatus,
  identityServer,
  logout,
  otpSignIn,
  readJson,
  signUpAndEnroll,
  totpCode,
  wrongTotpCode,
} from "./identity-harness.ts";

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
    const user = await ctx.store.getUserByEmail(email);
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
    const reset = await ctx.store.getUserByEmail(email);
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
