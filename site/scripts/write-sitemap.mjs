/**
 * Astro's sitemap integration writes sitemap-index.xml + sitemap-N.xml.
 * Crawlers, auditors, and people look at /sitemap.xml. Publish the urlset there.
 *
 *   node site/scripts/write-sitemap.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const shards = readdirSync(dist)
  .filter((name) => /^sitemap-\d+\.xml$/.test(name))
  .sort();
if (shards.length === 0) {
  throw new Error("write-sitemap: astro did not emit sitemap-0.xml");
}

const urls = [];
for (const name of shards) {
  const xml = readFileSync(join(dist, name), "utf8");
  for (const block of xml.matchAll(/<url>[\s\S]*?<\/url>/g)) {
    urls.push(block[0]);
  }
}
if (urls.length === 0) {
  throw new Error("write-sitemap: no <url> entries in Astro shards");
}

writeFileSync(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>\n`,
);
