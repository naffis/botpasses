/**
 * Rebuild site/public/favicon.ico and apple-touch-icon.png from favicon.svg.
 * Not part of site:build (needs rsvg-convert and ImageMagick). Commit the
 * outputs; Astro copies public/ into dist.
 *
 *   node site/scripts/write-icons.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const svg = join(publicDir, "favicon.svg");
const bg = "#0B0F0C";

function run(bin, args) {
  const r = spawnSync(bin, args, { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${bin} exited ${r.status}`);
}

const tmp = mkdtempSync(join(tmpdir(), "bp-icons-"));
try {
  run("rsvg-convert", ["-w", "16", "-h", "16", "-b", bg, "-o", join(tmp, "f16.png"), svg]);
  run("rsvg-convert", ["-w", "32", "-h", "32", "-b", bg, "-o", join(tmp, "f32.png"), svg]);
  run("rsvg-convert", ["-w", "48", "-h", "48", "-b", bg, "-o", join(tmp, "f48.png"), svg]);
  run("rsvg-convert", ["-w", "180", "-h", "180", "-b", bg, "-o", join(publicDir, "apple-touch-icon.png"), svg]);
  run("magick", [join(tmp, "f16.png"), join(tmp, "f32.png"), join(tmp, "f48.png"), join(publicDir, "favicon.ico")]);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
