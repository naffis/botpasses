import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import * as OTPAuth from "otpauth";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { identityAuthResolver } from "../src/hosted/identity.ts";
import { OperatorIdentity, setCookieHeader, sessionCookieName } from "../src/hosted/operator-identity.ts";
import { createOauthProvider } from "../src/hosted/oauth-as.ts";
import { parseOidcPrivateJwk } from "../src/hosted/boot.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, TEST_SESSION_SECRET, cleanup, tempHome, testOidcPrivateJwk } from "./helpers.ts";
import { codeFromEmail, cookieJar } from "./identity-harness.ts";

async function identityServer() {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "id.sqlite"));
  const kek = parseMasterKey(generateMasterKey());
  const emails: { to: string; html: string }[] = [];
  const kernel = new HostedKernel({
    store,
    kek,
    sendEmail: async (to, _s, html) => {
      emails.push({ to, html });
    },
    publicUrl: "http://127.0.0.1:8788",
  });
  const identity = new OperatorIdentity({
    store,
    sessionSecret: TEST_SESSION_SECRET,
    kek,
    sendEmail: async (to, _s, html) => {
      emails.push({ to, html });
    },
  });
  const jwk = parseOidcPrivateJwk(testOidcPrivateJwk());
  assert.ok(jwk);
  const oidcProvider = createOauthProvider({
    issuer: "http://127.0.0.1:8788",
    kernel,
    sessionSecret: TEST_SESSION_SECRET,
    jwk,
    secureCookies: false,
    oidcDirectory: kernel.oidc,
  });
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    identity,
    oidcProvider,
    secureCookies: false,
    authResolver: identityAuthResolver({
      identity,
      kernel,
      secureCookies: false,
      oidcJwk: jwk,
      issuer: "http://127.0.0.1:8788",
    }),
  });
  const addr = await http.listen();
  return {
    home,
    store,
    kernel,
    identity,
    emails,
    http,
    base: `http://${addr.host}:${addr.port}`,
    jwk,
  };
}

