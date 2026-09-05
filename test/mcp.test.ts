import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { callHostedMcpTool, HOSTED_MCP_TOOL_NAMES } from "../src/hosted/mcp.ts";
import {
  agentIdFromClientName,
  callMcpTool,
  handleMcpRpc,
  listMcpTools,
  MCP_TOOL_NAMES,
  newMcpSession,
} from "../src/mcp.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, makeVault, tempHome } from "./helpers.ts";

type Parsed = Record<string, unknown>;

function parsed(result: { content: { text: string }[] }): Parsed {
  return JSON.parse(result.content[0]?.text ?? "{}") as Parsed;
}

const origin = { resolveAddresses: async () => ["8.8.8.8"] };

test("local MCP advertises the five hosted tool names and never a read_value tool", () => {
  const tools = listMcpTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...MCP_TOOL_NAMES].sort());
  assert.deepEqual([...MCP_TOOL_NAMES].sort(), [...HOSTED_MCP_TOOL_NAMES].sort(), "same names as hosted");
  for (const tool of tools) {
    assert.doesNotMatch(tool.name, /value|decrypt|reveal|read_secret|get_secret/);
    assert.match(tool.description, /never/i);
  }
  const http = tools.find((t) => t.name === "http_request");
  assert.deepEqual(http?.inputSchema.required, ["method", "path"]);
  assert.ok(Object.keys(http?.inputSchema.properties ?? {}).includes("host"));
  assert.equal(http?.annotations?.destructiveHint, true);
});

test("local list_items has the same item key set as hosted list_items", async () => {
  const { vault, home } = makeVault();
  const hostedHome = tempHome();
  const store = openHostedSqlite(join(hostedHome, "h.sqlite"));
  try {
    vault.setSecret("STRIPE_KEY", CANARY, { allowedHosts: ["api.stripe.com"] });
    const local = parsed(await callMcpTool(vault, "list_items", {}));
    const localItems = local.items as Parsed[];
    assert.equal(localItems.length, 1);

    const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), deployPlane: "staging" });
    const { orgId } = await kernel.createOrg("acme", "user_owner");
    await kernel.createItem({
      orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "STRIPE_KEY",
      value: CANARY,
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
    });
    const { client } = await kernel.createModelClient({ orgId, name: "cursor", environment: "staging" });
    const hosted = parsed(
      await callHostedMcpTool(
        { kernel, principal: { channel: "model", orgId, clientId: client.id, environment: "staging" } },
        "list_items",
        {},
      ),
    );
    const hostedItems = hosted.items as Parsed[];
    assert.deepEqual(Object.keys(localItems[0] ?? {}).sort(), Object.keys(hostedItems[0] ?? {}).sort());
    assert.equal(localItems[0]?.environment, "local");
    assert.ok(!JSON.stringify(local).includes(CANARY));
  } finally {
    vault.close();
    await store.close();
    cleanup(home);
    cleanup(hostedHome);
  }
});

