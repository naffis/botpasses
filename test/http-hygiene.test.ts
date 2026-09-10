/**
 * Router hygiene: generic 500 with request id, malformed JSON is 400, HEAD /console, client
 * environment route, cookie MCP needs CSRF and same Origin, GET /mcp needs a principal, audit
 * truth for inject, loopback Host on a public plane, and origin failure messages (S4, S13, S14,
 * S15, S16, D9, 0.3, 3.4).
 */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { testAuthResolver, type AuthResolver, type Principal } from "../src/hosted/auth.ts";
import { createHostedServer, type HostedHttpOpts } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { OperatorIdentity, hashToken, signCsrf } from "../src/hosted/operator-identity.ts";
import { openHostedSqlite, type SqliteHostedStore } from "../src/store/sqlite-hosted.ts";
import type { VaultStore } from "../src/store/types.ts";
import { CANARY, TEST_SESSION_SECRET, cleanup, tempHome } from "./helpers.ts";

const SESSION_HASH = "c".repeat(64);

/** Header-driven cookie session for tests: `x-cookie-user` yields an operator with a sessionHash. */
function cookieResolver(orgId: string): AuthResolver {
  return async (req, kernel) => {
    const user = req.headers["x-cookie-user"];
    if (typeof user === "string") {
      const role = await kernel.requireMember(orgId, user);
      const p: Principal = { channel: "operator", userId: user, orgId, role, ready: true, sessionHash: SESSION_HASH };
      return p;
    }
    return testAuthResolver(req, kernel);
  };
}

async function setup(extra: Partial<HostedHttpOpts> & { store?: (s: SqliteHostedStore) => VaultStore; plane?: "staging" | "production" } = {}) {
  const home = tempHome();
  const sqlite = openHostedSqlite(join(home, "h.sqlite"));
  const store = extra.store ? extra.store(sqlite) : sqlite;
  const kek = parseMasterKey(generateMasterKey());
  const kernel = new HostedKernel({ store, kek, publicUrl: extra.publicUrl ?? "http://127.0.0.1:8788", deployPlane: extra.plane ?? "staging" });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  const item = await kernel.createItem({
    orgId,
    actor: "user_owner",
    environment: "staging",
    kind: "secret",
    name: "STRIPE_KEY",
    value: CANARY,
    allowedHosts: ["api.stripe.com"],
    inject: "bearer",
  });
  const { client: model } = await kernel.createModelClient({ orgId, name: "cursor", environment: "staging" });
  const identity = new OperatorIdentity({ store, sessionSecret: TEST_SESSION_SECRET, kek });
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    identity,
    secureCookies: false,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    resolveAddresses: async () => ["8.8.8.8"],
    ...extra,
    authResolver: extra.authResolver ?? cookieResolver(orgId),
  });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const op = { "x-test-channel": "operator", "x-test-user": "user_owner", "x-test-org": orgId, "content-type": "application/json" };
  const modelH = { "x-test-channel": "model", "x-test-client": model.id, "content-type": "application/json" };
  const close = async () => {
    await http.close();
    await sqlite.close();
    cleanup(home);
  };
  return { home, store: sqlite, kernel, orgId, item, model, http, base, op, modelH, close, addr };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

