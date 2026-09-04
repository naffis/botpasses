import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SignJWT, importJWK } from "jose";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { parseOidcPrivateJwk, type OidcPrivateJwk } from "../src/hosted/boot.ts";
import { principalFromAccessJwt } from "../src/hosted/access-jwt.ts";
import { HttpError } from "../src/hosted/errors.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { persistIssuedAccess, persistIssuedRefresh } from "../src/hosted/oauth-as.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import type { VaultEnvName } from "../src/hosted-types.ts";
import { CANARY, cleanup, tempHome, testOidcPrivateJwk } from "./helpers.ts";

const ISSUER = "http://127.0.0.1:8788";
const AUD = `${ISSUER}/mcp`;

async function ctx(deployPlane: VaultEnvName) {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "tenancy.sqlite"));
  const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), publicUrl: ISSUER, deployPlane });
  const jwk = parseOidcPrivateJwk(testOidcPrivateJwk());
  assert.ok(jwk);
  const signer = await importJWK({ ...jwk }, "RS256");
  async function jwt(claims: { sub?: string; client_id: string; jti?: string }): Promise<string> {
    let builder = new SignJWT({ client_id: claims.client_id, scope: "mcp" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setExpirationTime("10m");
    if (claims.sub) builder = builder.setSubject(claims.sub);
    if (claims.jti) builder = builder.setJti(claims.jti);
    return builder.sign(signer);
  }
  return {
    store,
    kernel,
    jwk: jwk as OidcPrivateJwk,
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

test("S2 access JWT resolves the vault client through sub then (org, client_id); no sub is 401", async () => {
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
    await persistIssuedAccess(c.kernel, { jti: "jti-a", oauthClientId: "dcr_shared", accountId: "user_a", clientName: "Cursor" });
    await persistIssuedAccess(c.kernel, { jti: "jti-b", oauthClientId: "dcr_shared", accountId: "user_b", clientName: "Cursor" });

    const pa = await principalFromAccessJwt(c.kernel, await c.jwt({ sub: "user_a", client_id: "dcr_shared", jti: "jti-a" }), c.jwk, ISSUER);
    const pb = await principalFromAccessJwt(c.kernel, await c.jwt({ sub: "user_b", client_id: "dcr_shared", jti: "jti-b" }), c.jwk, ISSUER);
    assert.equal(pa.channel, "model");
    assert.equal(pb.channel, "model");
    assert.equal(pa.orgId, a.orgId);
    assert.equal(pb.orgId, b.orgId);
    assert.notEqual(pa.channel === "model" && pa.clientId, pb.channel === "model" && pb.clientId);
    assert.deepEqual((await c.kernel.listItems(pa.orgId, "staging")).map((i) => i.name), ["A_KEY"]);
    assert.deepEqual((await c.kernel.listItems(pb.orgId, "staging")).map((i) => i.name), ["B_KEY"]);

    await rejects401(
      principalFromAccessJwt(c.kernel, await c.jwt({ client_id: "dcr_shared", jti: "jti-nosub" }), c.jwk, ISSUER),
      "no sub",
    );
    await rejects401(
      principalFromAccessJwt(c.kernel, await c.jwt({ sub: "dcr_shared", client_id: "dcr_shared", jti: "jti-cc" }), c.jwk, ISSUER),
      "sub equal to client_id means no account",
    );

    // Revoking A's vault client leaves B's principal resolvable.
    const clientA = (await c.store.listClients(a.orgId)).find((cl) => cl.oauthClientId === "dcr_shared");
    assert.ok(clientA);
    await c.kernel.revokeClient(a.orgId, "user_a", clientA.id);
    await rejects401(
      principalFromAccessJwt(c.kernel, await c.jwt({ sub: "user_a", client_id: "dcr_shared", jti: "jti-a" }), c.jwk, ISSUER),
      "revoked",
    );
    const stillB = await principalFromAccessJwt(c.kernel, await c.jwt({ sub: "user_b", client_id: "dcr_shared", jti: "jti-b" }), c.jwk, ISSUER);
    assert.equal(stillB.orgId, b.orgId);
  } finally {
    await c.done();
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
        await c.jwt({ sub: "user_a", client_id: "dcr_env", jti: `jti-${plane}` }),
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