test("AC-17 ensureVaultOrgForUser is idempotent; MCP does not provision", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "org.sqlite"));
  const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()) });
  try {
    const first = await kernel.ensureVaultOrgForUser("user_new");
    const second = await kernel.ensureVaultOrgForUser("user_new");
    assert.equal(first.orgId, second.orgId);
    const orgs = await store.listMembershipsForUser("user_new");
    assert.equal(orgs.length, 1);
    const before = (await store.listMembershipsForUser("mcp_actor")).length;
    assert.equal(before, 0);
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("AC-21 loopback session cookie is HttpOnly SameSite=Lax; HTTPS header uses __Host-", () => {
  const loop = setCookieHeader(sessionCookieName(false), "tok", false, true, 3600);
  assert.match(loop, /bp_session=/);
  assert.match(loop, /HttpOnly/);
  assert.match(loop, /SameSite=Lax/);
  assert.doesNotMatch(loop, /__Host-/);
  const host = setCookieHeader(sessionCookieName(true), "tok", true, true, 3600);
  assert.match(host, /__Host-bp_session=/);
  assert.match(host, /Secure/);
  assert.doesNotMatch(host, /Domain=/);
});

test("AC-22 OTP send is uniform; sixth verify fails; sixth send is 429", async () => {
  const ctx = await identityServer();
  try {
    const unknown = await fetch(`${ctx.base}/api/auth/otp/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com" }),
    });
    const known = await fetch(`${ctx.base}/api/auth/otp/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "other@example.com" }),
    });
    assert.equal(unknown.status, 200);
    assert.equal(known.status, 200);
    assert.deepEqual(await unknown.json(), await known.json());
    // A resend replaces the live code: a second email goes out and the first code stops working.
    const firstOtp = codeFromEmail(ctx.emails[0]?.html ?? "");
    const again = await fetch(`${ctx.base}/api/auth/otp/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com" }),
    });
    assert.equal(again.status, 200);
    const sent = ctx.emails.filter((e) => e.to === "new@example.com");
    assert.equal(sent.length, 2);
    const otp = codeFromEmail(sent[1]?.html ?? "");
    assert.notEqual(otp, firstOtp);
    const stale = await fetch(`${ctx.base}/api/auth/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", otp: firstOtp }),
    });
    assert.equal(stale.status, 401, "the replaced code is refused");
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      const r = await fetch(`${ctx.base}/api/auth/otp/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "new@example.com", otp: "00000000" }),
      });
      last = r.status;
    }
    assert.equal(last, 401);
    const ok = await fetch(`${ctx.base}/api/auth/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", otp }),
    });
    assert.equal(ok.status, 401);
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${ctx.base}/api/auth/otp/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "limit@example.com" }),
      });
      assert.equal(r.status, 200);
      const ch = await ctx.store.latestEmailOtp(await ctx.identity.emails.lookupKey("limit@example.com"));
      assert.ok(ch);
      await ctx.store.updateEmailOtp({ ...ch, expiresAt: new Date(Date.now() - 1000).toISOString() });
    }
    const sixth = await fetch(`${ctx.base}/api/auth/otp/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "limit@example.com" }),
    });
    assert.equal(sixth.status, 429);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-18 session without TOTP is 403 mfa_required; AC-23 TOTP replay rejected; AC-24 CSRF", async () => {
  const ctx = await identityServer();
  try {
    await fetch(`${ctx.base}/api/auth/otp/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "mfa@example.com" }),
    });
    const otp = codeFromEmail(ctx.emails.at(-1)?.html ?? "");
    const verified = await fetch(`${ctx.base}/api/auth/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "mfa@example.com", otp }),
    });
    assert.equal(verified.status, 200);
    const jar = cookieJar(verified);
    assert.match(verified.headers.getSetCookie().join(";"), /HttpOnly/);
    assert.match(verified.headers.getSetCookie().join(";"), /SameSite=Lax/);
    const items = await fetch(`${ctx.base}/api/items?environment=staging`, {
      headers: { cookie: jar.cookie },
    });
    assert.equal(items.status, 403);
    const denied = (await items.json()) as { error: string; enroll_url?: string };
    assert.equal(denied.error, "mfa_required");
    assert.equal(denied.enroll_url, "/enroll-totp");
    const signinMfa = await fetch(`${ctx.base}/sign-in`, {
      headers: { cookie: jar.cookie },
      redirect: "manual",
    });
    assert.equal(signinMfa.status, 302);
    assert.equal(signinMfa.headers.get("location"), "/enroll-totp");
    const consentMfa = await fetch(`${ctx.base}/consent`, {
      headers: { cookie: jar.cookie },
      redirect: "manual",
    });
    assert.equal(consentMfa.status, 302);
    assert.equal(consentMfa.headers.get("location"), "/enroll-totp");
    const start = await fetch(`${ctx.base}/api/auth/totp/start`, {
      method: "POST",
      headers: { cookie: jar.cookie, "content-type": "application/json", "x-csrf-token": jar.csrf },
      body: "{}",
    });
    assert.equal(start.status, 200);
    const started = (await start.json()) as { otpauth_url: string; qr_svg?: string };
    const secret = new URL(started.otpauth_url).searchParams.get("secret");
    assert.ok(secret);
    assert.ok(started.qr_svg);
    assert.match(started.qr_svg, /^<svg\b/);
    assert.equal(started.qr_svg.includes(secret), false);
    const totp = new OTPAuth.TOTP({
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const code = totp.generate();
    const confirm = await fetch(`${ctx.base}/api/auth/totp/confirm`, {
      method: "POST",
      headers: { cookie: jar.cookie, "content-type": "application/json", "x-csrf-token": jar.csrf },
      body: JSON.stringify({ code }),
    });
    assert.equal(confirm.status, 200);
    const confirmed = (await confirm.json()) as { backup_codes?: string[] };
    assert.equal(confirmed.backup_codes?.length, 10);
    const ready = cookieJar(confirm);
    // AC-23: the step consumed at confirm cannot be replayed at the sign-in authenticator step.
    const replay = await fetch(`${ctx.base}/api/auth/totp/verify`, {
      method: "POST",
      headers: { cookie: ready.cookie, "content-type": "application/json", "x-csrf-token": ready.csrf },
      body: JSON.stringify({ code }),
    });
    assert.equal(replay.status, 401);
    const noCsrf = await fetch(`${ctx.base}/api/items`, {
      method: "POST",
      headers: { cookie: ready.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "X",
        value: CANARY,
        environment: "staging",
        allowed_hosts: ["api.stripe.com"],
      }),
    });
    assert.equal(noCsrf.status, 403);
    const withCsrf = await fetch(`${ctx.base}/api/items`, {
      method: "POST",
      headers: {
        cookie: ready.cookie,
        "content-type": "application/json",
        "x-csrf-token": ready.csrf,
      },
      body: JSON.stringify({
        name: "X",
        value: CANARY,
        environment: "staging",
        allowed_hosts: ["api.stripe.com"],
      }),
    });
    assert.equal(withCsrf.status, 200);
    const signinReady = await fetch(`${ctx.base}/sign-in`, {
      headers: { cookie: ready.cookie },
      redirect: "manual",
    });
    assert.equal(signinReady.status, 302);
    assert.equal(signinReady.headers.get("location"), "/console");
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-07 grant email without magic token href ends at /console", async () => {
  const ctx = await identityServer();
  try {
    const { orgId } = await ctx.kernel.createOrg("acme", "user_owner");
    await ctx.kernel.createItem({
      orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "STRIPE_KEY",
      value: CANARY,
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
    });
    const { client } = await ctx.kernel.createModelClient({
      orgId,
      name: "grok",
      environment: "staging",
    });
    ctx.emails.length = 0;
    await ctx.kernel.requestGrant({
      orgId,
      clientId: client.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
      operatorEmail: "op@example.com",
    });
    const html = ctx.emails.at(-1)?.html ?? "";
    assert.match(html, /href="http:\/\/127\.0\.0\.1:8788\/console"/);
    assert.doesNotMatch(html, /\/approve\?token=/);
    assert.doesNotMatch(html, /Clerk/i);
    assert.ok(!html.includes(CANARY));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});
