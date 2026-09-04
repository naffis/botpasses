import { CONSOLE_ACCESS_JS } from "./console-access-js.ts";
import { CONSOLE_CSS } from "./console-css.ts";
import { CONSOLE_JS as CONSOLE_CORE_JS } from "./console-js.ts";

import { AUTH_JS } from "./auth-js.ts";
import { COLLECT_JS } from "./collect-js.ts";

export { CONSOLE_CSS, AUTH_JS, COLLECT_JS };
export const CONSOLE_JS = CONSOLE_CORE_JS + CONSOLE_ACCESS_JS;

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

export function hostedAsset(path: string): { type: string; body: string } | undefined {
  if (path === "/assets/auth.css") {
    return { type: "text/css; charset=utf-8", body: AUTH_CSS };
  }
  if (path === "/assets/console.css") {
    return { type: "text/css; charset=utf-8", body: CONSOLE_CSS };
  }
  if (path === "/assets/auth.js") return { type: "text/javascript; charset=utf-8", body: AUTH_JS };
  if (path === "/assets/console.js") return { type: "text/javascript; charset=utf-8", body: CONSOLE_JS };
  if (path === "/assets/collect.js") return { type: "text/javascript; charset=utf-8", body: COLLECT_JS };
  return undefined;
}
