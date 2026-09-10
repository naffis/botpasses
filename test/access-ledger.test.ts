import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { SignJWT, importJWK } from "jose";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { parseOidcPrivateJwk } from "../src/hosted/boot.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { identityAuthResolver } from "../src/hosted/identity.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import {
  persistIssuedAccess,
  persistIssuedRefresh,
  persistRevokedToken,
  createOauthProvider,
} from "../src/hosted/oauth-as.ts";
import { OperatorIdentity } from "../src/hosted/operator-identity.ts";
import { hostedAuthResolver, testAuthResolver, type AuthResolver } from "../src/hosted/auth.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, TEST_SESSION_SECRET, cleanup, tempHome, testOidcPrivateJwk } from "./helpers.ts";
import { pkce } from "./oauth-helpers.ts";

async function ledgerCtx() {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "acc.sqlite"));
  const kek = parseMasterKey(generateMasterKey());
  const kernel = new HostedKernel({
    store,
    kek,
    publicUrl: "http://127.0.0.1:8788",
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  const jwk = parseOidcPrivateJwk(testOidcPrivateJwk());
  assert.ok(jwk);
  const identity = new OperatorIdentity({ store, sessionSecret: TEST_SESSION_SECRET, kek });
  const oidcProvider = createOauthProvider({
    issuer: "http://127.0.0.1:8788",
    kernel,
    sessionSecret: TEST_SESSION_SECRET,
    jwk,
    secureCookies: false,
    oidcDirectory: kernel.oidc,
  });
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    identity,
    oidcProvider,
    secureCookies: false,
    authResolver: hostedAuthResolver({}, (async (req, k) => {
      const testP = await testAuthResolver(req, k);
      if (testP) return testP;
      return identityAuthResolver({
        identity,
        kernel,
        secureCookies: false,
        oidcJwk: jwk,
        issuer: "http://127.0.0.1:8788",
      })(req, k);
    }) satisfies AuthResolver),
  });
  const addr = await http.listen();
  const op = {
    "x-test-channel": "operator",
    "x-test-user": "user_owner",
    "x-test-org": orgId,
    "content-type": "application/json",
  };
  return {
    home,
    store,
    kernel,
    http,
    orgId,
    jwk,
    identity,
    oidcProvider,
    base: `http://${addr.host}:${addr.port}`,
    op,
  };
}

