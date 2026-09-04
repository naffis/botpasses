/**
 * Grant lifecycle: one open grant per (client, item), full revoke, limiter counted once in the
 * kernel, session expiry on read, approval-code attempts, member notifications, magic-link
 * confirm page, and the operator-only approval surfaces (S3, S6, D5, D14, D15, 1.14).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { isHttpError, isInjectDenied } from "../src/hosted/errors.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

const HMAC = Buffer.from("bb".repeat(32), "hex");

async function setup(opts: { now?: () => Date; clientName?: string } = {}) {
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
    deployPlane: "staging",
    now: opts.now,
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  await kernel.addMember(orgId, "user_op", "operator");
  for (const [id, email] of [
    ["user_owner", "owner@example.com"],
    ["user_op", "op@example.com"],
  ] as const) {
    await store.insertUser({
      id,
      email,
      emailVerifiedAt: "2026-01-01T00:00:00.000Z",
      totpWrappedIv: null,
      totpWrappedCiphertext: null,
      totpWrappedTag: null,
      totpLastStep: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }
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
    name: opts.clientName ?? "cursor",
    environment: "staging",
  });
  let originHits = 0;
  const http = createHostedServer({
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
  const close = async () => {
    await http.close();
    await store.close();
    cleanup(home);
  };
  return { home, store, kernel, emails, orgId, item, model, http, base, op, modelH, close, originHits: () => originHits };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

function toolText(rpc: unknown): Record<string, unknown> {
  const rec = rpc as { result?: { content?: { text?: string }[] } };
  return JSON.parse(rec.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

function toolIsError(rpc: unknown): boolean {
  return Boolean((rpc as { result?: { isError?: boolean } }).result?.isError);
}

async function mcp(ctx: Ctx, name: string, args: Record<string, unknown>, headers = ctx.modelH) {
  const res = await fetch(`${ctx.base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return { res, rpc: await res.json() };
}

test("ten request_grant calls under a standing policy yield exactly one active grant (S6)", async () => {
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
    const ids = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const { rpc } = await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY" });
      const body = toolText(rpc);
      assert.equal(body.status, "active");
      ids.add(String(body.grant_id));
    }
    assert.deepEqual([...ids], [first.grant.id]);
    const grants = await ctx.store.listGrants(ctx.orgId);
    assert.equal(grants.filter((g) => g.status === "active").length, 1);
    assert.equal(grants.length, 1);
  } finally {
    await ctx.close();
  }
});

test("repeated request_grant reuses the pending grant with a fresh code and one email (S6, D5)", async () => {
  const ctx = await setup();
  try {
    const a = toolText((await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY" })).rpc);
    const b = toolText((await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY" })).rpc);
    assert.equal(a.grant_id, b.grant_id);
    assert.equal(a.status, "pending");
    assert.notEqual(a.approval_code, b.approval_code, "each request gets a fresh code");
    assert.equal(a.notify_failed, false);
    assert.equal(b.notify_failed, false);
    assert.equal((await ctx.store.listGrants(ctx.orgId)).length, 1);
    assert.deepEqual(ctx.emails.map((e) => e.to).sort(), ["op@example.com", "owner@example.com"]);
    const approved = await fetch(`${ctx.base}/api/grants/approve-by-code`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ code: b.approval_code }),
    });
    assert.equal(approved.status, 200, "the latest code approves");
    assert.ok(ctx.emails.every((e) => !e.html.includes(CANARY)));
  } finally {
    await ctx.close();
  }
});

test("revoke revokes every open grant for the pair and later http_request is denied (S6)", async () => {
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
    // A second active row for the same pair (legacy duplicates from before dedupe).
    await ctx.store.insertGrant({ ...first.grant, id: "grt_legacy_dup", status: "active", policy: "item_standing" });
    const revoked = await fetch(`${ctx.base}/api/grants/${first.grant.id}/revoke`, {
      method: "POST",
      headers: ctx.op,
    });
    assert.equal(revoked.status, 200);
    const grants = await ctx.store.listGrants(ctx.orgId);
    assert.ok(grants.every((g) => g.status === "revoked"), JSON.stringify(grants.map((g) => g.status)));
    assert.equal(await ctx.store.findItemPolicy(ctx.orgId, ctx.model.id, ctx.item.id), undefined);
    await assert.rejects(
      () => ctx.kernel.consumeActiveGrant(ctx.orgId, ctx.model.id, ctx.item.id),
      (err: unknown) => isInjectDenied(err) && err.status === 403 && err.message === "inject_denied",
    );
    const { rpc } = await mcp(ctx, "http_request", { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance" });
    const body = toolText(rpc);
    assert.equal(body.status, "pending", "no active grant remains, so the call asks for a new one");
    assert.equal(ctx.originHits(), 0, "nothing reached the origin");
  } finally {
    await ctx.close();
  }
});

test("http_request on an ungranted item is limited to 30 grant requests per org hour (S6)", async () => {
  const ctx = await setup();
  try {
    const grantIds = new Set<string>();
    let limited: Record<string, unknown> | undefined;
    for (let i = 0; i < 31; i += 1) {
      const { rpc } = await mcp(ctx, "http_request", { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance" });
      const body = toolText(rpc);
      if (toolIsError(rpc)) {
        limited = body;
        break;
      }
      grantIds.add(String(body.grant_id));
    }
    assert.ok(limited, "the 31st call is rate limited");
    assert.match(String(limited?.error), /rate limit/);
    assert.equal(grantIds.size, 1, "the 30 admitted calls reuse one pending grant");
    assert.equal(ctx.originHits(), 0);
    const rest = await fetch(`${ctx.base}/api/grants/request`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({ item_name: "STRIPE_KEY" }),
    });
    assert.equal(rest.status, 429, "REST shares the same counter");
  } finally {
    await ctx.close();
  }
});

test("session grant past expires_at reads as expired in list_grants and cannot inject (D15)", async () => {
  let now = new Date("2026-03-01T10:00:00.000Z");
  const ctx = await setup({ now: () => now });
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
    now = new Date("2026-03-01T19:00:00.000Z");
    const listed = toolText((await mcp(ctx, "list_grants", {})).rpc) as { grants: { grant_id: string; status: string }[] };
    const row = listed.grants.find((g) => g.grant_id === asked.grant.id);
    assert.equal(row?.status, "expired");
    assert.equal((await ctx.store.getGrant(asked.grant.id))?.status, "expired");
    const { rpc } = await mcp(ctx, "http_request", { item_name: "STRIPE_KEY", method: "GET", path: "/v1/balance" });
    assert.equal(toolText(rpc).status, "pending");
    assert.equal(ctx.originHits(), 0);
  } finally {
    await ctx.close();
  }
});

test("a wrong approval code charges only the newest pending challenge (D14)", async () => {
  const ctx = await setup();
  try {
    const older = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    const { client: other } = await ctx.kernel.createModelClient({ orgId: ctx.orgId, name: "claude", environment: "staging" });
    const newer = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: other.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(() => ctx.kernel.approveByCode(ctx.orgId, "user_owner", "owner", "00000000"), /Invalid or reused code/);
    }
    const olderCh = await ctx.store.getChallengeByGrantKind(older.grant.id, "code");
    const newerCh = await ctx.store.getChallengeByGrantKind(newer.grant.id, "code");
    assert.equal(olderCh?.attempts, 0);
    assert.equal(newerCh?.attempts, 5);
    const ok = await ctx.kernel.approveByCode(ctx.orgId, "user_owner", "owner", older.code ?? "");
    assert.equal(ok.status, "active");
    await assert.rejects(
      () => ctx.kernel.approveByCode(ctx.orgId, "user_owner", "owner", newer.code ?? ""),
      /Invalid or reused code/,
      "five failures lock the newest challenge only",
    );
  } finally {
    await ctx.close();
  }
});

test("model operator_email is ignored; operator operator_email must be a member (S3)", async () => {
  const ctx = await setup();
  try {
    const viaModel = await fetch(`${ctx.base}/api/grants/request`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({ item_name: "STRIPE_KEY", operator_email: "attacker@evil.example" }),
    });
    assert.equal(viaModel.status, 200);
    assert.ok(!ctx.emails.some((e) => e.to === "attacker@evil.example"));
    assert.deepEqual(ctx.emails.map((e) => e.to).sort(), ["op@example.com", "owner@example.com"]);
    ctx.emails.length = 0;
    const outsider = await fetch(`${ctx.base}/api/grants/request`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ item_name: "STRIPE_KEY", client_id: ctx.model.id, operator_email: "nobody@example.com" }),
    });
    assert.equal(outsider.status, 400);
    assert.equal(ctx.emails.length, 0);
    // The pending grant's link is still fresh, so a member-addressed retry does not re-send.
    const member = await fetch(`${ctx.base}/api/grants/request`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ item_name: "STRIPE_KEY", client_id: ctx.model.id, operator_email: "OP@example.com" }),
    });
    assert.equal(member.status, 200);
  } finally {
    await ctx.close();
  }
});

test("client and item names are escaped in the approval email (S3)", async () => {
  const ctx = await setup({ clientName: `<script>alert("x")</script>` });
  try {
    await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY" });
    assert.ok(ctx.emails.length > 0);
    for (const mail of ctx.emails) {
      assert.doesNotMatch(mail.html, /<script>/);
      assert.match(mail.html, /&lt;script&gt;/);
      assert.match(mail.html, /STRIPE_KEY/);
      assert.ok(!mail.html.includes(CANARY));
    }
  } finally {
    await ctx.close();
  }
});

test("GET /approve renders a confirm page without approving; POST with the token approves (S3)", async () => {
  const ctx = await setup();
  try {
    const asked = toolText((await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY", task_description: "invoice run" })).rpc);
    const link = /href="([^"]+\/approve\?token=[^"]+)"/.exec(ctx.emails[0]?.html ?? "")?.[1];
    assert.ok(link, "email carries a magic link");
    const url = new URL(link.replace(/&amp;/g, "&"));
    const page = await fetch(`${ctx.base}${url.pathname}${url.search}`, { headers: ctx.op });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /cursor/);
    assert.match(html, /STRIPE_KEY/);
    assert.match(html, new RegExp(CANARY.slice(-4)));
    assert.match(html, /prompt/);
    assert.match(html, /invoice run/);
    assert.match(html, /<form method="post" action="\/approve">/);
    assert.ok(!html.includes(CANARY));
    assert.equal((await ctx.store.getGrant(String(asked.grant_id)))?.status, "pending", "GET changes nothing");
    const token = url.searchParams.get("token") ?? "";
    const noToken = await fetch(`${ctx.base}/approve`, {
      method: "POST",
      headers: { ...ctx.op, "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ token: "bogus.sig" }).toString(),
    });
    assert.equal(noToken.status, 410);
    assert.equal((await ctx.store.getGrant(String(asked.grant_id)))?.status, "pending");
    const posted = await fetch(`${ctx.base}/approve`, {
      method: "POST",
      headers: { ...ctx.op, "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ token }).toString(),
    });
    assert.equal(posted.status, 200);
    assert.match(await posted.text(), /approved/i);
    assert.equal((await ctx.store.getGrant(String(asked.grant_id)))?.status, "active");
    const again = await fetch(`${ctx.base}/approve`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ token }),
    });
    assert.equal(again.status, 410, "a used link is dead");
  } finally {
    await ctx.close();
  }
});

test("model bearer cannot approve: approve-by-code, /approve, /api/grants/:id/approve are 403 (1.14)", async () => {
  const ctx = await setup();
  try {
    const asked = toolText((await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY" })).rpc);
    const link = /href="([^"]+\/approve\?token=[^"]+)"/.exec(ctx.emails[0]?.html ?? "")?.[1] ?? "";
    const token = new URL(link.replace(/&amp;/g, "&")).searchParams.get("token") ?? "";
    const attempts = [
      fetch(`${ctx.base}/api/grants/approve-by-code`, { method: "POST", headers: ctx.modelH, body: JSON.stringify({ code: asked.approval_code }) }),
      fetch(`${ctx.base}/approve?token=${encodeURIComponent(token)}`, { headers: ctx.modelH }),
      fetch(`${ctx.base}/approve`, { method: "POST", headers: ctx.modelH, body: JSON.stringify({ token }) }),
      fetch(`${ctx.base}/api/grants/${String(asked.grant_id)}/approve`, { method: "POST", headers: ctx.modelH, body: JSON.stringify({ policy: "prompt" }) }),
    ];
    for (const res of await Promise.all(attempts)) {
      assert.equal(res.status, 403);
    }
    assert.equal((await ctx.store.getGrant(String(asked.grant_id)))?.status, "pending");
  } finally {
    await ctx.close();
  }
});

test("ensureModelClient reactivates a revoked OAuth client on re-consent instead of duplicating the unique pair (S15)", async () => {
  const ctx = await setup();
  try {
    const first = await ctx.kernel.ensureModelClient({
      orgId: ctx.orgId,
      name: "dcr",
      environment: "staging",
      clerkOauthUserId: "dcr_shared",
    });
    await ctx.kernel.revokeClient(ctx.orgId, "user_owner", first.id);
    const second = await ctx.kernel.ensureModelClient({
      orgId: ctx.orgId,
      name: "dcr",
      environment: "staging",
      clerkOauthUserId: "dcr_shared",
    });
    assert.equal(second.id, first.id);
    assert.equal(second.revokedAt, null);
  } finally {
    await ctx.close();
  }
});

test("revokeSession needs a 12+ char id and owner role for another member's session (S15)", async () => {
  const ctx = await setup();
  try {
    const ownerHash = "a".repeat(64);
    const opHash = "b".repeat(64);
    const opOther = "b".repeat(63) + "c";
    const at = new Date().toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    for (const [idHash, userId] of [[ownerHash, "user_owner"], [opHash, "user_op"], [opOther, "user_op"]] as const) {
      await ctx.store.insertSession({ idHash, userId, createdAt: at, lastSeenAt: at, expiresAt: later, mfaAt: at });
    }
    const asOp = { userId: "user_op", role: "operator" as const, sessionHash: opHash };
    const asOwner = { userId: "user_owner", role: "owner" as const, sessionHash: ownerHash };
    await assert.rejects(() => ctx.kernel.revokeSession(ctx.orgId, asOp, "a"), (e: unknown) => isHttpError(e) && e.status === 400);
    await assert.rejects(() => ctx.kernel.revokeSession(ctx.orgId, asOp, ownerHash.slice(0, 12)), (e: unknown) => isHttpError(e) && e.status === 403);
    await assert.rejects(() => ctx.kernel.revokeSession(ctx.orgId, asOp, opHash), (e: unknown) => isHttpError(e) && e.message === "cannot_revoke_current");
    await assert.rejects(() => ctx.kernel.revokeSession(ctx.orgId, asOwner, opHash.slice(0, 12)), (e: unknown) => isHttpError(e) && e.status === 404, "ambiguous prefix is not a match");
    await ctx.kernel.revokeSession(ctx.orgId, asOp, opOther);
    assert.equal(await ctx.store.getSession(opOther), undefined);
    await ctx.kernel.revokeSession(ctx.orgId, asOwner, opHash.slice(0, 12));
    assert.equal(await ctx.store.getSession(opHash), undefined);
    assert.ok(await ctx.store.getSession(ownerHash));
  } finally {
    await ctx.close();
  }
});

test("deleteOrg also removes access_events, rate_hits, and the members' oidc payloads (S15)", async () => {
  const ctx = await setup();
  try {
    await mcp(ctx, "request_grant", { item_name: "STRIPE_KEY" });
    await ctx.kernel.recordAccessEvent({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      actorUserId: null,
      kind: "machine",
      jtiHash: "jti_x",
      issuedAt: new Date().toISOString(),
      expiresAt: null,
    });
    await ctx.store.upsertOidcPayload({
      id: "sess_owner",
      kind: "Session",
      payload: JSON.stringify({ accountId: "user_owner", uid: "u1" }),
      expiresAt: null,
    });
    await ctx.store.upsertOidcPayload({
      id: "sess_other",
      kind: "Session",
      payload: JSON.stringify({ accountId: "user_elsewhere", uid: "u2" }),
      expiresAt: null,
    });
    const start = new Date();
    start.setUTCMinutes(0, 0, 0);
    assert.ok((await ctx.store.countRateHits(ctx.orgId, "grant", start.toISOString())) > 0);
    await ctx.kernel.deleteOrg(ctx.orgId, "user_owner", "owner", "acme");
    assert.equal((await ctx.store.listAccessEvents(ctx.orgId)).length, 0);
    assert.equal(await ctx.store.countRateHits(ctx.orgId, "grant", start.toISOString()), 0);
    assert.equal(await ctx.store.getOidcPayload("sess_owner", "Session"), undefined);
    assert.ok(await ctx.store.getOidcPayload("sess_other", "Session"), "other accounts' payloads survive");
  } finally {
    await ctx.close();
  }
});