test("MCP tools/call never returns the stored value; list_secrets stays as an alias", async () => {
  const { vault, home } = makeVault();
  try {
    vault.setSecret("STRIPE_KEY", CANARY, { allowedHosts: ["api.stripe.com"] });
    const listed = await callMcpTool(vault, "list_items", {});
    const alias = await callMcpTool(vault, "list_secrets", {});
    assert.equal(alias.content[0]?.text, listed.content[0]?.text);
    const requested = await callMcpTool(vault, "request_grant", { item_name: "STRIPE_KEY", task_description: "invoice" });
    const grants = await callMcpTool(vault, "list_grants", {});
    const found = await callMcpTool(vault, "find_items", { host: "api.stripe.com" });
    const blob = JSON.stringify({ listed, requested, grants, found });
    assert.ok(!blob.includes(CANARY));
    assert.match(listed.content[0]?.text ?? "", /STRIPE_KEY/);
    assert.match(listed.content[0]?.text ?? "", /c10b/);
    assert.equal(parsed(found).status, "found");
    assert.equal((parsed(found).item as Parsed).name, "STRIPE_KEY");
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("MCP get_secret / read_value are rejected", async () => {
  const { vault, home } = makeVault();
  try {
    vault.setSecret("STRIPE_KEY", CANARY);
    for (const name of ["get_secret", "read_value", "reveal_secret", "decrypt_secret"]) {
      const result = await callMcpTool(vault, name, { name: "STRIPE_KEY" });
      assert.equal(result.isError, true);
      assert.ok(!(result.content[0]?.text ?? "").includes(CANARY));
    }
    const rpc = await handleMcpRpc(vault, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_secret", arguments: { name: "STRIPE_KEY" } },
    });
    assert.ok(rpc);
    assert.ok(!JSON.stringify(rpc).includes(CANARY));
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("request_grant leaves the grant pending under the agent named by initialize", async () => {
  const { vault, home } = makeVault();
  try {
    vault.setSecret("STRIPE_KEY", CANARY);
    const session = newMcpSession();
    const init = await handleMcpRpc(
      vault,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "Cursor Agent 2.0", version: "1" } } },
      session,
    );
    assert.equal(session.agentId, "cursor-agent-2-0");
    assert.match(JSON.stringify(init?.result), /http_request/);
    const result = await callMcpTool(vault, "request_grant", { item_name: "STRIPE_KEY" }, { session });
    const body = parsed(result);
    assert.equal(body.status, "pending");
    assert.equal(body.agent_id, "cursor-agent-2-0");
    assert.equal(body.tool_id, "http_request");
    assert.equal(body.item_name, "STRIPE_KEY");
    assert.match(String(body.message), /vault grant --secret STRIPE_KEY --agent cursor-agent-2-0 --tool http_request/);
    assert.equal(vault.listGrants()[0]?.status, "pending");
    assert.equal(agentIdFromClientName(""), "mcp");
    assert.equal(agentIdFromClientName("  ##claude desktop  "), "claude-desktop");
    const missing = await callMcpTool(vault, "request_grant", { item_name: "MISSING_KEY" }, { session });
    assert.equal(missing.isError, true);
    assert.equal(parsed(missing).status, "need_item");
    assert.equal(parsed(missing).collect_url, undefined);
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("C4: arguments outside a tool's schema are refused; agent_id and tool_id no longer rebind the caller", async () => {
  const { vault, home } = makeVault();
  try {
    vault.setSecret("STRIPE_KEY", CANARY, { allowedHosts: ["api.stripe.com"] });
    const session = newMcpSession();
    session.agentId = "cursor";
    const rpc = await handleMcpRpc(
      vault,
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "request_grant", arguments: { item_name: "STRIPE_KEY", agent_id: "someone-else", tool_id: "stripe" } } },
      session,
    );
    assert.equal(rpc?.error?.code, -32602);
    assert.match(rpc?.error?.message ?? "", /Invalid params: unknown arguments agent_id, tool_id for tool request_grant/);
    assert.equal(vault.listGrants().length, 0, "nothing was created");
    const direct = await callMcpTool(vault, "list_grants", { agent_id: "someone-else" }, { session });
    assert.equal(direct.isError, true);
    assert.match(direct.content[0]?.text ?? "", /Invalid params/);
    const aliased = await handleMcpRpc(vault, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "list_secrets", arguments: { environment: "x" } } }, session);
    assert.equal(aliased?.error?.code, -32602, "aliases are checked against the canonical schema");
    const ok = parsed(await callMcpTool(vault, "request_grant", { item_name: "STRIPE_KEY", scope: "session", task_description: "x" }, { session }));
    assert.equal(ok.agent_id, "cursor");
    assert.equal(ok.tool_id, "http_request");
    assert.equal(ok.policy, "session");
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("C5/C14: local http_request honours dry_run, timeout_ms, and client_id; items carry a username and the hosted inject vocabulary", async () => {
  const { vault, home } = makeVault();
  const seen: { url: string; auth: string; query: string }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), auth: headers.get("authorization") ?? "", query: new URL(String(url)).search });
    if (init?.signal) {
      return new Promise<Response>((_resolve, reject) => {
        if (String(url).includes("/slow")) init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        else _resolve(new Response("{}", { status: 200 }));
      });
    }
    return new Response("{}", { status: 200 });
  };
  const session = newMcpSession();
  session.agentId = "cursor";
  const ctx = { session, fetchImpl, ...origin };
  try {
    const stored = vault.setSecret("BASIC_KEY", CANARY, { allowedHosts: ["api.example.com"], inject: "basic", username: "svc-user" });
    assert.equal(stored.username, "svc-user");
    assert.equal(vault.setSecret("QUERY_KEY", CANARY, { allowedHosts: ["api.other.com"], inject: "query:api_key" }).inject, "query:api_key");
    assert.throws(() => vault.setSecret("BAD", CANARY, { inject: "cookie" }), /inject must be/);
    assert.throws(() => vault.setSecret("BAD", CANARY, { username: "a\nb" }), /control characters/);
    const listed = parsed(await callMcpTool(vault, "list_items", {}, ctx)).items as Parsed[];
    assert.equal(listed.find((i) => i.name === "BASIC_KEY")?.username, "svc-user");

    const dry = parsed(await callMcpTool(vault, "http_request", { item_name: "BASIC_KEY", method: "GET", path: "/v1/me", dry_run: true }, ctx));
    assert.deepEqual(
      { ...dry, retry: undefined },
      { dry_run: true, item_name: "BASIC_KEY", host: "api.example.com", method: "GET", path: "/v1/me", would_send: false, reason: "grant_required", grant_status: "none", inject_mode: "basic", provider: null, retry: undefined },
    );
    assert.equal(seen.length, 0, "a dry run sends nothing");
    assert.equal(vault.listGrants().length, 0, "and requests no grant");
    vault.approveGrant({ secretName: "BASIC_KEY", agentId: "cursor", toolId: "http_request", scope: "session" });
    const ready = parsed(await callMcpTool(vault, "http_request", { host: "api.example.com", method: "GET", path: "/v1/me", dry_run: true }, ctx));
    assert.equal(ready.would_send, true);
    assert.equal(ready.grant_status, "active");
    const mismatch = parsed(await callMcpTool(vault, "http_request", { item_name: "BASIC_KEY", host: "api.other.com", method: "GET", path: "/", dry_run: true }, ctx));
    assert.equal(mismatch.reason, "host_mismatch");

    const sent = parsed(await callMcpTool(vault, "http_request", { item_name: "BASIC_KEY", method: "GET", path: "/v1/me" }, ctx));
    assert.equal(sent.origin_status, 200);
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.origin_headers, { "content-type": "text/plain;charset=UTF-8" });
    assert.equal(seen[0]?.auth, `Basic ${Buffer.from(`svc-user:${CANARY}`).toString("base64")}`, "the stored username is sent");
    await callMcpTool(vault, "http_request", { item_name: "BASIC_KEY", method: "GET", path: "/v1/me", client_id: "override-id" }, ctx);
    assert.equal(seen[1]?.auth, `Basic ${Buffer.from(`override-id:${CANARY}`).toString("base64")}`, "client_id overrides the username for one call");

    const started = Date.now();
    const slow = await callMcpTool(vault, "http_request", { item_name: "BASIC_KEY", method: "GET", path: "/slow", timeout_ms: 1000 }, ctx);
    assert.equal(slow.isError, true);
    assert.match(slow.content[0]?.text ?? "", /did not respond within 1s/);
    assert.ok(Date.now() - started < 5000, "timeout_ms applied instead of the 10 s default");
    assert.ok(!JSON.stringify({ sent, slow, seen: seen.map((s) => s.url) }).includes(CANARY));
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("G3 (local): a once grant is spent by any origin answer and handed back only when the send never left", async () => {
  const { vault, home } = makeVault();
  const session = newMcpSession();
  session.agentId = "cursor";
  const call = (fetchImpl: typeof fetch) =>
    callMcpTool(vault, "http_request", { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance" }, { session, fetchImpl, ...origin });
  const status = () => vault.listGrants().find((g) => g.status !== "revoked")?.status;
  const approveOnce = () => vault.approveGrant({ secretName: "STRIPE_KEY", agentId: "cursor", toolId: "http_request", scope: "once" });
  try {
    vault.setSecret("STRIPE_KEY", CANARY, { allowedHosts: ["api.stripe.com"] });
    approveOnce();
    await call(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    });
    assert.equal(status(), "active", "DNS failure: the value never left");
    await call(async () => new Response("", { status: 503 }));
    assert.equal(status(), "consumed", "an origin answer spends the grant");
    assert.equal((await call(async () => new Response("{}", { status: 200 }))).content[0]?.text.includes('"pending"'), true, "the next call needs a new approval");
    const revoked = vault.listGrants().filter((g) => g.status === "consumed");
    for (const g of revoked) vault.revokeGrant({ grantId: g.id });
    approveOnce();
    await call(async () => {
      throw new Error("socket hang up");
    });
    assert.equal(vault.listGrants().some((g) => g.status === "consumed"), true, "an unclassified transport failure counts as sent");
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("local http_request calls the origin with the credential and never shows it in the result", async () => {
  const { vault, home } = makeVault();
  const seen: { url: string; auth: string }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), auth: headers.get("authorization") ?? "" });
    return new Response(JSON.stringify({ ok: true, echo: CANARY, basic: Buffer.from(`:${CANARY}`).toString("base64") }), {
      status: 200,
    });
  };
  const session = newMcpSession();
  session.agentId = "cursor";
  const ctx = { session, fetchImpl, ...origin };
  try {
    vault.setSecret("STRIPE_KEY", CANARY, { allowedHosts: ["api.stripe.com"] });
    const before = parsed(await callMcpTool(vault, "http_request", { method: "GET", path: "https://api.stripe.com/v1/balance" }, ctx));
    assert.equal(before.status, "pending", "no grant yet: a pending grant comes back");
    assert.equal(before.item_name, "STRIPE_KEY");
    assert.deepEqual(before.retry, { method: "GET", path: "/v1/balance", host: "api.stripe.com", item_name: "STRIPE_KEY" });
    assert.equal(seen.length, 0, "nothing was sent without a grant");

    vault.approveGrant({ secretName: "STRIPE_KEY", agentId: "cursor", toolId: "http_request", scope: "once" });
    const result = await callMcpTool(vault, "http_request", { method: "GET", path: "https://api.stripe.com/v1/balance" }, ctx);
    const body = parsed(result);
    assert.equal(result.isError, undefined);
    assert.equal(body.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.auth, `Bearer ${CANARY}`, "the origin saw the credential");
    assert.equal(seen[0]?.url, "https://api.stripe.com/v1/balance");
    assert.ok(!JSON.stringify(result).includes(CANARY), "the model never sees the credential");
    assert.ok(!JSON.stringify(result).includes(Buffer.from(`:${CANARY}`).toString("base64")));
    assert.match(String(body.body), /\[redacted\]/);
    assert.equal(vault.listGrants()[0]?.status, "consumed", "once grant consumed after the send");
    const audit = vault.listAudit().filter((a) => a.action === "inject");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.agentId, "cursor");

    const again = parsed(await callMcpTool(vault, "http_request", { method: "GET", path: "/v1/balance", host: "api.stripe.com" }, ctx));
    assert.equal(again.status, "pending", "a consumed once grant needs a new approval");

    const mismatch = await callMcpTool(
      vault,
      "http_request",
      { method: "GET", path: "/v1/me", host: "api.other.com", item_name: "STRIPE_KEY" },
      ctx,
    );
    assert.equal(mismatch.isError, true);
    assert.equal(parsed(mismatch).status, "host_mismatch");
    assert.equal(seen.length, 1, "host mismatch never reaches the origin");

    const unknown = await callMcpTool(vault, "http_request", { method: "GET", path: "https://api.github.com/user" }, ctx);
    assert.equal(unknown.isError, true);
    assert.equal(parsed(unknown).status, "need_item");
    assert.match(String(parsed(unknown).message), /vault set API_GITHUB_COM --host api.github.com/);
    assert.ok(!JSON.stringify({ again, mismatch, unknown }).includes(CANARY));

    const aliased = await callMcpTool(vault, "http.request", { method: "GET", path: "https://api.stripe.com/v1/balance" }, ctx);
    assert.equal(parsed(aliased).status, "pending", "old dotted name still dispatches");
  } finally {
    vault.close();
    cleanup(home);
  }
});
