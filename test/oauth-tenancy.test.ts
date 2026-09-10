import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SignJWT, importJWK } from "jose";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { parseOidcPrivateJwk, type OidcPrivateJwk } from "../src/hosted/boot.ts";
import { oidcKid, principalFromAccessJwt, publicJwks } from "../src/hosted/access-jwt.ts";
import { HttpError } from "../src/hosted/errors.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { persistIssuedAccess, persistIssuedRefresh } from "../src/hosted/oauth-as.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import type { VaultEnvName } from "../src/hosted-types.ts";
import { CANARY, cleanup, tempHome, testOidcPrivateJwk } from "./helpers.ts";
import { testOidcPreviousJwk } from "./oauth-helpers.ts";

const ISSUER = "http://127.0.0.1:8788";
const AUD = `${ISSUER}/mcp`;

type Claims = { sub?: string; client_id: string; jti?: string; org_id?: string; expiresIn?: string | number; signWith?: OidcPrivateJwk };

async function ctx(deployPlane: VaultEnvName) {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "tenancy.sqlite"));
  const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), publicUrl: ISSUER, deployPlane });
  const jwk = parseOidcPrivateJwk(testOidcPrivateJwk());
  assert.ok(jwk);
  async function jwt(claims: Claims): Promise<string> {
    const key = claims.signWith ?? jwk;
    assert.ok(key);
    const signer = await importJWK({ ...key }, "RS256");
    let builder = new SignJWT({ client_id: claims.client_id, scope: "mcp", ...(claims.org_id ? { org_id: claims.org_id } : {}) })
      .setProtectedHeader({ alg: "RS256", kid: oidcKid(key) })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setExpirationTime(claims.expiresIn ?? "10m");
    if (claims.sub) builder = builder.setSubject(claims.sub);
    if (claims.jti) builder = builder.setJti(claims.jti);
    return builder.sign(signer);
  }
  return {
    store,
    kernel,
    jwk,
    jwt,
    async done() {
      await store.close();
      cleanup(home);
    },
  };
}

function rejects401(p: Promise<unknown>, label: string): Promise<void> {
  return assert.rejects(p, (err: unknown) => err instanceof HttpError && err.status === 401, label);
}

test("S2/O2 access JWT resolves the vault client through the org_id claim, then membership, then (org, client_id)", async () => {
  const c = await ctx("staging");
  try {
    const a = await c.kernel.createOrg("acme", "user_a");
    const b = await c.kernel.createOrg("beta", "user_b");
    for (const [orgId, actor, name] of [
      [a.orgId, "user_a", "A_KEY"],
      [b.orgId, "user_b", "B_KEY"],
    ] as const) {
      await c.kernel.createItem({
        orgId,
        actor,
        environment: "staging",
        kind: "secret",
        name,
        value: CANARY,
        allowedHosts: ["api.example.com"],
        inject: "bearer",
      });
    }
    await persistIssuedAccess(c.kernel, { jti: "jti-a", oauthClientId: "dcr_shared", accountId: "user_a", clientName: "Cursor", orgId: a.orgId });
    await persistIssuedAccess(c.kernel, { jti: "jti-b", oauthClientId: "dcr_shared", accountId: "user_b", clientName: "Cursor", orgId: b.orgId });

    const pa = await principalFromAccessJwt(c.kernel, await c.jwt({ sub: "user_a", client_id: "dcr_shared", jti: "jti-a", org_id: a.orgId }), c.jwk, ISSUER);
    const pb = await principalFromAccessJwt(c.kernel, await c.jwt({ sub: "user_b", client_id: "dcr_shared", jti: "jti-b", org_id: b.orgId }), c.jwk, ISSUER);
    assert.equal(pa.channel, "model");
    assert.equal(pb.channel, "model");
    assert.equal(pa.orgId, a.orgId);
    assert.equal(pb.orgId, b.orgId);
    assert.notEqual(pa.channel === "model" && pa.clientId, pb.channel === "model" && pb.clientId);
    assert.deepEqual((await c.kernel.listItems(pa.orgId, "staging")).map((i) => i.name), ["A_KEY"]);
    assert.deepEqual((await c.kernel.listItems(pb.orgId, "staging")).map((i) => i.name), ["B_KEY"]);

    await rejects401(
      principalFromAccessJwt(c.kernel, await c.jwt({ client_id: "dcr_shared", jti: "jti-nosub", org_id: a.orgId }), c.jwk, ISSUER),
      "no sub",
    );
    await rejects401(
      principalFromAccessJwt(c.kernel, await c.jwt({ sub: "dcr_shared", client_id: "dcr_shared", jti: "jti-cc", org_id: a.orgId }), c.jwk, ISSUER),
      "sub equal to client_id means no account",
    );
    // O2: the org is bound at consent and carried in the token; it is never inferred from
    // the account's first membership, and the account must still be a member of it.
    await rejects401(
      principalFromAccessJwt(c.kernel, await c.jwt({ sub: "user_a", client_id: "dcr_shared", jti: "jti-a" }), c.jwk, ISSUER),
      "no org_id claim",
    );
    await rejects401(
      principalFromAccessJwt(c.kernel, await c.jwt({ sub: "user_a", client_id: "dcr_shared", jti: "jti-a", org_id: b.orgId }), c.jwk, ISSUER),
      "org the account is not a member of",
    );
    // Verification has no side effects: an unknown account does not get an org provisioned.
    await rejects401(
      principalFromAccessJwt(c.kernel, await c.jwt({ sub: "user_ghost", client_id: "dcr_shared", jti: "jti-ghost", org_id: a.orgId }), c.jwk, ISSUER),
      "unknown account",
    );
    assert.deepEqual(await c.store.listMembershipsForUser("user_ghost"), []);
    assert.equal(await c.store.getOrg("org_ghost"), undefined);

    // Revoking A's vault client leaves B's principal resolvable.
    const clientA = (await c.store.listClients(a.orgId)).find((cl) => cl.oauthClientId === "dcr_shared");
    assert.ok(clientA);
    await c.kernel.revokeClient(a.orgId, "user_a", clientA.id);
    await rejects401(
      principalFromAccessJwt(c.kernel, await c.jwt({ sub: "user_a", client_id: "dcr_shared", jti: "jti-a", org_id: a.orgId }), c.jwk, ISSUER),
      "revoked",
    );
    const stillB = await principalFromAccessJwt(c.kernel, await c.jwt({ sub: "user_b", client_id: "dcr_shared", jti: "jti-b", org_id: b.orgId }), c.jwk, ISSUER);
    assert.equal(stillB.orgId, b.orgId);
  } finally {
    await c.done();
  }
});

