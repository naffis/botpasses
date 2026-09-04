import assert from "node:assert/strict";
import { test } from "node:test";
import { IpWindowLimiter, clientIpFrom } from "../src/hosted/identity-limiter.ts";
import { api, identityServer } from "./identity-harness.ts";

test("clientIpFrom prefers Fly-Client-IP, then the last X-Forwarded-For hop, then the socket", () => {
  assert.equal(clientIpFrom("203.0.113.9", "198.51.100.1, 10.0.0.1", "127.0.0.1"), "203.0.113.9");
  assert.equal(clientIpFrom(undefined, "198.51.100.1, 10.0.0.1", "127.0.0.1"), "10.0.0.1");
  assert.equal(clientIpFrom(undefined, " 198.51.100.1 ", "127.0.0.1"), "198.51.100.1");
  assert.equal(clientIpFrom("", ",,", "127.0.0.1"), "127.0.0.1");
  assert.equal(clientIpFrom(undefined, undefined, undefined), "0.0.0.0");
});

test("IpWindowLimiter caps its key set with least-recently-used eviction", () => {
  const limiter = new IpWindowLimiter(2);
  assert.equal(limiter.allow("a", 1, 1000, 0), true);
  assert.equal(limiter.allow("b", 1, 1000, 1), true);
  // Touch "a" so "b" becomes the oldest, then add "c": "b" is evicted, "a" keeps its count.
  assert.equal(limiter.allow("a", 1, 1000, 2), false);
  assert.equal(limiter.allow("c", 1, 1000, 3), true);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.allow("b", 1, 1000, 4), true, "evicted key starts fresh");
  assert.equal(limiter.allow("a", 1, 1000, 5), true, "a was the oldest and got evicted in turn");
});

test("I8: without a trusted proxy X-Forwarded-For is ignored and the socket peer is the address", async (t) => {
  const prevTrust = process.env.VAULT_TRUST_PROXY;
  const prevFly = process.env.FLY_APP_NAME;
  delete process.env.VAULT_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  t.after(() => {
    if (prevTrust !== undefined) process.env.VAULT_TRUST_PROXY = prevTrust;
    if (prevFly !== undefined) process.env.FLY_APP_NAME = prevFly;
  });
  const ctx = await identityServer();
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const r = await api(ctx, "/api/auth/otp/send", {
        body: { email: `direct${i}@example.com` },
        headers: { "x-forwarded-for": `198.51.100.${i}`, "fly-client-ip": `192.0.2.${i}` },
      });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
    assert.equal(statuses[10], 429, "eleven distinct spoofed headers are still one loopback caller");
  } finally {
    await ctx.close();
  }
});

test("S8: a spoofed first X-Forwarded-For hop does not bypass the per-IP OTP limit", async (t) => {
  // Fly-Client-IP is trusted only behind Fly or with VAULT_TRUST_PROXY=1; this test runs as if behind Fly.
  const prevTrust = process.env.VAULT_TRUST_PROXY;
  process.env.VAULT_TRUST_PROXY = "1";
  t.after(() => {
    if (prevTrust === undefined) delete process.env.VAULT_TRUST_PROXY;
    else process.env.VAULT_TRUST_PROXY = prevTrust;
  });
  const ctx = await identityServer();
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const r = await api(ctx, "/api/auth/otp/send", {
        body: { email: `spoof${i}@example.com` },
        headers: { "x-forwarded-for": `198.51.100.${i}, 203.0.113.9` },
      });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
    assert.equal(statuses[10], 429, "eleventh send from the same real address is limited");
    // Fly-Client-IP, when present, names the caller: distinct values are distinct callers.
    const fly = await api(ctx, "/api/auth/otp/send", {
      body: { email: "fly@example.com" },
      headers: { "x-forwarded-for": "198.51.100.99, 203.0.113.9", "fly-client-ip": "192.0.2.7" },
    });
    assert.equal(fly.status, 200);
  } finally {
    await ctx.close();
  }
});