test("AC-28 issue model token appears on access snapshot without avm_ value", async () => {
  const ctx = await ledgerCtx();
  try {
    const issued = await fetch(`${ctx.base}/api/clients/model`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ name: "grok", environment: "staging" }),
    });
    assert.equal(issued.status, 200);
    const body = (await issued.json()) as { token: string; client: { id: string } };
    assert.match(body.token, /^avm_/);
    const snap = await fetch(`${ctx.base}/api/access`, { headers: ctx.op });
    assert.equal(snap.status, 200);
    const json = (await snap.json()) as {
      clients: { id: string; status: string; last_token_at: string | null; last4: string | null }[];
    };
    const row = json.clients.find((c) => c.id === body.client.id);
    assert.ok(row);
    assert.equal(row.status, "active");
    assert.ok(row.last_token_at);
    assert.equal(row.last4, body.token.slice(-4));
    const raw = JSON.stringify(json);
    assert.doesNotMatch(raw, /avm_/);
    assert.doesNotMatch(raw, new RegExp(body.token.slice(4)));
    assert.doesNotMatch(raw, /audit/);
    const events = await fetch(`${ctx.base}/api/access/events`, { headers: ctx.op });
    const ledger = (await events.json()) as { events: unknown[] };
    assert.ok(Array.isArray(ledger.events));
    assert.ok(!("events" in json));
    const rotated = await fetch(`${ctx.base}/api/clients/${body.client.id}/rotate`, {
      method: "POST",
      headers: ctx.op,
      body: "{}",
    });
    assert.equal(rotated.status, 200);
    const next = (await rotated.json()) as { token: string };
    const snap2 = await fetch(`${ctx.base}/api/access`, { headers: ctx.op });
    const json2 = (await snap2.json()) as { clients: { id: string; last4: string | null }[] };
    const after = json2.clients.find((c) => c.id === body.client.id);
    assert.equal(after?.last4, next.token.slice(-4));
    assert.ok(!JSON.stringify(json2).includes(next.token));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-30 revoke client then MCP bearer is 401; AC-34 cross-org 404; signed-out 401", async () => {
  const ctx = await ledgerCtx();
  try {
    const signedOut = await fetch(`${ctx.base}/api/access`);
    assert.equal(signedOut.status, 401);
    const issued = await fetch(`${ctx.base}/api/clients/model`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ name: "grok", environment: "staging" }),
    });
    const body = (await issued.json()) as { token: string; client: { id: string } };
    const mcpOk = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcpOk.status, 200);
    const rev = await fetch(`${ctx.base}/api/clients/${body.client.id}/revoke`, {
      method: "POST",
      headers: ctx.op,
      body: "{}",
    });
    assert.equal(rev.status, 200);
    const mcpBad = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcpBad.status, 401);
    const snap = await fetch(`${ctx.base}/api/access`, { headers: ctx.op });
    const json = (await snap.json()) as { clients: { id: string; status: string }[] };
    assert.equal(json.clients.find((c) => c.id === body.client.id)?.status, "revoked");
    const audit = await ctx.kernel.store.listAudit(ctx.orgId, 50);
    assert.ok(audit.some((a) => a.action === "client_revoked"));
    assert.ok(!JSON.stringify(audit).includes(body.token));
    const other = await ctx.kernel.createOrg("other", "user_b");
    const cross = await fetch(`${ctx.base}/api/clients/${body.client.id}/revoke`, {
      method: "POST",
      headers: {
        "x-test-channel": "operator",
        "x-test-user": "user_b",
        "x-test-org": other.orgId,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(cross.status, 404);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-31 JWT issuance via /oauth/token writes access_events (extraTokenClaims, not access_token.saved)", async () => {
  const ctx = await ledgerCtx();
  try {
    const registered = await fetch(`${ctx.base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ledger-jwt",
        redirect_uris: ["http://127.0.0.1:9999/cb"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.ok(registered.status === 200 || registered.status === 201);
    const client = (await registered.json()) as { client_id: string };
    assert.ok(client.client_id);

    const { verifier, challenge } = pkce();
    const audience = "http://127.0.0.1:8788/mcp";
    const found = await ctx.oidcProvider.Client.find(client.client_id);
    assert.ok(found);
    const grant = new ctx.oidcProvider.Grant({
      accountId: "user_owner",
      clientId: client.client_id,
    });
    grant.addOIDCScope("openid");
    grant.addResourceScope(audience, "mcp");
    const grantId = await grant.save();
    const codeEntity = new ctx.oidcProvider.AuthorizationCode({
      accountId: "user_owner",
      client: found,
      grantId,
      redirectUri: "http://127.0.0.1:9999/cb",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "openid mcp",
      resource: audience,
    });
    const code = await codeEntity.save();

    const tokenRes = await fetch(`${ctx.base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1:9999/cb",
        client_id: client.client_id,
        code_verifier: verifier,
        resource: audience,
      }),
    });
    const tokenBody = await tokenRes.text();
    assert.equal(tokenRes.status, 200, tokenBody);
    const tokens = JSON.parse(tokenBody) as { access_token?: string };
    assert.match(tokens.access_token ?? "", /^eyJ/);

    const events = await ctx.store.listAccessEvents(ctx.orgId, 20);
    assert.ok(events.some((e) => e.kind === "oauth_access"));
    const audit = await ctx.store.listAudit(ctx.orgId, 20);
    assert.ok(audit.some((a) => a.action === "token_issued"));
    assert.ok(!JSON.stringify(events).includes("eyJ"));
    assert.ok(!JSON.stringify(audit).includes(tokens.access_token ?? "missing"));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("revokeClient deletes only that client's refresh payloads", async () => {
  const ctx = await ledgerCtx();
  try {
    const a = await ctx.kernel.createModelClient({
      orgId: ctx.orgId,
      name: "client-a",
      environment: "staging",
      clerkOauthUserId: "dcr_keep_scope_a",
    });
    const b = await ctx.kernel.createModelClient({
      orgId: ctx.orgId,
      name: "client-b",
      environment: "staging",
      clerkOauthUserId: "dcr_keep_scope_b",
    });
    await ctx.store.upsertOidcPayload({
      id: "rt_a",
      kind: "RefreshToken",
      payload: JSON.stringify({ clientId: "dcr_keep_scope_a" }),
      expiresAt: null,
    });
    await ctx.store.upsertOidcPayload({
      id: "rt_b",
      kind: "RefreshToken",
      payload: JSON.stringify({ clientId: "dcr_keep_scope_b" }),
      expiresAt: null,
    });
    await ctx.store.upsertOidcPayload({
      id: "ac_a",
      kind: "AuthorizationCode",
      payload: JSON.stringify({ clientId: "dcr_keep_scope_a" }),
      expiresAt: null,
    });
    await ctx.store.upsertOidcPayload({
      id: "ac_b",
      kind: "AuthorizationCode",
      payload: JSON.stringify({ clientId: "dcr_keep_scope_b" }),
      expiresAt: null,
    });
    await ctx.kernel.revokeClient(ctx.orgId, "user_owner", a.client.id);
    const leftRt = await ctx.store.listOidcPayloads("RefreshToken");
    assert.equal(leftRt.length, 1);
    assert.equal(leftRt[0]?.id, "rt_b");
    const leftAc = await ctx.store.listOidcPayloads("AuthorizationCode");
    assert.equal(leftAc.length, 1);
    assert.equal(leftAc[0]?.id, "ac_b");
    assert.equal(b.client.id.startsWith("cli_"), true);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-32 grant revoke stays listed; AC-33 missing and revoked jti are 401", async () => {
  const ctx = await ledgerCtx();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "STRIPE_KEY",
      value: CANARY,
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
    });
    const { client } = await ctx.kernel.createModelClient({
      orgId: ctx.orgId,
      name: "grok",
      environment: "staging",
    });
    const asked = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: client.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    const rev = await fetch(`${ctx.base}/api/grants/${asked.grant.id}/revoke`, {
      method: "POST",
      headers: ctx.op,
      body: "{}",
    });
    assert.equal(rev.status, 200);
    const snap = await fetch(`${ctx.base}/api/access`, { headers: ctx.op });
    const json = (await snap.json()) as { grants: { id: string; status: string }[] };
    const g = json.grants.find((row) => row.id === asked.grant.id);
    assert.equal(g?.status, "revoked");

    const noJti = await new SignJWT({ client_id: "dcr_demo" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("http://127.0.0.1:8788")
      .setAudience("http://127.0.0.1:8788/mcp")
      .setExpirationTime("10m")
      .sign(await importJWK({ ...ctx.jwk }, "RS256"));
    const missing = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${noJti}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(missing.status, 401);

    await persistIssuedAccess(ctx.kernel, {
      jti: "jti-revoked",
      oauthClientId: "dcr_demo",
      accountId: "user_owner",
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    await ctx.store.revokeAccessEvent(
      createHash("sha256").update("jti-revoked").digest("hex"),
      new Date().toISOString(),
    );
    const withJti = await new SignJWT({ client_id: "dcr_demo" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("http://127.0.0.1:8788")
      .setAudience("http://127.0.0.1:8788/mcp")
      .setJti("jti-revoked")
      .setExpirationTime("10m")
      .sign(await importJWK({ ...ctx.jwk }, "RS256"));
    const denied = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${withJti}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(denied.status, 401);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-25 DCR rejects javascript; stores https redirect; AC-19 metadata", async () => {
  const ctx = await ledgerCtx();
  try {
    const meta = await fetch(`${ctx.base}/.well-known/oauth-authorization-server`);
    const doc = (await meta.json()) as {
      code_challenge_methods_supported: string[];
      response_types_supported: string[];
      revocation_endpoint: string;
    };
    assert.deepEqual(doc.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(doc.response_types_supported, ["code"]);
    assert.match(doc.revocation_endpoint, /\/oauth\/revoke$/);
    const pr = await fetch(`${ctx.base}/.well-known/oauth-protected-resource`);
    const prj = (await pr.json()) as { authorization_servers: string[]; resource: string };
    assert.doesNotMatch(JSON.stringify(prj), /clerk\./);
    assert.equal(prj.resource, "http://127.0.0.1:8788/mcp");
    const pathAware = await fetch(`${ctx.base}/.well-known/oauth-authorization-server/mcp`);
    assert.equal(pathAware.status, 200);
    assert.deepEqual(((await pathAware.json()) as { response_types_supported: string[] }).response_types_supported, [
      "code",
    ]);
    const oidc = await fetch(`${ctx.base}/.well-known/openid-configuration`);
    assert.equal(oidc.status, 200);

    const bad = await fetch(`${ctx.base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "evil",
        redirect_uris: ["javascript:alert(1)"],
      }),
    });
    assert.equal(bad.status, 400);

    const desktop = await fetch(`${ctx.base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://grok.x.ai" },
      body: JSON.stringify({
        client_name: "grok-desktop",
        redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback", "grok://oauth/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    });
    const desktopText = await desktop.text();
    assert.ok(desktop.status === 200 || desktop.status === 201, desktopText);
    const desktopBody = JSON.parse(desktopText) as { redirect_uris?: string[] };
    assert.ok(desktopBody.redirect_uris?.includes("cursor://anysphere.cursor-mcp/oauth/callback"));

    const ok = await fetch(`${ctx.base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://grok.x.ai" },
      body: JSON.stringify({
        client_name: "good",
        redirect_uris: ["https://evil.example/cb"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    });
    assert.ok(ok.status === 200 || ok.status === 201);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://grok.x.ai");
    assert.equal(ok.headers.get("x-frame-options"), "DENY");
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(ok.headers.get("strict-transport-security"), "max-age=63072000");
    const created = (await ok.json()) as { redirect_uris?: string[]; client_id?: string };
    assert.deepEqual(created.redirect_uris, ["https://evil.example/cb"]);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-26 wrong aud is rejected; AC-27 unauthenticated MCP has resource_metadata", async () => {
  const ctx = await ledgerCtx();
  try {
    const unauth = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_items", arguments: {} },
      }),
    });
    assert.equal(unauth.status, 401);
    assert.match(
      unauth.headers.get("www-authenticate") ?? "",
      /resource_metadata="http:\/\/127\.0\.0\.1:8788\/\.well-known\/oauth-protected-resource\/mcp"/,
    );

    const wrongAud = await new SignJWT({ client_id: "dcr_demo" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("http://127.0.0.1:8788")
      .setAudience("https://evil.example/mcp")
      .setJti("jti-wrong-aud")
      .setExpirationTime("10m")
      .sign(await importJWK({ ...ctx.jwk }, "RS256"));
    const res = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${wrongAud}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("R-34 refresh issuance writes access_events oauth_refresh and audit token_issued", async () => {
  const ctx = await ledgerCtx();
  try {
    await persistIssuedRefresh(ctx.kernel, {
      jti: "jti-refresh-1",
      oauthClientId: "dcr_refresh",
      accountId: "user_owner",
      exp: Math.floor(Date.now() / 1000) + 14 * 24 * 3600,
    });
    const events = await ctx.store.listAccessEvents(ctx.orgId, 20);
    const row = events.find((e) => e.kind === "oauth_refresh");
    assert.ok(row?.clientId);
    const client = await ctx.store.getClient(row.clientId);
    assert.ok(client?.lastTokenAt);
    const audit = await ctx.store.listAudit(ctx.orgId, 20);
    assert.ok(audit.some((a) => a.action === "token_issued"));
    assert.ok(!JSON.stringify(events).includes("jti-refresh-1"));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("R-39 persistRevokedToken marks access_events and audit token_revoked", async () => {
  const ctx = await ledgerCtx();
  try {
    await persistIssuedAccess(ctx.kernel, {
      jti: "jti-rfc7009",
      oauthClientId: "dcr_demo",
      accountId: "user_owner",
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    await persistRevokedToken(ctx.kernel, "jti-rfc7009");
    const events = await ctx.store.listAccessEvents(ctx.orgId, 20);
    const row = events.find((e) => e.jtiHash === createHash("sha256").update("jti-rfc7009").digest("hex"));
    assert.ok(row?.revokedAt);
    const audit = await ctx.store.listAudit(ctx.orgId, 20);
    assert.ok(audit.some((a) => a.action === "token_revoked"));
    assert.ok(!JSON.stringify(audit).includes("jti-rfc7009"));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("inject writes audit and access snapshot fetched names without the secret", async () => {
  const ctx = await ledgerCtx();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "STRIPE_KEY",
      value: CANARY,
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
    });
    const issued = await fetch(`${ctx.base}/api/clients/model`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ name: "grok", environment: "staging" }),
    });
    const body = (await issued.json()) as { token: string; client: { id: string } };
    const asked = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: body.client.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: asked.grant.id,
      policy: "item_standing",
      role: "owner",
      actor: "user_owner",
    });
    await ctx.kernel.prepareConnector({
      orgId: ctx.orgId,
      clientId: body.client.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    const snap = await fetch(`${ctx.base}/api/access`, { headers: ctx.op });
    assert.equal(snap.status, 200);
    const json = (await snap.json()) as {
      clients: {
        id: string;
        created_at: string | null;
        first_access_at: string | null;
        last_access_at: string | null;
        fetched: string[];
      }[];
      grants: { id: string; client_id: string; fetched: string[] }[];
    };
    assert.ok(!("audit" in json));
    assert.ok(!("events" in json));
    const client = json.clients.find((c) => c.id === body.client.id);
    assert.ok(client);
    assert.ok(client.created_at);
    assert.ok(client.first_access_at);
    assert.deepEqual(client.fetched, ["STRIPE_KEY"]);
    const grant = json.grants.find((g) => g.id === asked.grant.id);
    assert.equal(grant?.client_id, body.client.id);
    assert.deepEqual(grant?.fetched, ["STRIPE_KEY"]);
    const raw = JSON.stringify(json);
    assert.doesNotMatch(raw, /avm_/);
    assert.ok(!raw.includes(CANARY));
    const auditRes = await fetch(`${ctx.base}/api/audit`, { headers: ctx.op });
    const auditJson = (await auditRes.json()) as {
      audit: { action: string; itemName: string | null; clientId: string | null }[];
    };
    assert.ok(auditJson.audit.some((a) => a.action === "inject" && a.itemName === "STRIPE_KEY"));
    assert.ok(!JSON.stringify(auditJson).includes(CANARY));
    const filtered = await fetch(
      `${ctx.base}/api/audit?client_id=${encodeURIComponent(body.client.id)}`,
      { headers: ctx.op },
    );
    const filteredJson = (await filtered.json()) as { audit: { action: string; clientId: string | null }[] };
    assert.ok(filteredJson.audit.every((a) => a.clientId === body.client.id));
    assert.ok(filteredJson.audit.some((a) => a.action === "inject"));
    const miss = await fetch(`${ctx.base}/api/audit?client_id=cli_missing`, { headers: ctx.op });
    const missJson = (await miss.json()) as { audit: { action: string }[] };
    assert.ok(!missJson.audit.some((a) => a.action === "inject"));
    const byItem = await fetch(`${ctx.base}/api/audit?item_name=STRIPE_KEY`, { headers: ctx.op });
    const byItemJson = (await byItem.json()) as { audit: { itemName: string | null }[] };
    assert.ok(byItemJson.audit.length > 0);
    assert.ok(byItemJson.audit.every((a) => a.itemName === "STRIPE_KEY"));
    const trusted = await ctx.kernel.createTrustedClient({
      orgId: ctx.orgId,
      name: "runner",
      environment: "staging",
    });
    const trustedGrant = await ctx.kernel.requestGrant({
      orgId: ctx.orgId,
      clientId: trusted.client.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    await ctx.kernel.approveGrant({
      orgId: ctx.orgId,
      grantId: trustedGrant.grant.id,
      policy: "item_standing",
      role: "owner",
      actor: "user_owner",
    });
    await ctx.kernel.resolveTrusted({
      orgId: ctx.orgId,
      clientId: trusted.client.id,
      itemName: "STRIPE_KEY",
      environment: "staging",
    });
    const afterTrusted = await ctx.store.listAudit(ctx.orgId, 50);
    assert.ok(
      afterTrusted.some((a) => a.action === "inject" && a.clientId === trusted.client.id && a.itemName === "STRIPE_KEY"),
    );
    assert.ok(!JSON.stringify(afterTrusted).includes(CANARY));
    assert.ok(!JSON.stringify(afterTrusted).includes(trusted.plaintext));
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});
