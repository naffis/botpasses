import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { hostedAuthResolver, testAuthResolver } from "../src/hosted/auth.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

const BOOTSTRAP = "a".repeat(32);

async function hostedCtx() {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: "http://127.0.0.1:8788",
    deployPlane: "staging",
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    authResolver: hostedAuthResolver({ VAULT_BOOTSTRAP_TOKEN: BOOTSTRAP }, testAuthResolver),
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    resolveAddresses: async () => ["8.8.8.8"],
  });
  const addr = await http.listen();
  return { home, store, kernel, http, orgId, base: `http://${addr.host}:${addr.port}` };
}

test("GET / is the operator HTML without auth", async () => {
  const ctx = await hostedCtx();
  try {
    const res = await fetch(`${ctx.base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Botpasses/);
    assert.match(html, /Issue Grok Bot token/);
    assert.match(html, /Issue Grok Bot token/);
    assert.match(html, /Authorization/);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("bootstrap token is an operator; wrong token is not", async () => {
  const ctx = await hostedCtx();
  try {
    const ok = await fetch(`${ctx.base}/api/items?environment=staging`, {
      headers: { authorization: `Bearer ${BOOTSTRAP}` },
    });
    assert.equal(ok.status, 200);
    const bad = await fetch(`${ctx.base}/api/items?environment=staging`, {
      headers: { authorization: `Bearer ${"b".repeat(32)}` },
    });
    assert.equal(bad.status, 401);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("issued avm_ token can MCP list_items and cannot resolve", async () => {
  const ctx = await hostedCtx();
  try {
    const stored = await fetch(`${ctx.base}/api/items`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOOTSTRAP}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "SPOTIFY_TOKEN",
        value: CANARY,
        environment: "staging",
        allowed_hosts: ["api.spotify.com"],
        inject: "bearer",
      }),
    });
    assert.equal(stored.status, 200);
    const issued = await fetch(`${ctx.base}/api/clients/model`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOOTSTRAP}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "grok", environment: "staging" }),
    });
    const body = (await issued.json()) as { token?: string; mcp_url?: string };
    assert.equal(issued.status, 200);
    assert.match(body.token ?? "", /^avm_/);
    assert.equal(body.mcp_url, "http://127.0.0.1:8788/mcp");
    const listed = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_items", arguments: { environment: "staging" } } }),
    });
    const mcp = (await listed.json()) as { result?: { content?: { text: string }[] } };
    assert.equal(listed.status, 200);
    const text = mcp.result?.content?.[0]?.text ?? "";
    assert.match(text, /SPOTIFY_TOKEN/);
    assert.ok(!text.includes(CANARY));
    const resolve = await fetch(`${ctx.base}/runtime/resolve`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ item_name: "SPOTIFY_TOKEN", environment: "staging" }),
    });
    assert.equal(resolve.status, 403);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("trusted avt_ token cannot use MCP", async () => {
  const ctx = await hostedCtx();
  try {
    const created = await fetch(`${ctx.base}/api/clients/trusted`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOOTSTRAP}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "runtime", environment: "staging" }),
    });
    const body = (await created.json()) as { token?: string };
    assert.equal(created.status, 200);
    const mcp = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(mcp.status, 401);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("avm_ token cannot fulfill a need", async () => {
  const ctx = await hostedCtx();
  try {
    const created = await ctx.kernel.createModelClient({
      orgId: ctx.orgId,
      name: "grok",
      environment: "staging",
      issueBearer: true,
    });
    assert.ok(created.plaintext);
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: created.client.id,
      environment: "staging",
      host: "api.example.com",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const fulfill = await fetch(`${ctx.base}/api/need-items/${miss.need_id}/fulfill`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({
        value: CANARY,
        allowed_hosts: ["api.example.com"],
        inject: "bearer",
      }),
    });
    assert.ok(fulfill.status === 401 || fulfill.status === 403);
    const env = await ctx.kernel.envFor(ctx.orgId, "staging");
    assert.equal((await ctx.store.listItems(env.id)).length, 0);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("avt_ token cannot fulfill a need", async () => {
  const ctx = await hostedCtx();
  try {
    const created = await ctx.kernel.createTrustedClient({
      orgId: ctx.orgId,
      name: "runtime",
      environment: "staging",
    });
    const model = await ctx.kernel.createModelClient({
      orgId: ctx.orgId,
      name: "grok",
      environment: "staging",
    });
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: model.client.id,
      environment: "staging",
      host: "api.example.com",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const fulfill = await fetch(`${ctx.base}/api/need-items/${miss.need_id}/fulfill`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({
        value: CANARY,
        allowed_hosts: ["api.example.com"],
        inject: "bearer",
      }),
    });
    assert.ok(fulfill.status === 401 || fulfill.status === 403);
    const env = await ctx.kernel.envFor(ctx.orgId, "staging");
    assert.equal((await ctx.store.listItems(env.id)).length, 0);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});
