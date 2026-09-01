import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { STAGING_ORIGIN } from "../src/brand.ts";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { handleHostedMcpRpc } from "../src/hosted/mcp.ts";
import { callMcpTool } from "../src/mcp.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, makeVault, tempHome } from "./helpers.ts";

async function setup() {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: STAGING_ORIGIN,
    deployPlane: "staging",
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  const { client: model } = await kernel.createModelClient({
    orgId,
    name: "grok",
    environment: "staging",
  });
  let lastAuth = "";
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    publicUrl: STAGING_ORIGIN,
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers);
      lastAuth = headers.get("authorization") ?? "";
      return new Response(JSON.stringify({ ok: true, echo: CANARY }), { status: 200 });
    },
    resolveAddresses: async () => ["8.8.8.8"],
  });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const op = {
    "x-test-channel": "operator",
    "x-test-user": "user_owner",
    "x-test-org": orgId,
    "content-type": "application/json",
  };
  const modelH = {
    "x-test-channel": "model",
    "x-test-client": model.id,
    "content-type": "application/json",
  };
  const principal = {
    channel: "model" as const,
    orgId,
    clientId: model.id,
    environment: "staging" as const,
  };
  return { home, store, kernel, http, base, orgId, model, op, modelH, principal, lastAuth: () => lastAuth };
}

function parseTool(rpc: unknown): { isError?: boolean; body: Record<string, unknown> } {
  const rec = rpc as { result?: { isError?: boolean; content?: { text?: string }[] } };
  const text = rec.result?.content?.[0]?.text ?? "{}";
  return { isError: rec.result?.isError, body: JSON.parse(text) as Record<string, unknown> };
}

