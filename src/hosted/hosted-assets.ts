import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_JS } from "./auth-js.ts";
import { COLLECT_BUNDLE_JS, CONSOLE_BUNDLE_JS } from "./client-bundle.ts";
import { CONSOLE_CSS } from "./console-css.ts";

export { CONSOLE_CSS, AUTH_JS };
/** Browser bundles are generated from src/hosted/client/*.ts by scripts/build-client.ts. */
export const CONSOLE_JS = CONSOLE_BUNDLE_JS;
export const COLLECT_JS = COLLECT_BUNDLE_JS;

const HERE = dirname(fileURLToPath(import.meta.url));
/** Brand mark, served so the console rail does not depend on the marketing root's favicon. */
export const MARK_SVG = readFileSync(join(HERE, "..", "brand-assets", "mark.svg"), "utf8");

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

const ASSETS: Record<string, { type: string; body: string }> = {
  "/assets/auth.css": { type: "text/css; charset=utf-8", body: AUTH_CSS },
  "/assets/console.css": { type: "text/css; charset=utf-8", body: CONSOLE_CSS },
  "/assets/auth.js": { type: "text/javascript; charset=utf-8", body: AUTH_JS },
  "/assets/console.js": { type: "text/javascript; charset=utf-8", body: CONSOLE_JS },
  "/assets/collect.js": { type: "text/javascript; charset=utf-8", body: COLLECT_JS },
  "/assets/mark.svg": { type: "image/svg+xml", body: MARK_SVG },
};

export function hostedAsset(path: string): { type: string; body: string } | undefined {
  return ASSETS[path];
}
