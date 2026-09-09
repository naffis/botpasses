import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONVENTIONAL_DISCOVERY_PATHS,
  canonicalSitePath,
  isPublicSitePath,
  resolveSiteFile,
  staticHeaders,
} from "../src/hosted/static-site.ts";

const dist = join(process.cwd(), "site/dist");

test("canonicalSitePath strips .html and trailing slash and folds index", () => {
  assert.equal(canonicalSitePath("/index.html"), "/");
  assert.equal(canonicalSitePath("/docs/start.html"), "/docs/start");
  assert.equal(canonicalSitePath("/docs/"), "/docs");
  assert.equal(canonicalSitePath("/"), "/");
  assert.equal(canonicalSitePath("/security"), "/security");
});

test("isPublicSitePath accepts canonical, .html, and trailing-slash forms of site pages", () => {
  for (const p of ["/", "/index.html", "/security", "/security.html", "/security/", "/docs", "/docs/", "/docs/start.html"]) {
    assert.equal(isPublicSitePath(p), true, p);
  }
  for (const p of ["/llms.txt", "/llms-full.txt", "/.well-known/security.txt", "/security.txt", "/sitemap.xml", "/sitemap-index.xml", "/sitemap-0.xml", "/favicon.ico", "/apple-touch-icon.png", "/_astro/x.css", "/pagefind/pagefind.js"]) {
    assert.equal(isPublicSitePath(p), true, p);
  }
  for (const p of ["/console", "/console/", "/api/items", "/mcp", "/sign-in", "/anything"]) {
    assert.equal(isPublicSitePath(p), false, p);
  }
});

test("staticHeaders: html revalidates, _astro is immutable, other assets live an hour", () => {
  assert.equal(staticHeaders("/site/dist/index.html")["cache-control"], "no-cache");
  assert.equal(staticHeaders("/site/dist/docs/start.html")["cache-control"], "no-cache");
  assert.equal(staticHeaders("/site/dist/_astro/claude.abc12345.css")["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(staticHeaders("/site/dist/_astro/fraunces-latin-700-normal.CEOla-zY.woff2")["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(staticHeaders("/site/dist/favicon.svg")["cache-control"], "public, max-age=3600");
  assert.equal(staticHeaders("/site/dist/pagefind/pagefind.js")["cache-control"], "public, max-age=3600");
  const html = staticHeaders("/site/dist/index.html");
  assert.equal(html["referrer-policy"], undefined, "referrer policy comes from securityHeaders, not here");
  assert.equal(html["x-content-type-options"], "nosniff");
});

test("staticHeaders knows fonts, wasm, pagefind chunks, txt, and xml", () => {
  const type = (f: string) => staticHeaders(f)["content-type"];
  assert.equal(type("a.woff"), "font/woff");
  assert.equal(type("a.woff2"), "font/woff2");
  assert.equal(type("a.wasm"), "application/wasm");
  assert.equal(type("pagefind/wasm.en.pagefind"), "application/octet-stream");
  assert.equal(type("x.pf_meta"), "application/octet-stream");
  assert.equal(type("x.pf_index"), "application/octet-stream");
  assert.equal(type("x.pf_fragment"), "application/octet-stream");
  assert.equal(type("llms.txt"), "text/plain; charset=utf-8");
  assert.equal(type("sitemap.xml"), "application/xml; charset=utf-8");
  assert.equal(type("sitemap-0.xml"), "application/xml; charset=utf-8");
  assert.equal(type("favicon.ico"), "image/x-icon");
  assert.equal(type("apple-touch-icon.png"), "image/png");
  assert.equal(type("a.unknown"), "application/octet-stream");
});

test("resolveSiteFile maps extensionless site paths to built HTML and refuses escapes", () => {
  assert.ok(resolveSiteFile(dist, "/")?.endsWith("index.html"));
  assert.ok(resolveSiteFile(dist, "/docs/start")?.endsWith(join("docs", "start.html")));
  assert.ok(resolveSiteFile(dist, "/404")?.endsWith("404.html"));
  assert.ok(resolveSiteFile(dist, "/.well-known/security.txt")?.endsWith("security.txt"));
  for (const path of CONVENTIONAL_DISCOVERY_PATHS) {
    assert.equal(isPublicSitePath(path), true, path);
    assert.ok(resolveSiteFile(dist, path), `${path} must resolve to a dist file`);
  }
  assert.equal(resolveSiteFile(dist, "/../package.json"), undefined);
  assert.equal(resolveSiteFile(dist, "/%2e%2e/package.json"), undefined);
  assert.equal(resolveSiteFile(dist, "/docs/does-not-exist"), undefined);
});