function toolText(rpc: unknown): Record<string, unknown> {
  const rec = rpc as { result?: { content?: { text?: string }[] } };
  return JSON.parse(rec.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

async function httpRequestRaw(ctx: Ctx, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: ctx.addr.host, port: ctx.addr.port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => {
        body += c.toString();
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("unknown errors are a generic 500 with x-request-id; driver text never reaches the client (S13)", async () => {
  const pgText = 'duplicate key value violates unique constraint "users_email" Key (email)=(ada@example.com)';
  const ctx = await setup({
    store: (s) =>
      new Proxy(s, {
        get(target, prop, receiver) {
          if (prop === "listItems") {
            return async () => {
              throw new Error(pgText);
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }),
  });
  try {
    const res = await fetch(`${ctx.base}/api/items?environment=staging`, { headers: ctx.op });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string; request_id: string };
    assert.equal(body.error, "Internal error");
    assert.match(body.request_id, /^[0-9a-f-]{36}$/);
    assert.equal(res.headers.get("x-request-id"), body.request_id);
    assert.ok(!JSON.stringify(body).includes("Key (email)"));
    assert.ok(!JSON.stringify(body).includes("users_email"));
  } finally {
    await ctx.close();
  }
});

test("malformed JSON is 400 Invalid JSON and does not echo the body (S13)", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/api/items`, { method: "POST", headers: ctx.op, body: '{"name": "X", "value": "leak-me-not' });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.match(text, /Invalid JSON/);
    assert.doesNotMatch(text, /leak-me-not/);
    assert.doesNotMatch(text, /Unexpected|position/);
  } finally {
    await ctx.close();
  }
});

test("a JSON route refuses a body that is not application/json with 415; a bodiless POST still reads as {} (B7)", async () => {
  const ctx = await setup();
  try {
    const noType = Object.fromEntries(Object.entries(ctx.op).filter(([name]) => name !== "content-type"));
    const body = JSON.stringify({ name: "X", value: CANARY, environment: "staging", allowed_hosts: ["api.stripe.com"] });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx"]) {
      const res = await fetch(`${ctx.base}/api/items`, { method: "POST", headers: { ...noType, "content-type": type }, body });
      assert.equal(res.status, 415, type);
      const text = await res.text();
      assert.match(text, /Content-Type must be application\/json/);
      assert.doesNotMatch(text, new RegExp(CANARY));
    }
    assert.equal((await ctx.store.listItems(ctx.orgId)).some((i) => i.name === "X"), false, "nothing stored");
    // fetch labels a string body text/plain when no type is given: refused the same way.
    const untyped = await fetch(`${ctx.base}/api/items`, { method: "POST", headers: noType, body });
    assert.equal(untyped.status, 415);
    // A charset parameter is fine.
    const charset = await fetch(`${ctx.base}/api/items`, {
      method: "POST",
      headers: { ...noType, "content-type": "application/json; charset=utf-8" },
      body,
    });
    assert.equal(charset.status, 200, await charset.text());
    // No body and no type (logout, revoke): the handler sees {}.
    const empty = await fetch(`${ctx.base}/api/clients/${ctx.model.id}/revoke`, { method: "POST", headers: noType });
    assert.equal(empty.status, 200, await empty.text());
    // The MCP endpoint is a JSON route too.
    const mcp = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "x-test-channel": "model", "x-test-client": ctx.model.id, "content-type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcp.status, 415);
  } finally {
    await ctx.close();
  }
});

test("HEAD /console behaves like GET (D9)", async () => {
  const ctx = await setup();
  try {
    const head = await fetch(`${ctx.base}/console`, { method: "HEAD", headers: ctx.op });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await head.text(), "");
    assert.match(head.headers.get("content-security-policy") ?? "", /nonce-/);
  } finally {
    await ctx.close();
  }
});

test("POST /api/clients/:id/environment moves a client; cross-org is 404; model is 403 (0.3)", async () => {
  const ctx = await setup({ plane: "production" });
  try {
    const res = await fetch(`${ctx.base}/api/clients/${ctx.model.id}/environment`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ environment: "production" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { client: { id: string; environment: string } };
    assert.equal(body.client.environment, "production");
    assert.equal((await ctx.store.getClient(ctx.model.id))?.environment, "production");
    const audit = await ctx.store.listAudit(ctx.orgId, 50, { action: "client_environment" });
    assert.equal(audit.length, 1);
    const { orgId: other } = await ctx.kernel.createOrg("other", "user_other");
    const cross = await fetch(`${ctx.base}/api/clients/${ctx.model.id}/environment`, {
      method: "POST",
      headers: { ...ctx.op, "x-test-user": "user_other", "x-test-org": other },
      body: JSON.stringify({ environment: "staging" }),
    });
    assert.equal(cross.status, 404);
    const asModel = await fetch(`${ctx.base}/api/clients/${ctx.model.id}/environment`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({ environment: "staging" }),
    });
    assert.equal(asModel.status, 403);
    assert.equal((await ctx.store.getClient(ctx.model.id))?.environment, "production");
  } finally {
    await ctx.close();
  }
});

test("cookie-authenticated POST /mcp requires a valid CSRF token and a same-origin Origin (S4)", async () => {
  const ctx = await setup();
  try {
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_items", arguments: {} } });
    const cookieUser = { "x-cookie-user": "user_owner", "content-type": "application/json" };
    // The CSRF token is signed for the session cookie it travels with (I7).
    const sessionToken = "session-raw-token";
    const csrf = signCsrf(TEST_SESSION_SECRET, "raw-token-value", hashToken(sessionToken));
    const jar = `bp_session=${sessionToken}; bp_csrf=${csrf}`;
    const noCsrf = await fetch(`${ctx.base}/mcp`, { method: "POST", headers: { ...cookieUser, origin: "http://127.0.0.1:8788" }, body: rpc });
    assert.equal(noCsrf.status, 403);
    const badCsrf = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { ...cookieUser, origin: "http://127.0.0.1:8788", cookie: jar, "x-csrf-token": "wrong.sig" },
      body: rpc,
    });
    assert.equal(badCsrf.status, 403);
    const otherSession = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { ...cookieUser, origin: "http://127.0.0.1:8788", cookie: `bp_session=another-session; bp_csrf=${csrf}`, "x-csrf-token": csrf },
      body: rpc,
    });
    assert.equal(otherSession.status, 403, "a token minted for one session does not verify with another session cookie");
    const crossOrigin = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { ...cookieUser, origin: "https://evil.example", cookie: jar, "x-csrf-token": csrf },
      body: rpc,
    });
    assert.equal(crossOrigin.status, 403);
    const noOrigin = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { ...cookieUser, cookie: jar, "x-csrf-token": csrf },
      body: rpc,
    });
    assert.equal(noOrigin.status, 403);
    const ok = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { ...cookieUser, origin: "http://127.0.0.1:8788", cookie: jar, "x-csrf-token": csrf },
      body: rpc,
    });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /STRIPE_KEY/);
    const bearer = await fetch(`${ctx.base}/mcp`, { method: "POST", headers: ctx.modelH, body: rpc });
    assert.equal(bearer.status, 200, "bearer principals have no cookie to ride");
  } finally {
    await ctx.close();
  }
});

test("GET /mcp needs a model or operator principal; trusted tokens are refused (S16)", async () => {
  const ctx = await setup();
  try {
    const prm =
      /resource_metadata="http:\/\/127\.0\.0\.1:8788\/\.well-known\/oauth-protected-resource\/mcp"/;
    const anon = await fetch(`${ctx.base}/mcp`, { headers: { accept: "text/event-stream" } });
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get("www-authenticate") ?? "", prm, "SSE 401 must start OAuth (BOTP-13)");
    const badGet = await fetch(`${ctx.base}/mcp`, {
      headers: { accept: "text/event-stream", authorization: "Bearer avm_not-a-real-token" },
    });
    assert.equal(badGet.status, 401);
    assert.match(badGet.headers.get("www-authenticate") ?? "", prm, "invalid bearer on GET /mcp still challenges");
    const trusted = await ctx.kernel.createTrustedClient({ orgId: ctx.orgId, name: "rt", environment: "staging" });
    const avt = await fetch(`${ctx.base}/mcp`, { headers: { accept: "text/event-stream", authorization: `Bearer ${trusted.plaintext}` } });
    assert.equal(avt.status, 403);
    const model = await fetch(`${ctx.base}/mcp`, { headers: { accept: "text/event-stream", ...ctx.modelH } });
    assert.equal(model.status, 200);
    await model.body?.cancel();
  } finally {
    await ctx.close();
  }
});

test("inject is audited after the send; host_mismatch writes inject_denied and no inject row (S14)", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.kernel.requestGrant({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "STRIPE_KEY", environment: "staging" });
    await ctx.kernel.approveGrant({ orgId: ctx.orgId, grantId: asked.grant.id, policy: "item_standing", role: "owner", actor: "user_owner" });
    const call = (args: Record<string, unknown>) =>
      fetch(`${ctx.base}/mcp`, {
        method: "POST",
        headers: ctx.modelH,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "http_request", arguments: args } }),
      }).then((r) => r.json());
    const mismatch = toolText(await call({ item_name: "STRIPE_KEY", host: "api.evil.example", method: "GET", path: "/v1/balance" }));
    assert.match(String(mismatch.error), /host_mismatch/);
    let audit = await ctx.store.listAudit(ctx.orgId);
    assert.equal(audit.filter((a) => a.action === "inject").length, 0, "nothing was sent");
    assert.equal(audit.filter((a) => a.action === "inject_denied").length, 1);
    const ok = toolText(await call({ item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance" }));
    assert.equal(ok.status, 200);
    audit = await ctx.store.listAudit(ctx.orgId);
    const injects = audit.filter((a) => a.action === "inject");
    assert.equal(injects.length, 1);
    assert.equal(injects[0]?.itemName, "STRIPE_KEY");
    assert.equal(injects[0]?.clientId, ctx.model.id);
    const snap = (await (await fetch(`${ctx.base}/api/access`, { headers: ctx.op })).json()) as { clients: { id: string; fetched: string[] }[] };
    assert.deepEqual(snap.clients.find((c) => c.id === ctx.model.id)?.fetched, ["STRIPE_KEY"]);
  } finally {
    await ctx.close();
  }
});

test("origin transport failure is inject_failed and the 502 names the cause without the secret (3.4)", async () => {
  const ctx = await setup({
    fetchImpl: async () => {
      throw Object.assign(new Error(`connect ECONNREFUSED Bearer ${CANARY}`), { code: "ECONNREFUSED" });
    },
  });
  try {
    const asked = await ctx.kernel.requestGrant({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "STRIPE_KEY", environment: "staging" });
    await ctx.kernel.approveGrant({ orgId: ctx.orgId, grantId: asked.grant.id, policy: "prompt", role: "owner", actor: "user_owner" });
    const res = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "http_request", arguments: { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance" } } }),
    });
    const rpc = (await res.json()) as { result?: { isError?: boolean } };
    assert.equal(rpc.result?.isError, true);
    const body = toolText(rpc);
    assert.match(String(body.error), /could not connect to api\.stripe\.com \(ECONNREFUSED\)/);
    assert.ok(!JSON.stringify(rpc).includes(CANARY));
    const audit = await ctx.store.listAudit(ctx.orgId);
    assert.equal(audit.filter((a) => a.action === "inject_failed").length, 1);
    assert.equal(audit.filter((a) => a.action === "inject").length, 0);
    assert.equal((await ctx.store.getGrant(asked.grant.id))?.status, "active", "prompt grant is reusable");
  } finally {
    await ctx.close();
  }
});

test("a public plane refuses loopback Host and Origin headers (S17)", async () => {
  const ctx = await setup({
    publicUrl: "https://botpasses.com",
    plane: "production",
    authResolver: async () => undefined,
  });
  try {
    const loopbackHost = await httpRequestRaw(ctx, "/api/items", { host: "localhost" });
    assert.equal(loopbackHost.status, 403);
    const realHost = await httpRequestRaw(ctx, "/api/items", { host: "botpasses.com" });
    assert.equal(realHost.status, 401, "host passes; no principal");
    const loopbackOrigin = await httpRequestRaw(ctx, "/api/items", { host: "botpasses.com", origin: "http://localhost:3000" });
    assert.equal(loopbackOrigin.status, 403);
    const health = await httpRequestRaw(ctx, "/health", { host: "localhost" });
    assert.equal(health.status, 200, "health stays reachable for the platform probe");
  } finally {
    await ctx.close();
  }
});

test("http.request is still accepted as an alias of http_request; tools/list advertises http_request only (D12)", async () => {
  const ctx = await setup();
  try {
    const listed = (await (await fetch(`${ctx.base}/mcp`, { method: "POST", headers: ctx.modelH, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json()) as {
      result: { tools: { name: string }[] };
    };
    const names = listed.result.tools.map((t) => t.name);
    assert.ok(names.includes("http_request"));
    assert.ok(!names.includes("http.request"));
    const asked = await ctx.kernel.requestGrant({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "STRIPE_KEY", environment: "staging" });
    await ctx.kernel.approveGrant({ orgId: ctx.orgId, grantId: asked.grant.id, policy: "item_standing", role: "owner", actor: "user_owner" });
    const legacy = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "http.request", arguments: { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance", environment: "production" } } }),
    });
    const body = toolText(await legacy.json());
    assert.equal(body.status, 200, "alias dispatches and the environment argument is ignored");
    const next = body.next as { tool?: string } | undefined;
    assert.equal(next?.tool, undefined);
  } finally {
    await ctx.close();
  }
});
