import assert from "node:assert/strict";
import { test } from "node:test";
import { executeConnector } from "../src/hosted/connector.ts";
import { hostAllowed } from "../src/hosted/http.ts";
import { isBlockedIp } from "../src/hosted/ssrf.ts";
import { CANARY } from "./helpers.ts";

test("Host allowlist is exact, not a prefix; loopback only when allowed", () => {
  assert.equal(hostAllowed("vault.example.com", ["vault.example.com"]), true);
  assert.equal(hostAllowed("VAULT.EXAMPLE.COM", ["vault.example.com"]), true);
  assert.equal(hostAllowed("v", ["vault.example.com"]), false);
  assert.equal(hostAllowed("1", ["127.0.0.1"]), false);
  assert.equal(hostAllowed("127.0.0.1", ["vault.example.com"], true), true);
  assert.equal(hostAllowed("localhost:8788", ["vault.example.com"], true), true);
  assert.equal(hostAllowed("127.0.0.1", ["vault.example.com"]), false);
  assert.equal(hostAllowed("localhost", ["vault.example.com", "localhost"]), false);
});

const BLOCKED = [
  ["224.0.0.1", "multicast 224/4"],
  ["239.255.255.250", "multicast 224/4 upper"],
  ["240.0.0.1", "reserved 240/4"],
  ["255.255.255.255", "broadcast"],
  ["192.0.0.8", "IETF protocol assignments 192.0.0.0/24"],
  ["192.0.2.10", "TEST-NET-1"],
  ["198.51.100.7", "TEST-NET-2"],
  ["203.0.113.9", "TEST-NET-3"],
  ["100.64.0.1", "shared address space"],
  ["198.18.0.1", "benchmarking"],
  ["169.254.169.254", "link-local metadata"],
  ["64:ff9b::808:808", "NAT64 64:ff9b::/96"],
  ["2002:c000:0204::1", "6to4 2002::/16"],
  ["fec0::1", "site-local fec0::/10"],
  ["ff02::1", "multicast ff00::/8"],
  ["ff05::1:3", "multicast ff00::/8 site"],
  ["2001:db8::1", "documentation 2001:db8::/32"],
  ["fe80::1", "link-local fe80::/10"],
  ["fd12:3456::1", "unique local fd00::/8"],
  ["fc00::1", "unique local fc00::/8"],
  ["::ffff:10.0.0.1", "v4-mapped private"],
  ["::ffff:224.0.0.1", "v4-mapped multicast"],
  ["::1", "loopback"],
  ["::", "unspecified"],
] as const;

for (const [ip, why] of BLOCKED) {
  test(`isBlockedIp blocks ${ip} (${why})`, () => {
    assert.equal(isBlockedIp(ip), true);
  });
}

const PUBLIC = ["8.8.8.8", "1.1.1.1", "192.0.1.1", "192.1.2.3", "198.50.100.1", "203.0.112.1", "223.255.255.1",
  "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "64:ff9a::1", "2001:db9::1", "fe00::1", "fb00::1"] as const;

for (const ip of PUBLIC) {
  test(`isBlockedIp allows public ${ip}`, () => {
    assert.equal(isBlockedIp(ip), false);
  });
}

test("connector never fetches when DNS returns a private address", async () => {
  let fetched = false;
  await assert.rejects(
    () =>
      executeConnector(
        {
          secret: CANARY,
          username: null,
          last4: "c10b",
          inject: "bearer",
          allowedHosts: ["api.stripe.com"],
          name: "STRIPE_KEY",
          kind: "secret",
        },
        { method: "GET", path: "/v1/balance" },
        {
          resolveAddresses: async () => ["10.0.0.1"],
          fetchImpl: async () => {
            fetched = true;
            return new Response("{}", { status: 200 });
          },
        },
      ),
    /private or blocked/,
  );
  assert.equal(fetched, false);
  assert.equal(isBlockedIp("10.0.0.1"), true);
});
