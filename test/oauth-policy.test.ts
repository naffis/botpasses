import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRedirectUri,
  deriveOidcCookieKeys,
  isDesktopRedirect,
  isOauthPath,
  redirectHosts,
} from "../src/hosted/oauth-as.ts";
import {
  consentExpiredHtml,
  consentHtml,
  deviceConfirmHtml,
  deviceHtml,
  deviceSuccessHtml,
  oauthErrorHtml,
} from "../src/hosted/oauth-pages.ts";
import { TEST_SESSION_SECRET } from "./helpers.ts";
import { startOauthServer } from "./oauth-helpers.ts";

test("S5 redirect_uri policy: https, IP-literal loopback http, named desktop schemes only", () => {
  for (const ok of [
    "https://claude.ai/api/mcp/auth_callback",
    "https://evil.example/cb",
    "http://127.0.0.1:5555/cb",
    "http://127.0.0.1/cb",
    "http://[::1]:5555/cb",
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "cursor-mcp://cb",
    "vscode://cb",
    "vscode-insiders://cb",
    "grok://oauth/callback",
    "xai://cb",
    "xai-grok://cb",
  ]) {
    assert.doesNotThrow(() => assertRedirectUri(ok), ok);
  }
  for (const bad of [
    "http://localhost:5555/cb",
    "http://localhost/cb",
    "http://example.com/cb",
    "http://10.0.0.5/cb",
    "com.example.app://cb",
    "myapp://cb",
    "claude://cb",
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "vbscript:msgbox",
    "https://user:pw@example.com/cb",
    "not a url",
    "",
  ]) {
    assert.throws(() => assertRedirectUri(bad), bad || "(empty)");
  }
  assert.equal(isDesktopRedirect("cursor://x"), true);
  assert.equal(isDesktopRedirect("com.example.app://x"), false);
  assert.equal(isDesktopRedirect("https://x"), false);
  assert.deepEqual(redirectHosts(["https://claude.ai/cb", "https://claude.ai/other", "http://127.0.0.1:9/cb", "grok://cb", "nope"]), [
    "claude.ai",
    "127.0.0.1:9",
    "grok://",
  ]);
});

test("S5 DCR rejects private-use schemes and localhost, accepts IP loopback", async () => {
  const srv = await startOauthServer({ secure: false });
  try {
    const attempt = (redirect_uris: string[]) =>
      srv.go("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "probe", redirect_uris, token_endpoint_auth_method: "none" }),
      });
    assert.equal((await attempt(["com.example.app://cb"])).status, 400);
    assert.equal((await attempt(["http://localhost:8080/cb"])).status, 400);
    assert.equal((await attempt(["https://ok.example/cb", "myapp://cb"])).status, 400, "one bad uri fails the registration");
    const ok = await attempt(["http://127.0.0.1:8080/cb"]);
    assert.ok(ok.status === 200 || ok.status === 201);
  } finally {
    await srv.close();
  }
});

test("HKDF cookie keys are derived per purpose, never the raw session secret", () => {
  const [key] = deriveOidcCookieKeys(TEST_SESSION_SECRET);
  assert.ok(key);
  assert.notEqual(key, TEST_SESSION_SECRET);
  assert.ok(!key.includes(TEST_SESSION_SECRET));
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(deriveOidcCookieKeys(TEST_SESSION_SECRET), [key], "deterministic across restarts");
  assert.notEqual(deriveOidcCookieKeys(`${TEST_SESSION_SECRET}x`)[0], key);
});

test("isOauthPath covers the device resume route", () => {
  assert.equal(isOauthPath("/device"), true);
  assert.equal(isOauthPath("/device/abc123"), true);
  assert.equal(isOauthPath("/devices"), false);
  assert.equal(isOauthPath("/oauth/token"), true);
  assert.equal(isOauthPath("/consent"), false);
});

test("consent page names the client, lists redirect hosts, flags first use, shows the account; escapes everything", () => {
  const html = consentHtml("<script>alert(1)</script>Evil", "u1", {
    hosts: ["claude.ai", "<b>x</b>"],
    email: "op@example.com",
    firstTime: true,
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;Evil/);
  assert.match(html, /data-testid="consent-hosts"/);
  assert.match(html, /<code>claude\.ai<\/code>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /data-testid="consent-first-time"/);
  assert.match(html, /data-testid="consent-account">Approving as <strong>op@example\.com</);
  assert.match(html, /name="uid" value="u1"/);
  assert.match(html, /value="allow"/);
  assert.doesNotMatch(html, /<img/);
  const plain = consentHtml("Widgets", "u2");
  assert.doesNotMatch(plain, /consent-hosts|consent-first-time|consent-account/);
  assert.match(plain, /Widgets/);
  const returning = consentHtml("Widgets", "u3", { firstTime: false, hosts: [] });
  assert.doesNotMatch(returning, /consent-first-time/);
  assert.equal((consentExpiredHtml().match(/<h1>/g) ?? []).length, 1);
});

test("S12 device pages carry oidc-provider's xsrf field and the client name", () => {
  const input = deviceHtml(undefined, { xsrf: "sec\"ret" });
  assert.match(input, /<input type="hidden" name="xsrf" value="sec&quot;ret" \/>/);
  assert.match(input, /name="user_code"/);
  assert.doesNotMatch(deviceHtml(), /name="xsrf"/);
  assert.match(deviceHtml("That code did not work."), /role="alert"[^>]*>That code did not work\./);
  const confirm = deviceConfirmHtml({ clientName: "Grok <CLI>", userCode: "123-456", xsrf: "s" });
  assert.match(confirm, /data-testid="device-client">Grok &lt;CLI&gt;</);
  assert.match(confirm, /data-testid="device-user-code">123-456</);
  assert.match(confirm, /name="xsrf" value="s"/);
  assert.match(confirm, /name="user_code" value="123-456"/);
  assert.match(confirm, /name="confirm" value="yes"/);
  assert.match(confirm, /name="abort" value="yes"/);
  assert.match(deviceSuccessHtml("Grok"), /<strong>Grok<\/strong> is connected/);
  assert.match(deviceSuccessHtml(), /The device is connected/);
  const err = oauthErrorHtml({ error: "invalid_client", error_description: "<x>" });
  assert.match(err, /data-testid="oauth-error-code">invalid_client</);
  assert.match(err, /&lt;x&gt;/);
  assert.doesNotMatch(err, /fonts\.googleapis/);
  for (const html of [input, confirm, deviceSuccessHtml(), err]) {
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
  }
});
