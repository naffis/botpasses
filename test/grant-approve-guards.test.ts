/**
 * Approval hardening: unenforceable scope on trusted clients (G6), approval-code attempts that
 * survive a code rotation and the per-org limiter (G9), a stale standing policy replaced on
 * approve (G14), the /approve page for an MFA-pending session (G15), and folder policies that
 * only a folder grant's revoke removes (G16).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { isHttpError } from "../src/hosted/errors.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { unscopedFields } from "../src/hosted-types.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

const NOW = new Date("2026-09-04T12:00:00.000Z");

async function setup() {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "guards.sqlite"));
  let now = NOW;
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    deployPlane: "staging",
    approvalHmac: Buffer.from("cc".repeat(32), "hex"),
    now: () => now,
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  const mk = (name: string) =>
    kernel.createItem({
      orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name,
      value: CANARY,
      allowedHosts: ["api.example.com"],
      inject: "bearer",
    });
  const item = await mk("STRIPE_KEY");
  const { client: model } = await kernel.createModelClient({ orgId, name: "agent", environment: "staging" });
  const close = async () => {
    await store.close();
    cleanup(home);
  };
  return { home, store, kernel, orgId, item, model, mk, close, tick: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

async function status(fn: () => Promise<unknown>): Promise<{ status: number; message: string; payload: Record<string, unknown> }> {
  try {
    await fn();
    return { status: 200, message: "", payload: {} };
  } catch (err) {
    if (!isHttpError(err)) throw err;
    return { status: err.status, message: err.message, payload: err.extra };
  }
}

test("method, path, and host limits are refused on a trusted client's grant; max_calls and ttl stay (G6)", async () => {
  const ctx = await setup();
  try {
    const { client: trusted } = await ctx.kernel.createTrustedClient({ orgId: ctx.orgId, name: "runtime", environment: "staging" });
    const asked = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: trusted.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
      request: { host: "api.example.com", method: "GET", path: "/v1/me" },
    });
    const approve = (scope?: Record<string, unknown>) =>
      ctx.kernel.approveGrant({ orgId: ctx.orgId, grantId: asked.grant.id, policy: "session", role: "owner", actor: "user_owner", scope });

    const inherited = await status(() => approve());
    assert.equal(inherited.status, 400, "inheriting the requested call would write limits nothing enforces");
    assert.equal(inherited.payload.status, "scope_unenforceable");
    assert.match(inherited.message, /trusted runtime client/);
    assert.equal((await ctx.store.getGrant(asked.grant.id))?.status, "pending");

    const explicit = await status(() => approve({ methods: ["GET"] }));
    assert.equal(explicit.status, 400);
    assert.equal((await status(() => approve({ hosts: ["api.example.com"] }))).status, 400);
    assert.equal((await status(() => approve({ pathPrefixes: ["/v1"] }))).status, 400);

    const ok = await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "session",
      role: "owner",
      actor: "user_owner",
      scope: { maxCalls: 2, ttlSeconds: 600 },
    });
    assert.equal(ok.status, "active");
    assert.deepEqual([ok.methods, ok.pathPrefixes, ok.hosts, ok.maxCalls], [null, null, null, 2]);

    // A model client is unaffected: its calls go through the connector where scope is checked.
    const viaModel = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
      request: { host: "api.example.com", method: "GET", path: "/v1/me" },
    });
    const modelGrant = await ctx.kernel.approveGrant({ orgId: ctx.orgId, grantId: viaModel.grant.id, policy: "prompt", role: "owner", actor: "user_owner" });
    assert.deepEqual(modelGrant.methods, ["GET"]);
  } finally {
    await ctx.close();
  }
});

test("wrong-code attempts carry across a code rotation (G9)", async () => {
  const ctx = await setup();
  try {
    const first = await ctx.kernel.requestGrant({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "STRIPE_KEY", environment: "staging" });
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(() => ctx.kernel.approveByCode(ctx.orgId, "user_owner", "owner", "00000000"), /Invalid or reused code/);
    }
    const again = await ctx.kernel.requestGrant({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "STRIPE_KEY", environment: "staging" });
    assert.equal(again.grant.id, first.grant.id);
    assert.notEqual(again.code, first.code);
    assert.equal((await ctx.store.getChallengeByGrantKind(first.grant.id, "code"))?.attempts, 5, "the fresh code inherits the count");
    await assert.rejects(
      () => ctx.kernel.approveByCode(ctx.orgId, "user_owner", "owner", again.code ?? ""),
      /Invalid or reused code/,
      "five failures lock the grant's code path even after a re-request",
    );
    assert.equal((await ctx.store.getGrant(first.grant.id))?.status, "pending");
    const inbox = await ctx.kernel.approveGrant({ orgId: ctx.orgId, grantId: first.grant.id, policy: "prompt", role: "owner", actor: "user_owner" });
    assert.equal(inbox.status, "active", "the inbox still approves it");
  } finally {
    await ctx.close();
  }
});

test("approve-by-code is limited to 20 attempts per org per 15 minutes (G9)", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.requestGrant({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "STRIPE_KEY", environment: "staging" });
    for (let i = 0; i < 20; i += 1) {
      const r = await status(() => ctx.kernel.approveByCode(ctx.orgId, "user_owner", "owner", "00000000"));
      assert.equal(r.status, 409, `attempt ${i + 1}`);
    }
    const denied = await status(() => ctx.kernel.approveByCode(ctx.orgId, "user_owner", "owner", "00000000"));
    assert.equal(denied.status, 429);
    assert.match(denied.message, /20 attempts per org per 15 minutes/);
    const { orgId: other } = await ctx.kernel.createOrg("other", "user_x");
    assert.equal((await status(() => ctx.kernel.approveByCode(other, "user_x", "owner", "00000000"))).status, 409, "per org");
    ctx.tick(15 * 60 * 1000);
    assert.equal((await status(() => ctx.kernel.approveByCode(ctx.orgId, "user_owner", "owner", "00000000"))).status, 409, "window rolled");
  } finally {
    await ctx.close();
  }
});

test("approving item_standing replaces a stale policy row for the pair instead of failing on the unique index (G14)", async () => {
  const ctx = await setup();
  try {
    const asked = await ctx.kernel.requestGrant({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "STRIPE_KEY", environment: "staging" });
    const env = await ctx.kernel.envFor(ctx.orgId, "staging");
    await ctx.store.insertPolicy({
      id: "pol_stale",
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemId: ctx.item.id,
      folderId: null,
      environmentId: env.id,
      kind: "item_standing",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
      ...unscopedFields(),
    });
    const approved = await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "item_standing",
      role: "owner",
      actor: "user_owner",
      scope: { maxCalls: 5 },
    });
    assert.equal(approved.status, "active");
    const policy = await ctx.store.findItemPolicy(ctx.orgId, ctx.model.id, ctx.item.id);
    assert.ok(policy);
    assert.notEqual(policy.id, "pol_stale");
    assert.equal(policy.maxCalls, 5);
    assert.equal(policy.expiresAt, null);

    // Same for a folder-wide (environment) policy.
    await ctx.mk("OTHER_KEY");
    const second = await ctx.kernel.requestGrant({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "OTHER_KEY", environment: "staging" });
    await ctx.store.insertPolicy({
      id: "pol_stale_folder",
      orgId: ctx.orgId,
      clientId: ctx.model.id,
      itemId: null,
      folderId: null,
      environmentId: env.id,
      kind: "folder_standing",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
      ...unscopedFields(),
    });
    const folder = await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: second.grant.id,
      policy: "folder_standing",
      confirmName: "staging",
      role: "owner",
      actor: "user_owner",
    });
    assert.equal(folder.status, "active");
    const folderPolicy = await ctx.store.findFolderPolicy(ctx.orgId, ctx.model.id, null, env.id);
    assert.ok(folderPolicy);
    assert.notEqual(folderPolicy.id, "pol_stale_folder");
  } finally {
    await ctx.close();
  }
});

test("GET /approve with a session that has not passed the authenticator step redirects like a signed-out visitor (G15)", async () => {
  const ctx = await setup();
  const serve = async (principal: Record<string, unknown> | undefined) => {
    const http = createHostedServer({
      kernel: ctx.kernel,
      host: "127.0.0.1",
      port: 0,
      authResolver: async () => principal as never,
    });
    const addr = await http.listen();
    try {
      const res = await fetch(`http://${addr.host}:${addr.port}/approve?token=abc`, { redirect: "manual" });
      return { status: res.status, location: res.headers.get("location"), body: await res.text() };
    } finally {
      await http.close();
    }
  };
  try {
    const base = { channel: "operator", userId: "user_owner", orgId: ctx.orgId, role: "owner" };
    const pending = await serve({ ...base, ready: false, needs_totp: true });
    assert.equal(pending.status, 302);
    assert.equal(pending.location, "/verify-totp");
    const unenrolled = await serve({ ...base, ready: false });
    assert.equal(unenrolled.status, 302);
    assert.equal(unenrolled.location, "/enroll-totp");
    const anonymous = await serve(undefined);
    assert.equal(anonymous.location, "/sign-in");
    const ready = await serve({ ...base, ready: true });
    assert.equal(ready.status, 410, "a ready operator gets the confirm page path (here: an invalid token page)");
    assert.doesNotMatch(ready.body, /mfa_required/);
  } finally {
    await ctx.close();
  }
});

test("revoking a prompt grant leaves a folder-wide approval in place; revoking the folder grant ends it (G16)", async () => {
  const ctx = await setup();
  try {
    const env = await ctx.kernel.envFor(ctx.orgId, "staging");
    const promptAsk = await ctx.kernel.requestGrant({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "STRIPE_KEY", environment: "staging" });
    const promptGrant = await ctx.kernel.approveGrant({ orgId: ctx.orgId, grantId: promptAsk.grant.id, policy: "prompt", role: "owner", actor: "user_owner" });

    await ctx.mk("OTHER_KEY");
    const folderAsk = await ctx.kernel.requestGrant({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "OTHER_KEY", environment: "staging" });
    const folderGrant = await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: folderAsk.grant.id,
      policy: "folder_standing",
      confirmName: "staging",
      role: "owner",
      actor: "user_owner",
    });
    assert.ok(await ctx.store.findFolderPolicy(ctx.orgId, ctx.model.id, null, env.id));

    await ctx.kernel.revokeGrant(ctx.orgId, "user_owner", promptGrant.id);
    assert.ok(
      await ctx.store.findFolderPolicy(ctx.orgId, ctx.model.id, null, env.id),
      "a prompt grant's revoke is scoped to its own (client, item) pair",
    );
    await ctx.mk("THIRD_KEY");
    const third = await ctx.kernel.requestGrant({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "THIRD_KEY", environment: "staging" });
    assert.equal(third.grant.status, "active", "the folder approval still activates other items");

    await ctx.kernel.revokeGrant(ctx.orgId, "user_owner", folderGrant.id);
    assert.equal(await ctx.store.findFolderPolicy(ctx.orgId, ctx.model.id, null, env.id), undefined, "revoking the folder grant ends the folder approval");
    const fourth = await ctx.kernel.requestGrant({ orgId: ctx.orgId, clientId: ctx.model.id, itemName: "STRIPE_KEY", environment: "staging" });
    assert.equal(fourth.grant.status, "pending");
  } finally {
    await ctx.close();
  }
});
