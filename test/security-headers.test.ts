import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type Provider from "oidc-provider";
import { handleConsentPost } from "../src/hosted/oauth-interactions.ts";
import { httpsHostList, MARKETING_CSP_EXTRAS, bindSecurityHeaders, securityHeaders } from "../src/hosted/security-headers.ts";

test("HTML security headers include CSP nonce and HSTS without preload", () => {
  const h = securityHeaders({ html: true, nonce: "abc123", extraScriptSrc: ["https://cdn.example.test"] });
  assert.match(h["content-security-policy"] ?? "", /nonce-abc123/);
  assert.match(h["content-security-policy"] ?? "", /cdn\.example\.test/);
  assert.equal(h["x-frame-options"], "DENY");
  assert.equal(h["x-content-type-options"], "nosniff");
  assert.equal(h["referrer-policy"], "strict-origin-when-cross-origin");
  assert.match(h["permissions-policy"] ?? "", /camera=\(\)/);
  assert.equal(h["cache-control"], "no-store");
  assert.equal(h["strict-transport-security"], "max-age=63072000");
  assert.doesNotMatch(h["strict-transport-security"] ?? "", /preload|includeSubDomains/);
});

test("JSON security headers omit CSP", () => {
  const h = securityHeaders({ html: false });
  assert.equal(h["content-security-policy"], undefined);
  assert.equal(h["x-frame-options"], "DENY");
});

test("httpsHostList prefixes https", () => {
  assert.deepEqual(httpsHostList("assets.example.test"), ["https://assets.example.test"]);
  assert.deepEqual(httpsHostList(""), []);
});

test("marketing extras allow self images and omit cache when asked", () => {
  const h = securityHeaders({ html: true, nonce: "n1", ...MARKETING_CSP_EXTRAS });
  assert.match(h["content-security-policy"] ?? "", /img-src 'self'/);
  assert.match(h["content-security-policy"] ?? "", /font-src 'self'/);
  assert.match(h["content-security-policy"] ?? "", /worker-src 'self' blob:/);
  assert.equal(h["cache-control"], "no-store");
  const asset = securityHeaders({ html: false, cache: false });
  assert.equal(asset["cache-control"], undefined);
  assert.equal(asset["x-frame-options"], "DENY");
});

test("bindSecurityHeaders injects D-05 on writeHead for JSON and HTML", async () => {
  const server = createServer((req, res) => {
    bindSecurityHeaders(res);
    if (req.url === "/html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html></html>");
      return;
    }
    res.writeHead(201, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  try {
    const json = await fetch(`http://127.0.0.1:${addr.port}/json`);
    assert.equal(json.headers.get("x-frame-options"), "DENY");
    assert.equal(json.headers.get("cache-control"), "no-store");
    assert.equal(json.headers.get("content-security-policy"), null);
    const html = await fetch(`http://127.0.0.1:${addr.port}/html`);
    assert.equal(html.headers.get("x-frame-options"), "DENY");
    assert.match(html.headers.get("content-security-policy") ?? "", /nonce-/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("consent POST oidc writeHead gets D-05 (sibling of handleOauth)", async () => {
  const fake = {
    async interactionFinished(_req: IncomingMessage, res: ServerResponse) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  };
  const server = createServer((req, res) => {
    void handleConsentPost(
      fake as unknown as Provider,
      req,
      res,
      { channel: "operator", userId: "u1", orgId: "o1", role: "owner", ready: true },
      { decision: "deny" },
      "http://127.0.0.1/mcp",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/consent`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
