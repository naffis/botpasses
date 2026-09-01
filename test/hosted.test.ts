import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { STAGING_ORIGIN } from "../src/brand.ts";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { hostedBootError, HOSTED_CONFIG_EXIT } from "../src/hosted/boot.ts";
import { createHostedServer, KEEPALIVE_MS } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { handleHostedMcpRpc, listHostedMcpTools } from "../src/hosted/mcp.ts";
import { assertAllowedHostname, isBlockedIp } from "../src/hosted/ssrf.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, TEST_SESSION_SECRET, cleanup, tempHome, testOidcPrivateJwk } from "./helpers.ts";

const HMAC = Buffer.from("aa".repeat(32), "hex");

async function setup() {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const emails: { to: string; subject: string; html: string }[] = [];
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    sendEmail: async (to, subject, html) => {
      emails.push({ to, subject, html });
    },
    publicUrl: "http://127.0.0.1:8788",
    approvalHmac: HMAC,
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  await kernel.addMember(orgId, "user_op", "operator");
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
  const { client: model } = await kernel.createModelClient({
    orgId,
    name: "grok",
    environment: "staging",
  });
  const trusted = await kernel.createTrustedClient({
    orgId,
    name: "runtime",
    environment: "staging",
  });
  let originHits = 0;
  let lastAuth = "";
  let lastUrl = "";
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    fetchImpl: async (url, init) => {
      originHits += 1;
      lastUrl = String(url);
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
  const opOnly = {
    "x-test-channel": "operator",
    "x-test-user": "user_op",
    "x-test-org": orgId,
    "content-type": "application/json",
  };
  const modelH = {
    "x-test-channel": "model",
    "x-test-client": model.id,
    "content-type": "application/json",
  };
  return {
    home,
    store,
    kernel,
    emails,
    orgId,
    item,
    model,
    trusted,
    http,
    base,
    op,
    opOnly,
    modelH,
    stats: () => ({ originHits, lastAuth, lastUrl }),
  };
}

function mcpToolStatus(rpc: unknown): unknown {
  const rec = rpc as { result?: { content?: { text?: string }[] } };
  const text = rec.result?.content?.[0]?.text ?? "{}";
  return (JSON.parse(text) as { status?: unknown }).status;
}

test("AC-08 unauthenticated POST /api/items is 401", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", value: "y", allowed_hosts: ["api.stripe.com"] }),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /Bearer/i);
    assert.match(res.headers.get("www-authenticate") ?? "", /realm="botpasses"/);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-14 /health has no fingerprint", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(body.product, "botpasses");
    assert.equal("fingerprint" in body, false);
    assert.ok(!JSON.stringify(body).includes("fingerprint"));
    assert.equal(res.headers.get("content-security-policy"), null);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-01 isolation across MCP REST email audit connector", async () => {
  const ctx = await setup();
  try {
    const listed = await handleHostedMcpRpc(
      {
        kernel: ctx.kernel,
        principal: {
          channel: "model",
          orgId: ctx.orgId,
          clientId: ctx.model.id,
          environment: "staging",
        },
        fetchImpl: async () => new Response("{}", { status: 200 }),
        resolveAddresses: async () => ["8.8.8.8"],
      },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_items", arguments: {} } },
    );
    const requested = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "request_grant",
          arguments: { item_name: "STRIPE_KEY", task_description: "invoice run" },
        },
      }),
    });
    const reqBody = await requested.json();
    const grants = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_grants", arguments: {} },
      }),
    });
    const connector = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "http.request",
          arguments: { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance" },
        },
      }),
    });
    const inbox = await (await fetch(`${ctx.base}/api/inbox`, { headers: ctx.op })).json();
    const audit = await (await fetch(`${ctx.base}/api/audit`, { headers: ctx.op })).json();
    const blob = JSON.stringify({
      listed,
      reqBody,
      grants: await grants.json(),
      connector: await connector.json(),
      inbox,
      audit,
      emails: ctx.emails,
    });
    assert.ok(!blob.includes(CANARY));
    assert.equal(ctx.emails.length, 0);
    const tools = listHostedMcpTools().map((t) => t.name as string);
    assert.ok(!tools.includes("revoke_grant"));
    assert.ok(!tools.includes("get_secret"));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-02 model token cannot resolve", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/runtime/resolve`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({ item_name: "STRIPE_KEY", environment: "staging" }),
    });
    const body = await res.text();
    assert.equal(res.status, 403);
    assert.ok(!body.includes(CANARY));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-03 approve-by-code then reuse is 409", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
      operatorEmail: "op@example.com",
    });
    assert.equal(asked.grant.status, "pending");
    assert.ok(asked.code);
    assert.equal(ctx.emails.length, 1);
    assert.ok(!ctx.emails[0]?.html.includes(CANARY));
    const first = await fetch(`${ctx.base}/api/grants/approve-by-code`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ code: asked.code }),
    });
    const firstBody = (await first.json()) as { grant: { status: string } };
    assert.equal(first.status, 200);
    assert.equal(firstBody.grant.status, "active");
    const second = await fetch(`${ctx.base}/api/grants/approve-by-code`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ code: asked.code }),
    });
    assert.equal(second.status, 409);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-04 folder_standing requires confirm_name", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    const bad = await fetch(`${ctx.base}/api/grants/${asked.grant.id}/approve`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ policy: "folder_standing" }),
    });
    assert.equal(bad.status, 400);
    const still = await ctx.kernel.store.getGrant(asked.grant.id);
    assert.equal(still?.status, "pending");
    const opTry = await fetch(`${ctx.base}/api/grants/${asked.grant.id}/approve`, {
      method: "POST",
      headers: ctx.opOnly,
      body: JSON.stringify({ policy: "folder_standing", confirm_name: "staging" }),
    });
    assert.equal(opTry.status, 403);
    const ok = await fetch(`${ctx.base}/api/grants/${asked.grant.id}/approve`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ policy: "folder_standing", confirm_name: "staging" }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-12 standing policy short-circuits request_grant", async () => {
  const ctx = await setup();
  try {
    const first = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: first.grant.id,
      policy: "item_standing",
      role: "owner",
      actor: "user_owner",
    });
    ctx.emails.length = 0;
    const second = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
      operatorEmail: "op@example.com",
    });
    assert.equal(second.grant.status, "active");
    assert.equal(second.code, undefined);
    assert.equal(ctx.emails.length, 0);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-05 concurrent prompt consume: one origin fetch", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "prompt",
      role: "owner",
      actor: "user_owner",
    });
    const call = () =>
      fetch(`${ctx.base}/mcp`, {
        method: "POST",
        headers: ctx.modelH,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "http.request",
            arguments: { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance" },
          },
        }),
      }).then((r) => r.json());
    const [a, b] = await Promise.all([call(), call()]);
    const texts = [JSON.stringify(a), JSON.stringify(b)];
    assert.ok(!texts.join("").includes(CANARY));
    assert.equal(ctx.stats().originHits, 1);
    const statuses = [a, b].map(mcpToolStatus);
    assert.ok(statuses.includes(200), "one call must reach the origin");
    assert.ok(statuses.includes("pending"), "the other call requests a new prompt grant");
    assert.ok(!texts.join("").includes("inject_denied"));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-06 staging token cannot read production items", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "production",
      kind: "secret",
      name: "PROD_KEY",
      value: CANARY,
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
    });
    const res = await fetch(`${ctx.base}/runtime/resolve`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.trusted.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({ item_name: "PROD_KEY", environment: "production" }),
    });
    const body = await res.text();
    assert.ok(res.status === 403 || res.status === 404);
    assert.ok(!body.includes(CANARY));
    const listed = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "list_items", arguments: { environment: "production" } },
      }),
    });
    const listedBody = await listed.text();
    assert.ok(!listedBody.includes("PROD_KEY"));
    assert.ok(!listedBody.includes(CANARY));
    const askedProd = await fetch(`${ctx.base}/api/grants/request`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({ item_name: "PROD_KEY", environment: "production" }),
    });
    assert.equal(askedProd.status, 403);
    assert.ok(!(await askedProd.text()).includes(CANARY));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-07 connector host is allowlisted; IP literal never leaves process", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "session",
      role: "owner",
      actor: "user_owner",
    });
    const res = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "http.request",
          arguments: { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance" },
        },
      }),
    });
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes(CANARY));
    assert.match(ctx.stats().lastUrl, /^https:\/\/api\.stripe\.com\//);
    assert.throws(() => assertAllowedHostname("169.254.169.254", ["169.254.169.254"]));
    assert.equal(isBlockedIp("169.254.169.254"), true);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-09 rotate updates envelope used by connector", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "session",
      role: "owner",
      actor: "user_owner",
    });
    const rotated = "sk_live_ROTATED_new_value_zzzz";
    await fetch(`${ctx.base}/api/items/${ctx.item.id}/rotate`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ value: rotated }),
    });
    await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "http.request",
          arguments: { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance" },
        },
      }),
    });
    assert.ok(ctx.stats().lastAuth.includes(rotated));
    assert.ok(!ctx.stats().lastAuth.includes(CANARY));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-13 operator revoke; MCP tools omit revoke_grant", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "session",
      role: "owner",
      actor: "user_owner",
    });
    const res = await fetch(`${ctx.base}/api/grants/${asked.grant.id}/revoke`, {
      method: "POST",
      headers: ctx.op,
    });
    const body = (await res.json()) as { grant: { status: string } };
    assert.equal(body.grant.status, "revoked");
    const tools = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const listed = JSON.stringify(await tools.json());
    assert.doesNotMatch(listed, /revoke_grant/);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-11 hosted boot refuses sqlite when VAULT_HOME is set", () => {
  const oidc = testOidcPrivateJwk();
  const err = hostedBootError({
    VAULT_MODE: "hosted",
    DATABASE_URL: "postgres://x",
    VAULT_HOME: "/tmp/vault",
    VAULT_KEK: "x",
    VAULT_PUBLIC_URL: STAGING_ORIGIN,
    VAULT_DEPLOY_PLANE: "staging",
    VAULT_SESSION_SECRET: TEST_SESSION_SECRET,
    VAULT_OIDC_PRIVATE_JWK: oidc,
  });
  assert.match(err ?? "", /VAULT_HOME/);
  assert.equal(HOSTED_CONFIG_EXIT, 78);
  assert.equal(
    hostedBootError({
      VAULT_MODE: "hosted",
      DATABASE_URL: "postgres://x",
      VAULT_KEK: "aa".repeat(32),
      VAULT_PUBLIC_URL: STAGING_ORIGIN,
      VAULT_DEPLOY_PLANE: "staging",
      VAULT_SESSION_SECRET: TEST_SESSION_SECRET,
      VAULT_OIDC_PRIVATE_JWK: oidc,
    }),
    undefined,
  );
  assert.match(
    hostedBootError({
      VAULT_MODE: "hosted",
      DATABASE_URL: "postgres://x",
      VAULT_KEK: "aa".repeat(32),
      RESEND_API_KEY: "re_test",
      VAULT_PUBLIC_URL: STAGING_ORIGIN,
      VAULT_DEPLOY_PLANE: "staging",
    }) ?? "",
    /VAULT_EMAIL_FROM/,
  );
  assert.equal(
    hostedBootError({
      VAULT_MODE: "hosted",
      DATABASE_URL: "postgres://x",
      VAULT_KEK: "aa".repeat(32),
      RESEND_API_KEY: "re_test",
      VAULT_EMAIL_FROM: "Botpasses <noreply@mail.botpasses.com>",
      VAULT_PUBLIC_URL: STAGING_ORIGIN,
      VAULT_DEPLOY_PLANE: "staging",
      VAULT_SESSION_SECRET: TEST_SESSION_SECRET,
      VAULT_OIDC_PRIVATE_JWK: oidc,
    }),
    undefined,
  );
  assert.match(
    hostedBootError({
      VAULT_MODE: "hosted",
      DATABASE_URL: "postgres://x",
      VAULT_KEK: "aa".repeat(32),
      VAULT_BOOTSTRAP_TOKEN: "short",
      VAULT_PUBLIC_URL: STAGING_ORIGIN,
      VAULT_DEPLOY_PLANE: "staging",
    }) ?? "",
    /VAULT_BOOTSTRAP_TOKEN/,
  );
  assert.match(
    hostedBootError({
      VAULT_MODE: "hosted",
      DATABASE_URL: "postgres://x",
      VAULT_KEK: "aa".repeat(32),
      VAULT_DEPLOY_PLANE: "staging",
    }) ?? "",
    /VAULT_PUBLIC_URL/,
  );
  const platformDefault = `https://botpasses-staging.${["fly", "dev"].join(".")}`;
  assert.match(
    hostedBootError({
      VAULT_MODE: "hosted",
      DATABASE_URL: "postgres://x",
      VAULT_KEK: "aa".repeat(32),
      VAULT_PUBLIC_URL: platformDefault,
      VAULT_DEPLOY_PLANE: "staging",
    }) ?? "",
    /staging\.botpasses\.com/,
  );
});

function bootEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    VAULT_MODE: "hosted",
    DATABASE_URL: "postgres://x",
    VAULT_PUBLIC_URL: STAGING_ORIGIN,
    VAULT_DEPLOY_PLANE: "staging",
    VAULT_SESSION_SECRET: TEST_SESSION_SECRET,
    VAULT_OIDC_PRIVATE_JWK: testOidcPrivateJwk(),
    ...extra,
  };
}

test("AC-02 REQUIRE_KMS refuses raw-only on a production plane", () => {
  const err = hostedBootError(
    bootEnv({
      VAULT_DEPLOY_PLANE: "production",
      VAULT_PUBLIC_URL: "https://botpasses.com",
      VAULT_KEK: "aa".repeat(32),
      VAULT_KEK_REQUIRE_KMS: "1",
    }),
  );
  assert.match(err ?? "", /VAULT_KEK_REQUIRE_KMS|VAULT_KEK_WRAPPED/);
});

test("AC-02b raw-only on a plane boots when REQUIRE_KMS is unset", () => {
  assert.equal(
    hostedBootError(
      bootEnv({
        VAULT_DEPLOY_PLANE: "production",
        VAULT_PUBLIC_URL: "https://botpasses.com",
        VAULT_KEK: "aa".repeat(32),
      }),
    ),
    undefined,
  );
});

