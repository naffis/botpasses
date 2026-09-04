import assert from "node:assert/strict";
import { test } from "node:test";
import { createVaultServer } from "../src/server.ts";
import type { LoopbackRole, Vault } from "../src/vault.ts";
import { CANARY, cleanup, makeVault } from "./helpers.ts";

function loopbackHeaders(vault: Vault, role: LoopbackRole, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${vault.loopbackToken(role)}`,
    ...extra,
  };
}

test("local API and MCP require the loopback bearer (AC-08)", async () => {
  const { vault, home } = makeVault();
  const http = createVaultServer({ vault, host: "127.0.0.1", port: 0 });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  try {
    const unauthApi = await fetch(`${base}/api/secrets`);
    assert.equal(unauthApi.status, 401);
    const unauthMcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    assert.equal(unauthMcp.status, 401);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /loopback-token/);
  } finally {
    await http.close();
    vault.close();
    cleanup(home);
  }
});

test("HTTP operator API never returns secret values", async () => {
  const { vault, home } = makeVault();
  const http = createVaultServer({ vault, host: "127.0.0.1", port: 0 });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const auth = loopbackHeaders(vault, "operator", { "content-type": "application/json" });
  const model = loopbackHeaders(vault, "model", { "content-type": "application/json" });
  try {
    const stored = await fetch(`${base}/api/secrets`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "STRIPE_KEY", value: CANARY }),
    });
    const storedBody = (await stored.json()) as { secret: { last4: string } };
    assert.equal(stored.ok, true);
    assert.equal(storedBody.secret.last4, CANARY.slice(-4));
    assert.ok(!JSON.stringify(storedBody).includes(CANARY));

    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /Botpasses/);
    assert.doesNotMatch(page, /Agent Grant Vault/);
    assert.doesNotMatch(page, /LastPass|1Password|Bitwarden/);
    assert.ok(!page.includes(CANARY));

    const secrets = await (await fetch(`${base}/api/secrets`, { headers: auth })).json();
    assert.ok(!JSON.stringify(secrets).includes(CANARY));

    const granted = await fetch(`${base}/api/grants`, {
      method: "POST",
      headers: auth,
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
      headers: model,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_secrets", arguments: {} },
      }),
    });
    const mcpBody = (await mcp.json()) as { result: { content: { text: string }[] } };
    assert.ok(!JSON.stringify(mcpBody).includes(CANARY));
    assert.match(mcpBody.result.content[0]?.text ?? "", /"items"/, "list_secrets alias answers with the list_items shape");

    const items = await fetch(`${base}/api/items`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "GITHUB_TOKEN", value: CANARY, allowed_hosts: "api.github.com", inject: "header:Authorization" }),
    });
    const itemBody = (await items.json()) as { item: { name: string; allowedHosts: string[]; inject: string } };
    assert.equal(items.status, 200, JSON.stringify(itemBody));
    assert.deepEqual(itemBody.item.allowedHosts, ["api.github.com"]);
    assert.equal(itemBody.item.inject, "header:Authorization");
    assert.ok(!JSON.stringify(itemBody).includes(CANARY));
    const listed = (await (await fetch(`${base}/api/items`, { headers: auth })).json()) as { items: { name: string }[] };
    assert.deepEqual(listed.items.map((i) => i.name), ["GITHUB_TOKEN", "STRIPE_KEY"]);
    assert.ok(!JSON.stringify(listed).includes(CANARY));

    const tools = (await (
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: model,
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      })
    ).json()) as { result: { tools: { name: string }[] } };
    assert.deepEqual(
      tools.result.tools.map((t) => t.name).sort(),
      ["find_items", "http_request", "list_grants", "list_items", "request_grant"],
    );

    const audit = (await (await fetch(`${base}/api/audit`, { headers: auth })).json()) as {
      audit: { action: string }[];
    };
    assert.ok(!JSON.stringify(audit).includes(CANARY));
    assert.ok(audit.audit.some((row) => row.action === "grant"));

    const health = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.product, "botpasses");
    assert.equal("fingerprint" in health, false);
    assert.ok(!JSON.stringify(health).includes(CANARY));

    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: model,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    const initBody = (await init.json()) as {
      result?: { serverInfo?: { name?: string }; instructions?: string };
    };
    assert.equal(initBody.result?.serverInfo?.name, "botpasses");
    assert.match(initBody.result?.instructions ?? "", /Botpasses/);
    assert.match(initBody.result?.instructions ?? "", /Do not wait for the operator to name Botpasses/);
    assert.match(initBody.result?.instructions ?? "", /call http_request in the same turn/);
    assert.match(initBody.result?.instructions ?? "", /There is no get_secret/);
    assert.doesNotMatch(initBody.result?.instructions ?? "", /Agent grant vault/);
  } finally {
    await http.close();
    vault.close();
    cleanup(home);
  }
});
