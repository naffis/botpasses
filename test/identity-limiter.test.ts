import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOUDFLARE_PROXY_CIDRS,
  IpWindowLimiter,
  clientIpFrom,
  clientIpFromHeaders,
  clientIpTrust,
  NO_PROXY_TRUST,
} from "../src/hosted/identity-limiter.ts";
import { api, identityServer } from "./identity-harness.ts";

const ON_FLY = { trustFlyHeader: true, trustForwarded: true };

test("clientIpFrom on Fly prefers Fly-Client-IP, then the last X-Forwarded-For hop, then the socket", () => {
  assert.equal(clientIpFrom("203.0.113.9", "198.51.100.1, 10.0.0.1", "127.0.0.1", ON_FLY), "203.0.113.9");
  assert.equal(clientIpFrom(undefined, "198.51.100.1, 10.0.0.1", "127.0.0.1", ON_FLY), "10.0.0.1");
  assert.equal(clientIpFrom(undefined, " 198.51.100.1 ", "127.0.0.1", ON_FLY), "198.51.100.1");
  assert.equal(clientIpFrom("", ",,", "127.0.0.1", ON_FLY), "127.0.0.1");
  assert.equal(clientIpFrom(undefined, undefined, undefined, ON_FLY), "0.0.0.0");
  assert.equal(clientIpFrom("203.0.113.9", "198.51.100.1", "127.0.0.1", NO_PROXY_TRUST), "127.0.0.1");
});

test("R2-2: off Fly with VAULT_TRUST_PROXY=1 a forged Fly-Client-IP is ignored and the last X-Forwarded-For hop counts", () => {
  const behindNginx = clientIpTrust({ VAULT_TRUST_PROXY: "1" });
  assert.deepEqual(
    { fly: behindNginx.trustFlyHeader, forwarded: behindNginx.trustForwarded },
    { fly: false, forwarded: true },
  );
  assert.equal(clientIpFrom("203.0.113.9", "10.0.0.1, 198.51.100.7", "172.19.0.1", behindNginx), "198.51.100.7");
  assert.equal(clientIpFrom("203.0.113.9", undefined, "172.19.0.1", behindNginx), "172.19.0.1", "no XFF: the socket peer");
  // The forged Fly header cannot make the peer a Cloudflare address, so CF-Connecting-IP stays shut.
  assert.equal(
    clientIpFromHeaders(
      { cfConnectingIp: "198.51.100.200", flyClientIp: "104.16.1.1", forwarded: "203.0.113.9", remote: "172.19.0.1" },
      behindNginx,
    ),
    "203.0.113.9",
  );
  assert.equal(behindNginx.trustedProxyCidrs, CLOUDFLARE_PROXY_CIDRS);
  // On Fly both headers are the proxy's, and with neither the socket peer is all there is.
  const onFly = clientIpTrust({ FLY_APP_NAME: "botpasses-staging" });
  assert.deepEqual({ fly: onFly.trustFlyHeader, forwarded: onFly.trustForwarded }, { fly: true, forwarded: true });
  const direct = clientIpTrust({});
  assert.deepEqual({ fly: direct.trustFlyHeader, forwarded: direct.trustForwarded }, { fly: false, forwarded: false });
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
  // VAULT_TRUST_PROXY=1 off Fly: the deployer's own proxy appends the last X-Forwarded-For hop,
  // and nothing on that path sets Fly-Client-IP, so that header is the client's and is ignored.
  const prevTrust = process.env.VAULT_TRUST_PROXY;
  const prevFly = process.env.FLY_APP_NAME;
  process.env.VAULT_TRUST_PROXY = "1";
  delete process.env.FLY_APP_NAME;
  t.after(() => {
    if (prevTrust === undefined) delete process.env.VAULT_TRUST_PROXY;
    else process.env.VAULT_TRUST_PROXY = prevTrust;
    if (prevFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = prevFly;
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
    // R2-2: off Fly a forged Fly-Client-IP does not make the caller someone else.
    const forgedFly = await api(ctx, "/api/auth/otp/send", {
      body: { email: "fly@example.com" },
      headers: { "x-forwarded-for": "198.51.100.99, 203.0.113.9", "fly-client-ip": "192.0.2.7" },
    });
    assert.equal(forgedFly.status, 429, "the forged Fly header is ignored; the last XFF hop is still the limited address");
    // On Fly the same header was set by the Fly proxy and names the caller.
    process.env.FLY_APP_NAME = "botpasses-staging";
    const onFly = await api(ctx, "/api/auth/otp/send", {
      body: { email: "fly@example.com" },
      headers: { "x-forwarded-for": "198.51.100.99, 203.0.113.9", "fly-client-ip": "192.0.2.7" },
    });
    assert.equal(onFly.status, 200);
  } finally {
    await ctx.close();
  }
});
