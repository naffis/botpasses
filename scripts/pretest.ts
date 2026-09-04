/**
 * `npm test` prerequisite. Hosted tests serve the built Astro site from `site/dist`;
 * fail fast with the fix instead of a wall of 404 assertions.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.env.VAULT_SITE_ROOT?.trim() || resolve(process.cwd(), "site/dist");
if (!existsSync(resolve(root, "index.html"))) {
  console.error(`${root}/index.html is missing: run npm run site:build first`);
  process.exit(1);
}
