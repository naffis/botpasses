import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const dist = join(process.cwd(), "site/dist");
const SITE = "https://botpasses.com";

/** Routes the hosted server answers itself; internal links to these are valid without a dist file. */
const SERVER_ROUTES = [
  "/sign-in",
  "/sign-up",
  "/console",
  "/enroll-totp",
  "/device",
  "/consent",
  "/collect",
  "/mcp",
  "/oauth/",
  "/api/",
  "/approve",
  "/runtime/resolve",
  "/health",
  "/ready",
  "/robots.txt",
  "/.well-known/",
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

type Page = { file: string; url: string; html: string; redirect: boolean };

function pages(): Page[] {
  return walk(dist)
    .filter((f) => f.endsWith(".html"))
    .map((file) => {
      const html = readFileSync(file, "utf8");
      const rel = relative(dist, file).replace(/\\/g, "/");
      const path = rel === "index.html" ? "/" : `/${rel.replace(/\.html$/, "")}`;
      return { file, url: path, html, redirect: /http-equiv="refresh"/.test(html) };
    });
}

function attr(html: string, re: RegExp): string | undefined {
  return re.exec(html)?.[1];
}

function canonicalOf(html: string): string | undefined {
  return attr(html, /<link rel="canonical" href="([^"]+)"/);
}

function sitemapUrls(): Set<string> {
  const xml = readFileSync(join(dist, "sitemap-0.xml"), "utf8");
  return new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? ""));
}

test("sitemap-index and sitemap-0 exist and every listed URL is extensionless", () => {
  assert.ok(existsSync(join(dist, "sitemap-index.xml")));
  assert.ok(existsSync(join(dist, "sitemap-0.xml")));
  assert.ok(!existsSync(join(dist, "sitemap.xml")), "sitemap.xml is not emitted; the index is sitemap-index.xml");
  const urls = sitemapUrls();
  assert.ok(urls.size >= 25, `expected at least 25 sitemap URLs, got ${urls.size}`);
  for (const u of urls) {
    assert.doesNotMatch(u, /\.html$/, u);
    if (u !== `${SITE}/`) assert.doesNotMatch(u, /\/$/, u);
  }
});

test("every canonical page has a canonical equal to its sitemap URL", () => {
  const urls = sitemapUrls();
  const all = pages().filter((p) => !p.redirect && p.url !== "/404");
  assert.ok(all.length >= 25);
  for (const p of all) {
    const canonical = canonicalOf(p.html);
    assert.equal(canonical, `${SITE}${p.url}`, `${p.file} canonical`);
    assert.ok(urls.has(canonical ?? ""), `${canonical} missing from sitemap`);
  }
  for (const u of urls) {
    const path = u.replace(SITE, "") || "/";
    const file = path === "/" ? join(dist, "index.html") : join(dist, `${path.slice(1)}.html`);
    assert.ok(existsSync(file), `${u} in sitemap but ${file} is missing`);
  }
});

test("redirect stubs point at a canonical page that exists", () => {
  const stubs = pages().filter((p) => p.redirect);
  assert.ok(stubs.length >= 3, "expected the three legacy redirects");
  const expected = new Map([
    ["/docs/how-to/connect-cursor", "/docs/connect/cursor"],
    ["/docs/how-to/connect-claude-code", "/docs/connect/claude-code"],
    ["/docs/connect/openai", "/docs/connect/chatgpt"],
  ]);
  for (const [from, to] of expected) {
    const stub = stubs.find((s) => s.url === from);
    assert.ok(stub, `${from} redirect stub missing`);
    assert.match(stub.html, new RegExp(`url=${to.replace(/\//g, "\\/")}"`));
    assert.equal(canonicalOf(stub.html), `${SITE}${to}`);
    assert.ok(existsSync(join(dist, `${to.slice(1)}.html`)), `${to} target missing`);
  }
});

test("every page has a unique description, a suffixed title, and one h1", () => {
  const seen = new Map<string, string>();
  for (const p of pages().filter((x) => !x.redirect)) {
    const desc = attr(p.html, /<meta name="description" content="([^"]+)"/);
    assert.ok(desc && desc.length >= 20, `${p.url} description`);
    const dup = seen.get(desc);
    assert.equal(dup, undefined, `${p.url} shares a description with ${dup}`);
    seen.set(desc, p.url);
    const title = attr(p.html, /<title>([^<]+)<\/title>/) ?? "";
    assert.match(title, / · Botpasses$/, `${p.url} title suffix`);
    assert.doesNotMatch(title, /—/, `${p.url} title em-dash`);
    assert.equal((p.html.match(/<h1[\s>]/g) ?? []).length, 1, `${p.url} h1 count`);
  }
});

