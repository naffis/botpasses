/**
 * Re-enrolling an authenticator from the console: `totp/start` (with the current code) leaves
 * a pending secret, `/enroll-totp` must render for that ready operator, and the page reads the
 * same secret back through `GET /api/auth/totp/pending` instead of starting another (B2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
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

type Started = { otpauth_url: string; qr_svg: string };

test("B2 re-enroll: /enroll-totp renders for a ready operator with a pending secret; totp/pending returns that secret's QR", async () => {
  const ctx = await identityServer();
  try {
    const email = "reenroll-page@example.com";
    const first = await signUpAndEnroll(ctx, email);

    // Nothing in flight: the page belongs to the console and the endpoint has nothing to show.
    const idle = await api(ctx, "/enroll-totp", { jar: first.jar });
    assert.equal(idle.status, 302);
    assert.equal(idle.headers.get("location"), "/console");
    assert.equal((await api(ctx, "/api/auth/totp/pending", { jar: first.jar })).status, 404);

    ctx.clock.now += 30_000;
    const start = await api(ctx, "/api/auth/totp/start", {
      jar: first.jar,
      csrf: true,
      body: { current_code: totpCode(first.secret, ctx.clock.now) },
    });
    await expectStatus(start, 200, "totp/start");
    const started = await readJson<Started>(start);

    // The console sends the operator here after `start`; a redirect to /console would lose the QR.
    const page = await api(ctx, "/enroll-totp", { jar: first.jar });
    assert.equal(page.status, 200, "enroll page renders for a ready operator with a pending secret");
    assert.match(await page.text(), /data-testid="enroll-totp"/);

    // The page shows the secret that `confirm` will check, not a fresh one.
    const pending = await api(ctx, "/api/auth/totp/pending", { jar: first.jar });
    await expectStatus(pending, 200, "totp/pending");
    const shown = await readJson<Started>(pending);
    assert.equal(shown.otpauth_url, started.otpauth_url);
    assert.equal(shown.qr_svg, started.qr_svg);
    assert.match(shown.qr_svg, /^<svg\b/);
    assert.notEqual(new URL(shown.otpauth_url).searchParams.get("secret"), first.secret);

    // Confirming clears the pending secret: the page goes back to the console.
    const secret = new URL(shown.otpauth_url).searchParams.get("secret") ?? "";
    const confirm = await api(ctx, "/api/auth/totp/confirm", {
      jar: first.jar,
      csrf: true,
      body: { code: totpCode(secret, ctx.clock.now) },
    });
    await expectStatus(confirm, 200, "totp/confirm");
    const ready = cookieJar(confirm);
    assert.equal((await api(ctx, "/api/auth/totp/pending", { jar: ready })).status, 404);
    const done = await api(ctx, "/enroll-totp", { jar: ready });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get("location"), "/console");
    const verify = await api(ctx, "/api/auth/totp/verify", { jar: ready, csrf: true, body: { code: totpCode(secret, ctx.clock.now + 30_000) } });
    assert.notEqual(verify.status, 401, "the confirmed secret is the live one");

    // An enrolled account whose session has not passed the authenticator step gets nothing.
    await logout(ctx, cookieJar(verify));
    const relog = await otpSignIn(ctx, email);
    assert.equal(relog.body.verify, true);
    assert.equal((await api(ctx, "/api/auth/totp/pending", { jar: relog.jar })).status, 403);
  } finally {
    await ctx.close();
  }
});

test("B2 first enrollment: a reload sees the secret already in flight, it expires after ten minutes, anonymous is 401", async () => {
  const ctx = await identityServer();
  try {
    const { jar } = await otpSignIn(ctx, "fresh@example.com");
    assert.equal((await api(ctx, "/api/auth/totp/pending", { jar })).status, 404);
    const start = await api(ctx, "/api/auth/totp/start", { jar, csrf: true, body: {} });
    await expectStatus(start, 200, "totp/start");
    const started = await readJson<Started>(start);
    const again = await readJson<Started>(await api(ctx, "/api/auth/totp/pending", { jar }));
    assert.equal(again.otpauth_url, started.otpauth_url);

    ctx.clock.now += 10 * 60 * 1000;
    assert.equal((await api(ctx, "/api/auth/totp/pending", { jar })).status, 404, "expired");
    assert.equal((await api(ctx, "/enroll-totp", { jar })).status, 200, "a pending session still gets the page");
    // A fresh start replaces the expired secret and enrollment completes as before.
    const enrolled = await enrollTotp(ctx, jar);
    assert.notEqual(enrolled.secret, new URL(started.otpauth_url).searchParams.get("secret"));

    assert.equal((await api(ctx, "/api/auth/totp/pending")).status, 401);
  } finally {
    await ctx.close();
  }
});
