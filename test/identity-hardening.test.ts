/**
 * Regression tests for the 2026-09-04 identity findings (I1 to I15): atomic OTP and TOTP
 * counters, session-scoped listing and CSRF, secure-only cookies, resend semantics, cookie
 * lifetime, auth events, the MFA redirect helper, the bootstrap token, and org creation.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { bootstrapTokenEnabled, hostedAuthResolver, type AuthResolver } from "../src/hosted/auth.ts";
import { mfaRedirectUrl } from "../src/hosted/client/shared.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { INVITE_ACTOR_MAX, INVITE_IP_MAX } from "../src/hosted/kernel-members.ts";
import { hashToken } from "../src/hosted/operator-identity.ts";
import { PlanLimitError } from "../src/hosted/plan-limits.ts";
import { TOTP_MAX_FAILURES } from "../src/hosted/identity-totp.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { cleanup, tempHome } from "./helpers.ts";
import {
  api,
  codeFromEmail,
  cookieJar,
  expectStatus,
  identityServer,
  otpSignIn,
  readJson,
  signUpAndEnroll,
  totpCode,
  wrongTotpCode,
  type Jar,
} from "./identity-harness.ts";

type Line = Record<string, unknown>;

/** Collect the JSON log lines written while `run` executes (the server logs in-process). */
async function captureLog<T>(run: () => Promise<T>): Promise<{ result: T; lines: Line[] }> {
  const lines: Line[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    try {
      lines.push(JSON.parse(args.map(String).join(" ")) as Line);
    } catch {
      // not a JSON line
    }
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original;
  }
}

const events = (lines: Line[]): string[] => lines.map((l) => String(l.event)).filter((e) => e.startsWith("auth_"));

test("I1: concurrent wrong OTP guesses each spend an attempt; the challenge dies at five", async () => {
  const ctx = await identityServer();
  try {
    const email = "race@example.com";
    const sent = await api(ctx, "/api/auth/otp/send", { body: { email } });
    assert.equal(sent.status, 200);
    const otp = codeFromEmail(ctx.emails.at(-1)?.html ?? "");
    const guesses = await Promise.all(
      Array.from({ length: 8 }, () => api(ctx, "/api/auth/otp/verify", { body: { email, otp: "00000000" } })),
    );
    assert.deepEqual(
      guesses.map((r) => r.status),
      Array(8).fill(401),
    );
    const challenge = await ctx.store.latestEmailOtp(await ctx.identity.emails.lookupKey(email));
    assert.equal(challenge?.attempts, 5, "attempts are claimed atomically, not read-then-written");
    const late = await api(ctx, "/api/auth/otp/verify", { body: { email, otp } });
    assert.equal(late.status, 401, "the right code no longer works once the challenge is exhausted");
  } finally {
    await ctx.close();
  }
});

test("I1: OTP verify is rate limited per address; verifies with no live code do not spend the per-email budget", async () => {
  const ctx = await identityServer();
  try {
    const email = "burst@example.com";
    await api(ctx, "/api/auth/otp/send", { body: { email } });
    const statuses: number[] = [];
    for (let i = 0; i < 26; i += 1) {
      const r = await api(ctx, "/api/auth/otp/verify", { body: { email, otp: "00000000" } });
      statuses.push(r.status);
    }
    // Five wrong codes kill the challenge; the other 21 find no live code and count against
    // the address only, so they cannot lock the owner out (R1-4).
    assert.deepEqual(statuses, Array(26).fill(401));
    await expectStatus(await api(ctx, "/api/auth/otp/send", { body: { email } }), 200, "otp/send");
    const otp = codeFromEmail(ctx.emails.filter((e) => e.to === email).at(-1)?.html ?? "");
    await expectStatus(await api(ctx, "/api/auth/otp/verify", { body: { email, otp } }), 200, "the owner signs in after 26 bogus verifies");
    // Every verify counts against the address: 50 in the window, the next is 429.
    for (let used = statuses.length + 1; used < 50; used += 1) {
      const r = await api(ctx, "/api/auth/otp/verify", { body: { email: `other-${used}@example.com`, otp: "00000000" } });
      assert.equal(r.status, 401, `verify ${used + 1}`);
    }
    const spent = await api(ctx, "/api/auth/otp/verify", { body: { email, otp: "00000000" } });
    assert.equal(spent.status, 429, "the per-address verify budget is spent");
  } finally {
    await ctx.close();
  }
});