test("find_items with neither name nor host is isError not a dump (AC-04)", async () => {
  const ctx = await setup();
  try {
    const rpc = await handleHostedMcpRpc(
      { kernel: ctx.kernel, principal: ctx.principal },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "find_items", arguments: {} },
      },
    );
    const parsed = parseTool(rpc);
    assert.equal(parsed.isError, true);
    assert.notEqual(parsed.body.status, "found");
    assert.equal(parsed.body.items, undefined);
    assert.ok(typeof parsed.body.error === "string" || parsed.body.status === undefined);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("unauthenticated POST fulfill is 401", async () => {
  const ctx = await setup();
  try {
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      environment: "staging",
      host: "api.example.com",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const res = await fetch(`${ctx.base}/api/need-items/${miss.need_id}/fulfill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: CANARY,
        allowed_hosts: ["api.example.com"],
        inject: "bearer",
      }),
    });
    assert.equal(res.status, 401);
    const env = await ctx.kernel.envFor(ctx.orgId, "staging");
    assert.equal((await ctx.store.listItems(env.id)).length, 0);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("GET /api/need-items/:id is not public JSON (R-19)", async () => {
  const ctx = await setup();
  try {
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      environment: "staging",
      host: "api.example.com",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const res = await fetch(`${ctx.base}/api/need-items/${miss.need_id}`);
    assert.equal(res.status, 404);
    const body = JSON.parse(await res.text()) as { collect_url?: string; error?: string };
    assert.equal(body.collect_url, undefined);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("find_items miss is need_item JSON with next, not isError (AC-16)", async () => {
  const ctx = await setup();
  try {
    const rpc = await handleHostedMcpRpc(
      { kernel: ctx.kernel, principal: ctx.principal },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "find_items", arguments: { host: "api.spotify.com" } },
      },
    );
    const parsed = parseTool(rpc);
    assert.equal(parsed.isError, undefined);
    assert.equal(parsed.body.status, "need_item");
    assert.equal(typeof parsed.body.collect_url, "string");
    assert.match(String((parsed.body.next as { for_model?: string } | undefined)?.for_model ?? ""), /collect_url/);
    assert.ok(!JSON.stringify(parsed.body).includes(CANARY));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("request_grant unknown name includes collect_url (AC-08)", async () => {
  const ctx = await setup();
  try {
    const rpc = await handleHostedMcpRpc(
      { kernel: ctx.kernel, principal: ctx.principal },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "request_grant", arguments: { item_name: "NEW_KEY" } },
      },
    );
    const parsed = parseTool(rpc);
    assert.equal(parsed.isError, undefined);
    assert.equal(typeof parsed.body.collect_url, "string");
    assert.notEqual(parsed.body.error, "Unknown item");
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("REST grants/request unknown item returns collect_url (AC-15)", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/api/grants/request`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({ item_name: "NEW_KEY", environment: "staging" }),
    });
    const body = JSON.parse(await res.text()) as { collect_url?: string; error?: string };
    assert.equal(res.status, 404);
    assert.equal(typeof body.collect_url, "string");
    assert.notEqual(body.error, "Unknown item");
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("http.request unknown item is need_item not connector body (AC-14)", async () => {
  const ctx = await setup();
  try {
    const rpc = await handleHostedMcpRpc(
      {
        kernel: ctx.kernel,
        principal: ctx.principal,
        fetchImpl: async () => new Response("nope", { status: 200 }),
        resolveAddresses: async () => ["8.8.8.8"],
      },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "http.request",
          arguments: { item_name: "MISSING", method: "GET", path: "/" },
        },
      },
    );
    const parsed = parseTool(rpc);
    assert.equal(parsed.isError, undefined);
    assert.equal(parsed.body.status, "need_item");
    assert.equal(parsed.body.body, undefined);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("model bearer cannot fulfill (AC-06)", async () => {
  const ctx = await setup();
  try {
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      environment: "staging",
      host: "api.example.com",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const res = await fetch(`${ctx.base}/api/need-items/${miss.need_id}/fulfill`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({
        value: CANARY,
        allowed_hosts: ["api.example.com"],
        inject: "bearer",
      }),
    });
    assert.ok(res.status === 401 || res.status === 403);
    const env = await ctx.kernel.envFor(ctx.orgId, "staging");
    assert.equal((await ctx.store.listItems(env.id)).length, 0);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("collect HTML has password input and client name, no canary (AC-09)", async () => {
  const ctx = await setup();
  try {
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      environment: "staging",
      host: "api.example.com",
      taskDescription: "fetch playlists",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const res = await fetch(`${ctx.base}/collect/${miss.need_id}`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /type="password"/);
    assert.match(html, /grok/);
    assert.match(html, /fetch playlists/);
    assert.ok(!html.includes(CANARY));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("fulfill then http.request attaches bearer and redacts canary (AC-07)", async () => {
  const ctx = await setup();
  try {
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      environment: "staging",
      host: "api.spotify.com",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const fulfill = await fetch(`${ctx.base}/api/need-items/${miss.need_id}/fulfill`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({
        name: "SPOTIFY_TOKEN",
        value: CANARY,
        allowed_hosts: ["api.spotify.com"],
        inject: "bearer",
      }),
    });
    assert.equal(fulfill.status, 200);
    const body = JSON.parse(await fulfill.text()) as { item?: { name?: string }; value?: string };
    assert.equal(body.item?.name, "SPOTIFY_TOKEN");
    assert.equal(body.value, undefined);
    const rpc = await handleHostedMcpRpc(
      {
        kernel: ctx.kernel,
        principal: ctx.principal,
        fetchImpl: async (_url, init) => {
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), `Bearer ${CANARY}`);
          return new Response(JSON.stringify({ ok: true, echo: CANARY }), { status: 200 });
        },
        resolveAddresses: async () => ["8.8.8.8"],
      },
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "http.request",
          arguments: { item_name: "SPOTIFY_TOKEN", method: "GET", path: "/v1/me" },
        },
      },
    );
    const text = JSON.stringify(rpc);
    assert.ok(!text.includes(CANARY));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("find_items host_mismatch is isError with full JSON (R-23)", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "FOO",
      value: "aaaa",
      allowedHosts: ["api.foo.com"],
      inject: "bearer",
    });
    const rpc = await handleHostedMcpRpc(
      { kernel: ctx.kernel, principal: ctx.principal },
      {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "find_items",
          arguments: { item_name: "FOO", host: "api.bar.com" },
        },
      },
    );
    const parsed = parseTool(rpc);
    assert.equal(parsed.isError, true);
    assert.equal(parsed.body.status, "host_mismatch");
    assert.equal(parsed.body.collect_url, undefined);
    assert.ok(!JSON.stringify(parsed.body).includes(CANARY));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("find_items found is not isError (R-23)", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "ONLY_ONE",
      value: "aaaa",
      allowedHosts: ["api.only.com"],
      inject: "bearer",
    });
    const rpc = await handleHostedMcpRpc(
      { kernel: ctx.kernel, principal: ctx.principal },
      {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "find_items", arguments: { host: "api.only.com" } },
      },
    );
    const parsed = parseTool(rpc);
    assert.equal(parsed.isError, undefined);
    assert.equal(parsed.body.status, "found");
    const next = parsed.body.next as { tool?: string } | undefined;
    assert.equal(next?.tool, "http.request");
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("unknown collect id is 404 HTML not JSON", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/collect/nid_missing`);
    const html = await res.text();
    assert.equal(res.status, 404);
    assert.match(html, /Unknown collect request/);
    assert.doesNotMatch(html, /collect_url/);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("fulfill ignores client_id and environment in the body (A-13)", async () => {
  const ctx = await setup();
  try {
    const other = await ctx.kernel.createModelClient({
      orgId: ctx.orgId,
      name: "other",
      environment: "staging",
    });
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      environment: "staging",
      host: "api.bind.com",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const res = await fetch(`${ctx.base}/api/need-items/${miss.need_id}/fulfill`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({
        value: "secret",
        allowed_hosts: ["api.bind.com"],
        inject: "bearer",
        client_id: other.client.id,
        environment: "production",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { item?: { environment?: string; id?: string } };
    assert.equal(body.item?.environment, "staging");
    const grants = await ctx.store.listGrants(ctx.orgId);
    const grant = grants.find((g) => g.itemId === body.item?.id);
    assert.equal(grant?.clientId, ctx.model.id);
    assert.notEqual(grant?.clientId, other.client.id);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("http.request with host only on a miss returns need_item and next, not isError", async () => {
  const ctx = await setup();
  try {
    const rpc = await handleHostedMcpRpc(
      { kernel: ctx.kernel, principal: ctx.principal },
      {
        jsonrpc: "2.0",
        id: 40,
        method: "tools/call",
        params: {
          name: "http.request",
          arguments: { host: "api.spotify.com", method: "GET", path: "/v1/me" },
        },
      },
    );
    const parsed = parseTool(rpc);
    assert.equal(parsed.isError, undefined);
    assert.equal(parsed.body.status, "need_item");
    assert.match(String(parsed.body.collect_url), /\/collect\//);
    const next = parsed.body.next as { for_model?: string; arguments?: Record<string, string> } | undefined;
    assert.match(next?.for_model ?? "", /collect_url/);
    assert.equal(next?.arguments?.host, "api.spotify.com");
    assert.equal(next?.arguments?.method, "GET");
    assert.equal(next?.arguments?.path, "/v1/me");
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("http.request accepts a full https URL as path and finds by host", async () => {
  const ctx = await setup();
  try {
    const rpc = await handleHostedMcpRpc(
      { kernel: ctx.kernel, principal: ctx.principal },
      {
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: {
          name: "http.request",
          arguments: { method: "GET", path: "https://api.spotify.com/v1/me" },
        },
      },
    );
    const parsed = parseTool(rpc);
    assert.equal(parsed.body.status, "need_item");
    assert.equal(parsed.body.host, "api.spotify.com");
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("http.request with host requests a grant when the item exists but is not granted", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "SPOTIFY_TOKEN",
      value: CANARY,
      allowedHosts: ["api.spotify.com"],
      inject: "bearer",
    });
    const rpc = await handleHostedMcpRpc(
      {
        kernel: ctx.kernel,
        principal: ctx.principal,
        fetchImpl: async () => new Response("should-not-run", { status: 200 }),
        resolveAddresses: async () => ["8.8.8.8"],
      },
      {
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "http.request",
          arguments: { host: "api.spotify.com", method: "GET", path: "/v1/me" },
        },
      },
    );
    const parsed = parseTool(rpc);
    assert.equal(parsed.body.status, "pending");
    assert.equal(typeof parsed.body.approval_code, "string");
    assert.equal(parsed.isError, undefined);
    const next = parsed.body.next as { for_model?: string; arguments?: Record<string, string> } | undefined;
    assert.match(next?.for_model ?? "", /approve/);
    assert.equal(next?.arguments?.host, "api.spotify.com");
    assert.equal(next?.arguments?.method, "GET");
    assert.equal(next?.arguments?.path, "/v1/me");
    assert.equal(next?.arguments?.item_name, "SPOTIFY_TOKEN");
    assert.ok(!JSON.stringify(parsed.body).includes(CANARY));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("local MCP miss is need_item without collect_url (AC-10)", () => {
  const { vault, home } = makeVault();
  try {
    const result = callMcpTool(vault, "request_grant", {
      secret_name: "MISSING_KEY",
      agent_id: "invoicer",
      tool_id: "stripe",
    });
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
      status?: string;
      collect_url?: string;
    };
    assert.equal(parsed.status, "need_item");
    assert.equal(parsed.collect_url, undefined);
  } finally {
    vault.close();
    cleanup(home);
  }
});
