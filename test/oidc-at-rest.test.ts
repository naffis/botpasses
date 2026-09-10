import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { IdentityKeyring } from "../src/hosted/identity-keys.ts";
import { createStoreAdapter, destroyOidcPayloadsForClient } from "../src/hosted/oidc-adapter.ts";
import { hashesOidcId, isOidcEnvelopePayload, OidcDirectory } from "../src/hosted/oidc-directory.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { AUDIENCE, ISSUER, pkce, startOauthServer } from "./oauth-helpers.ts";
import { cleanup, tempHome } from "./helpers.ts";

function hex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

test("AC-11: a hosted refresh is stored as 64 hex; find with the real token works; dump search misses", async () => {
  const srv = await startOauthServer({ secure: false, deployPlane: "staging" });
  try {
    const who = await srv.signInReady("oauth-wrap@example.com");
    const client = await srv.registerClient({
      client_name: "wrap",
      redirect_uris: ["http://127.0.0.1:9999/cb"],
    });
    const { verifier, challenge } = pkce();
    const leg = await srv.authorizeWithConsent({
      jar: who.jar,
      clientId: client.client_id,
      redirectUri: "http://127.0.0.1:9999/cb",
      challenge,
    });
    const issued = await srv.token({
      grant_type: "authorization_code",
      code: leg.code,
      redirect_uri: "http://127.0.0.1:9999/cb",
      client_id: client.client_id,
      code_verifier: verifier,
      resource: AUDIENCE,
    });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const refresh = String(issued.body.refresh_token);
    assert.ok(refresh);
    const rows = await srv.store.listAllOidcPayloads();
    const refreshRows = rows.filter((r) => r.kind === "RefreshToken");
    assert.ok(refreshRows.length >= 1);
    for (const row of refreshRows) {
      assert.ok(hex64(row.id), "bearer id is HMAC");
      assert.ok(isOidcEnvelopePayload(row.payload));
      assert.equal(row.payload.includes(refresh), false);
      assert.equal(row.id.includes(refresh), false);
    }
    const dump = JSON.stringify(refreshRows);
    assert.equal(dump.includes(refresh), false, "a dump string-search misses the token");
    const found = await srv.kernel.oidc.unwrap("RefreshToken", refreshRows[0]!.id, refreshRows[0]!.payload);
    assert.ok(found);
    const Adapter = createStoreAdapter(srv.store, srv.kernel.oidc);
    const live = await new Adapter("RefreshToken").find(refresh);
    assert.ok(live, "find with the presented token still works");
    assert.equal(ISSUER.includes("127.0.0.1"), true);
  } finally {
    await srv.close();
  }
});

