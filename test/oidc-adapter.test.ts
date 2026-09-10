import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { IdentityKeyring } from "../src/hosted/identity-keys.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { createStoreAdapter, destroyOidcPayloadsForClient, purgeExpired } from "../src/hosted/oidc-adapter.ts";
import { OidcDirectory } from "../src/hosted/oidc-directory.ts";
import { PostgresStore } from "../src/store/postgres.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { oidcPayloadIndex, type VaultStore } from "../src/store/types.ts";
import { cleanup, tempHome } from "./helpers.ts";
import { TEST_PLANE_KEK, ensureSharedIdentityKey } from "./helpers/plane-kek.ts";

type Backend = { name: string; open: () => Promise<{ store: VaultStore; done: () => Promise<void> }> };

const backends: Backend[] = [
  {
    name: "sqlite",
    open: async () => {
      const home = tempHome();
      const store = openHostedSqlite(join(home, "oidc.sqlite"));
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
      await ensureSharedIdentityKey(store);
      return { store, done: () => store.close() };
    },
  });
}

/** Unique ids per run so a shared Postgres database never collides between runs. */
function ids(prefix: string) {
  const run = randomUUID().slice(0, 8);
  return (name: string) => `${prefix}_${run}_${name}`;
}

function oidcDir(store: VaultStore): OidcDirectory {
  return new OidcDirectory(new IdentityKeyring(store, TEST_PLANE_KEK, () => new Date()), store);
}

test("oidcPayloadIndex pulls uid, userCode, grantId, clientId, accountId and tolerates junk", () => {
  assert.deepEqual(oidcPayloadIndex(JSON.stringify({ uid: "u", userCode: "123", grantId: "g", clientId: "c", accountId: "a" })), {
    uid: "u",
    userCode: "123",
    grantId: "g",
    clientId: "c",
    accountId: "a",
  });
  assert.deepEqual(oidcPayloadIndex("{}"), { uid: null, userCode: null, grantId: null, clientId: null, accountId: null });
  assert.deepEqual(oidcPayloadIndex("not json").clientId, null);
  assert.equal(oidcPayloadIndex(JSON.stringify({ clientId: 42 })).clientId, null);
});

