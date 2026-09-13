/**
 * Rebuild site/public icon PNGs and favicon.ico from the editable favicon SVG
 * in src/brand-assets. Not part of site:build (needs ImageMagick).
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
const source = join(here, "..", "..", "src", "brand-assets", "favicon.svg");

function run(bin, args) {
  const r = spawnSync(bin, args, { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${bin} exited ${r.status}`);
}

const tmp = mkdtempSync(join(tmpdir(), "bp-icons-"));
try {
  // Render each size directly from the SVG, so favicon and home-screen icons share one mark.
  for (const [size, file] of [[16, join(tmp, "f16.png")], [32, join(tmp, "f32.png")], [48, join(tmp, "f48.png")], [180, join(publicDir, "apple-touch-icon.png")], [192, join(publicDir, "android-chrome-192x192.png")], [512, join(publicDir, "android-chrome-512x512.png")]]) {
    run("magick", ["-background", "none", "-density", "1536", source, "-resize", `${size}x${size}`, "-strip", "-depth", "8", file]);
  }
  copyFileSync(join(publicDir, "android-chrome-512x512.png"), join(publicDir, "logo.png"));
  run("magick", [join(tmp, "f16.png"), join(tmp, "f32.png"), join(tmp, "f48.png"), join(publicDir, "favicon.ico")]);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
