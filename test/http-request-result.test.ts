/**
 * http_request result shape and controls (3.4): allowlisted origin_headers, origin_status with the
 * deprecated status duplicate, timeout_ms, dry_run without side effects, and the send-time refusal
 * of an unknown inject mode.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { clampTimeoutMs } from "../src/hosted/connector.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

const HOST = "api.echo.example";

function mcpText(rpc: unknown): Record<string, unknown> {
  const rec = rpc as { result?: { content?: { text?: string }[]; isError?: boolean } };
  return JSON.parse(rec.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

function isError(rpc: unknown): boolean {
  return Boolean((rpc as { result?: { isError?: boolean } }).result?.isError);
}

async function setup(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), publicUrl: "http://127.0.0.1:8788" });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  const echo = await kernel.createItem({
    orgId,
    actor: "user_owner",
    environment: "staging",
    kind: "secret",
    name: "ECHO_TOKEN",
    value: CANARY,
    allowedHosts: [HOST],
    inject: "bearer",
  });
  const { client: model } = await kernel.createModelClient({ orgId, name: "cursor", environment: "staging" });
  const hits: string[] = [];
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    fetchImpl: async (url, init) => {
      hits.push(String(url));
      return handler(String(url), init);
    },
    resolveAddresses: async () => ["8.8.8.8"],
  });
  const addr = await http.listen();
  const modelH = { "x-test-channel": "model", "x-test-client": model.id, "content-type": "application/json" };
  const call = async (args: Record<string, unknown>) => {
    const res = await fetch(`${addr.host === "127.0.0.1" ? `http://127.0.0.1:${addr.port}` : `http://${addr.host}:${addr.port}`}/mcp`, {
      method: "POST",
      headers: modelH,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "http_request", arguments: args } }),
    });
    const rpc: unknown = await res.json();
    return { rpc, payload: mcpText(rpc), isError: isError(rpc) };
  };
  const approve = async (itemName = "ECHO_TOKEN") => {
    const asked = await kernel.requestGrant({ orgId, clientId: model.id, itemName, environment: "staging" });
    await kernel.approveGrant({ orgId, grantId: asked.grant.id, policy: "prompt", role: "owner", actor: "user_owner" });
    return asked.grant.id;
  };
  const close = async () => {
    await http.close();
    await store.close();
    cleanup(home);
  };
  return { kernel, orgId, model, echoId: echo.id, hits, call, approve, close };
}

test("origin_headers carries only the allowlist; origin_status and the deprecated status agree", async () => {
  const ctx = await setup(
    async () =>
      new Response(JSON.stringify({ items: [1, 2] }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          link: `<https://${HOST}/v1/items?page=2>; rel="next"`,
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "59",
          "x-ratelimit-reset": "1760000000",
          "retry-after": "0",
          "x-request-id": "req_abc",
          "set-cookie": "sid=do-not-forward",
          "x-upstream-token": CANARY,
          server: "nginx",
        },
      }),
  );
  try {
    await ctx.approve();
    const { payload, isError } = await ctx.call({ item_name: "ECHO_TOKEN", method: "GET", path: "/v1/items" });
    assert.equal(isError, false);
    assert.equal(payload.origin_status, 200);
    assert.equal(payload.status, 200);
    assert.deepEqual(payload.origin_headers, {
      "content-type": "application/json; charset=utf-8",
      link: `<https://${HOST}/v1/items?page=2>; rel="next"`,
      "retry-after": "0",
      "x-ratelimit-limit": "60",
      "x-ratelimit-remaining": "59",
      "x-ratelimit-reset": "1760000000",
      "x-request-id": "req_abc",
    });
    assert.ok(!JSON.stringify(payload).includes(CANARY));
    assert.ok(!JSON.stringify(payload).includes("set-cookie"));
    const next = payload.next as { for_model?: string } | undefined;
    assert.match(next?.for_model ?? "", /origin_headers/);
  } finally {
    await ctx.close();
  }
});

test("timeout_ms bounds the origin wait; the failure message names the deadline and not the credential", async () => {
  const ctx = await setup(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by connector")), { once: true });
      }),
  );
  try {
    await ctx.approve();
    const started = Date.now();
    const { payload, isError } = await ctx.call({ item_name: "ECHO_TOKEN", method: "GET", path: "/slow", timeout_ms: 1000 });
    assert.equal(isError, true);
    assert.match(String(payload.error), /did not respond within 1s/);
    assert.ok(!JSON.stringify(payload).includes(CANARY));
    assert.ok(Date.now() - started < 5000, "the 10 s default did not apply");
    const bad = await ctx.call({ item_name: "ECHO_TOKEN", method: "GET", path: "/slow", timeout_ms: "soon" });
    assert.equal(bad.isError, true);
    assert.match(String(bad.payload.error), /timeout_ms must be a number/);
    assert.equal(ctx.hits.length, 1, "a rejected argument never reaches the origin");
  } finally {
    await ctx.close();
  }
  assert.equal(clampTimeoutMs(undefined), 10_000);
  assert.equal(clampTimeoutMs(1), 1000);
  assert.equal(clampTimeoutMs(60_000), 30_000);
});

test("dry_run resolves item, host, mode, provider, and grant without sending, consuming, or creating anything", async () => {
  const ctx = await setup(async () => new Response("{}", { status: 200 }));
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "client_secret",
      name: "SPOTIFY_SECRET",
      value: "spotify_client_secret_CANARY_x",
      username: "cid",
      allowedHosts: ["api.spotify.com", "accounts.spotify.com"],
      inject: "client_credentials",
    });
    const before = await ctx.call({ item_name: "ECHO_TOKEN", method: "GET", path: "/v1/items", dry_run: true });
    assert.equal(before.isError, false);
    assert.deepEqual(
      { ...before.payload, next: undefined, retry: undefined },
      {
        dry_run: true,
        item_name: "ECHO_TOKEN",
        host: HOST,
        method: "GET",
        path: "/v1/items",
        would_send: false,
        reason: "grant_required",
        grant_status: "none",
        inject_mode: "bearer",
        provider: null,
        next: undefined,
        retry: undefined,
      },
    );
    assert.match(String((before.payload.next as { for_model?: string }).for_model), /Dry run only/);

    const grantId = await ctx.approve();
    const after = await ctx.call({ host: HOST, method: "GET", path: "/v1/items", dry_run: true });
    assert.equal(after.payload.would_send, true);
    assert.equal(after.payload.reason, "ok");
    assert.equal(after.payload.grant_status, "active");
    assert.equal(after.payload.item_name, "ECHO_TOKEN");
    assert.equal((await ctx.kernel.store.getGrant(grantId))?.status, "active", "a dry run consumes nothing");

    const spotify = await ctx.call({ item_name: "spotify_secret", method: "GET", path: "https://api.spotify.com/v1/search", dry_run: true });
    assert.equal(spotify.payload.provider, "spotify");
    assert.equal(spotify.payload.inject_mode, "client_credentials");
    assert.equal(spotify.payload.reason, "grant_required");

    const mismatch = await ctx.call({ item_name: "ECHO_TOKEN", host: "api.other.example", method: "GET", path: "/", dry_run: true });
    assert.equal(mismatch.payload.reason, "host_mismatch");
    assert.equal(mismatch.payload.would_send, false);

    const missing = await ctx.call({ host: "api.nothing.example", method: "GET", path: "/", dry_run: true });
    assert.equal(missing.payload.reason, "need_item");
    assert.equal(missing.payload.item_name, null);
    assert.equal((await ctx.kernel.store.listPendingNeeds(ctx.orgId)).length, 0, "a dry run creates no need row");

    assert.equal(ctx.hits.length, 0, "the origin was never called");
    const audit = await ctx.kernel.store.listAudit(ctx.orgId, 200);
    assert.equal(audit.filter((a) => a.action.startsWith("inject")).length, 0, "no inject audit rows");
  } finally {
    await ctx.close();
  }
});

test("an item stored with an unknown mode is refused at send time as inject_unsupported and audited inject_denied", async () => {
  const ctx = await setup(async () => new Response("{}", { status: 200 }));
  try {
    // The kernel does not validate `inject` (the route does, via parseInjectMode); simulate a row
    // written before validation existed.
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "WEIRD_TOKEN",
      value: CANARY,
      allowedHosts: [HOST],
      inject: "weird",
    });
    await ctx.approve("WEIRD_TOKEN");
    const dry = await ctx.call({ item_name: "WEIRD_TOKEN", method: "GET", path: "/v1/items", dry_run: true });
    assert.equal(dry.payload.reason, "inject_unsupported");
    assert.equal(dry.payload.inject_mode, "weird");
    const { payload, isError } = await ctx.call({ item_name: "WEIRD_TOKEN", method: "GET", path: "/v1/items" });
    assert.equal(isError, true);
    assert.equal(payload.error, "inject_unsupported");
    assert.equal(ctx.hits.length, 0, "never sent as Bearer");
    const audit = await ctx.kernel.store.listAudit(ctx.orgId, 200);
    assert.equal(audit.filter((a) => a.action === "inject").length, 0);
    assert.equal(audit.filter((a) => a.action === "inject_denied" && a.itemName === "WEIRD_TOKEN").length, 1);
  } finally {
    await ctx.close();
  }
});