test("social and theme meta tags are complete on every page", () => {
  for (const p of pages().filter((x) => !x.redirect)) {
    const canonical = canonicalOf(p.html);
    assert.equal(attr(p.html, /<meta property="og:url" content="([^"]+)"/), canonical, `${p.url} og:url`);
    assert.equal(attr(p.html, /<meta property="og:site_name" content="([^"]+)"/), "Botpasses", p.url);
    assert.equal(attr(p.html, /<meta property="og:image" content="([^"]+)"/), `${SITE}/og.png`, p.url);
    assert.equal(attr(p.html, /<meta property="og:image:width" content="([^"]+)"/), "1200", p.url);
    assert.equal(attr(p.html, /<meta property="og:image:height" content="([^"]+)"/), "630", p.url);
    assert.ok(attr(p.html, /<meta property="og:image:alt" content="([^"]+)"/), `${p.url} og:image:alt`);
    assert.equal(attr(p.html, /<meta name="twitter:card" content="([^"]+)"/), "summary_large_image", p.url);
    assert.ok(attr(p.html, /<meta name="twitter:title" content="([^"]+)"/), `${p.url} twitter:title`);
    assert.ok(attr(p.html, /<meta name="twitter:description" content="([^"]+)"/), `${p.url} twitter:description`);
    assert.equal(attr(p.html, /<meta name="twitter:image" content="([^"]+)"/), `${SITE}/og.png`, p.url);
    assert.equal(attr(p.html, /<meta name="theme-color" content="([^"]+)"/), "#0B0F0C", p.url);
    assert.match(p.html, /<link rel="preload" href="\/_astro\/fraunces-latin-700-normal\.[^"]+\.woff2" as="font"/, `${p.url} preload`);
    assert.match(p.html, /:root\{color-scheme:dark;--bg: #0B0F0C;/, `${p.url} inline tokens`);
    assert.doesNotMatch(p.html, /<link rel="stylesheet" href="\/_astro\//, `${p.url} stylesheet should be inlined`);
  }
});

test("no page carries an inline executable script or a data: URI (the CSP would block them)", () => {
  for (const p of pages().filter((x) => !x.redirect)) {
    for (const tag of p.html.match(/<script[^>]*>/g) ?? []) {
      const ok = /\ssrc="\//.test(tag) || /type="application\/ld\+json"/.test(tag);
      assert.ok(ok, `${p.url} has an inline script: ${tag}`);
    }
    assert.doesNotMatch(p.html, /(src|href)="data:/, `${p.url} data: URI`);
  }
});

test("docs pages load Pagefind, mark the current page, and wrap tables", () => {
  const docs = pages().filter((p) => !p.redirect && (p.url === "/docs" || p.url.startsWith("/docs/")));
  assert.ok(docs.length >= 20);
  for (const p of docs) {
    assert.match(p.html, /<script src="\/pagefind\/pagefind-ui\.js"/, `${p.url} pagefind-ui.js`);
    assert.match(p.html, /<link rel="stylesheet" href="\/pagefind\/pagefind-ui\.css"/, `${p.url} pagefind css`);
    assert.match(p.html, /data-testid="docs-search"/, p.url);
    assert.match(p.html, /data-pagefind-body/, p.url);
    assert.match(p.html, /"@type":"BreadcrumbList"/, p.url);
    assert.match(p.html, /<nav class="crumbs" aria-label="Breadcrumb">/, p.url);
    if (p.url !== "/docs") {
      assert.ok((p.html.match(/aria-current="page"/g) ?? []).length >= 2, `${p.url} aria-current in sidebar and crumbs`);
    }
    assert.doesNotMatch(p.html.replace(/<div class="table-wrap">\s*<table/g, ""), /<table/, `${p.url} unwrapped table`);
    for (const th of p.html.match(/<th(?=[\s>])[^>]*>/g) ?? []) assert.match(th, /scope="col"/, `${p.url} th scope`);
    for (const pre of p.html.match(/<pre[^>]*>/g) ?? []) assert.match(pre, /tabindex="0"/, `${p.url} pre tabindex`);
    for (const table of p.html.match(/<table[^>]*>/g) ?? []) assert.match(table, /aria-label="/, `${p.url} table label`);
  }
  assert.ok(existsSync(join(dist, "pagefind/pagefind-ui.js")));
  assert.ok(existsSync(join(dist, "pagefind/pagefind.js")));
});

test("every internal link resolves to a dist file or a known server route", () => {
  const missing: string[] = [];
  for (const p of pages()) {
    for (const m of p.html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
      const href = m[1] ?? "";
      if (href === "/") continue;
      const served = SERVER_ROUTES.some((r) => (r.endsWith("/") ? href.startsWith(r) : href === r || href.startsWith(`${r}/`)));
      if (served) continue;
      const rel = href.slice(1);
      const ok = existsSync(join(dist, rel)) || existsSync(join(dist, `${rel}.html`));
      if (!ok) missing.push(`${p.url} -> ${href}`);
    }
    for (const m of p.html.matchAll(/href="(#[^"]+)"/g)) {
      const id = (m[1] ?? "").slice(1);
      if (id === "content" || id === "top") continue;
      assert.match(p.html, new RegExp(`id="${id}"`), `${p.url} anchor #${id}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("llms.txt and security.txt ship with the site", () => {
  const llms = readFileSync(join(dist, "llms.txt"), "utf8");
  assert.match(llms, /^# Botpasses/);
  assert.match(llms, /http_request/);
  for (const link of llms.matchAll(/\]\((https:\/\/botpasses\.com[^)]*)\)/g)) {
    const path = (link[1] ?? "").replace(SITE, "");
    if (SERVER_ROUTES.some((r) => path.startsWith(r))) continue;
    const rel = path.slice(1);
    assert.ok(existsSync(join(dist, rel)) || existsSync(join(dist, `${rel}.html`)), `llms.txt link ${path}`);
  }
  const sec = readFileSync(join(dist, ".well-known/security.txt"), "utf8");
  assert.match(sec, /^Contact: mailto:security@botpasses\.com$/m);
  assert.match(sec, /^Preferred-Languages: en$/m);
  const expires = /^Expires: (.+)$/m.exec(sec)?.[1] ?? "";
  assert.ok(new Date(expires).getTime() > Date.now(), "security.txt has expired");
});

test("404 page is real HTML, noindex, and not in the sitemap", () => {
  const html = readFileSync(join(dist, "404.html"), "utf8");
  assert.match(html, /<h1>Page not found<\/h1>/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.ok(!sitemapUrls().has(`${SITE}/404`));
});
