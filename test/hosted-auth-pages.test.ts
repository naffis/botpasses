import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { OperatorIdentity } from "../src/hosted/operator-identity.ts";
import { signInHtml, signUpHtml, enrollTotpHtml, consentHtml, deviceHtml } from "../src/hosted/auth-pages.ts";
import { AUTH_JS } from "../src/hosted/hosted-assets.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { TEST_SESSION_SECRET, cleanup, tempHome } from "./helpers.ts";

const BANNED_AUTH = /@clerk\/backend|CLERK_|better-auth|@better-auth\//;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

test("AC-14 auth HTML has one h1 and no secrets", () => {
  for (const html of [signInHtml(), signUpHtml(), enrollTotpHtml(), consentHtml("Demo", "uid"), deviceHtml()]) {
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.doesNotMatch(html, /sk_/);
    assert.doesNotMatch(html, /VAULT_SESSION_SECRET/);
    assert.doesNotMatch(html, /VAULT_OIDC/);
    assert.doesNotMatch(html, /CLERK_/);
    assert.doesNotMatch(html, /12345678/);
  }
  assert.match(signInHtml(), /data-testid="sign-in"/);
  assert.match(signInHtml(), /\/assets\/console\.css/);
  assert.match(signInHtml(), /id="otp-verify" hidden/);
  assert.match(signInHtml(), /class="auth-body"/);
  assert.doesNotMatch(signInHtml(), /<img/);
  assert.match(enrollTotpHtml(), /data-testid="enroll-totp"/);
  assert.match(enrollTotpHtml(), /data-testid="totp-qr"/);
  assert.match(enrollTotpHtml(), /data-testid="otpauth-link"/);
  assert.match(enrollTotpHtml(), /data-testid="totp-secret"/);
  assert.doesNotMatch(enrollTotpHtml(), /otpauth:/);
  assert.doesNotMatch(enrollTotpHtml(), /<img/);
  assert.match(AUTH_JS, /otpauth-link/);
  assert.match(AUTH_JS, /qr_svg/);
  assert.match(AUTH_JS, /DOMParser/);
  assert.match(AUTH_JS, /verifyForm.hidden = false/);
  assert.doesNotMatch(AUTH_JS, /chart\.googleapis|api\.qrserver|qrserver\.com/);
  assert.match(consentHtml("Widgets", "u1"), /Widgets/);
  assert.match(consentHtml("Widgets", "u1"), /btn-primary/);
  assert.doesNotMatch(consentHtml("Widgets", "u1"), /<img/);
  assert.match(deviceHtml(), /data-testid="device-code"/);
});

test("AC-14 GET /sign-in is HTML with CSP self only", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "auth.sqlite"));
  const kek = parseMasterKey(generateMasterKey());
  const kernel = new HostedKernel({ store, kek, publicUrl: "http://127.0.0.1:8788" });
  const identity = new OperatorIdentity({ store, sessionSecret: TEST_SESSION_SECRET, kek });
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    identity,
    deployPlane: "staging",
  });
  const addr = await http.listen();
  try {
    const res = await fetch(`http://${addr.host}:${addr.port}/sign-in`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /data-testid="sign-in"/);
    assert.match(res.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.match(res.headers.get("content-security-policy") ?? "", /font-src 'self'/);
    assert.match(res.headers.get("content-security-policy") ?? "", /img-src 'self'/);
    assert.match(res.headers.get("content-security-policy") ?? "", /style-src 'unsafe-inline' 'self'/);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("strict-transport-security"), "max-age=63072000");
    const logout = await fetch(`http://${addr.host}:${addr.port}/api/auth/logout`, { method: "POST" });
    assert.equal(logout.status, 200);
    assert.equal(logout.headers.get("x-frame-options"), "DENY");
    assert.equal(logout.headers.get("cache-control"), "no-store");
  } finally {
    await http.close();
    await store.close();
    cleanup(home);
  }
});

test("AC-20 src and package.json have no Clerk or Better Auth", () => {
  const hits: string[] = [];
  for (const p of ["package.json", ...filesUnder("src")]) {
    if (BANNED_AUTH.test(readFileSync(p, "utf8"))) hits.push(p);
  }
  assert.deepEqual(hits, []);
});
