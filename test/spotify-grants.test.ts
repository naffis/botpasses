import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { assertRedirectUri } from "../src/hosted/oauth-as.ts";
import { clearSpotifyMintCache } from "../src/hosted/spotify.ts";
import { redactOauthJson } from "../src/redact.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

const CLIENT_ID = "97540628b46c43059710d66714d75870";
const CLIENT_SECRET = "spotify_client_secret_CANARY_b91c";
const ACCESS = "BQC_fake_access_token_do_not_leak_zzzz";

function mcpText(rpc: unknown): Record<string, unknown> {
  const rec = rpc as { result?: { content?: { text?: string }[] } };
  return JSON.parse(rec.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

async function setup(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  clearSpotifyMintCache();
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: "http://127.0.0.1:8788",
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  await kernel.createItem({
    orgId,
    actor: "user_owner",
    environment: "staging",
    kind: "secret",
    name: "SPOTIFY_SECRET",
    value: CLIENT_SECRET,
    username: CLIENT_ID,
    allowedHosts: ["api.spotify.com", "accounts.spotify.com"],
    inject: "client_credentials",
  });
  const { client: model } = await kernel.createModelClient({
    orgId,
    name: "grok",
    environment: "staging",
  });
  const hits: { url: string; auth: string; contentType: string; body: string }[] = [];
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    fetchImpl: async (url, init) => {
      const headers = new Headers(init?.headers);
      hits.push({
        url: String(url),
        auth: headers.get("authorization") ?? "",
        contentType: headers.get("content-type") ?? "",
        body: typeof init?.body === "string" ? init.body : "",
      });
      return handler(String(url), init);
    },
    resolveAddresses: async () => ["8.8.8.8"],
  });
  const addr = await http.listen();
  return {
    home,
    store,
    kernel,
    orgId,
    model,
    http,
    hits,
    base: `http://${addr.host}:${addr.port}`,
    op: {
      "x-test-channel": "operator",
      "x-test-user": "user_owner",
      "x-test-org": orgId,
      "content-type": "application/json",
    },
    modelH: {
      "x-test-channel": "model",
      "x-test-client": model.id,
      "content-type": "application/json",
    },
  };
}

async function approve(ctx: Awaited<ReturnType<typeof setup>>) {
  const asked = await ctx.kernel.requestGrant({
    orgId: ctx.orgId,
    clientId: ctx.model.id,
    itemName: "SPOTIFY_SECRET",
    environment: "staging",
  });
  await ctx.kernel.approveGrant({
    orgId: ctx.orgId,
    grantId: asked.grant.id,
    policy: "prompt",
    role: "owner",
    actor: "user_owner",
  });
  return asked.grant.id;
}

async function call(ctx: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown>) {
  const res = await fetch(`${ctx.base}/mcp`, {
    method: "POST",
    headers: ctx.modelH,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "http_request", arguments: args },
    }),
  });
  const rpc = await res.json();
  return { res, rpc, payload: mcpText(rpc) };
}

