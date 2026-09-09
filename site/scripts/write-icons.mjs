/**
 * Rebuild site/public icon PNGs and favicon.ico from the official brand rasters
 * in src/brand-assets/source. Not part of site:build (needs ImageMagick).
 * Commit the outputs; Astro copies public/ into dist.
 *
 *   node site/scripts/write-icons.mjs
 *
 * Writes favicon.ico, apple-touch-icon.png (180), android-chrome-192x192.png,
 * android-chrome-512x512.png, and logo.png (512, JSON-LD Organization.logo).
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const source = join(here, "..", "..", "src", "brand-assets", "source");
const official512 = join(source, "favicon-512.png");
const official32 = join(source, "favicon.png");

function run(bin, args) {
  const r = spawnSync(bin, args, { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${bin} exited ${r.status}`);
}

const tmp = mkdtempSync(join(tmpdir(), "bp-icons-"));
try {
  run("magick", [official32, "-resize", "16x16", join(tmp, "f16.png")]);
  copyFileSync(official32, join(tmp, "f32.png"));
  run("magick", [official512, "-resize", "48x48", join(tmp, "f48.png")]);
  run("magick", [official512, "-resize", "180x180", join(publicDir, "apple-touch-icon.png")]);
  run("magick", [official512, "-resize", "192x192", join(publicDir, "android-chrome-192x192.png")]);
  copyFileSync(official512, join(publicDir, "android-chrome-512x512.png"));
  copyFileSync(official512, join(publicDir, "logo.png"));
  run("magick", [join(tmp, "f16.png"), join(tmp, "f32.png"), join(tmp, "f48.png"), join(publicDir, "favicon.ico")]);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