test("O9 access JWT verification tolerates 30 seconds of clock skew and no more", async () => {
  const c = await ctx("staging");
  try {
    const { orgId } = await c.kernel.createOrg("acme", "user_a");
    await persistIssuedAccess(c.kernel, { jti: "jti-skew", oauthClientId: "dcr_skew", accountId: "user_a", orgId });
    const now = Math.floor(Date.now() / 1000);
    const slightlyPast = await principalFromAccessJwt(
      c.kernel,
      await c.jwt({ sub: "user_a", client_id: "dcr_skew", jti: "jti-skew", org_id: orgId, expiresIn: now - 10 }),
      c.jwk,
      ISSUER,
    );
    assert.equal(slightlyPast.orgId, orgId);
    await rejects401(
      principalFromAccessJwt(
        c.kernel,
        await c.jwt({ sub: "user_a", client_id: "dcr_skew", jti: "jti-skew", org_id: orgId, expiresIn: now - 60 }),
        c.jwk,
        ISSUER,
      ),
      "a minute past expiry is refused",
    );
  } finally {
    await c.done();
  }
});

test("O13 a token signed by the previous key verifies only while that key is configured; unknown keys never do", async () => {
  const c = await ctx("staging");
  try {
    const previous = testOidcPreviousJwk();
    const stranger = testOidcPreviousJwk();
    assert.notEqual(oidcKid(previous), oidcKid(c.jwk));
    const { orgId } = await c.kernel.createOrg("acme", "user_a");
    await persistIssuedAccess(c.kernel, { jti: "jti-prev", oauthClientId: "dcr_prev", accountId: "user_a", orgId });
    const signedByPrevious = await c.jwt({ sub: "user_a", client_id: "dcr_prev", jti: "jti-prev", org_id: orgId, signWith: previous });
    const ok = await principalFromAccessJwt(c.kernel, signedByPrevious, c.jwk, ISSUER, previous);
    assert.equal(ok.orgId, orgId);
    await rejects401(principalFromAccessJwt(c.kernel, signedByPrevious, c.jwk, ISSUER), "previous key not configured");
    await rejects401(
      principalFromAccessJwt(
        c.kernel,
        await c.jwt({ sub: "user_a", client_id: "dcr_prev", jti: "jti-prev", org_id: orgId, signWith: stranger }),
        c.jwk,
        ISSUER,
        previous,
      ),
      "unknown key",
    );
    const jwks = publicJwks({ current: c.jwk, previous });
    assert.deepEqual(jwks.keys.map((k) => k.kid), [oidcKid(c.jwk), oidcKid(previous)]);
    assert.ok(jwks.keys.every((k) => !("d" in k) && !("p" in k)), "JWKS carries public halves only");
  } finally {
    await c.done();
  }
});

test("persistIssuedAccess on a dev process plane writes clients.environment staging", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "dev-tenancy.sqlite"));
  try {
    const kernel = new HostedKernel({
      store,
      kek: parseMasterKey(generateMasterKey()),
      publicUrl: ISSUER,
      deployPlane: "dev",
    });
    await kernel.createOrg("acme", "user_a");
    await persistIssuedAccess(kernel, { jti: "jti-dev", oauthClientId: "dcr_dev", accountId: "user_a" });
    const { orgId } = await kernel.ensureVaultOrgForUser("user_a");
    const client = (await store.listClients(orgId)).find((cl) => cl.oauthClientId === "dcr_dev");
    assert.ok(client);
    assert.equal(client.environment, "staging");
  } finally {
    await store.close();
    cleanup(home);
  }
});

