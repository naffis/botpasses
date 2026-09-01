import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HOSTED_CONFIG_EXIT, hostedBootError } from "../src/hosted/boot.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { TEST_SESSION_SECRET, cleanup, tempHome, testOidcPrivateJwk } from "./helpers.ts";

const SITE = join(process.cwd(), "site/dist");

async function siteServer(plane: "staging" | "production" = "staging") {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: "http://127.0.0.1:8788",
    deployPlane: plane,
  });
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    siteRoot: SITE,
    deployPlane: plane,
  });
  const addr = await http.listen();
  return { home, store, http, base: `http://${addr.host}:${addr.port}` };
}

test("AC-01 fixture dist GET / is marketing", async () => {
  const ctx = await siteServer();
  try {
    const res = await fetch(`${ctx.base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<h1>Named credentials for agents\. The model never sees the value\.<\/h1>/);
    assert.match(html, /href="\/sign-up"/);
    assert.match(html, /href="\/sign-in"/);
    assert.doesNotMatch(html, /Operator token/);
    assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/);
    assert.match(res.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.match(res.headers.get("content-security-policy") ?? "", /style-src 'unsafe-inline' 'self'/);
    assert.match(res.headers.get("content-security-policy") ?? "", /img-src 'self'/);
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

test("AC-05 static jail rejects traversal", async () => {
  const ctx = await siteServer();
  try {
    for (const path of ["/../src/hosted/http.ts", "/%2e%2e/package.json"]) {
      const res = await fetch(`${ctx.base}${path}`);
      const body = await res.text();
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(body, /createHostedServer/);
      assert.doesNotMatch(body, /"name": "botpasses"/);
    }
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-06 robots staging allow and prod disallow console", async () => {
  const staging = await siteServer("staging");
  try {
    const res = await fetch(`${staging.base}/robots.txt`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.doesNotMatch(body, /Disallow: \//);
    assert.match(body, /Allow: \//);
  } finally {
    await staging.http.close();
    await staging.store.close();
    cleanup(staging.home);
  }
  const prod = await siteServer("production");
  try {
    const res = await fetch(`${prod.base}/robots.txt`);
    const body = await res.text();
    assert.match(body, /Allow: \/docs/);
    assert.match(body, /Disallow: \/console/);
    assert.match(body, /Disallow: \/sign-in/);
  } finally {
    await prod.http.close();
    await prod.store.close();
    cleanup(prod.home);
  }
});

test("AC-03 docs and pagefind exist", async () => {
  const ctx = await siteServer();
  try {
    assert.equal((await fetch(`${ctx.base}/docs/start`)).status, 200);
    assert.equal((await fetch(`${ctx.base}/docs`)).status, 200);
    const pf = await fetch(`${ctx.base}/pagefind/pagefind-entry.json`);
    assert.ok(pf.status === 200 || pf.status === 404);
    if (pf.status === 404) {
      const alt = await fetch(`${ctx.base}/pagefind/pagefind.js`);
      assert.equal(alt.status, 200);
    }
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-02 GET /console is the hosted console", async () => {
  const ctx = await siteServer();
  try {
    const res = await fetch(`${ctx.base}/console`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Issue Grok Bot token/);
    assert.match(html, /data-testid="console-signin"/);
    assert.match(html, /data-testid="access-panel"/);
    assert.match(html, /data-testid="access-revoke-confirm"/);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-15 invalid bearer on marketing is 200; on API is 401", async () => {
  const ctx = await siteServer();
  try {
    const page = await fetch(`${ctx.base}/`, { headers: { authorization: "Bearer not-a-token" } });
    assert.equal(page.status, 200);
    const api = await fetch(`${ctx.base}/api/items`, { headers: { authorization: "Bearer not-a-token" } });
    assert.equal(api.status, 401);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("AC-10b boot without session or JWK exits 78", () => {
  assert.equal(HOSTED_CONFIG_EXIT, 78);
  assert.match(
    hostedBootError({
      VAULT_MODE: "hosted",
      DATABASE_URL: "postgres://x",
      VAULT_KEK: "aa".repeat(32),
      VAULT_PUBLIC_URL: "https://staging.botpasses.com",
      VAULT_DEPLOY_PLANE: "staging",
      VAULT_OIDC_PRIVATE_JWK: testOidcPrivateJwk(),
    }) ?? "",
    /VAULT_SESSION_SECRET/,
  );
  assert.match(
    hostedBootError({
      VAULT_MODE: "hosted",
      DATABASE_URL: "postgres://x",
      VAULT_KEK: "aa".repeat(32),
      VAULT_PUBLIC_URL: "https://staging.botpasses.com",
      VAULT_DEPLOY_PLANE: "staging",
      VAULT_SESSION_SECRET: TEST_SESSION_SECRET,
      VAULT_OIDC_PRIVATE_JWK: '{"kty":"EC","alg":"ES256","d":"x"}',
    }) ?? "",
    /VAULT_OIDC_PRIVATE_JWK/,
  );
});
