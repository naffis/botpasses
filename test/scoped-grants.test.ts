/**
 * Scoped approvals (plan 3.1) and the tool surface (3.5): request_grant carries host, method,
 * path; approvals narrow to the request by default or to operator limits; prepareConnector
 * enforces method, host, and path prefix; max_calls spends the grant and its policy; standing
 * policies and sessions expire on a parameter; the inbox card and Approvals row show the scope.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { describeScope, grantCard, limitsBody } from "../src/hosted/client/inbox.ts";
import { isHttpError, isInjectDenied, isScopeDenied } from "../src/hosted/errors.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { resolveApprovalScope, scopeDenialReason } from "../src/hosted/kernel-grants.ts";
import { listHostedMcpTools, publicGrant } from "../src/hosted/mcp.ts";
import { unscopedFields } from "../src/hosted-types.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

const HOSTS = ["api.stripe.com", "files.stripe.com"];

async function setup(opts: { now?: () => Date } = {}) {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: "http://127.0.0.1:8788",
    deployPlane: "staging",
    now: opts.now,
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  const item = await kernel.createItem({
    orgId,
    actor: "user_owner",
    environment: "staging",
    kind: "secret",
    name: "STRIPE_KEY",
    value: CANARY,
    allowedHosts: HOSTS,
    inject: "bearer",
  });
  const { client: model } = await kernel.createModelClient({ orgId, name: "cursor", environment: "staging" });
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    fetchImpl: async () => new Response("{}", { status: 200 }),
    resolveAddresses: async () => ["8.8.8.8"],
  });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const op = { "x-test-channel": "operator", "x-test-user": "user_owner", "x-test-org": orgId, "content-type": "application/json" };
  const modelH = { "x-test-channel": "model", "x-test-client": model.id, "content-type": "application/json" };
  const close = async () => {
    await http.close();
    await store.close();
    cleanup(home);
  };
  const prepare = (request: { host: string; method: string; path: string }) =>
    kernel.prepareConnector({ orgId, clientId: model.id, itemName: "STRIPE_KEY", environment: "staging", auditAfterSend: true, request });
  const ask = (request?: { host?: string; method?: string; path?: string }) =>
    kernel.requestGrant({ orgId, clientId: model.id, itemName: "STRIPE_KEY", environment: "staging", request });
  return { store, kernel, orgId, item, model, base, op, modelH, close, prepare, ask };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function mcp(ctx: Ctx, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${ctx.base}/mcp`, {
    method: "POST",
    headers: ctx.modelH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const rpc = (await res.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
  return { body: JSON.parse(rpc.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>, isError: Boolean(rpc.result?.isError) };
}

async function approveHttp(ctx: Ctx, grantId: string, body: Record<string, unknown>) {
  const res = await fetch(`${ctx.base}/api/grants/${grantId}/approve`, { method: "POST", headers: ctx.op, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function scopeDenied(err: unknown, reason: string): boolean {
  if (!isScopeDenied(err) || err.status !== 403 || err.message !== "scope_denied") return false;
  assert.equal(err.extra.status, "scope_denied");
  assert.equal(err.extra.reason, reason);
  assert.ok(err.extra.grant_scope, "payload carries the scope");
  assert.ok(!JSON.stringify(err.extra).includes(CANARY), "payload never carries the secret");
  return true;
}

test("scope denies per dimension (method, host, path prefix) and admits a matching call", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.ask();
    const grant = await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "item_standing",
      role: "owner",
      actor: "user_owner",
      scope: { methods: ["get"], pathPrefixes: ["/v1/balance?x=1"], hosts: ["API.stripe.com"] },
    });
    assert.deepEqual(grant.methods, ["GET"]);
    assert.deepEqual(grant.pathPrefixes, ["/v1/balance"], "query string is not part of a prefix");
    assert.deepEqual(grant.hosts, ["api.stripe.com"]);
    const ok = await ctx.prepare({ host: "api.stripe.com", method: "GET", path: "/v1/balance/history?limit=3" });
    assert.equal(ok.secret, CANARY);
    await assert.rejects(() => ctx.prepare({ host: "api.stripe.com", method: "POST", path: "/v1/balance" }), (e: unknown) => scopeDenied(e, "method"));
    await assert.rejects(() => ctx.prepare({ host: "files.stripe.com", method: "GET", path: "/v1/balance" }), (e: unknown) => scopeDenied(e, "host"));
    await assert.rejects(() => ctx.prepare({ host: "api.stripe.com", method: "GET", path: "/v1/customers" }), (e: unknown) => scopeDenied(e, "path"));
    const audit = await ctx.store.listAudit(ctx.orgId, 50, { action: "scope_denied" });
    assert.equal(audit.length, 3, "each denial is audited");
    assert.equal(audit[0]?.itemName, "STRIPE_KEY");
    const unscoped = await ctx.kernel.prepareConnector({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "STRIPE_KEY", environment: "staging", auditAfterSend: true });
    assert.equal(unscoped.grantId, grant.id, "callers without a request (trusted resolve) are not scope-checked");
  } finally {
    await ctx.close();
  }
});

test("scopeDenialReason and resolveApprovalScope are pure and exact", () => {
  const scope = { ...unscopedFields(), methods: ["GET"], pathPrefixes: ["/v1"], hosts: ["a.example"] };
  assert.equal(scopeDenialReason(scope, { host: "a.example", method: "get", path: "/v1" }), undefined);
  assert.equal(scopeDenialReason(scope, { host: "a.example", method: "GET", path: "/v1/x" }), undefined, "prefix covers deeper segments");
  assert.equal(scopeDenialReason(scope, { host: "a.example", method: "GET", path: "/v10/x" }), "path", "prefix matches on segment boundaries");
  assert.equal(scopeDenialReason(scope, { host: "a.example", method: "GET", path: "/v2" }), "path");
  assert.equal(scopeDenialReason(scope, { host: "b.example", method: "GET", path: "/v1" }), "host");
  assert.equal(scopeDenialReason(scope, { host: "a.example", method: "DELETE", path: "/v1" }), "method");
  assert.equal(scopeDenialReason(unscopedFields(), { host: "x", method: "DELETE", path: "/" }), undefined);
  const now = new Date("2026-03-01T10:00:00.000Z");
  const item = { allowedHostsJson: JSON.stringify(HOSTS) };
  const fromRequest = resolveApprovalScope({ scope: undefined, requested: { host: "api.stripe.com", method: "GET", path: "/v1/balance?limit=1" }, item, policy: "prompt", now });
  assert.deepEqual([fromRequest.methods, fromRequest.pathPrefixes, fromRequest.hosts, fromRequest.maxCalls, fromRequest.expiresAt], [["GET"], ["/v1/balance"], ["api.stripe.com"], null, null]);
  const unrestricted = resolveApprovalScope({ scope: undefined, requested: null, item, policy: "item_standing", now });
  assert.deepEqual(unrestricted, { ...unscopedFields(), expiresAt: null }, "no request and no limits is the pre-3.1 approval");
  const session = resolveApprovalScope({ scope: undefined, requested: null, item, policy: "session", now });
  assert.equal(session.expiresAt, "2026-03-01T18:00:00.000Z", "session default stays 8 hours");
  assert.throws(() => resolveApprovalScope({ scope: { hosts: ["evil.example"] }, requested: null, item, policy: "prompt", now }), (e: unknown) => isHttpError(e) && e.status === 400);
  assert.throws(() => resolveApprovalScope({ scope: { methods: [] }, requested: null, item, policy: "prompt", now }), (e: unknown) => isHttpError(e) && e.status === 400);
  assert.throws(() => resolveApprovalScope({ scope: { pathPrefixes: ["v1"] }, requested: null, item, policy: "prompt", now }), (e: unknown) => isHttpError(e) && e.status === 400);
  // An explicit scope replaces the request entirely: dimensions it leaves out are unrestricted,
  // not inherited from what the agent asked for. Operators see this as "Approve with limits".
  const explicit = resolveApprovalScope({
    scope: { maxCalls: 3, ttlSeconds: 120 },
    requested: { host: "api.stripe.com", method: "GET", path: "/v1/balance" },
    item,
    policy: "session",
    now,
  });
  assert.deepEqual([explicit.methods, explicit.pathPrefixes, explicit.hosts, explicit.maxCalls, explicit.expiresAt], [null, null, null, 3, "2026-03-01T10:02:00.000Z"]);
  const normalised = resolveApprovalScope({ scope: { methods: ["get", "Post", "GET"], pathPrefixes: ["/v1/", "/v1/items?x=1"], hosts: [" API.STRIPE.COM "] }, requested: null, item, policy: "prompt", now });
  assert.deepEqual([normalised.methods, normalised.pathPrefixes, normalised.hosts], [["GET", "POST"], ["/v1", "/v1/items"], ["api.stripe.com"]]);
  assert.throws(() => resolveApprovalScope({ scope: { ttlSeconds: 30 }, requested: null, item, policy: "session", now }), (e: unknown) => isHttpError(e) && e.status === 400, "ttl below the floor");
  assert.throws(() => resolveApprovalScope({ scope: { ttlSeconds: 86_401 }, requested: null, item, policy: "session", now }), (e: unknown) => isHttpError(e) && e.status === 400, "session ttl above one day");
  assert.throws(() => resolveApprovalScope({ scope: { maxCalls: 0 }, requested: null, item, policy: "prompt", now }), (e: unknown) => isHttpError(e) && e.status === 400);
  assert.throws(
    () => resolveApprovalScope({ scope: undefined, requested: { host: "gone.example", method: null, path: null }, item, policy: "prompt", now }),
    (e: unknown) => isHttpError(e) && e.status === 400,
    "a requested host no longer on the item is refused rather than widened",
  );
});

test("max_calls spends the grant on the last call and takes the standing policy with it", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.ask();
    const grant = await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "item_standing",
      role: "owner",
      actor: "user_owner",
      scope: { maxCalls: 2 },
    });
    assert.equal(grant.maxCalls, 2);
    const policy = await ctx.store.findItemPolicy(ctx.orgId, ctx.model.id, ctx.item.id);
    assert.equal(policy?.maxCalls, 2);
    const call = { host: "api.stripe.com", method: "GET", path: "/v1/balance" };
    const first = await ctx.prepare(call);
    assert.equal(first.grantId, grant.id);
    assert.equal((await ctx.store.getGrant(grant.id))?.callsUsed, 1);
    assert.equal((await ctx.store.findItemPolicy(ctx.orgId, ctx.model.id, ctx.item.id))?.callsUsed, 1);
    await ctx.prepare(call);
    const spent = await ctx.store.getGrant(grant.id);
    assert.equal(spent?.status, "consumed");
    assert.equal(spent?.callsUsed, 2);
    assert.ok(spent?.consumedAt);
    assert.equal(await ctx.store.findItemPolicy(ctx.orgId, ctx.model.id, ctx.item.id), undefined, "a spent quota does not renew itself");
    await assert.rejects(() => ctx.prepare(call), (e: unknown) => isInjectDenied(e) && e.status === 403 && e.message === "inject_denied");
    const again = await ctx.ask();
    assert.equal(again.grant.status, "pending", "the agent must ask again");
    assert.notEqual(again.grant.id, grant.id);
    assert.equal((await ctx.store.listAudit(ctx.orgId, 50, { action: "grant_exhausted" })).length, 1);
    assert.equal(await ctx.store.recordGrantCall(grant.id, new Date().toISOString()), false, "a consumed grant cannot be counted again");
  } finally {
    await ctx.close();
  }
});

test("MCP request_grant with host, method, path: card shows the call and one-click approve narrows to it", async () => {
  const ctx = await setup();
  try {
    const asked = await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY", host: "api.stripe.com", method: "get", path: "/v1/balance", task_description: "invoice run" });
    assert.equal(asked.body.status, "pending");
    assert.deepEqual(asked.body.requested_scope, { host: "api.stripe.com", method: "GET", path: "/v1/balance" });
    assert.equal(asked.body.grant_scope, null, "pending grants carry no limits yet");
    const inbox = await fetch(`${ctx.base}/api/inbox`, { headers: ctx.op });
    const cards = ((await inbox.json()) as { grants: Record<string, unknown>[] }).grants;
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0]?.requested_scope, { host: "api.stripe.com", method: "GET", path: "/v1/balance" });
    assert.deepEqual(cards[0]?.allowed_hosts, HOSTS);
    // A repeat ask with a different path updates what the card shows.
    await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY", host: "api.stripe.com", method: "GET", path: "/v1/charges" });
    assert.equal((await ctx.store.getGrant(String(asked.body.grant_id)))?.requestedScope?.path, "/v1/charges");
    const approved = await approveHttp(ctx, String(asked.body.grant_id), { policy: "item_standing" });
    assert.equal(approved.status, 200);
    const grant = approved.body.grant as Record<string, unknown>;
    assert.deepEqual([grant.methods, grant.pathPrefixes, grant.hosts, grant.maxCalls], [["GET"], ["/v1/charges"], ["api.stripe.com"], null]);
    const listed = await mcp(ctx, "list_grants", {});
    const row = (listed.body.grants as Record<string, unknown>[])[0];
    assert.deepEqual(row?.grant_scope, { methods: ["GET"], path_prefixes: ["/v1/charges"], hosts: ["api.stripe.com"], max_calls: null, calls_used: 0, expires_at: null });
    assert.ok(await ctx.prepare({ host: "api.stripe.com", method: "GET", path: "/v1/charges/ch_1" }));
    await assert.rejects(() => ctx.prepare({ host: "api.stripe.com", method: "DELETE", path: "/v1/charges/ch_1" }), (e: unknown) => scopeDenied(e, "method"));
    const snap = (await (await fetch(`${ctx.base}/api/access`, { headers: ctx.op })).json()) as { grants: Record<string, unknown>[] };
    assert.equal(snap.grants[0]?.policy, "item_standing");
    assert.deepEqual((snap.grants[0]?.grant_scope as Record<string, unknown>).methods, ["GET"]);
  } finally {
    await ctx.close();
  }
});

test("request_grant validates the stated call: host outside allowed_hosts and a bad method are 400", async () => {
  const ctx = await setup();
  try {
    const wrongHost = await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY", host: "evil.example", method: "GET", path: "/" });
    assert.equal(wrongHost.isError, true);
    assert.match(String(wrongHost.body.error), /host_mismatch/);
    const badMethod = await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY", method: "FETCH" });
    assert.equal(badMethod.isError, true);
    assert.match(String(badMethod.body.error), /method must be one of/);
    const badPath = await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY", path: "v1/balance" });
    assert.equal(badPath.isError, true);
    assert.equal((await ctx.store.listGrants(ctx.orgId)).length, 0, "no grant row for a rejected request");
    const rest = await fetch(`${ctx.base}/api/grants/request`, { method: "POST", headers: ctx.modelH, body: JSON.stringify({ item_name: "STRIPE_KEY", host: "files.stripe.com", method: "PUT", path: "/v1/files" }) });
    assert.equal(rest.status, 200);
    const body = (await rest.json()) as { grant: { requestedScope: unknown } };
    assert.deepEqual(body.grant.requestedScope, { host: "files.stripe.com", method: "PUT", path: "/v1/files" });
  } finally {
    await ctx.close();
  }
});

test("operator limits on approve: widened hosts and bad values are 400, a narrowed scope is stored", async () => {
  const now = new Date("2026-03-01T10:00:00.000Z");
  const ctx = await setup({ now: () => now });
  try {
    const asked = await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY", host: "api.stripe.com", method: "GET", path: "/v1/balance" });
    const id = String(asked.body.grant_id);
    for (const scope of [
      { hosts: ["api.stripe.com", "evil.example"] },
      { methods: ["FETCH"] },
      { max_calls: 0 },
      { max_calls: "ten" },
      { path_prefixes: "not-a-list" },
      { ttl_seconds: 59 },
    ]) {
      const res = await approveHttp(ctx, id, { policy: "item_standing", scope });
      assert.equal(res.status, 400, JSON.stringify(scope));
      assert.equal((await ctx.store.getGrant(id))?.status, "pending", "a rejected approve changes nothing");
    }
    const bad = await fetch(`${ctx.base}/api/grants/${id}/approve`, { method: "POST", headers: ctx.op, body: JSON.stringify({ policy: "prompt", scope: [] }) });
    assert.equal(bad.status, 400);
    const ok = await approveHttp(ctx, id, {
      policy: "item_standing",
      scope: { methods: ["GET", "POST"], path_prefixes: ["/v1"], hosts: ["files.stripe.com"], max_calls: 5, ttl_seconds: 3600 },
    });
    assert.equal(ok.status, 200);
    const grant = ok.body.grant as Record<string, unknown>;
    assert.deepEqual(grant.methods, ["GET", "POST"]);
    assert.deepEqual(grant.pathPrefixes, ["/v1"]);
    assert.deepEqual(grant.hosts, ["files.stripe.com"], "the operator's hosts replace the requested host");
    assert.equal(grant.maxCalls, 5);
    assert.equal(grant.expiresAt, "2026-03-01T11:00:00.000Z");
    const policy = await ctx.store.findItemPolicy(ctx.orgId, ctx.model.id, ctx.item.id);
    assert.deepEqual([policy?.methods, policy?.pathPrefixes, policy?.hosts, policy?.maxCalls, policy?.expiresAt], [["GET", "POST"], ["/v1"], ["files.stripe.com"], 5, "2026-03-01T11:00:00.000Z"]);
    await assert.rejects(() => ctx.prepare({ host: "api.stripe.com", method: "GET", path: "/v1/balance" }), (e: unknown) => scopeDenied(e, "host"));
    assert.ok(await ctx.prepare({ host: "files.stripe.com", method: "POST", path: "/v1/files" }));
  } finally {
    await ctx.close();
  }
});

test("item_standing with ttl_seconds expires: the grant reads expired and the policy no longer re-grants", async () => {
  let now = new Date("2026-03-01T10:00:00.000Z");
  const ctx = await setup({ now: () => now });
  try {
    const asked = await ctx.ask({ host: "api.stripe.com", method: "GET", path: "/v1/balance" });
    const grant = await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "item_standing",
      role: "owner",
      actor: "user_owner",
      scope: { ttlSeconds: 3600 },
    });
    assert.equal(grant.expiresAt, "2026-03-01T11:00:00.000Z");
    assert.equal(grant.methods, null, "an explicit scope object without dimensions is unrestricted apart from the expiry");
    now = new Date("2026-03-01T10:30:00.000Z");
    const reused = await ctx.ask();
    assert.equal(reused.grant.id, grant.id, "inside the hour the standing approval is reused");
    assert.equal(reused.grant.status, "active");
    now = new Date("2026-03-01T12:00:00.000Z");
    const later = await ctx.ask();
    assert.equal(later.grant.status, "pending", "after expiry the agent needs a fresh approval");
    assert.notEqual(later.grant.id, grant.id);
    assert.equal((await ctx.store.getGrant(grant.id))?.status, "expired");
    assert.deepEqual(await ctx.store.listPoliciesForClient(ctx.orgId, ctx.model.id), [], "the expired policy is gone");
    await assert.rejects(() => ctx.kernel.approveGrant({ orgId: ctx.orgId, grantId: later.grant.id, policy: "item_standing", role: "owner", actor: "user_owner", scope: { ttlSeconds: 365 * 86_400 + 1 } }), (e: unknown) => isHttpError(e) && e.status === 400);
  } finally {
    await ctx.close();
  }
});

test("session ttl_seconds is a parameter bounded 60..86400 with an 8 hour default", async () => {
  const now = new Date("2026-03-01T10:00:00.000Z");
  const ctx = await setup({ now: () => now });
  try {
    const first = await ctx.ask();
    for (const ttl of [59, 86_401, 0, -5, 1.5]) {
      const res = await approveHttp(ctx, first.grant.id, { policy: "session", scope: { ttl_seconds: ttl } });
      assert.equal(res.status, 400, `ttl ${ttl}`);
    }
    const hour = await approveHttp(ctx, first.grant.id, { policy: "session", scope: { ttl_seconds: 3600 } });
    assert.equal(hour.status, 200);
    assert.equal((hour.body.grant as Record<string, unknown>).expiresAt, "2026-03-01T11:00:00.000Z");
    await ctx.kernel.revokeGrant(ctx.orgId, "user_owner", first.grant.id);
    const second = await ctx.ask();
    const dflt = await approveHttp(ctx, second.grant.id, { policy: "session" });
    assert.equal(dflt.status, 200);
    assert.equal((dflt.body.grant as Record<string, unknown>).expiresAt, "2026-03-01T18:00:00.000Z");
    await ctx.kernel.revokeGrant(ctx.orgId, "user_owner", second.grant.id);
    const third = await ctx.ask();
    const max = await approveHttp(ctx, third.grant.id, { policy: "session", scope: { ttl_seconds: 86_400 } });
    assert.equal(max.status, 200);
    assert.equal((max.body.grant as Record<string, unknown>).expiresAt, "2026-03-02T10:00:00.000Z");
  } finally {
    await ctx.close();
  }
});

test("a need fulfilled under a scoped standing policy inherits the policy's limits", async () => {
  const ctx = await setup();
  try {
    const miss = await ctx.kernel.findItems({ orgId: ctx.orgId, clientId: ctx.model.id, environment: "staging", host: "api.notion.com" });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const asked = await ctx.ask();
    await ctx.kernel.approveGrant({ orgId: ctx.orgId, grantId: asked.grant.id, policy: "folder_standing", confirmName: "staging", role: "owner", actor: "user_owner", scope: { methods: ["GET"], maxCalls: 3 } });
    const done = await ctx.kernel.fulfillNeed({ orgId: ctx.orgId, actor: "user_owner", needId: miss.need_id, value: "notion-secret-value", allowedHosts: ["api.notion.com"], inject: "bearer" });
    assert.equal(done.grant_status, "active");
    const grants = await ctx.store.listGrants(ctx.orgId);
    const notion = grants.find((g) => g.policy === "folder_standing" && g.itemId !== ctx.item.id);
    assert.deepEqual([notion?.methods, notion?.maxCalls, notion?.callsUsed], [["GET"], 3, 0]);
  } finally {
    await ctx.close();
  }
});

test("publicGrant shape and tool schemas: grant_scope, requested_scope, list_items hosts, request_grant call fields", () => {
  const grant = publicGrant({
    id: "grt_1",
    orgId: "org",
    clientId: "cli",
    itemId: "itm",
    folderId: null,
    environmentId: "env",
    policy: "item_standing",
    status: "active",
    expiresAt: "2026-03-01T11:00:00.000Z",
    createdAt: "2026-03-01T10:00:00.000Z",
    approvedAt: "2026-03-01T10:01:00.000Z",
    consumedAt: null,
    taskId: null,
    taskDescription: "invoice run",
    requestedScope: { host: "api.stripe.com", method: "GET", path: "/v1/balance" },
    methods: ["GET"],
    pathPrefixes: ["/v1/balance"],
    hosts: ["api.stripe.com"],
    maxCalls: 10,
    callsUsed: 2,
  });
  assert.deepEqual(Object.keys(grant).sort(), [
    "approved_at",
    "consumed_at",
    "created_at",
    "environment_id",
    "expires_at",
    "grant_id",
    "grant_scope",
    "policy",
    "requested_scope",
    "status",
    "task_description",
    "task_id",
  ]);
  assert.deepEqual(grant.grant_scope, { methods: ["GET"], path_prefixes: ["/v1/balance"], hosts: ["api.stripe.com"], max_calls: 10, calls_used: 2, expires_at: "2026-03-01T11:00:00.000Z" });
  const tools = Object.fromEntries(listHostedMcpTools().map((t) => [t.name, t]));
  const grantProps = tools.request_grant?.inputSchema.properties ?? {};
  assert.ok(grantProps.host && grantProps.method && grantProps.path, "request_grant takes the call it is for");
  assert.deepEqual((grantProps.method as { enum: string[] }).enum, ["GET", "POST", "PUT", "PATCH", "DELETE"]);
  assert.match(tools.find_items?.description ?? "", /^Optional\./);
  assert.equal(tools.list_items?.annotations?.readOnlyHint, true);
  assert.equal(tools.list_grants?.annotations?.readOnlyHint, true);
  assert.equal(tools.find_items?.annotations?.readOnlyHint, undefined, "find_items records a need on a miss");
  assert.equal(tools.request_grant?.annotations?.readOnlyHint, undefined);
});

test("list_items includes allowed_hosts and kind", async () => {
  const ctx = await setup();
  try {
    const listed = await mcp(ctx, "list_items", {});
    const items = listed.body.items as Record<string, unknown>[];
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "secret");
    assert.deepEqual(items[0]?.allowed_hosts, HOSTS);
    assert.ok(!JSON.stringify(listed.body).includes(CANARY));
  } finally {
    await ctx.close();
  }
});

test("inbox card names the call when the agent stated one, else the credential; limits form maps to the approve body", () => {
  const now = Date.parse("2026-03-01T10:05:00.000Z");
  const base = {
    id: "grt_1",
    status: "pending",
    policy: "prompt",
    item_name: "STRIPE_KEY",
    item_last4: "10b",
    client_name: "cursor",
    task_description: "invoice run",
    created_at: "2026-03-01T10:00:00.000Z",
    approved_at: null,
    allowed_hosts: HOSTS,
  };
  const scoped = grantCard({ ...base, requested_scope: { host: "api.stripe.com", method: "GET", path: "/v1/balance?limit=3" } }, now).html;
  assert.match(scoped, /cursor wants to GET api\.stripe\.com\/v1\/balance\?limit=3/);
  assert.match(scoped, /using STRIPE_KEY ····10b/);
  assert.match(scoped, /data-limits-form="grt_1" data-host="api\.stripe\.com"/);
  assert.match(scoped, /name="path_prefix" value="\/v1\/balance"/, "the prefix field is prefilled without the query string");
  assert.match(scoped, /value="GET" checked/);
  assert.doesNotMatch(scoped, /value="DELETE" checked/, "only the requested method is pre-checked");
  assert.match(scoped, /Limited to api\.stripe\.com\./);
  const plain = grantCard({ ...base, requested_scope: null }, now).html;
  assert.match(plain, /cursor wants STRIPE_KEY/);
  assert.match(plain, /value="DELETE" checked/, "no stated method pre-checks every method");
  assert.match(plain, /Any of api\.stripe\.com, files\.stripe\.com\./);
  const approved = grantCard(
    { ...base, status: "active", approved_at: "2026-03-01T10:04:00.000Z", requested_scope: { host: "api.stripe.com", method: "GET", path: "/v1/balance" }, grant_scope: { methods: ["GET"], path_prefixes: ["/v1/balance"], hosts: ["api.stripe.com"], max_calls: 10, calls_used: 2, expires_at: "2026-03-01T18:05:00.000Z" } },
    now,
  ).html;
  assert.match(approved, /Approved: cursor can GET api\.stripe\.com\/v1\/balance using STRIPE_KEY/);
  assert.match(approved, /GET only · paths under \/v1\/balance · api\.stripe\.com · 2 of 10 calls used · expires in 8 hours/);
  assert.equal(describeScope(null), "");
  assert.equal(describeScope({ methods: null, path_prefixes: null, hosts: null, max_calls: 3, calls_used: 3, expires_at: null }), "3 of 3 calls used");
  assert.deepEqual(limitsBody({ methods: ["GET"], pathPrefix: "/v1", maxCalls: "10", duration: "3600", host: "api.stripe.com" }), {
    policy: "session",
    scope: { methods: ["GET"], path_prefixes: ["/v1"], hosts: ["api.stripe.com"], max_calls: 10, ttl_seconds: 3600 },
  });
  assert.deepEqual(limitsBody({ methods: ["GET", "POST"], pathPrefix: "", maxCalls: "", duration: "604800", host: "" }), {
    policy: "item_standing",
    scope: { methods: ["GET", "POST"], ttl_seconds: 604_800 },
  });
  assert.deepEqual(limitsBody({ methods: ["GET"], pathPrefix: "", maxCalls: "", duration: "standing", host: "" }), { policy: "item_standing", scope: { methods: ["GET"] } });
  assert.deepEqual(limitsBody({ methods: ["GET"], pathPrefix: "", maxCalls: "", duration: "once", host: "" }), { policy: "prompt", scope: { methods: ["GET"] } });
  assert.deepEqual(limitsBody({ methods: [], pathPrefix: "", maxCalls: "", duration: "once", host: "" }), { error: "Pick at least one method." });
  assert.deepEqual(limitsBody({ methods: ["GET"], pathPrefix: "v1", maxCalls: "", duration: "once", host: "" }), { error: "Path prefix must start with /." });
  assert.deepEqual(limitsBody({ methods: ["GET"], pathPrefix: "", maxCalls: "0", duration: "once", host: "" }), { error: "Max calls must be a whole number of 1 or more." });
});
