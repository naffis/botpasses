/**
 * Conventional discovery URLs that Astro does not emit under the name crawlers
 * and browsers request. /sitemap.xml is write-sitemap.mjs. This copies
 * /.well-known/security.txt to /security.txt (RFC 9116 allows the top-level
 * file; it must be the same bytes, not a redirect) and then fails the build
 * if any conventional twin is missing from dist.
 *
 *   node site/scripts/write-conventional.mjs
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** Keep in lockstep with CONVENTIONAL_DISCOVERY_PATHS in src/hosted/static-site.ts. */
const CONVENTIONAL = [
  "/sitemap.xml",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/security.txt",
];

const wellKnown = join(dist, ".well-known", "security.txt");
if (!existsSync(wellKnown)) {
  throw new Error("write-conventional: astro did not emit .well-known/security.txt");
}
copyFileSync(wellKnown, join(dist, "security.txt"));

const icoMagic = Buffer.from([0, 0, 1, 0]);
const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

for (const path of CONVENTIONAL) {
  const abs = join(dist, path.slice(1));
  if (!existsSync(abs)) {
    throw new Error(`write-conventional: missing ${path} (conventional twin with a working original)`);
  }
}

const sitemap = readFileSync(join(dist, "sitemap.xml"), "utf8");
if (!/<urlset\b/.test(sitemap) || !/<loc>https:\/\/botpasses\.com\/<\/loc>/.test(sitemap)) {
  throw new Error("write-conventional: /sitemap.xml must be a urlset that lists https://botpasses.com/");
}

const ico = readFileSync(join(dist, "favicon.ico"));
if (!ico.subarray(0, 4).equals(icoMagic)) {
  throw new Error("write-conventional: /favicon.ico is not an ICO");
}

const apple = readFileSync(join(dist, "apple-touch-icon.png"));
if (!apple.subarray(0, 8).equals(pngMagic)) {
  throw new Error("write-conventional: /apple-touch-icon.png is not a PNG");
}

const rootSec = readFileSync(join(dist, "security.txt"), "utf8");
const wellSec = readFileSync(wellKnown, "utf8");
if (rootSec !== wellSec) {
  throw new Error("write-conventional: /security.txt must match /.well-known/security.txt");
}
