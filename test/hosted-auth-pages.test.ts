import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { OperatorIdentity } from "../src/hosted/operator-identity.ts";
import {
  signInHtml,
  signUpHtml,
  enrollTotpHtml,
  verifyTotpHtml,
  consentHtml,
  deviceHtml,
} from "../src/hosted/auth-pages.ts";
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
  const pages = [signInHtml(), signUpHtml(), enrollTotpHtml(), verifyTotpHtml(), consentHtml("Demo", "uid"), deviceHtml()];
  for (const html of pages) {
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.doesNotMatch(html, /sk_/);
    assert.doesNotMatch(html, /VAULT_SESSION_SECRET/);
    assert.doesNotMatch(html, /VAULT_OIDC/);
    assert.doesNotMatch(html, /CLERK_/);
    assert.doesNotMatch(html, /12345678/);
    // Operator-facing copy says "authenticator app"; the acronym and em-dashes are banned (2.1, 2.2).
    assert.doesNotMatch(html, /TOTP/);
    assert.doesNotMatch(html, /—/);
    // The brand link sits inside a landmark (axe `region`).
    assert.match(html, /<header class="auth-header">\s*<a class="brand auth-brand"/);
  }
  assert.doesNotMatch(AUTH_JS, /—/);
  assert.match(signInHtml(), /data-testid="sign-in"/);
  assert.match(signInHtml(), /\/assets\/console\.[0-9a-f]{8}\.css/);
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

test("2.2 sign-in and sign-up are one page with the heading chosen by route", () => {
  const signIn = signInHtml();
  const signUp = signUpHtml();
  assert.match(signIn, /<h1>Sign in<\/h1>/);
  assert.match(signUp, /<h1>Create account<\/h1>/);
  assert.match(signUp, /data-testid="sign-up"/);
  const strip = (html: string): string =>
    html
      .replace(/<title>.*?<\/title>/, "")
      .replace(/<h1>.*?<\/h1>/, "")
      .replace(/data-testid="sign-(in|up)"/, "")
      .replace(/<p><a href="\/sign-(in|up)">.*?<\/a><\/p>/, "");
  assert.equal(strip(signIn), strip(signUp), "only title, heading, testid and the footer link differ");
  // After "Send code" the script hides the send form and shows the sent line, Resend and the code form.
  assert.match(signIn, /id="otp-sent"[^>]*hidden/);
  assert.match(signIn, /id="sent-email"/);
  assert.match(signIn, /id="otp-change"/);
  assert.match(signIn, /id="otp-resend"/);
  assert.match(signIn, /<input type="hidden" name="email" \/>/, "email carried as a real hidden field");
  assert.match(AUTH_JS, /sendForm\.hidden = true/);
  assert.match(AUTH_JS, /Resend in " \+ left \+ " s"/);
  assert.match(AUTH_JS, /r\.body\.message/);
  assert.match(AUTH_JS, /attempts_remaining/);
  assert.match(AUTH_JS, /retry_after/);
});

test("D3 / 2.2 enrollment renders backup codes in a dedicated step and never auto-redirects", () => {
  const enroll = enrollTotpHtml();
  assert.match(enroll, /<details>\s*<summary>Show URL<\/summary>\s*<pre id="otpauth"/);
  assert.match(enroll, /<section id="backup-step" data-testid="backup-codes" hidden>/);
  assert.match(enroll, /<ol id="backups"/);
  assert.match(enroll, /id="backups-copy"/);
  assert.match(enroll, /id="backups-download"[^>]*download="botpasses-backup-codes\.txt"/);
  assert.match(enroll, /id="backups-continue"[^>]*href="\/console">Continue to console<\/a>/);
  assert.match(AUTH_JS, /showBackupCodes\(/);
  assert.match(AUTH_JS, /navigator\.clipboard\.writeText/);
  assert.match(AUTH_JS, /data:text\/plain;charset=utf-8,/);
  // The confirm handler ends in the backup step, not in a redirect.
  const confirmHandler = /totp\/confirm[\s\S]*?\}\);\n/.exec(AUTH_JS)?.[0] ?? "";
  assert.ok(confirmHandler.length > 0);
  assert.doesNotMatch(confirmHandler, /location\.href/);
});

test("0.1 the sign-in authenticator step has its own page and the script routes to it", () => {
  const verify = verifyTotpHtml();
  assert.match(verify, /data-testid="verify-totp"/);
  assert.match(verify, /<form id="totp-verify">/);
  assert.equal((verify.match(/<input /g) ?? []).length, 1, "one code input");
  assert.match(verify, /maxlength="10"/, "accepts a 6-digit code or a 10-character backup code");
  assert.match(AUTH_JS, /if \(r\.body\.enroll\) \{ location\.href = "\/enroll-totp"; return; \}/);
  assert.match(AUTH_JS, /if \(r\.body\.verify\) \{ location\.href = "\/verify-totp"; return; \}/);
  assert.match(AUTH_JS, /\/api\/auth\/totp\/verify/);
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

test("B10 /consent and /device are not mounted without the OAuth provider", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "auth.sqlite"));
  const kek = parseMasterKey(generateMasterKey());
  const kernel = new HostedKernel({ store, kek, publicUrl: "http://127.0.0.1:8788" });
  const identity = new OperatorIdentity({ store, sessionSecret: TEST_SESSION_SECRET, kek });
  const http = createHostedServer({ kernel, host: "127.0.0.1", port: 0, identity, deployPlane: "staging" });
  const addr = await http.listen();
  try {
    for (const path of ["/consent", "/consent?uid=abc", "/device"]) {
      const res = await fetch(`http://${addr.host}:${addr.port}${path}`);
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/, path);
      assert.doesNotMatch(await res.text(), /<form/, `${path} must not render an unbacked consent or device form`);
    }
    // The first-party pages are unaffected.
    const signIn = await fetch(`http://${addr.host}:${addr.port}/sign-in`);
    assert.equal(signIn.status, 200);
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