test("I9: a verify with no live challenge costs the same scrypt work as a wrong code", async () => {
  const ctx = await identityServer();
  try {
    const live = "timing-live@example.com";
    await api(ctx, "/api/auth/otp/send", { body: { email: live } });
    const timed = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      const r = await api(ctx, "/api/auth/otp/verify", { body: { email, otp: "00000000" } });
      assert.equal(r.status, 401);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    // Warm both paths once (the dummy hash is computed on first use), then compare medians.
    await timed(live);
    await timed("timing-none@example.com");
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const withChallenge = median([await timed(live), await timed(live), await timed(live)]);
    const withoutChallenge = median([
      await timed("timing-none@example.com"),
      await timed("timing-none@example.com"),
      await timed("timing-none@example.com"),
    ]);
    assert.ok(
      withoutChallenge >= withChallenge * 0.5,
      `no-challenge path ${withoutChallenge.toFixed(1)}ms vs live challenge ${withChallenge.toFixed(1)}ms`,
    );
  } finally {
    await ctx.close();
  }
});

test("I11: a mailer failure stores nothing and the next send works; a resend replaces the live code", async () => {
  const mailer = { fail: true };
  const ctx = await identityServer({ mailer });
  try {
    const email = "resend@example.com";
    const down = await api(ctx, "/api/auth/otp/send", { body: { email } });
    assert.equal(down.status, 503);
    assert.equal(await ctx.store.latestEmailOtp(await ctx.identity.emails.lookupKey(email)), undefined, "no challenge row without a delivered email");
    mailer.fail = false;
    const up = await api(ctx, "/api/auth/otp/send", { body: { email } });
    assert.equal(up.status, 200, "not blocked for ten minutes by the failed send");
    const first = codeFromEmail(ctx.emails.at(-1)?.html ?? "");
    const again = await api(ctx, "/api/auth/otp/send", { body: { email } });
    assert.equal(again.status, 200);
    const second = codeFromEmail(ctx.emails.at(-1)?.html ?? "");
    assert.notEqual(first, second);
    assert.equal(ctx.emails.filter((e) => e.to === email).length, 2, "the resend actually sends");
    const stale = await api(ctx, "/api/auth/otp/verify", { body: { email, otp: first } });
    assert.equal(stale.status, 401, "the replaced code is dead");
    const fresh = await api(ctx, "/api/auth/otp/verify", { body: { email, otp: second } });
    await expectStatus(fresh, 200, "the new code signs in");
    assert.equal(await ctx.store.countEmailOtpSince(await ctx.identity.emails.lookupKey(email), new Date(0).toISOString()), 2, "resends count against the budget");
  } finally {
    await ctx.close();
  }
});

