/**
 * BOTP-4: Always approve (item_standing) so a matching later http_request skips Inbox.
 * Auto-approve audit names item, client, and host. Clear standing returns the pair to Inbox.
 * Canary secret values must not appear in MCP results or audit rows.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { testAuthResolver } from "../src/hosted/auth.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

async function setup() {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: "http://127.0.0.1:8788",
    deployPlane: "staging",
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  const item = await kernel.createItem({
    orgId,
    actor: "user_owner",
    environment: "staging",
    kind: "secret",
    name: "SPOTIFY_SECRET",
    value: CANARY,
    allowedHosts: ["api.spotify.com", "accounts.spotify.com"],
    inject: "bearer",
  });
  const { client: model } = await kernel.createModelClient({ orgId, name: "cursor", environment: "staging" });
  const { client: other } = await kernel.createModelClient({ orgId, name: "claude", environment: "staging" });
  let originHits = 0;
  const http = createHostedServer({
    authResolver: testAuthResolver,
    kernel,
    host: "127.0.0.1",
    port: 0,
    fetchImpl: async () => {
      originHits += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
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
  const otherH = {
    "x-test-channel": "model",
    "x-test-client": other.id,
    "content-type": "application/json",
  };
  const close = async () => {
    await http.close();
    await store.close();
    cleanup(home);
  };
  return { store, kernel, orgId, item, model, other, base, op, modelH, otherH, close, originHits: () => originHits };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

function toolText(rpc: unknown): Record<string, unknown> {
  const rec = rpc as { result?: { content?: { text?: string }[] } };
  return JSON.parse(rec.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

async function mcp(ctx: Ctx, name: string, args: Record<string, unknown>, headers = ctx.modelH) {
  const res = await fetch(`${ctx.base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return { res, rpc: await res.json() };
}

async function httpRequest(ctx: Ctx, headers = ctx.modelH, path = "/v1/search") {
  return mcp(ctx, "http_request", { item_name: "SPOTIFY_SECRET", method: "GET", path, host: "api.spotify.com" }, headers);
}

function assertNoCanary(payload: unknown): void {
  assert.ok(!JSON.stringify(payload).includes(CANARY), "canary must not appear in the result");
}

test("Always approve: matching http_request proceeds and audits auto_approved with item, client, host", async () => {
  const ctx = await setup();
  try {
    const first = toolText((await httpRequest(ctx)).rpc);
    assert.equal(first.status, "pending");
    assert.ok(first.grant_id);
    assertNoCanary(first);

    const approved = await fetch(`${ctx.base}/api/grants/${String(first.grant_id)}/approve`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ policy: "item_standing", scope: { methods: ["GET"], path_prefixes: ["/v1/search"] } }),
    });
    assert.equal(approved.status, 200);
    const approvedBody = (await approved.json()) as { grant?: { policy?: string } };
    assert.equal(approvedBody.grant?.policy, "item_standing");
    assertNoCanary(approvedBody);

    const second = toolText((await httpRequest(ctx)).rpc);
    assert.equal(second.origin_status, 200);
    assert.notEqual(second.status, "pending");
    assertNoCanary(second);
    assert.equal(ctx.originHits(), 1);

    const audit = await ctx.store.listAudit(ctx.orgId, 50, { action: "auto_approved" });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.itemName, "SPOTIFY_SECRET");
    assert.equal(audit[0]?.clientId, ctx.model.id);
    assert.equal(audit[0]?.host, "api.spotify.com");
    assert.ok(!JSON.stringify(audit).includes(CANARY));

    const listed = await fetch(`${ctx.base}/api/audit`, { headers: ctx.op });
    assert.equal(listed.status, 200);
    const listedBody = (await listed.json()) as { audit: unknown };
    assert.ok(JSON.stringify(listedBody).includes("auto_approved"));
    assert.ok(JSON.stringify(listedBody).includes("api.spotify.com"));
    assertNoCanary(listedBody);
  } finally {
    await ctx.close();
  }
});

test("clear standing approval: revoke drops the policy and the next http_request is pending", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "SPOTIFY_SECRET",
      environment: "staging",
      request: { host: "api.spotify.com", method: "GET", path: "/v1/search" },
    });
    await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "item_standing",
      role: "owner",
      actor: "user_owner",
      scope: { methods: ["GET"], pathPrefixes: ["/v1/search"] },
    });
    assert.ok(await ctx.store.findItemPolicy(ctx.orgId, ctx.model.id, ctx.item.id));

    const snap = await fetch(`${ctx.base}/api/access`, { headers: ctx.op });
    const access = (await snap.json()) as { grants: { id: string; policy?: string; status: string }[] };
    const standing = access.grants.find((g) => g.policy === "item_standing" && g.status === "active");
    assert.ok(standing, "access snapshot lists the standing grant");

    const revoked = await fetch(`${ctx.base}/api/grants/${asked.grant.id}/revoke`, {
      method: "POST",
      headers: ctx.op,
    });
    assert.equal(revoked.status, 200);
    assertNoCanary(await revoked.json());
    assert.equal(await ctx.store.findItemPolicy(ctx.orgId, ctx.model.id, ctx.item.id), undefined);

    const again = toolText((await httpRequest(ctx)).rpc);
    assert.equal(again.status, "pending");
    assert.equal(ctx.originHits(), 0);
    assertNoCanary(again);
  } finally {
    await ctx.close();
  }
});

test("standing approval is per client: another agent still hits Inbox", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "SPOTIFY_SECRET",
      environment: "staging",
    });
    await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "item_standing",
      role: "owner",
      actor: "user_owner",
      scope: {},
    });
    const other = toolText((await httpRequest(ctx, ctx.otherH)).rpc);
    assert.equal(other.status, "pending");
    assert.equal(ctx.originHits(), 0);
    assertNoCanary(other);
  } finally {
    await ctx.close();
  }
});

test("standing token-scope does not satisfy playlist request_grant (BOTP-8)", async () => {
  const ctx = await setup();
  try {
    const tokenAsk = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "SPOTIFY_SECRET",
      environment: "staging",
      request: { host: "accounts.spotify.com", method: "POST", path: "/api/token" },
    });
    const standing = await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: tokenAsk.grant.id,
      policy: "item_standing",
      role: "owner",
      actor: "user_owner",
      scope: { methods: ["POST"], pathPrefixes: ["/api/token"] },
    });
    assert.equal(standing.status, "active");
    assert.equal(standing.hosts, null, "Always approve limits method and path, not host");
    assert.deepEqual(standing.pathPrefixes, ["/api/token"]);

    const denied = toolText(
      (
        await mcp(ctx, "http_request", {
          item_name: "SPOTIFY_SECRET",
          host: "api.spotify.com",
          method: "POST",
          path: "/v1/me/playlists",
        })
      ).rpc,
    );
    assert.equal(denied.status, "scope_denied");
    assert.equal(denied.reason, "path");
    assertNoCanary(denied);

    const asked = toolText(
      (
        await mcp(ctx, "request_grant", {
          item_name: "SPOTIFY_SECRET",
          host: "api.spotify.com",
          method: "POST",
          path: "/v1/me/playlists",
        })
      ).rpc,
    );
    assert.equal(asked.status, "pending");
    assert.notEqual(asked.grant_id, standing.id);
    assert.deepEqual(asked.requested_scope, {
      host: "api.spotify.com",
      method: "POST",
      path: "/v1/me/playlists",
    });
    assert.notEqual(asked.status, "active");
    assertNoCanary(asked);

    const again = toolText(
      (
        await mcp(ctx, "request_grant", {
          item_name: "SPOTIFY_SECRET",
          host: "api.spotify.com",
          method: "POST",
          path: "/v1/me/playlists",
        })
      ).rpc,
    );
    assert.equal(again.grant_id, asked.grant_id);
    assert.equal(again.status, "pending");

    const covering = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "SPOTIFY_SECRET",
      environment: "staging",
      request: { host: "accounts.spotify.com", method: "POST", path: "/api/token" },
    });
    assert.equal(covering.grant.id, standing.id);
    assert.equal(covering.grant.status, "active");

    const unnamed = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "SPOTIFY_SECRET",
      environment: "staging",
    });
    assert.equal(unnamed.grant.id, standing.id);
    assert.equal(unnamed.grant.status, "active");

    await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: String(asked.grant_id),
      policy: "prompt",
      role: "owner",
      actor: "user_owner",
    });
    const playlist = toolText(
      (
        await mcp(ctx, "http_request", {
          item_name: "SPOTIFY_SECRET",
          host: "api.spotify.com",
          method: "POST",
          path: "/v1/me/playlists",
        })
      ).rpc,
    );
    assert.equal(playlist.origin_status, 200);
    assertNoCanary(playlist);

    const token = toolText(
      (
        await mcp(ctx, "http_request", {
          item_name: "SPOTIFY_SECRET",
          host: "accounts.spotify.com",
          method: "POST",
          path: "/api/token",
        })
      ).rpc,
    );
    assert.equal(token.origin_status, 200);
    assertNoCanary(token);
    assert.ok(!JSON.stringify(await ctx.store.listAudit(ctx.orgId, 50)).includes(CANARY));
  } finally {
    await ctx.close();
  }
});

test("plain Approve stays one-shot: a second identical http_request is pending", async () => {
  const ctx = await setup();
  try {
    const first = toolText((await httpRequest(ctx)).rpc);
    assert.equal(first.status, "pending");
    const approved = await fetch(`${ctx.base}/api/grants/${String(first.grant_id)}/approve`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ policy: "prompt" }),
    });
    assert.equal(approved.status, 200);
    const used = toolText((await httpRequest(ctx)).rpc);
    assert.equal(used.origin_status, 200);
    const again = toolText((await httpRequest(ctx)).rpc);
    assert.equal(again.status, "pending");
    assert.equal(ctx.originHits(), 1);
    assertNoCanary(again);
    const auto = await ctx.store.listAudit(ctx.orgId, 50, { action: "auto_approved" });
    assert.equal(auto.length, 0);
  } finally {
    await ctx.close();
  }
});