test("AC-12: consume is one-wins; payload ciphertext has no consumed key", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "oidc.sqlite"));
  const directory = new OidcDirectory(new IdentityKeyring(store, parseMasterKey(generateMasterKey()), () => new Date()), store);
  try {
    const Adapter = createStoreAdapter(store, directory);
    const refresh = new Adapter("RefreshToken");
    const token = "rt_live_token";
    await refresh.upsert(token, { grantId: "g1", clientId: "c", jti: "j" }, 600);
    const outcomes = await Promise.allSettled([refresh.consume(token), refresh.consume(token), refresh.consume(token)]);
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    await assert.rejects(refresh.consume(token), (err: unknown) => err instanceof Error && err.name === "InvalidGrant");
    const storedId = await directory.storedId("RefreshToken", token);
    const row = await store.getOidcPayload(storedId, "RefreshToken");
    assert.ok(row);
    assert.ok(typeof row.consumedAt === "number");
    assert.equal(row.payload.includes("consumed"), false, "raw payload has no consumed key");
    const body = await refresh.find(token);
    assert.equal(typeof body?.consumed, "number");
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("AC-13: device user_code column is HMAC; findByUserCode with the typed code works", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "oidc.sqlite"));
  const directory = new OidcDirectory(new IdentityKeyring(store, parseMasterKey(generateMasterKey()), () => new Date()), store);
  try {
    const Adapter = createStoreAdapter(store, directory);
    const codes = new Adapter("DeviceCode");
    const typed = "WDJB-MJHT";
    await codes.upsert("device-token", { userCode: typed, clientId: "c" }, 600);
    const rows = await store.listAllOidcPayloads();
    const row = rows.find((r) => r.kind === "DeviceCode");
    assert.ok(row);
    assert.ok(row.userCode && hex64(row.userCode));
    assert.notEqual(row.userCode, typed);
    const found = await codes.findByUserCode(typed);
    assert.equal(found?.clientId, "c");
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("AC-14: destroyOidcPayloadsForClient decrypts Grants; parsing without decrypt leaves the token", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "oidc.sqlite"));
  const directory = new OidcDirectory(new IdentityKeyring(store, parseMasterKey(generateMasterKey()), () => new Date()), store);
  try {
    const Adapter = createStoreAdapter(store, directory);
    const grantId = "gnt_plain";
    const token = "rt_owned";
    await new Adapter("Grant").upsert(grantId, {
      jti: grantId,
      clientId: "dcr_x",
      accountId: "usr_a",
      resources: { [AUDIENCE]: "mcp org:org_a" },
    });
    await new Adapter("RefreshToken").upsert(token, { grantId, clientId: "dcr_x", accountId: "usr_a" }, 600);
    const grants = await store.listOidcPayloadsForClient("Grant", ["dcr_x"]);
    assert.equal(grants.length, 1);
    const parsed = JSON.parse(grants[0]!.payload) as { accountId?: string; clientId?: string; v?: unknown };
    assert.notEqual(parsed.accountId, "usr_a", "parsing Grant JSON without decrypt leaves the token wrapped");
    assert.notEqual(parsed.clientId, "dcr_x");
    assert.ok(isOidcEnvelopePayload(grants[0]!.payload));
    await destroyOidcPayloadsForClient(
      store,
      directory,
      { id: "cli_a", oauthClientId: "dcr_x", clerkOauthUserId: null, consentedByUserId: "usr_a" },
      { orgId: "org_a", memberUserIds: ["usr_a"] },
    );
    assert.equal(await store.getOidcPayload(grantId, "Grant"), undefined);
    assert.equal(await store.getOidcPayload(await directory.storedId("RefreshToken", token), "RefreshToken"), undefined);
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("AC-15: RefreshToken grant_id stays the plaintext grant id", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "oidc.sqlite"));
  const directory = new OidcDirectory(new IdentityKeyring(store, parseMasterKey(generateMasterKey()), () => new Date()), store);
  try {
    const Adapter = createStoreAdapter(store, directory);
    const grantId = "gnt_keep";
    await new Adapter("RefreshToken").upsert("rt", { grantId, clientId: "c" }, 600);
    const row = (await store.listAllOidcPayloads()).find((r) => r.kind === "RefreshToken");
    assert.equal(row?.grantId, grantId);
    assert.notEqual(row?.grantId, null);
    assert.notEqual(row?.grantId, await directory.storedId("RefreshToken", "rt"));
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("AC-16: Session id is HMAC; Grant id stays the oidc-provider grant id", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "oidc.sqlite"));
  const directory = new OidcDirectory(new IdentityKeyring(store, parseMasterKey(generateMasterKey()), () => new Date()), store);
  try {
    const Adapter = createStoreAdapter(store, directory);
    const cookie = "sess_cookie_value";
    const grantId = "gnt_session";
    await new Adapter("Session").upsert(cookie, { uid: "uid1", accountId: "a" }, 600);
    await new Adapter("Grant").upsert(grantId, { accountId: "a", clientId: "c" });
    const sessionRow = (await store.listAllOidcPayloads()).find((r) => r.kind === "Session");
    const grantRow = (await store.listAllOidcPayloads()).find((r) => r.kind === "Grant");
    assert.ok(sessionRow && hex64(sessionRow.id));
    assert.equal(grantRow?.id, grantId);
    assert.equal(hashesOidcId("Grant"), false);
    const found = await new Adapter("Session").find(cookie);
    assert.equal(found?.accountId, "a");
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("R-18: oidc restore writes the inner id and JSON body back", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "oidc-restore.sqlite"));
  const directory = new OidcDirectory(new IdentityKeyring(store, parseMasterKey(generateMasterKey()), () => new Date()), store);
  try {
    const token = "rt_restore_me";
    const body = { grantId: "gnt_restore", clientId: "c" };
    await new (createStoreAdapter(store, directory))("RefreshToken").upsert(token, body, 600);
    const hashed = await directory.storedId("RefreshToken", token);
    const before = await store.getOidcPayload(hashed, "RefreshToken");
    assert.ok(before && isOidcEnvelopePayload(before.payload));
    const result = await directory.restorePlaintext(() => false);
    assert.equal(result.restored, 1);
    assert.equal(await store.getOidcPayload(hashed, "RefreshToken"), undefined);
    const restored = await store.getOidcPayload(token, "RefreshToken");
    assert.ok(restored);
    assert.equal(isOidcEnvelopePayload(restored.payload), false);
    assert.deepEqual(JSON.parse(restored.payload), body);
    const dump = JSON.stringify(await store.listAllOidcPayloads());
    assert.equal(dump.includes(token), true);
  } finally {
    await store.close();
    cleanup(home);
  }
});