test("I4: concurrent wrong authenticator codes all count and lock the account", async () => {
  const clock = { now: Date.now() };
  const ctx = await identityServer({ clock });
  try {
    const email = "totp-race@example.com";
    const { secret, jar } = await signUpAndEnroll(ctx, email);
    await api(ctx, "/api/auth/logout", { jar, csrf: true, body: {} });
    const pending = await otpSignIn(ctx, email);
    const wrong = wrongTotpCode(secret, clock.now);
    const results = await Promise.all(
      Array.from({ length: TOTP_MAX_FAILURES + 2 }, () =>
        api(ctx, "/api/auth/totp/verify", { jar: pending.jar, csrf: true, body: { code: wrong } }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    assert.ok(statuses.includes(429), `some attempt locked the account: ${statuses.join(",")}`);
    const user = await ctx.identity.userByEmail(email);
    assert.ok(user?.totpLockedUntil, "the lock is persisted");
    assert.ok((user?.totpFailures ?? 0) >= TOTP_MAX_FAILURES, `failures counted atomically: ${user?.totpFailures}`);
  } finally {
    await ctx.close();
  }
});

test("I4: the same authenticator code and the same backup code each pass exactly once under concurrency", async () => {
  const clock = { now: Date.now() };
  const ctx = await identityServer({ clock });
  try {
    const email = "replay@example.com";
    const { secret, backupCodes, jar } = await signUpAndEnroll(ctx, email);
    await api(ctx, "/api/auth/logout", { jar, csrf: true, body: {} });
    clock.now += 60_000;
    const a = await otpSignIn(ctx, email);
    const b = await otpSignIn(ctx, email);
    const code = totpCode(secret, clock.now);
    const both = await Promise.all([
      api(ctx, "/api/auth/totp/verify", { jar: a.jar, csrf: true, body: { code } }),
      api(ctx, "/api/auth/totp/verify", { jar: b.jar, csrf: true, body: { code } }),
    ]);
    assert.deepEqual(
      both.map((r) => r.status).sort(),
      [200, 401],
      "one wins the step, the other is a replay",
    );
    const winner = both.find((r) => r.status === 200);
    assert.ok(winner);
    await api(ctx, "/api/auth/logout", { jar: cookieJar(winner), csrf: true, body: {} });
    clock.now += 60_000;
    const c = await otpSignIn(ctx, email);
    const d = await otpSignIn(ctx, email);
    const backup = backupCodes[0] ?? "";
    const pair = await Promise.all([
      api(ctx, "/api/auth/totp/verify", { jar: c.jar, csrf: true, body: { code: backup } }),
      api(ctx, "/api/auth/totp/verify", { jar: d.jar, csrf: true, body: { code: backup } }),
    ]);
    assert.deepEqual(
      pair.map((r) => r.status).sort(),
      [200, 401],
      "a backup code is single use even when submitted twice at once",
    );
  } finally {
    await ctx.close();
  }
});

test("I6: a malformed cookie value is ignored, not a 500", async () => {
  const ctx = await identityServer();
  try {
    const r = await api(ctx, "/api/auth/me", { headers: { cookie: "bp_session=%E0%A4%A; bp_csrf=%zz" } });
    assert.equal(r.status, 401);
  } finally {
    await ctx.close();
  }
});

test("I7: a CSRF token is bound to its session; another session's token is refused", async () => {
  const ctx = await identityServer();
  try {
    const a = await signUpAndEnroll(ctx, "csrf-a@example.com");
    const b = await signUpAndEnroll(ctx, "csrf-b@example.com");
    const sessionA = a.jar.cookie.split("; ").find((c) => c.startsWith("bp_session="));
    const csrfB = b.jar.cookie.split("; ").find((c) => c.startsWith("bp_csrf="));
    assert.ok(sessionA && csrfB);
    const mixed: Jar = { cookie: `${sessionA}; ${csrfB}`, csrf: b.jar.csrf, token: a.jar.token };
    const r = await api(ctx, "/api/auth/logout", { jar: mixed, csrf: true, body: {} });
    assert.equal(r.status, 403, "B's token does not verify for A's session");
    assert.ok(await ctx.store.getSession(hashToken(a.jar.token)), "A is still signed in");
    const own = await api(ctx, "/api/auth/logout", { jar: a.jar, csrf: true, body: {} });
    assert.equal(own.status, 200);
  } finally {
    await ctx.close();
  }
});

test("I10: in secure mode only __Host- cookies over TLS are honoured", async () => {
  const ctx = await identityServer({ secure: true });
  try {
    const email = "secure@example.com";
    const { jar } = await otpSignIn(ctx, email);
    assert.match(jar.cookie, /__Host-bp_session=/);
    const tls = { "x-forwarded-proto": "https" };
    const overHttp = await api(ctx, "/api/auth/totp/start", { jar, csrf: true, body: {} });
    assert.equal(overHttp.status, 401, "the session is not loaded on a plain request");
    const plainName: Jar = {
      ...jar,
      cookie: jar.cookie.replace("__Host-bp_session=", "bp_session=").replace("__Host-bp_csrf=", "bp_csrf="),
    };
    const tossed = await api(ctx, "/api/auth/totp/start", { jar: plainName, csrf: true, body: {}, headers: tls });
    assert.equal(tossed.status, 401, "a plain-named cookie is not a fallback in secure mode");
    const ok = await api(ctx, "/api/auth/totp/start", { jar, csrf: true, body: {}, headers: tls });
    await expectStatus(ok, 200, "the __Host- cookie over TLS works");
  } finally {
    await ctx.close();
  }
});

test("I13: session cookies carry the absolute lifetime so the server-side idle extension is reachable", async () => {
  const clock = { now: Date.now() };
  const ctx = await identityServer({ clock });
  try {
    const email = "idle@example.com";
    const sent = await api(ctx, "/api/auth/otp/send", { body: { email } });
    assert.equal(sent.status, 200);
    const verified = await api(ctx, "/api/auth/otp/verify", { body: { email, otp: codeFromEmail(ctx.emails.at(-1)?.html ?? "") } });
    await expectStatus(verified, 200);
    for (const cookie of verified.headers.getSetCookie()) {
      assert.match(cookie, /Max-Age=604800(;|$)/, cookie);
    }
    const jar = cookieJar(verified);
    // Active every eleven hours for two days: the session lives on past the twelve-hour idle window.
    for (let i = 0; i < 4; i += 1) {
      clock.now += 11 * 60 * 60 * 1000;
      const r = await api(ctx, "/api/auth/totp/start", { jar, csrf: true, body: {} });
      await expectStatus(r, 200, `touch ${i}`);
    }
    clock.now += 13 * 60 * 60 * 1000;
    const idle = await api(ctx, "/api/auth/totp/start", { jar, csrf: true, body: {} });
    assert.equal(idle.status, 401, "thirteen idle hours end the session server-side");
  } finally {
    await ctx.close();
  }
});

test("I14: otp_locked, totp_verified, signed_out, and session_revoked are logged", async () => {
  const clock = { now: Date.now() };
  const ctx = await identityServer({ clock });
  try {
    const email = "events@example.com";
    const { result: enrolled, lines: enrollLines } = await captureLog(() => signUpAndEnroll(ctx, email));
    assert.ok(events(enrollLines).includes("auth_totp_verified"), events(enrollLines).join(","));

    const { lines: outLines } = await captureLog(() => api(ctx, "/api/auth/logout", { jar: enrolled.jar, csrf: true, body: {} }));
    assert.ok(events(outLines).includes("auth_signed_out"), events(outLines).join(","));

    const { lines: lockLines } = await captureLog(async () => {
      await api(ctx, "/api/auth/otp/send", { body: { email } });
      for (let i = 0; i < 5; i += 1) await api(ctx, "/api/auth/otp/verify", { body: { email, otp: "00000000" } });
    });
    assert.ok(events(lockLines).includes("auth_otp_locked"), events(lockLines).join(","));

    clock.now += 60_000;
    const first = await signInEnrolled(ctx, email, enrolled.secret, clock.now);
    clock.now += 60_000;
    const second = await signInEnrolled(ctx, email, enrolled.secret, clock.now);
    const snapshot = await api(ctx, "/api/access", { jar: first.jar });
    await expectStatus(snapshot, 200);
    const body = await readJson<{ sessions: { id: string; current: boolean }[] }>(snapshot);
    const other = body.sessions.find((s) => !s.current);
    assert.ok(other, "the second session is listed");
    const { result: revoked, lines: revokeLines } = await captureLog(() =>
      api(ctx, `/api/sessions/${other.id}/revoke`, { jar: first.jar, csrf: true, body: {} }),
    );
    await expectStatus(revoked, 200);
    assert.ok(events(revokeLines).includes("auth_session_revoked"), events(revokeLines).join(","));
    assert.equal(await ctx.store.getSession(hashToken(second.jar.token)), undefined);
  } finally {
    await ctx.close();
  }
});

/** Email step plus the authenticator step for an enrolled account. */
async function signInEnrolled(
  ctx: Awaited<ReturnType<typeof identityServer>>,
  email: string,
  secret: string,
  atMs: number,
): Promise<{ jar: Jar }> {
  const pending = await otpSignIn(ctx, email);
  const r = await api(ctx, "/api/auth/totp/verify", { jar: pending.jar, csrf: true, body: { code: totpCode(secret, atMs) } });
  await expectStatus(r, 200, "totp/verify");
  return { jar: cookieJar(r) };
}

test("I5: sessions are listed and revocable by the org they act in, not by every org the user belongs to", async () => {
  const clock = { now: Date.now() };
  const ctx = await identityServer({ clock });
  try {
    const a = await signUpAndEnroll(ctx, "member-a@example.com");
    clock.now += 60_000;
    const b = await signUpAndEnroll(ctx, "owner-b@example.com");
    const userA = await ctx.identity.userByEmail("member-a@example.com");
    const userB = await ctx.identity.userByEmail("owner-b@example.com");
    assert.ok(userA && userB);
    const orgA = (await ctx.kernel.ensureVaultOrgForUser(userA.id)).orgId;
    const orgB = (await ctx.kernel.ensureVaultOrgForUser(userB.id)).orgId;
    assert.notEqual(orgA, orgB);
    clock.now += 60_000;
    await ctx.kernel.addMember(orgB, userA.id, "operator");
    const prefix = hashToken(a.jar.token).slice(0, 12);

    // A acts in its own org: B (owner of orgB) neither sees nor revokes A's session.
    const before = await readJson<{ sessions: { id: string }[] }>(await api(ctx, "/api/access", { jar: b.jar }));
    assert.ok(!before.sessions.some((s) => s.id === prefix), "A's session is not in orgB's list");
    const denied = await api(ctx, `/api/sessions/${prefix}/revoke`, { jar: b.jar, csrf: true, body: {} });
    assert.equal(denied.status, 404);
    assert.ok(await ctx.store.getSession(hashToken(a.jar.token)));

    // A switches to orgB: now the session acts there and B may revoke it.
    const pinned = await api(ctx, "/api/session/org", { jar: a.jar, csrf: true, body: { org_id: orgB } });
    await expectStatus(pinned, 200);
    const after = await readJson<{ sessions: { id: string }[] }>(await api(ctx, "/api/access", { jar: b.jar }));
    assert.ok(after.sessions.some((s) => s.id === prefix), "A's session now acts in orgB");
    const revoked = await api(ctx, `/api/sessions/${prefix}/revoke`, { jar: b.jar, csrf: true, body: {} });
    await expectStatus(revoked, 200);
    assert.equal(await ctx.store.getSession(hashToken(a.jar.token)), undefined);
  } finally {
    await ctx.close();
  }
});

test("I3: POST /api/orgs needs a ready session, a printable name of 1 to 80 characters, and stays under the orgs limit", async () => {
  const ctx = await identityServer();
  try {
    const email = "orgs@example.com";
    const pending = await otpSignIn(ctx, email);
    const early = await api(ctx, "/api/orgs", { jar: pending.jar, csrf: true, body: { name: "too soon" } });
    assert.equal(early.status, 403);
    assert.equal((await readJson<{ error: string }>(early)).error, "mfa_required");
    const { jar } = await signUpAndEnroll(ctx, "orgs-ready@example.com");
    for (const bad of ["", "   ", "x".repeat(81), "ctlchr", "line\nbreak"]) {
      const r = await api(ctx, "/api/orgs", { jar, csrf: true, body: { name: bad } });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    const ok = await api(ctx, "/api/orgs", { jar, csrf: true, body: { name: "  Acme Robotics  " } });
    await expectStatus(ok, 200);
    const { orgId } = await readJson<{ orgId: string }>(ok);
    assert.equal((await ctx.store.getOrg(orgId))?.name, "Acme Robotics");
    const user = await ctx.identity.userByEmail("orgs-ready@example.com");
    assert.ok(user);
    // The free tier allows ten owned orgs; the workspace and Acme make two.
    for (let i = 2; i < 10; i += 1) await ctx.kernel.createOrgForUser(`org ${i}`, user.id);
    await assert.rejects(
      ctx.kernel.createOrgForUser("one too many", user.id),
      (err: unknown) => err instanceof PlanLimitError && err.kind === "orgs" && err.limit === 10,
    );
    const over = await api(ctx, "/api/orgs", { jar, csrf: true, body: { name: "eleventh" } });
    assert.equal(over.status, 402);
  } finally {
    await ctx.close();
  }
});

test("I3: invites are rate limited per inviting account and per address", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "invites.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: "http://127.0.0.1:8788",
    planLimits: { credentials: 25, agents: 10, members: 500, calls: 5000, orgs: 10 },
  });
  try {
    const owners = ["own_1", "own_2", "own_3", "own_4"];
    const orgs: string[] = [];
    for (const owner of owners) {
      await store.insertUser({
        id: owner,
        email: `${owner}@example.com`,
        emailVerifiedAt: null,
        totpWrappedIv: null,
        totpWrappedCiphertext: null,
        totpWrappedTag: null,
        totpLastStep: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      orgs.push((await kernel.createOrg(owner, owner)).orgId);
    }
    const invite = (i: number, owner: string, orgId: string, ip: string) =>
      kernel.inviteMember({ orgId, actorUserId: owner, actorRole: "owner", email: `guest${i}-${randomUUID()}@example.com`, role: "operator", ip });
    for (let i = 0; i < INVITE_ACTOR_MAX; i += 1) await invite(i, "own_1", orgs[0] ?? "", "198.51.100.1");
    await assert.rejects(invite(99, "own_1", orgs[0] ?? "", "198.51.100.1"), /Too many invites/);
    // Other owners from the same address share the per-address budget.
    let sent = INVITE_ACTOR_MAX;
    for (const [n, owner] of owners.slice(1).entries()) {
      for (let i = 0; i < INVITE_ACTOR_MAX && sent < INVITE_IP_MAX; i += 1, sent += 1) {
        await invite(100 + n * 10 + i, owner, orgs[n + 1] ?? "", "198.51.100.1");
      }
    }
    assert.equal(sent, INVITE_IP_MAX);
    await assert.rejects(invite(200, "own_4", orgs[3] ?? "", "198.51.100.1"), /Too many invites/);
    const elsewhere = await invite(201, "own_4", orgs[3] ?? "", "198.51.100.2");
    assert.ok(elsewhere.invite.id, "a different address is not affected");
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("I15: the console follows a 403 mfa_required to the verify or enroll page and nothing else", () => {
  assert.equal(mfaRedirectUrl(403, { error: "mfa_required", verify_url: "/verify-totp" }), "/verify-totp");
  assert.equal(mfaRedirectUrl(403, { error: "mfa_required", enroll_url: "/enroll-totp" }), "/enroll-totp");
  assert.equal(mfaRedirectUrl(403, { error: "mfa_required", verify_url: "https://evil.example/" }), undefined);
  assert.equal(mfaRedirectUrl(403, { error: "mfa_required", verify_url: "//evil.example/" }), undefined);
  assert.equal(mfaRedirectUrl(403, { error: "Operator session required" }), undefined);
  assert.equal(mfaRedirectUrl(401, { error: "mfa_required", verify_url: "/verify-totp" }), undefined);
});

test("I2: the bootstrap token is refused on a plane without the opt-in and every use is logged as a hash", async () => {
  const token = "b".repeat(40);
  assert.equal(bootstrapTokenEnabled({ VAULT_BOOTSTRAP_TOKEN: token }), true);
  assert.equal(bootstrapTokenEnabled({ VAULT_BOOTSTRAP_TOKEN: token, VAULT_DEPLOY_PLANE: "production" }), false);
  assert.equal(
    bootstrapTokenEnabled({ VAULT_BOOTSTRAP_TOKEN: token, VAULT_DEPLOY_PLANE: "production", VAULT_BOOTSTRAP_ALLOW_PLANE: "1" }),
    true,
  );
  assert.equal(bootstrapTokenEnabled({ VAULT_BOOTSTRAP_TOKEN: "short" }), false);

  const home = tempHome();
  const store = openHostedSqlite(join(home, "bootstrap.sqlite"));
  const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), publicUrl: "http://127.0.0.1:8788" });
  const fallback: AuthResolver = async () => undefined;
  const req = {
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.5" },
    method: "GET",
    url: "/api/items?environment=staging",
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
  try {
    const { result: onPlane, lines: ignoredLines } = await captureLog(() =>
      hostedAuthResolver({ VAULT_BOOTSTRAP_TOKEN: token, VAULT_DEPLOY_PLANE: "staging" }, fallback)(req, kernel),
    );
    assert.equal(onPlane, undefined, "ignored on a plane without VAULT_BOOTSTRAP_ALLOW_PLANE=1");
    assert.ok(
      ignoredLines.some((l) => l.event === "bootstrap_token_ignored"),
      "leftover token on a plane logs bootstrap_token_ignored and still boots",
    );
    const { result: local, lines } = await captureLog(async () => {
      const resolver = hostedAuthResolver({ VAULT_BOOTSTRAP_TOKEN: token }, fallback);
      return resolver(req, kernel);
    });
    assert.equal(local?.channel, "operator");
    const enabled = lines.find((l) => l.event === "bootstrap_token_enabled");
    const used = lines.find((l) => l.event === "auth_bootstrap_used");
    assert.ok(enabled, "boot warning when the token is set");
    assert.ok(used, "each use is logged");
    assert.equal(typeof used.token_hash, "string");
    assert.equal(used.path, "/api/items");
    assert.equal(used.ip, "127.0.0.1", "no trusted proxy, so the socket peer is the address");
    for (const line of lines) assert.ok(!JSON.stringify(line).includes(token), "the token value never reaches a log line");
  } finally {
    await store.close();
    cleanup(home);
  }
});
