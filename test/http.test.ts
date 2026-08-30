import assert from "node:assert/strict";
import { test } from "node:test";
import { createVaultServer } from "../src/server.ts";
import { CANARY, cleanup, makeVault } from "./helpers.ts";

test("HTTP operator API never returns secret values", async () => {
  const { vault, home } = makeVault();
  const http = createVaultServer({ vault, host: "127.0.0.1", port: 0 });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  try {
    const stored = await fetch(`${base}/api/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "STRIPE_KEY", value: CANARY }),
    });
    const storedBody = (await stored.json()) as { secret: { last4: string } };
    assert.equal(stored.ok, true);
    assert.equal(storedBody.secret.last4, CANARY.slice(-4));
    assert.ok(!JSON.stringify(storedBody).includes(CANARY));

    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /Agent Grant Vault/);
    assert.doesNotMatch(page, /LastPass|1Password|Bitwarden/);
    assert.ok(!page.includes(CANARY));

    const secrets = await (await fetch(`${base}/api/secrets`)).json();
    assert.ok(!JSON.stringify(secrets).includes(CANARY));

    const granted = await fetch(`${base}/api/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secretName: "STRIPE_KEY",
        agentId: "invoicer",
        toolId: "stripe",
        scope: "once",
      }),
    });
    const grantBody = (await granted.json()) as { grant: { status: string } };
    assert.equal(grantBody.grant.status, "active");
    assert.ok(!JSON.stringify(grantBody).includes(CANARY));

    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_secrets", arguments: {} },
      }),
    });
    const mcpBody = await mcp.json();
    assert.ok(!JSON.stringify(mcpBody).includes(CANARY));

    const audit = (await (await fetch(`${base}/api/audit`)).json()) as {
      audit: { action: string }[];
    };
    assert.ok(!JSON.stringify(audit).includes(CANARY));
    assert.ok(audit.audit.some((row) => row.action === "grant"));
  } finally {
    await http.close();
    vault.close();
    cleanup(home);
  }
});
