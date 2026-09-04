/**
 * Plan 1.10: the same kernel and store scenarios against every backend. SQLite always
 * runs; Postgres runs when DATABASE_URL is set (`npm run test:pg`). A behaviour that
 * only one store implements shows up here as a failure on the other.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import type { AccessEventRecord, UserRecord } from "../src/hosted-types.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { PostgresStore } from "../src/store/postgres.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import type { OperatorSessionRow, VaultStore } from "../src/store/types.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

type Backend = { name: string; open: () => Promise<{ store: VaultStore; done: () => Promise<void> }> };

const backends: Backend[] = [
  {
    name: "sqlite",
    open: async () => {
      const home = tempHome();
      const store = openHostedSqlite(join(home, "parity.sqlite"));
      return {
        store,
        done: async () => {
          await store.close();
          cleanup(home);
        },
      };
    },
  },
];
if (process.env.DATABASE_URL) {
  const url = process.env.DATABASE_URL;
  backends.push({
    name: "postgres",
    open: async () => {
      const store = await PostgresStore.open(url);
      return { store, done: () => store.close() };
    },
  });
}

/** Unique ids per run so a shared Postgres database never collides between runs. */
function ids(prefix: string): (name: string) => string {
  const run = randomUUID().slice(0, 8);
  return (name: string) => `${prefix}_${run}_${name}`;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function user(id: string, email: string): UserRecord {
  return {
    id,
    email,
    emailVerifiedAt: "2026-01-01T00:00:00.000Z",
    totpWrappedIv: null,
    totpWrappedCiphertext: null,
    totpWrappedTag: null,
    totpLastStep: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function session(idHash: string, userId: string, mfaAt: string | null, expiresAt = "2099-01-01T00:00:00.000Z"): OperatorSessionRow {
  return {
    idHash,
    userId,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    expiresAt,
    mfaAt,
    activeOrgId: null,
  };
}

for (const backend of backends) {
  test(`[${backend.name}] items: create, rename, list on plane, delete, plan count`, async () => {
    const { store, done } = await backend.open();
    try {
      const id = ids("it");
      const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()) });
      const { orgId } = await kernel.createOrg(id("org"), id("owner"));
      const created = await kernel.createItem({
        orgId,
        actor: id("owner"),
        environment: "staging",
        kind: "secret",
        name: "PARITY_KEY",
        value: CANARY,
        allowedHosts: ["api.example.com"],
        inject: "bearer",
      });
      assert.equal(created.last4, CANARY.slice(-4));
      assert.equal(await store.countItemsForOrg(orgId), 1);
      assert.equal(await store.countProductionItems(orgId), 0);

      await kernel.updateItem({
        orgId,
        actor: id("owner"),
        itemId: created.id,
        name: "PARITY_KEY_2",
        allowedHosts: ["api.example.com", "api2.example.com"],
        inject: "header:X-Api-Key",
      });
      const listed = await kernel.listItems(orgId, "staging");
      assert.deepEqual(
        listed.map((i) => [i.name, i.inject, i.allowedHosts]),
        [["PARITY_KEY_2", "header:X-Api-Key", ["api.example.com", "api2.example.com"]]],
      );
      const decrypted = await kernel.decryptItem(orgId, created.id);
      assert.equal(decrypted.secret, CANARY);

      await kernel.deleteItem(orgId, id("owner"), created.id);
      assert.deepEqual(await kernel.listItems(orgId, "staging"), []);
      assert.equal(await store.countItemsForOrg(orgId), 0);
      const audit = await store.listAudit(orgId, 10);
      assert.deepEqual(
        audit.map((a) => a.action).sort(),
        ["delete", "store", "store"],
      );
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] grants: scoped approve, quota spends the row, dedupe, revoke`, async () => {
    const { store, done } = await backend.open();
    try {
      const id = ids("gr");
      const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()) });
      const owner = id("owner");
      const { orgId } = await kernel.createOrg(id("org"), owner);
      const item = await kernel.createItem({
        orgId,
        actor: owner,
        environment: "staging",
        kind: "secret",
        name: "SCOPED",
        value: CANARY,
        allowedHosts: ["api.example.com"],
        inject: "bearer",
      });
      const { client } = await kernel.createModelClient({ orgId, name: "agent", environment: "staging" });
      const asked = await kernel.requestGrant({
        orgId,
        clientId: client.id,
        itemName: "SCOPED",
        environment: "staging",
        request: { host: "api.example.com", method: "GET", path: "/v1/me" },
      });
      assert.equal(asked.grant.status, "pending");
      assert.deepEqual(asked.grant.requestedScope, { host: "api.example.com", method: "GET", path: "/v1/me" });

      // A second ask for the same (client, item) returns the pending row rather than a duplicate.
      const again = await kernel.requestGrant({ orgId, clientId: client.id, itemName: "SCOPED", environment: "staging" });
      assert.equal(again.grant.id, asked.grant.id);
      assert.equal((await store.listPendingGrants(orgId)).length, 1);

      const approved = await kernel.approveGrant({
        orgId,
        grantId: asked.grant.id,
        policy: "session",
        role: "owner",
        actor: owner,
        scope: { methods: ["GET"], pathPrefixes: ["/v1"], maxCalls: 2, ttlSeconds: 600 },
      });
      assert.equal(approved.status, "active");
      assert.deepEqual([approved.methods, approved.pathPrefixes, approved.maxCalls, approved.callsUsed], [["GET"], ["/v1"], 2, 0]);
      assert.ok(approved.expiresAt);

      assert.equal(await store.recordGrantCall(approved.id, "2026-01-01T00:00:01.000Z"), true);
      assert.equal(await store.recordGrantCall(approved.id, "2026-01-01T00:00:02.000Z"), true);
      const spent = await store.getGrant(approved.id);
      assert.equal(spent?.status, "consumed");
      assert.equal(spent?.callsUsed, 2);
      assert.equal(await store.recordGrantCall(approved.id, "2026-01-01T00:00:03.000Z"), false);

      // A fresh pending grant can be revoked; the item still exists.
      const second = await kernel.requestGrant({ orgId, clientId: client.id, itemName: "SCOPED", environment: "staging" });
      assert.notEqual(second.grant.id, asked.grant.id);
      const revoked = await kernel.revokeGrant(orgId, owner, second.grant.id);
      assert.equal(revoked.status, "revoked");
      assert.ok(await store.getItem(item.id));
      assert.deepEqual((await store.listGrants(orgId)).map((g) => g.status).sort(), ["consumed", "revoked"]);
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] clients: revoke, reactivate, tenant lookup, last-seen`, async () => {
    const { store, done } = await backend.open();
    try {
      const id = ids("cl");
      const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()) });
      const owner = id("owner");
      const { orgId } = await kernel.createOrg(id("org"), owner);
      const { client, plaintext } = await kernel.createModelClient({ orgId, name: "m", environment: "staging", issueBearer: true });
      assert.ok(plaintext);
      assert.ok(plaintext.startsWith("avm_"));
      const found = await kernel.lookupTrustedToken(plaintext);
      assert.equal(found?.id, client.id);
      const byHash = await store.findClientByHashedSecret(found?.hashedSecret ?? "");
      assert.equal(byHash?.id, client.id);
      assert.equal(byHash?.orgId, orgId);

      await store.setClientRevoked(client.id, "2026-01-01T00:00:00.000Z");
      assert.equal((await store.getClient(client.id))?.revokedAt, "2026-01-01T00:00:00.000Z");
      await store.setClientRevoked(client.id, null);
      assert.equal((await store.getClient(client.id))?.revokedAt, null);

      await store.touchClientLastSeen(client.id, "2026-02-01T00:00:00.000Z");
      await store.setClientLastTokenAt(client.id, "2026-02-02T00:00:00.000Z");
      const touched = await store.getClient(client.id);
      assert.equal(touched?.lastSeenAt, "2026-02-01T00:00:00.000Z");
      assert.equal(touched?.lastTokenAt, "2026-02-02T00:00:00.000Z");

      const oauth = await kernel.ensureModelClient({ orgId, clerkOauthUserId: id("dcr"), name: "oauth-agent", environment: "staging" });
      assert.equal((await store.findClientByOrgAndOauthId(orgId, id("dcr")))?.id, oauth.id);
      await store.setClientRevoked(oauth.id, "2026-01-01T00:00:00.000Z");
      await assert.rejects(kernel.ensureModelClient({ orgId, clerkOauthUserId: id("dcr"), name: "oauth-agent", environment: "staging" }));
      const revived = await kernel.ensureModelClient({ orgId, clerkOauthUserId: id("dcr"), name: "oauth-agent", environment: "staging", reactivateRevoked: true });
      assert.equal(revived.id, oauth.id);
      assert.equal(revived.revokedAt, null);
      assert.equal(await store.findClientByOrgAndOauthId(id("other-org"), id("dcr")), undefined);
      await store.setClientConsentedBy(oauth.id, owner);
      await store.setClientConsentedBy(oauth.id, id("someone-else"));
      assert.equal((await store.getClient(oauth.id))?.consentedByUserId, owner);
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] sessions and backup codes: pending, ready, touch, delete others, active org`, async () => {
    const { store, done } = await backend.open();
    try {
      const id = ids("se");
      const userId = id("user");
      await store.insertUser(user(userId, `${id("u")}@example.com`));
      await store.insertSession(session(sha(id("pending")), userId, null));
      await store.insertSession(session(sha(id("ready")), userId, "2026-01-01T00:00:00.000Z"));
      await store.insertSession(session(sha(id("other")), userId, "2026-01-01T00:00:00.000Z"));
      await store.insertSession(session(sha(id("stale")), userId, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"));

      await store.deletePendingSessions(userId, sha(id("nothing")));
      assert.equal(await store.getSession(sha(id("pending"))), undefined);
      assert.ok(await store.getSession(sha(id("ready"))));

      await store.touchSession(sha(id("ready")), "2026-03-01T00:00:00.000Z", "2026-03-02T00:00:00.000Z");
      const touched = await store.getSession(sha(id("ready")));
      assert.equal(touched?.lastSeenAt, "2026-03-01T00:00:00.000Z");
      assert.equal(touched?.expiresAt, "2026-03-02T00:00:00.000Z");

      await store.setSessionActiveOrg(sha(id("ready")), id("org"));
      assert.equal((await store.getSession(sha(id("ready"))))?.activeOrgId, id("org"));
      await store.setSessionActiveOrg(sha(id("ready")), null);
      assert.equal((await store.getSession(sha(id("ready"))))?.activeOrgId, null);

      const swept = await store.sweepExpired("2026-01-03T00:00:00.000Z");
      assert.equal(await store.getSession(sha(id("stale"))), undefined);
      assert.ok(swept.operatorSessions >= 1);

      await store.deleteOtherSessions(userId, sha(id("ready")));
      assert.equal(await store.getSession(sha(id("other"))), undefined);
      assert.ok(await store.getSession(sha(id("ready"))));

      await store.insertBackupCode(userId, sha(id("code-a")));
      await store.insertBackupCode(userId, sha(id("code-b")));
      await store.markBackupUsed(userId, sha(id("code-a")), "2026-01-01T00:00:00.000Z");
      const codes = await store.listBackupCodes(userId);
      assert.deepEqual(codes.map((c) => c.usedAt !== null).sort(), [false, true]);
      await store.deleteUnusedBackupCodes(userId);
      assert.deepEqual((await store.listBackupCodes(userId)).map((c) => c.usedAt !== null), [true]);

      await store.updateUserSecurity(userId, {
        totpFailures: 3,
        totpLockedUntil: "2026-01-01T00:15:00.000Z",
        totpPendingWrappedIv: null,
        totpPendingWrappedCiphertext: null,
        totpPendingWrappedTag: null,
        totpPendingAt: null,
      });
      const row = await store.getUser(userId);
      assert.equal(row?.totpFailures, 3);
      assert.equal(row?.totpLockedUntil, "2026-01-01T00:15:00.000Z");
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] access events: jti lookup, revoke one, revoke per client`, async () => {
    const { store, done } = await backend.open();
    try {
      const id = ids("ae");
      const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()) });
      const { orgId } = await kernel.createOrg(id("org"), id("owner"));
      const { client } = await kernel.createModelClient({ orgId, name: "m", environment: "staging" });
      const event = (n: string, clientId: string | null): AccessEventRecord => ({
        id: id(n),
        orgId,
        clientId,
        actorUserId: null,
        kind: "oauth_access",
        jtiHash: sha(id(n)),
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:10:00.000Z",
        revokedAt: null,
      });
      await store.insertAccessEvent(event("a", client.id));
      await store.insertAccessEvent(event("b", client.id));
      await store.insertAccessEvent(event("c", null));

      await store.revokeAccessEvent(sha(id("a")), "2026-01-01T00:01:00.000Z");
      assert.equal((await store.getAccessEventByJti(sha(id("a"))))?.revokedAt, "2026-01-01T00:01:00.000Z");
      assert.equal((await store.getAccessEventByJti(sha(id("b"))))?.revokedAt, null);

      await store.revokeAccessEventsForClient(client.id, "2026-01-01T00:02:00.000Z");
      assert.equal((await store.getAccessEventByJti(sha(id("b"))))?.revokedAt, "2026-01-01T00:02:00.000Z");
      assert.equal((await store.getAccessEventByJti(sha(id("c"))))?.revokedAt, null);
      assert.equal((await store.listAccessEvents(orgId, 10)).length, 3);
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] team: invite, list, accept, role change, remove`, async () => {
    const { store, done } = await backend.open();
    try {
      const id = ids("tm");
      const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), publicUrl: "http://127.0.0.1:8788" });
      const owner = id("owner");
      const invitee = id("invitee");
      const inviteeEmail = `${id("inv")}@example.com`;
      await store.insertUser(user(owner, `${id("own")}@example.com`));
      await store.insertUser(user(invitee, inviteeEmail));
      const { orgId } = await kernel.createOrg(id("org"), owner);

      const invited = await kernel.inviteMember({ orgId, actorUserId: owner, actorRole: "owner", email: inviteeEmail, role: "operator" });
      const token = new URL(invited.accept_url).searchParams.get("token") ?? "";
      assert.ok(token);
      assert.equal((await store.listInvites(orgId)).length, 1);
      await assert.rejects(
        kernel.inviteMember({ orgId, actorUserId: owner, actorRole: "owner", email: inviteeEmail, role: "operator" }),
        /already pending/,
      );

      const preview = await kernel.previewInvite(token);
      assert.equal(preview.role, "operator");
      const accepted = await kernel.acceptInvite({ userId: invitee, email: inviteeEmail, token });
      assert.equal(accepted.org_id, orgId);
      assert.equal((await store.getMember(orgId, invitee))?.role, "operator");
      assert.deepEqual(await store.listInvites(orgId), []);
      assert.deepEqual((await store.listMemberEmails(orgId)).sort(), [`${id("own")}@example.com`, inviteeEmail].sort());

      await kernel.updateMemberRole({ orgId, actorUserId: owner, actorRole: "owner", userId: invitee, role: "owner" });
      assert.equal((await store.getMember(orgId, invitee))?.role, "owner");
      const memberships = await store.listMembershipsForUser(invitee);
      assert.deepEqual(memberships.map((m) => m.orgId), [orgId]);

      await kernel.removeMember({ orgId, actorUserId: owner, actorRole: "owner", userId: invitee });
      assert.equal(await store.getMember(orgId, invitee), undefined);
      assert.deepEqual((await store.listMembers(orgId)).map((m) => m.userId), [owner]);
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] needs and rate hits: pending dedupe, cancel, sweep, budget count`, async () => {
    const { store, done } = await backend.open();
    try {
      const id = ids("nd");
      const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()) });
      const { orgId } = await kernel.createOrg(id("org"), id("owner"));
      const { client } = await kernel.createModelClient({ orgId, name: "m", environment: "staging" });
      const env = await kernel.envFor(orgId, "staging");
      const need = await store.insertPendingNeed({
        id: id("need"),
        orgId,
        clientId: client.id,
        environmentId: env.id,
        suggestedName: "NEW_KEY",
        host: "api.example.com",
        taskDescription: "parity",
        status: "pending",
        itemId: null,
        grantId: null,
        expiresAt: "2026-01-01T01:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        fulfilledAt: null,
      });
      const pending = await store.getPendingNeed({
        orgId,
        clientId: client.id,
        environmentId: env.id,
        suggestedName: "NEW_KEY",
        host: "api.example.com",
      });
      assert.equal(pending?.id, need.id);
      await store.refreshNeedExpires(need.id, "2026-01-01T02:00:00.000Z");
      assert.equal((await store.getNeed(need.id))?.expiresAt, "2026-01-01T02:00:00.000Z");
      assert.equal((await store.listPendingNeeds(orgId)).length, 1);
      await store.cancelNeed(need.id);
      assert.equal((await store.getNeed(need.id))?.status, "cancelled");
      assert.deepEqual(await store.listPendingNeeds(orgId), []);
      const swept = await store.sweepExpired("2026-01-03T00:00:00.000Z");
      assert.ok(swept.needItems >= 1);
      assert.equal(await store.getNeed(need.id), undefined);

      const window = "2026-01-01T00:00:00.000Z";
      assert.equal(await store.incrementRateHit(orgId, "grant", window), 1);
      assert.equal(await store.incrementRateHit(orgId, "grant", window), 2);
      assert.equal(await store.countRateHits(orgId, "grant", window), 2);
      assert.equal(await store.countRateHits(orgId, "need", window), 0);

      await kernel.writeAudit(orgId, "inject", client.id, "PARITY", null);
      await kernel.writeAudit(orgId, "inject", client.id, "PARITY", null);
      assert.equal(await store.countAuditSince(orgId, "inject", "2000-01-01T00:00:00.000Z"), 2);
      assert.equal(await store.countAuditSince(orgId, "inject", "2999-01-01T00:00:00.000Z"), 0);
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] deleteOrg removes items, clients, grants, audit, and members`, async () => {
    const { store, done } = await backend.open();
    try {
      const id = ids("do");
      const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()) });
      const owner = id("owner");
      const { orgId } = await kernel.createOrg(id("org"), owner);
      await kernel.createItem({
        orgId,
        actor: owner,
        environment: "staging",
        kind: "secret",
        name: "GONE",
        value: CANARY,
        allowedHosts: ["api.example.com"],
        inject: "bearer",
      });
      const { client } = await kernel.createModelClient({ orgId, name: "m", environment: "staging" });
      await kernel.requestGrant({ orgId, clientId: client.id, itemName: "GONE", environment: "staging" });
      await kernel.deleteOrg(orgId, owner, "owner", id("org"));
      assert.equal(await store.getOrg(orgId), undefined);
      assert.deepEqual(await store.listClients(orgId), []);
      assert.deepEqual(await store.listGrants(orgId), []);
      assert.deepEqual(await store.listAudit(orgId, 10), []);
      assert.deepEqual(await store.listMembershipsForUser(owner), []);
      assert.equal(await store.countItemsForOrg(orgId), 0);
    } finally {
      await done();
    }
  });
}
