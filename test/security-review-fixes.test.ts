/** Regression tests for the findings of the 2026-09-04 security review of the improvement PR. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { requireModelOrOperator } from "../src/hosted/auth.ts";
import { redactOriginHeaders } from "../src/hosted/connector.ts";
import { isHttpError } from "../src/hosted/errors.ts";
import { clientIpFrom, trustsProxyHeaders } from "../src/hosted/identity-limiter.ts";
import { pathWithinPrefix, scopeDenialReason } from "../src/hosted/kernel-grants.ts";
import { assertSafePath, hasDotSegments } from "../src/hosted/ssrf.ts";

const SECRET = "sk_live_CANARY_do_not_leak_f47ac10b";

test("origin headers are redacted for every encoding of the secret (query inject echoed in Link)", () => {
  const headers = {
    link: `<https://api.example.com/v1/items?api_key=${SECRET}&page=2>; rel="next"`,
    "x-request-id": Buffer.from(`user:${SECRET}`).toString("base64"),
    "content-type": "application/json",
  };
  const out = redactOriginHeaders(headers, { secret: SECRET, username: "user" });
  assert.doesNotMatch(JSON.stringify(out), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(out), /c2tfbGl2ZV9DQU5BUlk/);
  assert.equal(out["content-type"], "application/json");
  assert.match(out.link ?? "", /rel="next"/);
});

test("paths with dot segments are refused before any send, raw or percent-encoded", () => {
  for (const p of ["/v1/../admin/keys", "/v1/%2e%2e/admin", "/v1/./x", "/v1/%2E/x", "/%zz"]) {
    assert.ok(hasDotSegments(p), p);
    assert.throws(() => assertSafePath(p), (e: unknown) => isHttpError(e) && e.status === 400, p);
  }
  for (const p of ["/v1/balance", "/v1/items?page=2", "/", "/a.b/c..d"]) {
    assert.ok(!hasDotSegments(p), p);
    assert.doesNotThrow(() => assertSafePath(p), p);
  }
});

test("scope path prefixes match on segment boundaries and cannot be escaped with dot segments", () => {
  const scope = { methods: null, hosts: null, pathPrefixes: ["/v1/read"], maxCalls: null, callsUsed: 0 };
  const call = (path: string) => ({ host: "api.example.com", method: "GET", path });
  assert.equal(scopeDenialReason(scope, call("/v1/read")), undefined);
  assert.equal(scopeDenialReason(scope, call("/v1/read/items?x=1")), undefined);
  assert.equal(scopeDenialReason(scope, call("/v1/readwrite/keys")), "path");
  assert.equal(scopeDenialReason(scope, call("/v1/read/../admin")), "path");
  assert.equal(scopeDenialReason(scope, call("/v1/read/%2e%2e/admin")), "path");
  assert.ok(pathWithinPrefix("/anything", "/"));
  assert.ok(!pathWithinPrefix("/v1/users/4200", "/v1/users/42"));
});

test("a pending-MFA operator session cannot use the model channel", () => {
  const pending = { channel: "operator" as const, userId: "u", orgId: "", role: "owner" as const, ready: false, needs_totp: true };
  assert.throws(
    () => requireModelOrOperator(pending),
    (e: unknown) => isHttpError(e) && e.status === 403 && e.message === "mfa_required" && e.extra.verify_url === "/verify-totp",
  );
});

test("proxy headers are honoured only behind Fly or with an explicit opt-in; otherwise the socket peer counts", () => {
  const none = { trustFlyHeader: false, trustForwarded: false };
  const fly = { trustFlyHeader: true, trustForwarded: true };
  assert.equal(clientIpFrom("203.0.113.9", "10.0.0.1, 198.51.100.7", "127.0.0.1", none), "127.0.0.1");
  assert.equal(clientIpFrom(undefined, "10.0.0.1, 198.51.100.7", "127.0.0.1", none), "127.0.0.1");
  assert.equal(clientIpFrom("203.0.113.9", "10.0.0.1, 198.51.100.7", "127.0.0.1", fly), "203.0.113.9");
  assert.equal(clientIpFrom(undefined, "10.0.0.1, 198.51.100.7", "127.0.0.1", fly), "198.51.100.7");
  assert.equal(trustsProxyHeaders({}), false);
  assert.equal(trustsProxyHeaders({ FLY_APP_NAME: "botpasses-prod" }), true);
  assert.equal(trustsProxyHeaders({ VAULT_TRUST_PROXY: "1" }), true);
});
