import { cssVariables } from "../brand-visual.ts";

/** Fonts, tokens, reset, app shell, rail, page head. Components live in console-css-components.ts. */
export const CONSOLE_CSS_BASE = `@font-face {
  font-family: "IBM Plex Sans";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/assets/fonts/ibm-plex-sans-400.woff2") format("woff2");
}
@font-face {
  font-family: "IBM Plex Sans";
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url("/assets/fonts/ibm-plex-sans-600.woff2") format("woff2");
}
@font-face {
  font-family: "IBM Plex Mono";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/assets/fonts/ibm-plex-mono-400.woff2") format("woff2");
}
@font-face {
  font-family: "Fraunces";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/assets/fonts/fraunces-400.woff2") format("woff2");
}
@font-face {
  font-family: "Fraunces";
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("/assets/fonts/fraunces-700.woff2") format("woff2");
}

${cssVariables()}

:root {
  --font-display: "Fraunces", ui-serif, Georgia, serif;
  --font-body: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
  --radius: 10px;
  --radius-small: 8px;
  --shadow: 0 12px 40px rgba(0, 0, 0, 0.12);
  --title-size: 1.25rem;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --shadow: 0 12px 40px rgba(0, 0, 0, 0.35); }
}
:root[data-theme="dark"] { --shadow: 0 12px 40px rgba(0, 0, 0, 0.35); }

*,
*::before,
*::after { box-sizing: border-box; }

html, body {
  margin: 0;
  min-height: 100%;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.5 var(--font-body);
}

body {
  background:
    radial-gradient(1200px 600px at 0% -10%, color-mix(in oklab, var(--accent) 8%, transparent), transparent 55%),
    var(--bg);
}

[hidden] { display: none !important; }

.visually-hidden {
  position: absolute !important;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

a { color: var(--fg); text-decoration: underline; text-underline-offset: 0.15em; text-decoration-color: color-mix(in oklab, var(--fg) 45%, transparent); }
a:hover { text-decoration-color: currentColor; }
a.btn, a.btn-primary, a.btn-ghost, .nav-link, .brand, .tabs a { text-decoration: none; }

a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible,
summary:focus-visible,
tr:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.skip {
  position: absolute;
  left: 0.75rem;
  top: 0.75rem;
  transform: translateY(-200%);
  background: var(--bg-elev);
  color: var(--fg);
  padding: 0.5rem 0.75rem;
  z-index: 20;
}
.skip:focus { transform: none; }

.app-shell {
  display: grid;
  grid-template-columns: 15.5rem minmax(0, 1fr);
  min-height: 100vh;
}

.rail {
  position: sticky;
  top: 0;
  align-self: start;
  min-height: 100vh;
  padding: 1.25rem 1rem 1.5rem;
  border-right: 1px solid var(--line);
  background: color-mix(in oklab, var(--bg-elev) 72%, var(--bg));
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  color: var(--fg);
  font-weight: 600;
  letter-spacing: -0.02em;
}
.brand img { width: 28px; height: 28px; }
.brand-mark { font-family: var(--font-display); font-size: 1.2rem; font-weight: 700; }

.plane-label {
  margin: -0.75rem 0 0;
  display: inline-flex;
  align-self: flex-start;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: var(--warn-dim);
  color: var(--warn);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.rail-nav {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.nav-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: 44px;
  width: 100%;
  padding: 0.45rem 0.7rem;
  border-radius: var(--radius);
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
}
.nav-link:hover { color: var(--fg); background: color-mix(in oklab, var(--bg-elev) 80%, var(--line)); }
.nav-link[aria-current="page"] {
  color: var(--fg);
  background: var(--accent-dim);
  border-color: color-mix(in oklab, var(--accent) 35%, var(--line));
}
.nav-button { justify-content: flex-start; }

.badge {
  min-width: 1.4rem;
  height: 1.4rem;
  padding: 0 0.4rem;
  border-radius: 999px;
  background: var(--warn);
  color: var(--bg);
  font-size: 0.75rem;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.badge[data-count="0"] { display: none; }

.rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 0.35rem; }
.signin { margin: 0.5rem 0 0; color: var(--muted); font-size: 0.9rem; }

.workspace {
  min-width: 0;
  padding: 1.5rem 1.75rem 4rem;
}

.page-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
}
.page-head h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(1.6rem, 2.4vw, 2.1rem);
  line-height: 1.15;
  letter-spacing: -0.03em;
}
.lede { margin: 0.35rem 0 0; color: var(--muted); max-width: 62ch; }

.toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; }

.panel { display: none; }
.panel.is-active { display: block; }

body[data-session="out"] .page-head { visibility: hidden; height: 0; margin: 0; overflow: hidden; }
body[data-session="out"] .workspace {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 100vh;
  padding-top: 2.5rem;
}
.gate-card { max-width: 28rem; margin-inline: auto; }
`;
