import assert from "node:assert/strict";
import { test } from "node:test";
import { executeConnector } from "../src/hosted/connector.ts";
import { hostAllowed } from "../src/hosted/http.ts";
import { isBlockedIp } from "../src/hosted/ssrf.ts";
import { CANARY } from "./helpers.ts";

test("Host allowlist is exact, not a prefix", () => {
  assert.equal(hostAllowed("vault.example.com", ["vault.example.com"]), true);
  assert.equal(hostAllowed("VAULT.EXAMPLE.COM", ["vault.example.com"]), true);
  assert.equal(hostAllowed("v", ["vault.example.com"]), false);
  assert.equal(hostAllowed("1", ["127.0.0.1"]), false);
  assert.equal(hostAllowed("127.0.0.1", ["vault.example.com"]), true);
});

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
