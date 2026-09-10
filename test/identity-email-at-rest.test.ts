import assert from "node:assert/strict";
import { test } from "node:test";
import { decrypt, generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { isLegacyPlaintextEmail, persistUserEmail, rebindLegacyEmails, restorePlaintextEmails } from "../src/hosted/email-directory.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { sha256Hex } from "../src/ids.ts";
import { CANARY } from "./helpers.ts";
import { api, identityServer, otpSignIn, readJson, signUpAndEnroll } from "./identity-harness.ts";

function hex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

test("AC-02/AC-03: sign-up stores 64 hex plus wrap; API still shows the inbox; raw row does not", async () => {
  const ctx = await identityServer();
  try {
    const email = "wrap@example.com";
    const { jar } = await signUpAndEnroll(ctx, email);
    const found = await ctx.identity.userByEmail(email);
    assert.ok(found);
    assert.equal(found.email, email);
    const raw = await ctx.store.getUser(found.id);
    assert.ok(raw);
    assert.ok(hex64(raw.email), "column is the lookup HMAC");
    assert.ok(raw.emailWrappedIv && raw.emailWrappedCiphertext && raw.emailWrappedTag);
    assert.equal(JSON.stringify(raw).includes(email), false, "AC-03: inbox is not in the stored row");
    const account = await api(ctx, "/api/auth/me", { jar });
    const body = await readJson<{ email?: string }>(account);
    assert.equal(body.email, email);
  } finally {
    await ctx.close();
  }
});

test("AC-03 fail-before: a wrap skip leaves the inbox in the stored row", async () => {
  const ctx = await identityServer();
  try {
    const email = "skip-wrap@example.com";
    await ctx.store.insertUser({
      id: "usr_skip",
      email,
      emailVerifiedAt: new Date(ctx.clock.now).toISOString(),
      totpWrappedIv: null,
      totpWrappedCiphertext: null,
      totpWrappedTag: null,
      totpLastStep: null,
      createdAt: new Date(ctx.clock.now).toISOString(),
    });
    const skipped = await ctx.store.getUser("usr_skip");
    assert.ok(skipped);
    assert.equal(JSON.stringify(skipped).includes(email), true, "without a wrap write the inbox is visible");
    await persistUserEmail(ctx.store, ctx.identity.emails, skipped, email);
    const wrapped = await ctx.store.getUser("usr_skip");
    assert.ok(wrapped);
    assert.equal(JSON.stringify(wrapped).includes(email), false);
    assert.ok(hex64(wrapped.email));
  } finally {
    await ctx.close();
  }
});

test("AC-04: a legacy @ row rebinds once; the second boot is a no-op", async () => {
  const ctx = await identityServer();
  try {
    const email = "legacy-rebind@example.com";
    await ctx.store.insertUser({
      id: "usr_legacy",
      email,
      emailVerifiedAt: new Date(ctx.clock.now).toISOString(),
      totpWrappedIv: null,
      totpWrappedCiphertext: null,
      totpWrappedTag: null,
      totpLastStep: null,
      createdAt: new Date(ctx.clock.now).toISOString(),
    });
    const first = await rebindLegacyEmails(ctx.store, ctx.identity.emails, () => false);
    assert.equal(first.users, 1);
    const raw = await ctx.store.getUser("usr_legacy");
    assert.ok(raw && hex64(raw.email) && !isLegacyPlaintextEmail(raw.email));
    const second = await rebindLegacyEmails(ctx.store, ctx.identity.emails, () => false);
    assert.deepEqual(second, { users: 0, invites: 0 });
    assert.equal(await ctx.identity.emails.revealUser(raw), email);
  } finally {
    await ctx.close();
  }
});

test("AC-04 mixed-case: boot rebind hashes the normalized inbox so later lookup hits", async () => {
  const ctx = await identityServer();
  try {
    const stored = "Legacy.Mixed@Example.COM";
    await ctx.store.insertUser({
      id: "usr_mixed",
      email: stored,
      emailVerifiedAt: new Date(ctx.clock.now).toISOString(),
      totpWrappedIv: null,
      totpWrappedCiphertext: null,
      totpWrappedTag: null,
      totpLastStep: null,
      createdAt: new Date(ctx.clock.now).toISOString(),
    });
    assert.equal((await rebindLegacyEmails(ctx.store, ctx.identity.emails, () => false)).users, 1);
    const found = await ctx.identity.userByEmail("legacy.mixed@example.com");
    assert.ok(found);
    assert.equal(found.email, "legacy.mixed@example.com");
    const raw = await ctx.store.getUser("usr_mixed");
    assert.ok(raw && hex64(raw.email));
    assert.equal(JSON.stringify(raw).includes("Example.COM"), false);
    await ctx.store.insertInvite({
      id: "inv_mixed",
      orgId: "org_mixed",
      email: "Invite.Mixed@Example.COM",
      role: "operator",
      tokenHash: "th_mixed",
      invitedBy: "usr_mixed",
      createdAt: new Date(ctx.clock.now).toISOString(),
      expiresAt: new Date(ctx.clock.now + 86_400_000).toISOString(),
      acceptedAt: null,
    });
    assert.equal((await rebindLegacyEmails(ctx.store, ctx.identity.emails, () => false)).invites, 1);
    assert.equal(await ctx.identity.emails.revealInvite((await ctx.store.getInvite("inv_mixed"))!), "invite.mixed@example.com");
  } finally {
    await ctx.close();
  }
});

test("AC-05: concurrent OTP verify of one code still has one user row", async () => {
  const ctx = await identityServer();
  try {
    const email = "race@example.com";
    await api(ctx, "/api/auth/otp/send", { body: { email } });
    const mail = ctx.emails.filter((e) => e.to === email).at(-1);
    assert.ok(mail);
    const otp = /(\d{8})/.exec(mail.html)?.[1];
    assert.ok(otp);
    const results = await Promise.allSettled([
      ctx.identity.verifyOtp(email, otp, { secure: false }, "127.0.0.1"),
      ctx.identity.verifyOtp(email, otp, { secure: false }, "127.0.0.1"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    assert.ok(ok.length >= 1, "at least one verify wins");
    const users = (await ctx.store.listAllUsers()).filter((u) => u.id.startsWith("usr_"));
    const matches = [];
    for (const u of users) {
      if ((await ctx.identity.emails.revealUser(u)) === email) matches.push(u.id);
    }
    assert.equal(matches.length, 1, "one user row for that inbox");
  } finally {
    await ctx.close();
  }
});

test("AC-06: team list shows the invite inbox; the column is hex; accept matches; wrong inbox fails", async () => {
  const ctx = await identityServer();
  try {
    const ownerEmail = "owner-team@example.com";
    const inviteeEmail = "invitee-team@example.com";
    const { jar } = await signUpAndEnroll(ctx, ownerEmail);
    const owner = await ctx.identity.userByEmail(ownerEmail);
    assert.ok(owner);
    const membership = await ctx.kernel.ensureVaultOrgForUser(owner.id);
    const invited = await ctx.kernel.inviteMember({
      orgId: membership.orgId,
      actorUserId: owner.id,
      actorRole: "owner",
      email: inviteeEmail,
      role: "operator",
      ip: "127.0.0.1",
    });
    assert.equal(invited.invite.email, inviteeEmail);
    const storedInvite = (await ctx.store.listInvites(membership.orgId))[0];
    assert.ok(storedInvite);
    assert.ok(hex64(storedInvite.email));
    assert.equal(JSON.stringify(storedInvite).includes(inviteeEmail), false);
    const team = await ctx.kernel.listTeam(membership.orgId);
    assert.equal(team.invites[0]?.email, inviteeEmail);
    const token = new URL(invited.accept_url).searchParams.get("token") ?? "";
    await assert.rejects(
      ctx.kernel.acceptInvite({ userId: owner.id, email: "wrong@example.com", token }),
      /invite_email_mismatch/,
    );
    await otpSignIn(ctx, inviteeEmail);
    const invitee = await ctx.identity.userByEmail(inviteeEmail);
    assert.ok(invitee);
    const accepted = await ctx.kernel.acceptInvite({ userId: invitee.id, email: inviteeEmail, token });
    assert.equal(accepted.org_id, membership.orgId);
    assert.ok(jar.cookie);
  } finally {
    await ctx.close();
  }
});

test("AC-07: after KEK rotate, sign-in and team list still show inboxes", async () => {
  const kekA = parseMasterKey(generateMasterKey());
  const kekB = parseMasterKey(generateMasterKey());
  let ctx = await identityServer({ kek: kekA });
  try {
    const email = "rotate-inbox@example.com";
    await signUpAndEnroll(ctx, email);
    const user = await ctx.identity.userByEmail(email);
    assert.ok(user);
    const { orgId } = await ctx.kernel.ensureVaultOrgForUser(user.id);
    await ctx.identity.rotateKek(kekA, kekB);
    ctx = await ctx.reopen(kekB);
    const again = await ctx.identity.userByEmail(email);
    assert.equal(again?.email, email);
    const team = await ctx.kernel.listTeam(orgId);
    assert.ok(team.members.some((m) => m.email === email));
  } finally {
    await ctx.close();
  }
});

test("AC-08: an empty KEK cannot open email wraps", async () => {
  const ctx = await identityServer();
  try {
    const email = "sealed@example.com";
    await otpSignIn(ctx, email);
    const user = await ctx.identity.userByEmail(email);
    assert.ok(user);
    const raw = await ctx.store.getUser(user.id);
    const iv = raw?.emailWrappedIv;
    const ciphertext = raw?.emailWrappedCiphertext;
    const tag = raw?.emailWrappedTag;
    assert.ok(raw && iv && ciphertext && tag);
    assert.throws(() => decrypt({ iv, ciphertext, tag }, Buffer.alloc(32), `email:${raw.id}`));
  } finally {
    await ctx.close();
  }
});

test("AC-09: email restore writes @ back equal to the wrap", async () => {
  const ctx = await identityServer();
  try {
    const email = "restore@example.com";
    await otpSignIn(ctx, email);
    const user = await ctx.identity.userByEmail(email);
    assert.ok(user);
    const before = await ctx.store.getUser(user.id);
    assert.ok(before && hex64(before.email));
    const result = await restorePlaintextEmails(ctx.store, ctx.identity.emails, () => false);
    assert.ok(result.users >= 1);
    const restored = await ctx.store.getUser(user.id);
    assert.equal(restored?.email, email);
  } finally {
    await ctx.close();
  }
});

test("AC-17: magic code_hash is sha256 of the URL token; reuse does not write the token back", async () => {
  const ctx = await identityServer();
  try {
    const hmac = Buffer.from("ab".repeat(32), "hex");
    const mailed: string[] = [];
    const kernel = new HostedKernel({
      store: ctx.store,
      kek: ctx.kek,
      publicUrl: "http://127.0.0.1:8788",
      approvalHmac: hmac,
      deployPlane: "staging",
      sendEmail: async (_to, _s, html) => {
        mailed.push(html);
      },
    });
    const email = "magic@example.com";
    const { jar } = await signUpAndEnroll(ctx, email);
    const user = await ctx.identity.userByEmail(email);
    assert.ok(user);
    const { orgId } = await kernel.ensureVaultOrgForUser(user.id);
    await kernel.createItem({
      orgId,
      actor: user.id,
      environment: "staging",
      kind: "secret",
      name: "MAGIC_KEY",
      value: CANARY,
      allowedHosts: ["api.example.com"],
      inject: "bearer",
    });
    const { client } = await kernel.createModelClient({ orgId, name: "agent", environment: "staging" });
    const first = await kernel.requestGrant({
      orgId,
      clientId: client.id,
      itemName: "MAGIC_KEY",
      environment: "staging",
    });
    const magic = await ctx.store.getChallengeByGrantKind(first.grant.id, "magic");
    assert.ok(magic);
    assert.equal(magic.codeHash.includes("."), false);
    assert.ok(hex64(magic.codeHash));
    const mailToken = mailed.join("").match(/token=([^"&]+)/)?.[1];
    assert.ok(mailToken);
    const token = decodeURIComponent(mailToken);
    assert.notEqual(magic.codeHash, token);
    assert.equal(magic.codeHash, sha256Hex(token));
    const second = await kernel.requestGrant({
      orgId,
      clientId: client.id,
      itemName: "MAGIC_KEY",
      environment: "staging",
    });
    const reused = await ctx.store.getChallengeByGrantKind(second.grant.id, "magic");
    assert.equal(reused?.codeHash, magic.codeHash);
    const preview = await kernel.previewMagic(orgId, token);
    assert.equal(preview.grant_id, first.grant.id);
    const approved = await kernel.approveMagic(orgId, user.id, "owner", token);
    assert.equal(approved.id, first.grant.id);
    assert.equal(approved.status, "active");
    assert.ok(jar.cookie);
  } finally {
    await ctx.close();
  }
});
