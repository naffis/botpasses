import assert from "node:assert/strict";
import { test } from "node:test";
import { McpSessionRegistry } from "../src/mcp.ts";
import { createVaultServer, MCP_SESSION_HEADER, MCP_SESSION_REQUIRED, MCP_SESSION_UNKNOWN } from "../src/server.ts";
import type { LoopbackRole, Vault } from "../src/vault.ts";
import { CANARY, cleanup, makeVault } from "./helpers.ts";

function loopbackHeaders(vault: Vault, role: LoopbackRole, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${vault.loopbackToken(role)}`,
    ...extra,
  };
}

type Rpc = { id?: unknown; result?: { content?: { text: string }[] }; error?: { code: number; message: string } };

/** `initialize` as `clientName` and return the session id the server issued. */
async function initializeMcp(base: string, model: Record<string, string>, clientName: string): Promise<string> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: model,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: clientName, version: "1" } } }),
  });
  assert.equal(res.status, 200);
  const id = res.headers.get(MCP_SESSION_HEADER);
  assert.ok(id, "initialize issues an Mcp-Session-Id");
  return id;
}

async function mcpCall(base: string, headers: Record<string, string>, name: string, args: Record<string, unknown> = {}): Promise<{ status: number; body: Rpc & { error?: { code: number; message: string } | string } }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  return { status: res.status, body: (await res.json()) as Rpc };
}

function textOf(body: Rpc): string {
  return body.result?.content?.[0]?.text ?? "";
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

    const sessionId = await initializeMcp(base, model, "cursor");
    const inSession = { ...model, [MCP_SESSION_HEADER]: sessionId };
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: inSession,
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
    const itemBody = (await items.json()) as { item: { name: string; allowedHosts: string[]; inject: string; username: string | null } };
    assert.equal(items.status, 200, JSON.stringify(itemBody));
    assert.deepEqual(itemBody.item.allowedHosts, ["api.github.com"]);
    assert.equal(itemBody.item.inject, "header:Authorization");
    assert.equal(itemBody.item.username, null);
    assert.ok(!JSON.stringify(itemBody).includes(CANARY));
    // R2-7: the console offers HTTP Basic, so the route takes the username that mode needs.
    const basic = await fetch(`${base}/api/items`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "GITHUB_TOKEN", value: CANARY, inject: "basic", username: " svc " }),
    });
    const basicBody = (await basic.json()) as { item: { inject: string; username: string | null } };
    assert.equal(basic.status, 200, JSON.stringify(basicBody));
    assert.equal(basicBody.item.inject, "basic");
    assert.equal(basicBody.item.username, "svc", "trimmed and stored");
    const kept = await fetch(`${base}/api/items`, { method: "POST", headers: auth, body: JSON.stringify({ name: "GITHUB_TOKEN", value: CANARY }) });
    assert.equal(((await kept.json()) as { item: { username: string | null } }).item.username, "svc", "omitted keeps the stored username");
    const cleared = await fetch(`${base}/api/items`, { method: "POST", headers: auth, body: JSON.stringify({ name: "GITHUB_TOKEN", value: CANARY, username: null }) });
    assert.equal(((await cleared.json()) as { item: { username: string | null } }).item.username, null, "null clears it");
    const listed = (await (await fetch(`${base}/api/items`, { headers: auth })).json()) as { items: { name: string }[] };
    assert.deepEqual(listed.items.map((i) => i.name), ["GITHUB_TOKEN", "STRIPE_KEY"]);
    assert.ok(!JSON.stringify(listed).includes(CANARY));

    const tools = (await (
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: inSession,
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      })
    ).json()) as { result: { tools: { name: string }[] } };
    assert.deepEqual(
      tools.result.tools.map((t) => t.name).sort(),
      ["find_items", "http_request", "list_grants", "list_items", "request_grant", "setup"],
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

test("R2-3: each MCP client on the loopback server keeps its own session and agent id", async () => {
  const { vault, home } = makeVault();
  const http = createVaultServer({ vault, host: "127.0.0.1", port: 0 });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const model = loopbackHeaders(vault, "model", { "content-type": "application/json" });
  try {
    vault.setSecret("STRIPE_KEY", CANARY, { allowedHosts: ["api.stripe.com"] });
    vault.approveGrant({ secretName: "STRIPE_KEY", agentId: "cursor", toolId: "http_request", scope: "session" });

    const cursor = { ...model, [MCP_SESSION_HEADER]: await initializeMcp(base, model, "cursor") };
    // A second client initialises after cursor: before the fix this rebound the one shared
    // session, and cursor's later calls ran as "rogue".
    const rogue = { ...model, [MCP_SESSION_HEADER]: await initializeMcp(base, model, "rogue") };
    assert.notEqual(cursor[MCP_SESSION_HEADER], rogue[MCP_SESSION_HEADER]);

    const cursorGrants = await mcpCall(base, cursor, "list_grants");
    assert.equal(cursorGrants.status, 200);
    assert.match(textOf(cursorGrants.body), /"agent_id": "cursor"/, "cursor still sees its own grant");
    const rogueGrants = await mcpCall(base, rogue, "list_grants");
    assert.match(textOf(rogueGrants.body), /"grants": \[\]/, "rogue sees no grant of cursor's");
    const rogueDry = await mcpCall(base, rogue, "http_request", { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance", dry_run: true });
    assert.match(textOf(rogueDry.body), /"grant_status": "none"/, "rogue cannot spend cursor's approval");
    const cursorDry = await mcpCall(base, cursor, "http_request", { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance", dry_run: true });
    assert.match(textOf(cursorDry.body), /"grant_status": "active"/);

    // The header is the session: a call without it is refused, an unknown one too.
    const missing = await mcpCall(base, model, "list_grants");
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { error: MCP_SESSION_REQUIRED });
    const unknown = await mcpCall(base, { ...model, [MCP_SESSION_HEADER]: "not-a-session" }, "list_grants");
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: MCP_SESSION_UNKNOWN });
    const ping = await fetch(`${base}/mcp`, { method: "POST", headers: model, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }) });
    assert.equal(ping.status, 400, "every non-initialize frame needs the session");
    const note = await fetch(`${base}/mcp`, { method: "POST", headers: cursor, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.equal(note.status, 202);
    // The operator surface is untouched by sessions and never sees the secret.
    assert.ok(!JSON.stringify([cursorGrants.body, rogueGrants.body, rogueDry.body, cursorDry.body]).includes(CANARY));
  } finally {
    await http.close();
    vault.close();
    cleanup(home);
  }
});

test("R2-3: MCP HTTP sessions expire when idle and the registry is bounded", () => {
  let now = 1_000;
  const registry = new McpSessionRegistry({ idleMs: 100, maxSessions: 2, now: () => now });
  const a = registry.create();
  a.session.agentId = "a";
  assert.match(a.id, /^[A-Za-z0-9_-]{22}$/, "128 random bits, base64url");
  now += 50;
  assert.equal(registry.get(a.id)?.agentId, "a", "a call inside the idle window keeps the session");
  now += 99;
  assert.equal(registry.get(a.id)?.agentId, "a", "the window is measured from the last call");
  now += 101;
  assert.equal(registry.get(a.id), undefined, "idle past the window: forgotten");
  const b = registry.create();
  const c = registry.create();
  const d = registry.create();
  assert.equal(registry.size, 2);
  assert.equal(registry.get(b.id), undefined, "past the cap the least recently used session is dropped");
  assert.ok(registry.get(c.id) && registry.get(d.id));
});
