import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../ids.ts";
import { AUTH_JS } from "./auth-js.ts";
import { COLLECT_BUNDLE_JS, CONSOLE_BUNDLE_JS } from "./client-bundle.ts";
import { CONSOLE_CSS } from "./console-css.ts";

export { CONSOLE_CSS, AUTH_JS };
/** Browser bundles are generated from src/hosted/client/*.ts by scripts/build-client.ts. */
export const CONSOLE_JS = CONSOLE_BUNDLE_JS;
export const COLLECT_JS = COLLECT_BUNDLE_JS;

const HERE = dirname(fileURLToPath(import.meta.url));
/** Brand marks, served so the console rail does not depend on the marketing root. */
export const MARK_SVG = readFileSync(join(HERE, "..", "brand-assets", "mark.svg"), "utf8");
export const MARK_ON_DARK_SVG = readFileSync(join(HERE, "..", "brand-assets", "mark-on-dark.svg"), "utf8");

export const AUTH_CSS = `.auth-body {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4.5rem 1rem 2rem;
}
.auth-brand {
  position: absolute;
  top: 1.25rem;
  left: 1.25rem;
}
.auth-card {
  width: min(26rem, 100%);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1.5rem 1.4rem 1.6rem;
  box-shadow: var(--shadow);
}
.auth-card.wide { width: min(32rem, 100%); }
.auth-card h1 {
  font-family: var(--font-display);
  font-size: 1.75rem;
  margin: 0 0 0.5rem;
}
.auth-card > p { color: var(--muted); }
.auth-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem; }
.totp-qr { width: 14rem; height: 14rem; background: #fff; border: 1px solid var(--line); }
.totp-qr svg { display: block; width: 100%; height: 100%; }
#totp-secret { letter-spacing: 0.06em; word-break: break-all; }
figure { margin: 1rem 0; }
figcaption { color: var(--muted); font-size: 0.9rem; margin-top: 0.4rem; }
#backups:empty, #otpauth:empty { display: none; }
`;

/** First-party files under `/assets/`, keyed by their plain file name. */
export type AssetName =
  | "auth.css"
  | "console.css"
  | "auth.js"
  | "console.js"
  | "collect.js"
  | "mark.svg"
  | "mark-on-dark.svg";

export type HostedAsset = {
  type: string;
  body: string;
  /**
   * True when the request path carried the content hash, so the body can never change under
   * that URL and the router may serve it `immutable`. Plain names are served `no-cache`.
   */
  immutable: boolean;
};

const SOURCES: Record<AssetName, { type: string; body: string }> = {
  "auth.css": { type: "text/css; charset=utf-8", body: AUTH_CSS },
  "console.css": { type: "text/css; charset=utf-8", body: CONSOLE_CSS },
  "auth.js": { type: "text/javascript; charset=utf-8", body: AUTH_JS },
  "console.js": { type: "text/javascript; charset=utf-8", body: CONSOLE_JS },
  "collect.js": { type: "text/javascript; charset=utf-8", body: COLLECT_JS },
  "mark.svg": { type: "image/svg+xml", body: MARK_SVG },
  "mark-on-dark.svg": { type: "image/svg+xml", body: MARK_ON_DARK_SVG },
};

/** Eight hex characters of the body's SHA-256: enough to change on every edit, short in the URL. */
export function assetContentHash(body: string): string {
  return sha256Hex(body).slice(0, 8);
}

/** `/assets/console.<sha8>.js`: the versioned path the page renderers reference. */
export function assetPath(name: AssetName): string {
  const dot = name.lastIndexOf(".");
  const stem = name.slice(0, dot);
  const ext = name.slice(dot + 1);
  return `/assets/${stem}.${assetContentHash(SOURCES[name].body)}.${ext}`;
}

const HASHED = new Map<string, AssetName>();
const PLAIN = new Map<string, AssetName>();
for (const name of Object.keys(SOURCES) as AssetName[]) {
  HASHED.set(assetPath(name), name);
  PLAIN.set(`/assets/${name}`, name);
}

/**
 * Resolve a request path. The hashed path (from `assetPath`) is immutable; the plain path still
 * serves the current body so old bookmarks and tests keep working, but must be revalidated.
 */
export function hostedAsset(path: string): HostedAsset | undefined {
  const hashed = HASHED.get(path);
  if (hashed) return { ...SOURCES[hashed], immutable: true };
  const plain = PLAIN.get(path);
  if (plain) return { ...SOURCES[plain], immutable: false };
  return undefined;
}