for (const backend of backends) {
  test(`[${backend.name}] findByUid and findByUserCode use indexed columns and drop expired rows`, async () => {
    const { store, done } = await backend.open();
    const id = ids("idx");
    try {
      const directory = oidcDir(store);
      const Adapter = createStoreAdapter(store, directory);
      const sessions = new Adapter("Session");
      const codes = new Adapter("DeviceCode");
      await sessions.upsert(id("s1"), { uid: id("uid1"), accountId: "acc", jti: id("s1") }, 600);
      await sessions.upsert(id("s2"), { uid: id("uid2"), accountId: "acc", jti: id("s2") }, -5);
      await codes.upsert(id("d1"), { userCode: id("777"), clientId: "dcr_x", jti: id("d1") }, 600);

      const found = await sessions.findByUid(id("uid1"));
      assert.equal(found?.accountId, "acc");
      assert.equal(await sessions.findByUid(id("missing")), undefined);
      assert.equal(await codes.findByUid(id("uid1")), undefined, "kind is part of the lookup");
      assert.equal(await sessions.findByUid(id("uid2")), undefined, "expired row is not returned");
      assert.equal(await store.getOidcPayload(id("s2"), "Session"), undefined, "expired row was deleted on read");

      const code = await codes.findByUserCode(id("777"));
      assert.equal(code?.clientId, "dcr_x");
      assert.equal(await codes.findByUserCode(id("000")), undefined);

      // An update that changes the indexed field moves the row to the new key.
      await sessions.upsert(id("s1"), { uid: id("uid1b"), accountId: "acc", jti: id("s1") }, 600);
      assert.equal(await sessions.findByUid(id("uid1")), undefined);
      assert.equal((await sessions.findByUid(id("uid1b")))?.accountId, "acc");
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] revokeByGrantId deletes only that grant's rows of that kind`, async () => {
    const { store, done } = await backend.open();
    const id = ids("grant");
    try {
      const directory = oidcDir(store);
      const Adapter = createStoreAdapter(store, directory);
      const refresh = new Adapter("RefreshToken");
      const codes = new Adapter("AuthorizationCode");
      await refresh.upsert(id("rt1"), { grantId: id("g1"), clientId: "c", jti: id("rt1") }, 600);
      await refresh.upsert(id("rt2"), { grantId: id("g2"), clientId: "c", jti: id("rt2") }, 600);
      await codes.upsert(id("ac1"), { grantId: id("g1"), clientId: "c", jti: id("ac1") }, 600);
      await refresh.revokeByGrantId(id("g1"));
      assert.equal(await refresh.find(id("rt1")), undefined);
      assert.ok(await refresh.find(id("rt2")));
      assert.ok(await codes.find(id("ac1")), "other kinds are revoked by their own adapter instance");
      await codes.revokeByGrantId(id("g1"));
      assert.equal(await codes.find(id("ac1")), undefined);
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] I7 consume keeps the original expiry instead of making the row immortal`, async () => {
    const { store, done } = await backend.open();
    const id = ids("consume");
    try {
      const directory = oidcDir(store);
      const Adapter = createStoreAdapter(store, directory);
      const codes = new Adapter("AuthorizationCode");
      await codes.upsert(id("ac"), { grantId: id("g"), clientId: "c", jti: id("ac") }, 60);
      const storedId = await directory.storedId("AuthorizationCode", id("ac"));
      const before = await store.getOidcPayload(storedId, "AuthorizationCode");
      assert.ok(before?.expiresAt);
      await codes.consume(id("ac"));
      const after = await store.getOidcPayload(storedId, "AuthorizationCode");
      assert.equal(after?.expiresAt, before.expiresAt);
      const payload = (await codes.find(id("ac"))) as { consumed?: unknown; grantId?: string };
      assert.equal(typeof payload.consumed, "number");
      assert.equal(payload.grantId, id("g"));
      await assert.rejects(codes.consume(id("never-stored")), (err: unknown) => err instanceof Error && err.name === "InvalidGrant");
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] O7 consume is one conditional write: of concurrent exchanges exactly one wins`, async () => {
    const { store, done } = await backend.open();
    const id = ids("race");
    try {
      const directory = oidcDir(store);
      const Adapter = createStoreAdapter(store, directory);
      const codes = new Adapter("AuthorizationCode");
      await codes.upsert(id("ac"), { grantId: id("g"), clientId: "c", jti: id("ac"), nested: { keep: true } }, 60);
      const outcomes = await Promise.allSettled([codes.consume(id("ac")), codes.consume(id("ac")), codes.consume(id("ac"))]);
      assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1, "one consumer wins");
      assert.equal(outcomes.filter((o) => o.status === "rejected").length, 2, "the others fail the grant");
      for (const o of outcomes) {
        if (o.status === "rejected") assert.equal((o.reason as Error).name, "InvalidGrant");
      }
      // A second, later consume of an already consumed row is refused too.
      await assert.rejects(codes.consume(id("ac")));
      const payload = (await codes.find(id("ac"))) as { consumed?: unknown; nested?: { keep?: boolean }; jti?: string };
      assert.equal(typeof payload.consumed, "number");
      assert.deepEqual(payload.nested, { keep: true }, "the rest of the payload survives the JSON update");
      assert.equal(payload.jti, id("ac"));
      assert.equal(await store.consumeOidcPayload(await directory.storedId("AuthorizationCode", id("ac")), "AuthorizationCode", 1), false);
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] O1 revoke sweeps every grant this org's members gave for the client id, and no other org's`, async () => {
    const { store, done } = await backend.open();
    const id = ids("sweep");
    try {
      const AUD = "http://127.0.0.1:8788/mcp";
      const orgA = id("org_a");
      const orgB = id("org_b");
      const dcr = id("dcr_shared");
      const grants = [
        // owner's grant in A, member's grant in A, member's grant in B (same account, other org),
        // the consenting owner's grant in B, a legacy grant (no org marker) by a member of A,
        // and a legacy grant by a stranger.
        { g: id("g_owner_a"), account: id("owner"), org: orgA },
        { g: id("g_member_a"), account: id("member"), org: orgA },
        { g: id("g_member_b"), account: id("member"), org: orgB },
        { g: id("g_owner_b"), account: id("owner"), org: orgB },
        { g: id("g_legacy_member"), account: id("member"), org: undefined },
        { g: id("g_legacy_stranger"), account: id("stranger"), org: undefined },
      ];
      for (const row of grants) {
        await store.upsertOidcPayload({
          id: row.g,
          kind: "Grant",
          payload: JSON.stringify({
            jti: row.g,
            clientId: dcr,
            accountId: row.account,
            resources: { [AUD]: row.org ? `mcp org:${row.org}` : "mcp" },
          }),
          expiresAt: null,
        });
        await store.upsertOidcPayload({
          id: `rt_${row.g}`,
          kind: "RefreshToken",
          payload: JSON.stringify({ jti: `rt_${row.g}`, clientId: dcr, accountId: row.account, grantId: row.g }),
          expiresAt: null,
        });
      }
      // A token the consenting owner holds for this client id with no grant behind it: the
      // account-scoped sweep still removes it.
      await store.upsertOidcPayload({
        id: id("rt_owner_loose"),
        kind: "RefreshToken",
        payload: JSON.stringify({ jti: id("rt_owner_loose"), clientId: dcr, accountId: id("owner") }),
        expiresAt: null,
      });
      await destroyOidcPayloadsForClient(
        store,
        oidcDir(store),
        { id: id("cli_a"), oauthClientId: dcr, clerkOauthUserId: null, consentedByUserId: id("owner") },
        { orgId: orgA, memberUserIds: [id("owner"), id("member")] },
      );
      const alive = async (g: string) => (await store.getOidcPayload(g, "Grant")) !== undefined || (await store.getOidcPayload(`rt_${g}`, "RefreshToken")) !== undefined;
      assert.equal(await alive(id("g_owner_a")), false, "owner's consent in A gone");
      assert.equal(await alive(id("g_member_a")), false, "member's consent in A gone (was the reactivation hole)");
      assert.equal(await alive(id("g_legacy_member")), false, "member's legacy grant gone");
      assert.equal(await alive(id("g_member_b")), true, "the same member's consent in org B survives");
      assert.equal(await alive(id("g_legacy_stranger")), true, "a non-member's legacy grant survives");
      assert.equal(await store.getOidcPayload(id("g_owner_b"), "Grant") !== undefined, true, "the consenting owner's grant in org B survives");
      assert.equal(await store.getOidcPayload(`rt_${id("g_owner_b")}`, "RefreshToken") !== undefined, true, "and so does its refresh token");
      assert.equal(await store.getOidcPayload(id("rt_owner_loose"), "RefreshToken"), undefined, "the owner's grantless token for the client id is gone");
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] purgeExpired removes only rows whose expiry has passed`, async () => {
    const { store, done } = await backend.open();
    const id = ids("purge");
    try {
      const directory = oidcDir(store);
      const Adapter = createStoreAdapter(store, directory);
      const refresh = new Adapter("RefreshToken");
      await refresh.upsert(id("old"), { jti: id("old") }, -10);
      await refresh.upsert(id("live"), { jti: id("live") }, 600);
      await refresh.upsert(id("forever"), { jti: id("forever") });
      const removed = await purgeExpired(store);
      assert.ok(removed >= 1);
      assert.equal(await store.getOidcPayload(await directory.storedId("RefreshToken", id("old")), "RefreshToken"), undefined);
      assert.ok(await store.getOidcPayload(await directory.storedId("RefreshToken", id("live")), "RefreshToken"));
      assert.ok(await store.getOidcPayload(await directory.storedId("RefreshToken", id("forever")), "RefreshToken"));
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] S2 destroyOidcPayloadsForClient is scoped to the consenting account`, async () => {
    const { store, done } = await backend.open();
    const id = ids("scope");
    try {
      const rows = [
        { id: id("rt_a"), clientId: id("dcr_shared"), accountId: id("user_a") },
        { id: id("rt_b"), clientId: id("dcr_shared"), accountId: id("user_b") },
        { id: id("rt_none"), clientId: id("dcr_shared") },
        { id: id("rt_other"), clientId: id("dcr_other"), accountId: id("user_a") },
      ];
      for (const row of rows) {
        await store.upsertOidcPayload({
          id: row.id,
          kind: "RefreshToken",
          payload: JSON.stringify({ clientId: row.clientId, accountId: row.accountId, jti: row.id }),
          expiresAt: null,
        });
      }
      const directory = oidcDir(store);
      await destroyOidcPayloadsForClient(store, directory, {
        id: id("cli_a"),
        oauthClientId: id("dcr_shared"),
        clerkOauthUserId: null,
        consentedByUserId: id("user_a"),
      });
      assert.equal(await store.getOidcPayload(id("rt_a"), "RefreshToken"), undefined, "A's token gone");
      assert.ok(await store.getOidcPayload(id("rt_none"), "RefreshToken"), "unattributed rows for a shared client id are not this tenant's to delete");
      assert.ok(await store.getOidcPayload(id("rt_b"), "RefreshToken"), "B's token for the same DCR id survives");
      assert.ok(await store.getOidcPayload(id("rt_other"), "RefreshToken"), "other client untouched");

      // A legacy client with no recorded consenting account only loses unattributed rows.
      await destroyOidcPayloadsForClient(store, directory, {
        id: id("cli_legacy"),
        oauthClientId: id("dcr_shared"),
        clerkOauthUserId: null,
        consentedByUserId: null,
      });
      assert.ok(await store.getOidcPayload(id("rt_b"), "RefreshToken"), "account-bound rows survive an unattributed revoke");
    } finally {
      await done();
    }
  });

  test(`[${backend.name}] findClientByOrgAndOauthId is per org and the pair is unique`, async () => {
    const { store, done } = await backend.open();
    const id = ids("tenant");
    try {
      const kernel = new HostedKernel({ store, kek: TEST_PLANE_KEK, deployPlane: "staging" });
      const a = await kernel.createOrg(id("a"), id("user_a"));
      const b = await kernel.createOrg(id("b"), id("user_b"));
      const clientA = await kernel.ensureModelClient({ orgId: a.orgId, name: "shared", environment: "staging", clerkOauthUserId: id("dcr") });
      const clientB = await kernel.ensureModelClient({ orgId: b.orgId, name: "shared", environment: "staging", clerkOauthUserId: id("dcr") });
      assert.notEqual(clientA.id, clientB.id);
      assert.equal((await store.findClientByOrgAndOauthId(a.orgId, id("dcr")))?.id, clientA.id);
      assert.equal((await store.findClientByOrgAndOauthId(b.orgId, id("dcr")))?.id, clientB.id);
      assert.equal(await store.findClientByOrgAndOauthId(id("org_none"), id("dcr")), undefined);
      assert.equal(await kernel.ensureModelClient({ orgId: a.orgId, name: "again", environment: "staging", clerkOauthUserId: id("dcr") }).then((c) => c.id), clientA.id);
      await assert.rejects(
        kernel.createModelClient({ orgId: a.orgId, name: "dup", environment: "staging", clerkOauthUserId: id("dcr") }),
        "second vault client for the same (org, oauth_client_id) violates the unique index",
      );
      await store.setClientConsentedBy(clientA.id, id("user_a"));
      await store.setClientConsentedBy(clientA.id, id("user_x"));
      assert.equal((await store.getClient(clientA.id))?.consentedByUserId, id("user_a"), "first consenting account sticks");
    } finally {
      await done();
    }
  });
}