test("AC-02c both wrapped and raw prefer wrapped and do not fail boot", () => {
  assert.equal(
    hostedBootError(
      bootEnv({
        VAULT_KEK: "aa".repeat(32),
        VAULT_KEK_WRAPPED: "d3JhcA==",
        VAULT_KMS_KEY_ID: "arn:aws:kms:us-east-1:1:key/x",
        FLY_APP_NAME: "botpasses-staging",
      }),
    ),
    undefined,
  );
});

test("AC-12 test auth mode is refused on a deploy plane", () => {
  assert.match(
    hostedBootError(
      bootEnv({
        VAULT_KEK: "aa".repeat(32),
        VAULT_AUTH_MODE: "test",
        VAULT_DEPLOY_PLANE: "production",
        VAULT_PUBLIC_URL: "https://botpasses.com",
      }),
    ) ?? "",
    /VAULT_AUTH_MODE/,
  );
});

test("login username is listable; password is not", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "login",
      name: "GMAIL",
      value: "super-secret-password",
      username: "ada@example.com",
      allowedHosts: ["gmail.googleapis.com"],
      inject: "basic",
    });
    const items = await ctx.kernel.listItems(ctx.orgId, "staging");
    const login = items.find((i) => i.name === "GMAIL");
    assert.equal(login?.username, "ada@example.com");
    assert.ok(!JSON.stringify(items).includes("super-secret-password"));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("SSE keepalive interval is 25s", async () => {
  assert.equal(KEEPALIVE_MS, 25_000);
  const ctx = await setup();
  try {
    const ac = new AbortController();
    const res = await fetch(`${ctx.base}/mcp`, {
      headers: { accept: "text/event-stream", ...ctx.modelH },
      signal: ac.signal,
    });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body?.getReader();
    const first = await reader?.read();
    const text = new TextDecoder().decode(first?.value);
    assert.match(text, /connected/);
    ac.abort();
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("session without orgId is 403", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-channel": "operator", "x-test-user": "user_owner" },
      body: JSON.stringify({ name: "X", value: "y", allowed_hosts: ["api.stripe.com"] }),
    });
    assert.equal(res.status, 403);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("empty name is 400 and duplicate name is 409", async () => {
  const ctx = await setup();
  try {
    const empty = await fetch(`${ctx.base}/api/items`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ name: "", value: "abc", allowed_hosts: ["api.stripe.com"] }),
    });
    assert.equal(empty.status, 400);
    const bad = await fetch(`${ctx.base}/api/items`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ name: "not-valid", value: "abc", allowed_hosts: ["api.stripe.com"] }),
    });
    assert.equal(bad.status, 400);
    const dup = await fetch(`${ctx.base}/api/items`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({
        name: "STRIPE_KEY",
        value: "other",
        environment: "staging",
        allowed_hosts: ["api.stripe.com"],
      }),
    });
    assert.equal(dup.status, 409);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("expired approval code is 410", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    now: () => now,
    publicUrl: "http://127.0.0.1:8788",
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  await kernel.createItem({
    orgId,
    actor: "user_owner",
    environment: "staging",
    kind: "secret",
    name: "K",
    value: "abcd",
    allowedHosts: ["api.stripe.com"],
    inject: "bearer",
  });
  const { client: model } = await kernel.createModelClient({ orgId, name: "m", environment: "staging" });
  const asked = await kernel.requestGrant({
    orgId,
    clientId: model.id,
    itemName: "K",
    environment: "staging",
  });
  now = new Date("2026-01-01T00:20:00.000Z");
  await assert.rejects(
    () => kernel.approveByCode(orgId, "user_owner", "owner", asked.code ?? ""),
    /Expired code/,
  );
  const still = await kernel.store.getGrant(asked.grant.id);
  assert.equal(still?.status, "pending");
  await store.close();
  cleanup(home);
});

