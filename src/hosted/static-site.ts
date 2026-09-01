import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const PUBLIC_STATIC = new Set([
  "/",
  "/index.html",
  "/design",
  "/security",
  "/privacy",
  "/terms",
  "/changelog",
  "/favicon.svg",
  "/og.png",
  "/robots.txt",
  "/sitemap.xml",
  "/sitemap-index.xml",
]);

export function isPublicSitePath(path: string): boolean {
  if (PUBLIC_STATIC.has(path)) return true;
  if (path.startsWith("/docs")) return true;
  if (path.startsWith("/pagefind/")) return true;
  if (path.startsWith("/_astro/")) return true;
  if (path.startsWith("/sitemap-")) return true;
  return false;
}

export function resolveSiteFile(siteRoot: string, urlPath: string): string | undefined {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
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

export function staticHeaders(filePath: string, htmlNoCache: boolean): Record<string, string> {
  const ext = extname(filePath);
  const type = TYPES[ext] ?? "application/octet-stream";
  const hashed = /\/_astro\//.test(filePath) || /-[a-zA-Z0-9]{8}\.\w+$/.test(filePath);
  const cache = ext === ".html" || htmlNoCache
    ? "no-cache"
    : hashed
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600";
  return {
    "content-type": type,
    "cache-control": cache,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

export function sendSiteFile(res: ServerResponse, filePath: string, extra: Record<string, string> = {}): void {
  const headers = { ...staticHeaders(filePath, true), ...extra };
  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
}

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
  const file = resolveSiteFile(siteRoot, urlPath);
  if (!file) return false;
  const extra = extname(file) === ".html" ? htmlExtra : assetExtra;
  if (method === "HEAD") {
    res.writeHead(200, { ...staticHeaders(file, true), ...extra });
    res.end();
    return true;
  }
  sendSiteFile(res, file, extra);
  return true;
}

export function siteIndexExists(siteRoot: string): boolean {
  return existsSync(join(siteRoot, "index.html"));
}
