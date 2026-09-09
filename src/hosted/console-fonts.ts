import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "fonts");

const FONTS: Record<string, string> = {
  "/assets/fonts/inter-400.woff2": "inter-400.woff2",
  "/assets/fonts/inter-600.woff2": "inter-600.woff2",
  "/assets/fonts/inter-700.woff2": "inter-700.woff2",
  "/assets/fonts/ibm-plex-mono-400.woff2": "ibm-plex-mono-400.woff2",
};

/** Latin OFL files for the console. Same faces as the marketing site. */
export function hostedFont(path: string): { type: string; body: Buffer } | undefined {
  const name = FONTS[path];
  if (!name) return undefined;
  const file = join(FONT_DIR, name);
  if (!existsSync(file)) return undefined;
  return { type: "font/woff2", body: readFileSync(file) };
}
