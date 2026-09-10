import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import * as OTPAuth from "otpauth";
import { decrypt, encrypt, generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { IDENTITY_KEY_ID } from "../src/hosted/identity-keys.ts";
import { unwrapDek } from "../src/hosted/kek.ts";
import { OperatorIdentity, hashToken } from "../src/hosted/operator-identity.ts";
import { TEST_SESSION_SECRET } from "./helpers.ts";
import {
  api,
  cookieJar,
  expectStatus,
  identityServer,
  logout,
  otpSignIn,
  signUpAndEnroll,
  totpCode,
  type IdentityCtx,
} from "./identity-harness.ts";

/** Email step then the authenticator step, one 30 s step later than whatever consumed the current one. */
async function verifyStep(ctx: IdentityCtx, email: string, secret: string): Promise<Response> {
  ctx.clock.now += 30_000;
  const pending = await otpSignIn(ctx, email);
  assert.equal(pending.body.verify, true);
  return api(ctx, "/api/auth/totp/verify", {
    jar: pending.jar,
    csrf: true,
    body: { code: totpCode(secret, ctx.clock.now) },
  });
}

test("S9: KEK rotation re-wraps the identity DEK and the authenticator step still passes", async () => {
  const kekA = parseMasterKey(generateMasterKey());
  const kekB = parseMasterKey(generateMasterKey());
  let ctx = await identityServer({ kek: kekA });
  try {
    const email = "rotate@example.com";
    const { secret, jar } = await signUpAndEnroll(ctx, email);
    await logout(ctx, jar);
    const before = await ctx.store.getIdentityKey(IDENTITY_KEY_ID);
    assert.ok(before, "identity DEK row created on first use");

    await ctx.identity.rotateKek(kekA, kekB);
    const after = await ctx.store.getIdentityKey(IDENTITY_KEY_ID);
    assert.ok(after);
    const envelope = { iv: after.wrappedIv, ciphertext: after.wrappedCiphertext, tag: after.wrappedTag };
    unwrapDek(envelope, kekB, IDENTITY_KEY_ID);
    assert.throws(() => unwrapDek(envelope, kekA, IDENTITY_KEY_ID));
    assert.deepEqual(
      unwrapDek(envelope, kekB, IDENTITY_KEY_ID),
      unwrapDek({ iv: before.wrappedIv, ciphertext: before.wrappedCiphertext, tag: before.wrappedTag }, kekA, IDENTITY_KEY_ID),
      "the DEK itself is unchanged",
    );

    ctx = await ctx.reopen(kekB);
    const verified = await verifyStep(ctx, email, secret);
    await expectStatus(verified, 200);
    assert.equal((await api(ctx, "/api/items?environment=staging", { jar: cookieJar(verified) })).status, 200);
    const me = await api(ctx, "/api/auth/me", { jar: cookieJar(verified) });
    assert.equal((await me.json() as { email?: string }).email, email);

    // Idempotent: a second rotation with the same pair is a no-op.
    await ctx.identity.rotateKek(kekA, kekB);
    const again = await ctx.store.getIdentityKey(IDENTITY_KEY_ID);
    assert.equal(again?.wrappedCiphertext, after.wrappedCiphertext);
  } finally {
    await ctx.close();
  }
});

test("S9: a legacy secret wrapped under the raw KEK is re-wrapped under the identity DEK on first use", async () => {
  const ctx = await identityServer();
  try {
    const email = "legacy@example.com";
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const userId = `usr_${randomUUID()}`;
    const legacy = encrypt(secret, ctx.kek, userId);
    await ctx.store.insertUser({
      id: userId,
      email,
      emailVerifiedAt: new Date(ctx.clock.now).toISOString(),
      totpWrappedIv: legacy.iv,
      totpWrappedCiphertext: legacy.ciphertext,
      totpWrappedTag: legacy.tag,
      totpLastStep: 0,
      createdAt: new Date(ctx.clock.now).toISOString(),
    });
    const verified = await verifyStep(ctx, email, secret);
    await expectStatus(verified, 200);
    const migrated = await ctx.store.getUser(userId);
    assert.ok(migrated?.totpWrappedIv && migrated.totpWrappedCiphertext && migrated.totpWrappedTag);
    const envelope = {
      iv: migrated.totpWrappedIv,
      ciphertext: migrated.totpWrappedCiphertext,
      tag: migrated.totpWrappedTag,
    };
    assert.throws(() => decrypt(envelope, ctx.kek, userId), "no longer under the raw KEK");
    const dek = await ctx.identity.keys.dek();
    assert.equal(decrypt(envelope, dek, userId), secret);
  } finally {
    await ctx.close();
  }
});

test("S9: rotateKek moves legacy raw-KEK secrets under the DEK so they survive the old KEK going away", async () => {
  const kekA = parseMasterKey(generateMasterKey());
  const kekB = parseMasterKey(generateMasterKey());
  let ctx = await identityServer({ kek: kekA });
  try {
    const email = "legacy-rotate@example.com";
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const userId = `usr_${randomUUID()}`;
    const legacy = encrypt(secret, kekA, userId);
    await ctx.store.insertUser({
      id: userId,
      email,
      emailVerifiedAt: new Date(ctx.clock.now).toISOString(),
      totpWrappedIv: legacy.iv,
      totpWrappedCiphertext: legacy.ciphertext,
      totpWrappedTag: legacy.tag,
      totpLastStep: 0,
      createdAt: new Date(ctx.clock.now).toISOString(),
    });
    const result = await ctx.identity.keys.rotateKek(kekA, kekB);
    assert.equal(result.dek_rewrapped, true);
    assert.equal(result.users_rewrapped, 1);
    assert.equal(result.users_unreadable, 0);
    ctx = await ctx.reopen(kekB);
    const verified = await verifyStep(ctx, email, secret);
    await expectStatus(verified, 200);
  } finally {
    await ctx.close();
  }
});

test("D16: an in-flight enrollment started on one process can be confirmed on another", async () => {
  const ctx = await identityServer();
  try {
    const pending = await otpSignIn(ctx, "restart@example.com");
    const start = await api(ctx, "/api/auth/totp/start", { jar: pending.jar, csrf: true, body: {} });
    assert.equal(start.status, 200);
    const secret = new URL(((await start.json()) as { otpauth_url: string }).otpauth_url).searchParams.get("secret")!;
    const user = await ctx.identity.userByEmail("restart@example.com");
    assert.ok(user?.totpPendingWrappedIv, "pending secret is in the store, not in memory");
    const other = new OperatorIdentity({
      store: ctx.store,
      sessionSecret: TEST_SESSION_SECRET,
      kek: ctx.kek,
      now: () => new Date(ctx.clock.now),
    });
    const confirmed = await other.confirmTotp(user.id, hashToken(pending.jar.token), totpCode(secret, ctx.clock.now), {
      secure: false,
    });
    assert.equal(confirmed.backup_codes.length, 10);
    const cleared = await ctx.store.getUser(user.id);
    assert.equal(cleared?.totpPendingWrappedIv, null);
    assert.ok(cleared?.totpWrappedIv);
  } finally {
    await ctx.close();
  }
});
