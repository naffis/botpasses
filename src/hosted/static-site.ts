import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logVaultEvent } from "./observe.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  // Pagefind index chunks and its gzip-compressed wasm (`wasm.en.pagefind`). Binary,
  // fetched and decompressed by pagefind.js, so not `application/wasm`.
  ".pf_meta": "application/octet-stream",
  ".pf_index": "application/octet-stream",
  ".pf_fragment": "application/octet-stream",
  ".pagefind": "application/octet-stream",
};

const PUBLIC_STATIC = new Set([
  "/",
  "/design",
  "/security",
  "/privacy",
  "/terms",
  "/changelog",
  "/favicon.svg",
  "/og.png",
  "/robots.txt",
  "/llms.txt",
  "/.well-known/security.txt",
  "/sitemap-index.xml",
]);

const CACHE_HTML = "no-cache";
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
const CACHE_ASSET = "public, max-age=3600";

/**
 * Canonical form of a site URL: no `.html`, no trailing slash, `/index` folded to `/`.
 * Returns the input unchanged when it is already canonical.
 */
export function canonicalSitePath(path: string): string {
  let out = path;
  if (out.endsWith(".html")) out = out.slice(0, -".html".length);
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  if (out === "/index" || out === "") out = "/";
  return out;
}

export function isPublicSitePath(path: string): boolean {
  const canonical = canonicalSitePath(path);
  if (PUBLIC_STATIC.has(canonical)) return true;
  if (canonical === "/docs" || canonical.startsWith("/docs/")) return true;
  if (path.startsWith("/pagefind/")) return true;
  if (path.startsWith("/_astro/")) return true;
  if (path.startsWith("/sitemap-")) return true;
  return false;
}

export function resolveSiteFile(siteRoot: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    // A malformed percent-escape names no file; the caller serves its 404 page.
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\//, "");
  const withHtml = rel.endsWith("/") ? `${rel.slice(0, -1)}.html` : extname(rel) ? rel : `${rel}.html`;
  const candidates = extname(rel) ? [rel, join(rel, "index.html")] : [withHtml, rel, join(rel, "index.html")];
  const root = resolve(siteRoot);
  for (const cand of candidates) {
    const abs = resolve(root, cand);
    const relToRoot = relative(root, abs);
    if (relToRoot.startsWith("..") || relToRoot.includes(`..${sep}`) || normalize(relToRoot).startsWith("..")) {
      return undefined;
    }
    if (!abs.startsWith(root + sep) && abs !== root) return undefined;
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
  }
  return undefined;
}

/**
 * Content type and cache policy for a file under the site root. HTML is revalidated on
 * every request; hashed Astro assets are immutable; everything else lives for an hour.
 * Security headers are added by the caller (`securityHeaders`), not here.
 */
export function staticHeaders(filePath: string): Record<string, string> {
  const ext = extname(filePath);
  const type = TYPES[ext] ?? "application/octet-stream";
  const hashed = /[\\/]_astro[\\/]/.test(filePath);
  const cache = ext === ".html" ? CACHE_HTML : hashed ? CACHE_IMMUTABLE : CACHE_ASSET;
  return {
    "content-type": type,
    "cache-control": cache,
    "x-content-type-options": "nosniff",
  };
}

export function sendSiteFile(res: ServerResponse, filePath: string, extra: Record<string, string> = {}): void {
  const headers = { ...staticHeaders(filePath), ...extra };
  res.writeHead(200, headers);
  const stream = createReadStream(filePath);
  stream.on("error", (err) => {
    // The file vanished or became unreadable mid-stream (a deploy swapping site/dist). The
    // headers are out, so cut the response rather than end it as if the body were complete.
    logVaultEvent("static_stream_failed", { message: err.message.slice(0, 200) });
    res.destroy(err);
  });
  stream.pipe(res);
}

/**
 * Serve the Astro 404 page (or a plain-text fallback) with status 404.
 * Exported so the router can use it for unknown paths outside the site prefixes too.
 */
export function sendSiteNotFound(
  res: ServerResponse,
  siteRoot: string,
  method: string,
  htmlExtra: Record<string, string> = {},
): void {
  const file = join(resolve(siteRoot), "404.html");
  const hasPage = existsSync(file) && statSync(file).isFile();
  const body = hasPage ? readFileSync(file) : Buffer.from("Not found\n", "utf8");
  const headers = {
    ...staticHeaders(hasPage ? file : "not-found.txt"),
    ...htmlExtra,
    "content-length": String(body.byteLength),
  };
  res.writeHead(404, headers);
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

function redirectTo(res: ServerResponse, location: string, assetExtra: Record<string, string>): void {
  res.writeHead(308, { ...assetExtra, location, "cache-control": CACHE_HTML, "content-length": "0" });
  res.end();
}

/**
 * Serve a public site path. Returns false only when the method is not GET/HEAD or the
 * path is not a site path, so the router can keep going. For site paths it always
 * answers: 308 to the canonical URL for `.html` and trailing-slash variants, the file,
 * or the 404 page.
 */
export function tryServeSite(
  req: IncomingMessage,
  res: ServerResponse,
  siteRoot: string,
  urlPath: string,
  htmlExtra: Record<string, string> = {},
  assetExtra: Record<string, string> = {},
): boolean {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  if (!isPublicSitePath(urlPath)) return false;

  const canonical = canonicalSitePath(urlPath);
  const isPageUrl = urlPath.endsWith(".html") || (urlPath.length > 1 && urlPath.endsWith("/"));
  if (isPageUrl && canonical !== urlPath && resolveSiteFile(siteRoot, canonical)) {
    const query = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    redirectTo(res, `${canonical}${query}`, assetExtra);
    return true;
  }

  const file = resolveSiteFile(siteRoot, urlPath);
  if (!file) {
    sendSiteNotFound(res, siteRoot, method, htmlExtra);
    return true;
  }
  const extra = extname(file) === ".html" ? htmlExtra : assetExtra;
  if (method === "HEAD") {
    res.writeHead(200, { ...staticHeaders(file), ...extra });
    res.end();
    return true;
  }
  sendSiteFile(res, file, extra);
  return true;
}
