import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { assertHostedBoot, HOSTED_CONFIG_EXIT, hostedBootError } from "../src/hosted/boot.ts";
import { testAuthResolver } from "../src/hosted/auth.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { identityAuthResolver } from "../src/hosted/identity.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { OperatorIdentity } from "../src/hosted/operator-identity.ts";
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
    authResolver: testAuthResolver,
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
    assert.match(html, /id="hero-title">Let agents work\./);
    assert.match(html, /data-access-demo/);
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
    assert.match(body, /Sitemap: https:\/\/botpasses\.com\/sitemap\.xml/);
    assert.match(body, /llms\.txt/);
    assert.match(body, /llms-full\.txt/);
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

test("site: .html and trailing-slash URLs 308 to the canonical path; /console/ is untouched", async () => {
  const ctx = await siteServer();
  try {
    const cases: [string, string][] = [
      ["/index.html", "/"],
      ["/docs/start.html", "/docs/start"],
      ["/docs/", "/docs"],
      ["/security/", "/security"],
      ["/docs/connect/grok.html?x=1", "/docs/connect/grok?x=1"],
    ];
    for (const [from, to] of cases) {
      const res = await fetch(`${ctx.base}${from}`, { redirect: "manual" });
      assert.equal(res.status, 308, from);
      assert.equal(res.headers.get("location"), to, from);
    }
    const console_ = await fetch(`${ctx.base}/console/`, { redirect: "manual" });
    assert.equal(console_.status, 308);
    assert.equal(console_.headers.get("location"), "/console");
    const canonical = await fetch(`${ctx.base}/docs/start`);
    assert.equal(canonical.status, 200);
    assert.match(await canonical.text(), /<link rel="canonical" href="https:\/\/botpasses\.com\/docs\/start">/);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("site: unknown docs path is the HTML 404 page, not JSON", async () => {
  const ctx = await siteServer();
  try {
    for (const path of ["/docs/does-not-exist", "/docs/how-to/nope.html", "/_astro/missing.css"]) {
      const res = await fetch(`${ctx.base}${path}`);
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/, path);
      assert.match(await res.text(), /<h1>Page not found<\/h1>/, path);
      assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/, path);
    }
    const head = await fetch(`${ctx.base}/docs/does-not-exist`, { method: "HEAD" });
    assert.equal(head.status, 404);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("site: hashed assets are immutable, sitemaps and text files are served", async () => {
  const ctx = await siteServer();
  try {
    const home = await (await fetch(`${ctx.base}/`)).text();
    const font = /href="(\/_astro\/[^"]+\.woff2)"/.exec(home)?.[1];
    assert.ok(font, "preloaded font href");
    const asset = await fetch(`${ctx.base}${font}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(asset.headers.get("content-type"), "font/woff2");
    assert.equal(asset.headers.get("x-content-type-options"), "nosniff");

    const favicon = await fetch(`${ctx.base}/favicon.svg`);
    assert.equal(favicon.headers.get("cache-control"), "public, max-age=3600");

    for (const [path, type] of [
      ["/sitemap.xml", /application\/xml/],
      ["/sitemap-index.xml", /application\/xml/],
      ["/sitemap-0.xml", /application\/xml/],
      ["/llms.txt", /text\/plain/],
      ["/llms-full.txt", /text\/plain/],
      ["/.well-known/security.txt", /text\/plain/],
      ["/security.txt", /text\/plain/],
      ["/favicon.ico", /image\/x-icon/],
      ["/favicon.svg", /image\/svg\+xml/],
      ["/mark.svg", /image\/svg\+xml/],
      ["/mark-on-dark.svg", /image\/svg\+xml/],
      ["/apple-touch-icon.png", /image\/png/],
      ["/og.png", /image\/png/],
      ["/og-square.png", /image\/png/],
      ["/logo.png", /image\/png/],
      ["/android-chrome-192x192.png", /image\/png/],
      ["/android-chrome-512x512.png", /image\/png/],
      ["/site.webmanifest", /application\/manifest\+json/],
    ] as const) {
      const res = await fetch(`${ctx.base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", type, path);
    }
    const sitemap = await (await fetch(`${ctx.base}/sitemap.xml`)).text();
    assert.match(sitemap, /<urlset\b/);
    assert.match(sitemap, /<loc>https:\/\/botpasses\.com\/<\/loc>/);
    const sec = await (await fetch(`${ctx.base}/.well-known/security.txt`)).text();
    assert.match(sec, /Contact: mailto:security@botpasses\.com/);
    const rootSec = await (await fetch(`${ctx.base}/security.txt`)).text();
    assert.equal(rootSec, sec);
    const ico = Buffer.from(await (await fetch(`${ctx.base}/favicon.ico`)).arrayBuffer());
    assert.equal(ico.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])), true);
    const apple = Buffer.from(await (await fetch(`${ctx.base}/apple-touch-icon.png`)).arrayBuffer());
    assert.equal(apple.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);

    const pf = await fetch(`${ctx.base}/pagefind/pagefind-ui.js`);
    assert.equal(pf.status, 200);
    assert.match(pf.headers.get("content-type") ?? "", /text\/javascript/);
    const wasm = await fetch(`${ctx.base}/pagefind/wasm.en.pagefind`);
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers.get("content-type"), "application/octet-stream");
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("site: paths with no conventional twin stay JSON 404", async () => {
  const ctx = await siteServer();
  try {
    for (const path of ["/humans.txt", "/ads.txt", "/feed.xml"]) {
      const res = await fetch(`${ctx.base}${path}`);
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/, path);
      assert.deepEqual(await res.json(), { error: "not found" });
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
    assert.match(html, /Issue agent token/);
    assert.match(html, /data-testid="console-signin"/);
    assert.match(html, /data-testid="access-panel"/);
    assert.match(html, /data-testid="item-delete-confirm"/);
    assert.match(html, /data-testid="app-shell"/);
    assert.match(res.headers.get("content-security-policy") ?? "", /font-src 'self'/);
    assert.match(res.headers.get("content-security-policy") ?? "", /img-src 'self'/);
    assert.match(html, /data-environments="staging"/);
    assert.doesNotMatch(html, /<option value="production">/);
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

/** Request with an explicit Host (fetch will not let a test forge one). */
function requestWithHost(
  port: number,
  host: string,
  path: string,
  opts: { method?: string; origin?: string } = {},
): Promise<{ status: number; body: string; type: string; acao: string | null }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host };
    if (opts.origin) headers.origin = opts.origin;
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            type: String(res.headers["content-type"] ?? ""),
            acao: typeof res.headers["access-control-allow-origin"] === "string"
              ? res.headers["access-control-allow-origin"]
              : null,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function getWithHost(port: number, host: string, path: string): Promise<{ status: number; body: string }> {
  return requestWithHost(port, host, path);
}

test("B9 the marketing site is served only on an allowed Host; a foreign or loopback Host on a public plane is refused", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kek = parseMasterKey(generateMasterKey());
  // The kernel pins a staging plane to its real origin, so that is the one allowed Host.
  const publicUrl = "https://staging.botpasses.com";
  const kernel = new HostedKernel({ store, kek, publicUrl, deployPlane: "staging" });
  const identity = new OperatorIdentity({ store, sessionSecret: TEST_SESSION_SECRET, kek });
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    publicUrl,
    siteRoot: SITE,
    deployPlane: "staging",
    identity,
    authResolver: identityAuthResolver({ identity, kernel, secureCookies: true }),
  });
  const addr = await http.listen();
  try {
    const ok = await getWithHost(addr.port, "staging.botpasses.com", "/");
    assert.equal(ok.status, 200);
    assert.match(ok.body, /<h1\b/);
    for (const host of ["evil.example.com", "staging.botpasses.com.evil.net", "botpasses.com", "127.0.0.1", "localhost"]) {
      for (const path of ["/", "/docs/start", "/security", "/favicon.svg", "/_astro/missing.css"]) {
        const res = await getWithHost(addr.port, host, path);
        assert.equal(res.status, 403, `${host} ${path}`);
        assert.doesNotMatch(res.body, /<h1\b|<html/, `${host} ${path} must not serve the site`);
      }
    }
    // Platform health checks do not carry the public Host and stay reachable.
    assert.equal((await getWithHost(addr.port, "evil.example.com", "/health")).status, 200);
  } finally {
    await http.close();
    await store.close();
    cleanup(home);
  }
});

test("public site GET/HEAD/OPTIONS from a foreign Origin still serve cards and icons", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const publicUrl = "https://staging.botpasses.com";
  const kek = parseMasterKey(generateMasterKey());
  const kernel = new HostedKernel({
    store,
    kek,
    publicUrl,
    deployPlane: "staging",
  });
  const identity = new OperatorIdentity({ store, sessionSecret: TEST_SESSION_SECRET, kek });
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    publicUrl,
    siteRoot: SITE,
    deployPlane: "staging",
    identity,
    authResolver: identityAuthResolver({ identity, kernel, secureCookies: true }),
  });
  const addr = await http.listen();
  const host = "staging.botpasses.com";
  const unfurl = "https://composer.example";
  const other = "https://cards.example";
  try {
    for (const [path, type] of [
      ["/favicon.ico", /image\/x-icon/],
      ["/og.png", /image\/png/],
      ["/og-square.png", /image\/png/],
      ["/logo.png", /image\/png/],
      ["/apple-touch-icon.png", /image\/png/],
    ] as const) {
      const res = await requestWithHost(addr.port, host, path, { origin: unfurl });
      assert.equal(res.status, 200, path);
      assert.match(res.type, type, path);
      assert.equal(res.acao, unfurl, path);
    }
    const page = await requestWithHost(addr.port, host, "/", { origin: other });
    assert.equal(page.status, 200);
    assert.match(page.body, /<h1\b/);
    assert.equal(page.acao, other);
    const preflight = await requestWithHost(addr.port, host, "/og.png", {
      method: "OPTIONS",
      origin: unfurl,
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.acao, unfurl);
    const head = await requestWithHost(addr.port, host, "/logo.png", {
      method: "HEAD",
      origin: other,
    });
    assert.equal(head.status, 200);
    assert.equal(head.acao, other);
    for (const path of ["/api/items", "/sign-in", "/console"]) {
      const locked = await requestWithHost(addr.port, host, path, { origin: "https://evil.example" });
      assert.equal(locked.status, 403, path);
      assert.equal(locked.acao, null, path);
    }
    const wrongHost = await requestWithHost(addr.port, "evil.example.com", "/favicon.ico", {
      origin: unfurl,
    });
    assert.equal(wrongHost.status, 403);
    assert.doesNotMatch(wrongHost.body, /<h1\b|<html/);
  } finally {
    await http.close();
    await store.close();
    cleanup(home);
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
  // R2-4: the retiring key's shape is a boot error too, before the KEK is unwrapped (exit 78, not 1).
  const withPrevious = {
    VAULT_MODE: "hosted",
    DATABASE_URL: "postgres://x",
    VAULT_KEK: "aa".repeat(32),
    VAULT_PUBLIC_URL: "https://staging.botpasses.com",
    VAULT_DEPLOY_PLANE: "staging",
    VAULT_SESSION_SECRET: TEST_SESSION_SECRET,
    VAULT_OIDC_PRIVATE_JWK: testOidcPrivateJwk(),
    VAULT_SITE_ROOT: SITE,
  };
  assert.equal(hostedBootError(withPrevious), undefined, "control: the env boots");
  assert.equal(hostedBootError({ ...withPrevious, VAULT_OIDC_PREVIOUS_JWK: testOidcPrivateJwk() }), undefined);
  assert.equal(hostedBootError({ ...withPrevious, VAULT_OIDC_PREVIOUS_JWK: "  " }), undefined, "blank is unset");
  assert.match(
    hostedBootError({ ...withPrevious, VAULT_OIDC_PREVIOUS_JWK: '{"kty":"EC","alg":"ES256","d":"x"}' }) ?? "",
    /VAULT_OIDC_PREVIOUS_JWK/,
  );
  assert.throws(() => assertHostedBoot({ ...withPrevious, VAULT_OIDC_PREVIOUS_JWK: "{" }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /VAULT_OIDC_PREVIOUS_JWK/);
    assert.equal((err as Error & { exitCode?: number }).exitCode, HOSTED_CONFIG_EXIT);
    return true;
  });
});