test("missing Resend still returns a code and audits notify_failed", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  await kernel.createItem({
    orgId,
    actor: "user_owner",
    environment: "staging",
    kind: "secret",
    name: "K",
    value: "abcd",
    allowedHosts: ["api.stripe.com"],
    inject: "bearer",
  });
  const { client: model } = await kernel.createModelClient({ orgId, name: "m", environment: "staging" });
  const asked = await kernel.requestGrant({
    orgId,
    clientId: model.id,
    itemName: "K",
    environment: "staging",
  });
  assert.ok(asked.code);
  assert.equal(asked.notifyFailed, true);
  const audit = await kernel.store.listAudit(orgId);
  assert.ok(audit.some((a) => a.action === "notify_failed"));
  await store.close();
  cleanup(home);
});

test("prompt consume happens even when origin fetch fails", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "prompt",
      role: "owner",
      actor: "user_owner",
    });
    const http = createHostedServer({
      kernel: ctx.kernel,
      host: "127.0.0.1",
      port: 0,
      fetchImpl: async () => {
        throw new Error("timeout");
      },
      resolveAddresses: async () => ["8.8.8.8"],
    });
    const addr = await http.listen();
    const res = await fetch(`http://${addr.host}:${addr.port}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "http.request",
          arguments: { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance" },
        },
      }),
    });
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes(CANARY));
    const grant = await ctx.kernel.store.getGrant(asked.grant.id);
    assert.equal(grant?.status, "consumed");
    await http.close();
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("org delete refuses production items without confirm_name", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "production",
      kind: "secret",
      name: "PROD",
      value: "abcd",
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
    });
    const bad = await fetch(`${ctx.base}/api/orgs`, {
      method: "DELETE",
      headers: ctx.op,
      body: JSON.stringify({ confirm_name: "wrong" }),
    });
    assert.equal(bad.status, 400);
    const org = await ctx.kernel.store.getOrg(ctx.orgId);
    assert.ok(org);
    const ok = await fetch(`${ctx.base}/api/orgs`, {
      method: "DELETE",
      headers: ctx.op,
      body: JSON.stringify({ confirm_name: "acme" }),
    });
    assert.equal(ok.status, 200);
    assert.equal(await ctx.kernel.store.getOrg(ctx.orgId), undefined);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("JSON body over 128KiB is 413", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/api/items`, {
      method: "POST",
      headers: ctx.op,
      body: "x".repeat(129 * 1024),
    });
    assert.equal(res.status, 413);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("REST request_grant is rate limited at 30 per org hour", async () => {
  const ctx = await setup();
  try {
    let last = 0;
    for (let i = 0; i < 31; i += 1) {
      const res = await fetch(`${ctx.base}/api/grants/request`, {
        method: "POST",
        headers: ctx.modelH,
        body: JSON.stringify({ item_name: "STRIPE_KEY", environment: "staging" }),
      });
      last = res.status;
    }
    assert.equal(last, 429);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("CORS preflight exposes WWW-Authenticate", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/api/items`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-expose-headers") ?? "", /WWW-Authenticate/i);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("operator session JWT path can call MCP stdio-style", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_items", arguments: {} },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /STRIPE_KEY/);
    assert.ok(!body.includes(CANARY));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("unauthenticated GET /mcp is 401", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/mcp`, { headers: { accept: "text/event-stream" } });
    assert.equal(res.status, 401);
    const tools = await fetch(`${ctx.base}/mcp/tools`);
    assert.equal(tools.status, 401);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("hosted operator page is Botpasses", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/`, { headers: ctx.op });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Botpasses/);
    assert.doesNotMatch(html, /Agent Grant Vault/);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /nonce-([A-Za-z0-9_-]+)/.exec(csp)?.[1];
    assert.ok(nonce);
    assert.match(html, new RegExp(`nonce="${nonce}"`));
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.match(res.headers.get("permissions-policy") ?? "", /camera=\(\)/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("strict-transport-security"), "max-age=63072000");
    assert.doesNotMatch(res.headers.get("strict-transport-security") ?? "", /preload|includeSubDomains/);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("hosted MCP initialize name is botpasses", async () => {
  const ctx = await setup();
  try {
    const rpc = await handleHostedMcpRpc(
      {
        kernel: ctx.kernel,
        principal: {
          channel: "model",
          orgId: ctx.orgId,
          clientId: ctx.model.id,
          environment: "staging",
        },
      },
      { jsonrpc: "2.0", id: 1, method: "initialize" },
    );
    const result = rpc?.result as { serverInfo?: { name?: string }; instructions?: string };
    assert.equal(result.serverInfo?.name, "botpasses");
    assert.match(result.instructions ?? "", /Botpasses/);
    assert.match(result.instructions ?? "", /does not need to say Botpasses/);
    assert.doesNotMatch(result.instructions ?? "", /Agent grant vault/);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("CORS disallowed Origin is 403 without ACAO (AC-10)", async () => {
  const ctx = await setup();
  try {
    const evil = await fetch(`${ctx.base}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    assert.equal(evil.headers.get("x-frame-options"), "DENY");
    assert.equal(evil.headers.get("cache-control"), "no-store");
    const post = await fetch(`${ctx.base}/api/items`, {
      headers: { ...ctx.op, origin: "https://evil.example" },
    });
    assert.equal(post.status, 403);
    assert.equal(post.headers.get("access-control-allow-origin"), null);
    const ok = await fetch(`${ctx.base}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:8788" },
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://127.0.0.1:8788");
    const noOrigin = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "list_items", arguments: {} },
      }),
    });
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
    assert.match(await noOrigin.text(), /STRIPE_KEY/);
    const prod = createHostedServer({
      kernel: ctx.kernel,
      host: "127.0.0.1",
      port: 0,
      publicUrl: "https://botpasses.com",
      deployPlane: "production",
    });
    const prodAddr = await prod.listen();
    try {
      const allowed = await fetch(`http://${prodAddr.host}:${prodAddr.port}/mcp`, {
        method: "OPTIONS",
        headers: { origin: "https://botpasses.com" },
      });
      assert.equal(allowed.status, 204);
      assert.equal(allowed.headers.get("access-control-allow-origin"), "https://botpasses.com");
    } finally {
      await prod.close();
    }
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("MCP session header does not bind principals (AC-13)", async () => {
  const ctx = await setup();
  try {
    const other = await ctx.kernel.createModelClient({
      orgId: ctx.orgId,
      name: "other",
      environment: "staging",
      issueBearer: true,
    });
    const a = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { ...ctx.modelH, "mcp-session-id": "S1" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_items", arguments: {} },
      }),
    });
    assert.equal(a.status, 200);
    const b = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: {
        "x-test-channel": "model",
        "x-test-client": other.client.id,
        "content-type": "application/json",
        "mcp-session-id": "S1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_items", arguments: {} },
      }),
    });
    assert.equal(b.status, 200);
    const text = await b.text();
    assert.match(text, /STRIPE_KEY/);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("GET /runtime/resolve is not a value path (AC-17)", async () => {
  const ctx = await setup();
  try {
    const get = await fetch(`${ctx.base}/runtime/resolve`, { headers: ctx.modelH });
    assert.ok(get.status === 404 || get.status === 405);
    const modelPost = await fetch(`${ctx.base}/runtime/resolve`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({ item_name: "STRIPE_KEY", environment: "staging" }),
    });
    assert.equal(modelPost.status, 403);
    await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.trusted.client.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    const grants = await ctx.kernel.inbox(ctx.orgId);
    await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      actor: "user_owner",
      role: "owner",
      grantId: grants[0]!.id,
      policy: "prompt",
    });
    const trustedPost = await fetch(`${ctx.base}/runtime/resolve`, {
      method: "POST",
      headers: {
        "x-test-channel": "trusted",
        "x-test-client": ctx.trusted.client.id,
        "content-type": "application/json",
      },
      body: JSON.stringify({ item_name: "STRIPE_KEY", environment: "staging" }),
    });
    assert.equal(trustedPost.status, 200);
    const body = (await trustedPost.json()) as { value?: string };
    assert.equal(body.value, CANARY);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("client rotate invalidates the old secret (AC-15)", async () => {
  const ctx = await setup();
  try {
    const issued = await ctx.kernel.createModelClient({
      orgId: ctx.orgId,
      name: "rot",
      environment: "staging",
      issueBearer: true,
    });
    assert.ok(issued.plaintext);
    const before = await fetch(`${ctx.base}/mcp/tools`, {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    });
    assert.equal(before.status, 200);
    const rot = await fetch(`${ctx.base}/api/clients/${issued.client.id}/rotate`, {
      method: "POST",
      headers: ctx.op,
      body: "{}",
    });
    assert.equal(rot.status, 200);
    const out = (await rot.json()) as { token?: string; client_id?: string };
    assert.ok(out.token?.startsWith("avm_"));
    assert.notEqual(out.token, issued.plaintext);
    const after = await fetch(`${ctx.base}/mcp/tools`, {
      headers: { authorization: `Bearer ${issued.plaintext}` },
    });
    assert.equal(after.status, 401);
    const next = await fetch(`${ctx.base}/mcp/tools`, {
      headers: { authorization: `Bearer ${out.token}` },
    });
    assert.equal(next.status, 200);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AgentPass stays dark when VAULT_AGENTPASS is unset", async () => {
  const prev = process.env.VAULT_AGENTPASS;
  delete process.env.VAULT_AGENTPASS;
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/agentpass/configuration`);
    assert.notEqual(res.status, 200);
    const inbox = await fetch(`${ctx.base}/api/inbox`, { headers: ctx.op });
    const body = (await inbox.json()) as { agentpass?: unknown[] };
    assert.deepEqual(body.agentpass, []);
  } finally {
    if (prev === undefined) delete process.env.VAULT_AGENTPASS;
    else process.env.VAULT_AGENTPASS = prev;
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});