test("assertRedirectUri accepts Grok/Cursor desktop schemes", () => {
  assert.doesNotThrow(() => assertRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback"));
  assert.doesNotThrow(() => assertRedirectUri("grok://oauth/callback"));
  assert.doesNotThrow(() => assertRedirectUri("http://127.0.0.1:8888/callback"));
  assert.throws(() => assertRedirectUri("javascript:alert(1)"));
});

test("redactOauthJson never emits access_token values", () => {
  const out = redactOauthJson(JSON.stringify({ access_token: ACCESS, token_type: "Bearer", expires_in: 3600 }));
  assert.doesNotMatch(out, new RegExp(ACCESS));
  assert.match(out, /\[redacted\]/);
});

test("Spotify token mint uses Basic + form body and redacts the access token", async () => {
  const ctx = await setup(async (url) => {
    if (url.includes("accounts.spotify.com/api/token")) {
      return new Response(JSON.stringify({ access_token: ACCESS, token_type: "Bearer", expires_in: 3600 }), {
        status: 200,
      });
    }
    return new Response("nope", { status: 404 });
  });
  try {
    await approve(ctx);
    const { res, payload } = await call(ctx, {
      item_name: "SPOTIFY_SECRET",
      method: "POST",
      path: "https://accounts.spotify.com/api/token",
      client_id: CLIENT_ID,
    });
    assert.equal(res.status, 200);
    assert.equal(payload.status, 200);
    const blob = JSON.stringify(payload);
    assert.doesNotMatch(blob, new RegExp(CLIENT_SECRET));
    assert.doesNotMatch(blob, new RegExp(ACCESS));
    assert.match(String(payload.body), /\[redacted\]/);
    assert.equal(payload.minted, true);
    const hit = ctx.hits.find((h) => h.url.includes("/api/token"));
    assert.ok(hit);
    assert.match(hit.auth, /^Basic /);
    assert.doesNotMatch(hit.auth, /Bearer /);
    assert.match(hit.contentType, /application\/x-www-form-urlencoded/);
    assert.match(hit.body, /grant_type=client_credentials/);
    const expected = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    assert.equal(hit.auth, `Basic ${expected}`);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("minted app token calls /v1/search; /v1/me explains user OAuth", async () => {
  const ctx = await setup(async (url) => {
    if (url.includes("accounts.spotify.com/api/token")) {
      return new Response(JSON.stringify({ access_token: ACCESS, token_type: "Bearer", expires_in: 3600 }), {
        status: 200,
      });
    }
    if (url.includes("/v1/search")) {
      return new Response(JSON.stringify({ tracks: { items: [{ name: "test" }] } }), { status: 200 });
    }
    if (url.includes("/v1/me")) {
      return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 });
    }
    return new Response("nope", { status: 404 });
  });
  try {
    const grantId = await approve(ctx);
    const me = await call(ctx, {
      item_name: "SPOTIFY_SECRET",
      method: "GET",
      path: "https://api.spotify.com/v1/me",
      client_id: CLIENT_ID,
    });
    assert.equal(me.payload.status, 401);
    assert.match(String(me.payload.hint ?? ""), /user OAuth|\/v1\/me|Client credentials/i);
    assert.equal((await ctx.kernel.store.getGrant(grantId))?.status, "active");

    const search = await call(ctx, {
      item_name: "SPOTIFY_SECRET",
      method: "GET",
      path: "https://api.spotify.com/v1/search?q=test&type=track",
      client_id: CLIENT_ID,
    });
    assert.equal(search.payload.status, 200);
    assert.doesNotMatch(JSON.stringify(search.payload), new RegExp(ACCESS));
    assert.doesNotMatch(JSON.stringify(search.payload), new RegExp(CLIENT_SECRET));
    const searchAuth = ctx.hits.find((h) => h.url.includes("/v1/search"))?.auth ?? "";
    assert.equal(searchAuth, `Bearer ${ACCESS}`);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("failed Spotify 401/410 reuses the same prompt grant", async () => {
  let tokenStatus = 401;
  const ctx = await setup(async (url) => {
    if (url.includes("/api/token")) {
      if (tokenStatus === 410) return new Response("", { status: 410 });
      if (tokenStatus === 401) return new Response("invalid", { status: 401 });
      return new Response(JSON.stringify({ access_token: ACCESS, token_type: "Bearer", expires_in: 3600 }), {
        status: 200,
      });
    }
    return new Response("nope", { status: 404 });
  });
  try {
    const grantId = await approve(ctx);
    const first = await call(ctx, {
      item_name: "SPOTIFY_SECRET",
      method: "POST",
      path: "https://accounts.spotify.com/api/token",
      client_id: CLIENT_ID,
    });
    assert.equal(first.payload.status, 401);
    assert.equal((await ctx.kernel.store.getGrant(grantId))?.status, "active");

    tokenStatus = 410;
    const gone = await call(ctx, {
      item_name: "SPOTIFY_SECRET",
      method: "POST",
      path: "https://accounts.spotify.com/api/token",
      client_id: CLIENT_ID,
    });
    assert.equal(gone.payload.status, 410);
    assert.equal(gone.payload.body, "");
    assert.match(String(gone.payload.hint), /410/);
    assert.equal((await ctx.kernel.store.getGrant(grantId))?.status, "active");

    tokenStatus = 200;
    const ok = await call(ctx, {
      item_name: "SPOTIFY_SECRET",
      method: "POST",
      path: "https://accounts.spotify.com/api/token",
      client_id: CLIENT_ID,
    });
    assert.equal(ok.payload.status, 200);
    assert.equal((await ctx.kernel.store.getGrant(grantId))?.status, "consumed");
    assert.doesNotMatch(JSON.stringify(ok.payload), new RegExp(CLIENT_SECRET));
    assert.doesNotMatch(JSON.stringify(ok.payload), new RegExp(ACCESS));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("avm-style model principal can tools/list without leaking secrets", async () => {
  const ctx = await setup(async () => new Response("{}", { status: 200 }));
  try {
    const listed = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = await listed.text();
    assert.equal(listed.status, 200);
    assert.doesNotMatch(body, new RegExp(CLIENT_SECRET));
    assert.doesNotMatch(body, /avm_/);
    assert.match(body, /http_request/);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("isolation: canary secret never appears after store grant mint or search", async () => {
  const ctx = await setup(async (url) => {
    if (url.includes("/api/token")) {
      return new Response(JSON.stringify({ access_token: ACCESS, token_type: "Bearer", expires_in: 3600 }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
  });
  try {
    await approve(ctx);
    const search = await call(ctx, {
      item_name: "SPOTIFY_SECRET",
      method: "GET",
      path: "https://api.spotify.com/v1/search?q=test&type=track",
    });
    const inbox = await (await fetch(`${ctx.base}/api/inbox`, { headers: ctx.op })).json();
    const blob = JSON.stringify({ search, inbox, hits: ctx.hits.map((h) => ({ url: h.url, type: h.contentType })) });
    assert.doesNotMatch(blob, new RegExp(CLIENT_SECRET));
    assert.doesNotMatch(blob, new RegExp(ACCESS));
    assert.doesNotMatch(blob, new RegExp(CANARY));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});