for (const plane of ["staging", "production"] as const) {
  test(`D1 OAuth-issued vault clients bind to the ${plane} plane's environment, take the client_name, and record the consenting account`, async () => {
    const c = await ctx(plane);
    try {
      await c.kernel.createOrg("acme", "user_a");
      await persistIssuedAccess(c.kernel, { jti: `jti-${plane}`, oauthClientId: "dcr_env", accountId: "user_a", clientName: "  Claude Desktop  " });
      const { orgId } = await c.kernel.ensureVaultOrgForUser("user_a");
      const client = (await c.store.listClients(orgId)).find((cl) => cl.oauthClientId === "dcr_env");
      assert.ok(client);
      assert.equal(client.environment, plane);
      assert.equal(client.name, "Claude Desktop");
      assert.equal(client.consentedByUserId, "user_a");
      const principal = await principalFromAccessJwt(
        c.kernel,
        await c.jwt({ sub: "user_a", client_id: "dcr_env", jti: `jti-${plane}`, org_id: orgId }),
        c.jwk,
        ISSUER,
      );
      assert.equal(principal.channel === "model" && principal.environment, plane);

      // A refresh for the same client reuses the vault client and does not rename it.
      await persistIssuedRefresh(c.kernel, { jti: `rt-${plane}`, oauthClientId: "dcr_env", accountId: "user_a", clientName: "Renamed" });
      const after = (await c.store.listClients(orgId)).filter((cl) => cl.oauthClientId === "dcr_env");
      assert.equal(after.length, 1);
      assert.equal(after[0]?.name, "Claude Desktop");
      // Without a client_name the id is the fallback.
      await persistIssuedAccess(c.kernel, { jti: `jti2-${plane}`, oauthClientId: "dcr_nameless", accountId: "user_a" });
      assert.equal((await c.store.listClients(orgId)).find((cl) => cl.oauthClientId === "dcr_nameless")?.name, "dcr_nameless");
    } finally {
      await c.done();
    }
  });
}

test("legacy vault client without a consenting account is backfilled at the next issue", async () => {
  const c = await ctx("staging");
  try {
    const { orgId } = await c.kernel.createOrg("acme", "user_a");
    const legacy = await c.kernel.ensureModelClient({ orgId, name: "dcr_legacy", environment: "staging", clerkOauthUserId: "dcr_legacy" });
    assert.equal(legacy.consentedByUserId, null);
    await persistIssuedAccess(c.kernel, { jti: "jti-legacy", oauthClientId: "dcr_legacy", accountId: "user_a" });
    assert.equal((await c.store.getClient(legacy.id))?.consentedByUserId, "user_a");
    await assert.rejects(persistIssuedAccess(c.kernel, { jti: "jti-noacct", oauthClientId: "dcr_legacy" }), /missing account/);
  } finally {
    await c.done();
  }
});

test("O1 only a fresh consent reactivates a revoked vault client; a refresh or an unstated issuance fails the grant", async () => {
  const c = await ctx("staging");
  try {
    const { orgId } = await c.kernel.createOrg("acme", "user_a");
    await persistIssuedAccess(c.kernel, { jti: "jti-1", oauthClientId: "dcr_react", accountId: "user_a", orgId, issuance: "authorization_code" });
    const client = (await c.store.listClients(orgId)).find((cl) => cl.oauthClientId === "dcr_react");
    assert.ok(client);
    await c.kernel.revokeClient(orgId, "user_a", client.id);
    const isInvalidGrant = (err: unknown) => err instanceof Error && err.name === "InvalidGrant";
    await assert.rejects(
      persistIssuedRefresh(c.kernel, { jti: "rt-2", oauthClientId: "dcr_react", accountId: "user_a", orgId, issuance: "refresh_token" }),
      isInvalidGrant,
      "refresh must not resurrect",
    );
    await assert.rejects(
      persistIssuedAccess(c.kernel, { jti: "jti-3", oauthClientId: "dcr_react", accountId: "user_a", orgId }),
      isInvalidGrant,
      "unknown issuance must not resurrect",
    );
    assert.ok((await c.store.getClient(client.id))?.revokedAt, "still revoked");
    await persistIssuedAccess(c.kernel, { jti: "jti-4", oauthClientId: "dcr_react", accountId: "user_a", orgId, issuance: "device_code" });
    assert.equal((await c.store.getClient(client.id))?.revokedAt, null, "device consent reactivates");
    // An account that left the org cannot be issued a token for it, whatever the issuance.
    await c.store.removeMember(orgId, "user_a");
    await assert.rejects(
      persistIssuedAccess(c.kernel, { jti: "jti-5", oauthClientId: "dcr_react", accountId: "user_a", orgId, issuance: "authorization_code" }),
      isInvalidGrant,
    );
  } finally {
    await c.done();
  }
});
