import { cssVariables } from "../brand-visual.ts";

export const CONSOLE_CSS = `@font-face {
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

:root {
  color-scheme: dark;
  ${cssVariables()}
  --font-display: "Fraunces", ui-serif, Georgia, serif;
  --font-body: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
  --radius: 10px;
  --shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}

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

a { color: var(--accent); text-underline-offset: 0.15em; }
a.btn, a.btn-primary { text-decoration: none; }

a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible,
summary:focus-visible {
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
  grid-template-columns: 15.5rem 1fr;
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
  text-decoration: none;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.brand img { width: 28px; height: 28px; }
.brand-mark { font-family: var(--font-display); font-size: 1.2rem; font-weight: 700; }

.plane {
  margin: 0;
  color: var(--muted);
  font-size: 0.8rem;
}
.plane strong { color: var(--fg); font-weight: 600; }

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
  padding: 0.45rem 0.7rem;
  border-radius: var(--radius);
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  text-decoration: none;
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.nav-link:hover { color: var(--fg); background: color-mix(in oklab, var(--bg-elev) 80%, var(--line)); }
.nav-link[aria-current="page"] {
  color: var(--fg);
  background: var(--accent-dim);
  border-color: color-mix(in oklab, var(--accent) 35%, var(--line));
}

.badge {
  min-width: 1.4rem;
  height: 1.4rem;
  padding: 0 0.4rem;
  border-radius: 999px;
  background: var(--accent);
  color: var(--bg);
  font-size: 0.75rem;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.badge[data-count="0"] { display: none; }

.rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 0.75rem; }
.signin { margin: 0; color: var(--muted); font-size: 0.9rem; }

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

.card {
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1.1rem 1.2rem;
  box-shadow: var(--shadow);
}
.card + .card, .inbox-list + .card, .banner + .card { margin-top: 1rem; }
.gate-card { max-width: 28rem; margin-inline: auto; }
body[data-session="out"] .page-head { visibility: hidden; height: 0; margin: 0; overflow: hidden; }
body[data-session="out"] .workspace {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 100vh;
  padding-top: 2.5rem;
}
.empty .toolbar { justify-content: center; margin-top: 1.1rem; }
.copy-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 1rem;
}
.copy-row code { flex: 1 1 12rem; min-width: 0; word-break: break-all; }
#grok_once:empty { display: none; }
.section-empty { margin: 0; color: var(--muted); }
details.card > summary { font-weight: 600; color: var(--fg); font-size: 1rem; }
.card h2, .card h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  font-weight: 600;
}

.empty, .error-box {
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  padding: 2rem 1.25rem;
  text-align: center;
  color: var(--muted);
  background: color-mix(in oklab, var(--bg-elev) 55%, transparent);
}
.empty strong, .error-box strong { display: block; color: var(--fg); margin-bottom: 0.35rem; }
.error-box { border-style: solid; border-color: color-mix(in oklab, var(--danger) 45%, var(--line)); }

.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-elev); }
table { width: 100%; border-collapse: collapse; }
th, td {
  text-align: left;
  padding: 0.7rem 0.85rem;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}
th { color: var(--muted); font-size: 0.8rem; font-weight: 600; letter-spacing: 0.02em; }
tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: color-mix(in oklab, var(--accent-dim) 35%, transparent); }
.name { font-weight: 600; }
.mono, code, pre, #mcp_url, #totp-secret { font-family: var(--font-mono); }
.last4 { color: var(--muted); letter-spacing: 0.04em; }

.pill {
  display: inline-flex;
  align-items: center;
  min-height: 1.5rem;
  padding: 0 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--muted);
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: lowercase;
}

.row-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; }

.inbox-list, .access-list { display: flex; flex-direction: column; gap: 0.65rem; }
.inbox-item, .access-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-elev);
}
.inbox-item p, .access-row p { margin: 0; color: var(--muted); }
.inbox-item strong { color: var(--fg); }
.inbox-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.inbox-item .hint { margin-top: 0.35rem; max-width: 36rem; }
.access-row-main { flex: 1; min-width: 12rem; }
.access-row-title { color: var(--fg); }
.access-meta { margin: 0.4rem 0 0; font-size: 0.85rem; color: var(--muted); }
.access-row-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.access-log-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0.5rem 0.85rem;
  color: var(--fg);
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

label { display: block; margin: 0.85rem 0 0.3rem; color: var(--muted); font-size: 0.9rem; }
input, select, textarea {
  width: 100%;
  font: inherit;
  min-height: 44px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid color-mix(in oklab, var(--line) 70%, var(--muted));
  border-radius: 8px;
  padding: 0.5rem 0.7rem;
}
input:focus, select:focus { border-color: var(--accent); }

button, .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  min-width: 44px;
  padding: 0.5rem 0.95rem;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary, form > button[type="submit"], #store button[type="submit"], #grok button[type="submit"] {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}
.btn-ghost { background: transparent; color: var(--fg); }
.btn-danger { color: var(--danger); border-color: color-mix(in oklab, var(--danger) 40%, var(--line)); }

.flash {
  min-height: 1.3em;
  margin: 0 0 1rem;
  padding: 0.55rem 0.75rem;
  border-radius: 8px;
  border: 1px solid transparent;
}
.flash:empty { display: none; }
.flash.is-ok { color: var(--accent); border-color: color-mix(in oklab, var(--accent) 35%, var(--line)); background: var(--accent-dim); }
.flash.is-err { color: var(--danger); border-color: color-mix(in oklab, var(--danger) 40%, var(--line)); }

.banner {
  border: 1px solid var(--line);
  background: var(--bg-elev);
  border-radius: var(--radius);
  padding: 0.9rem 1rem;
  color: var(--muted);
  margin: 0 0 1rem;
}

pre {
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg);
  padding: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.hint, summary { color: var(--muted); font-size: 0.9rem; }
details { margin: 0.75rem 0; }
summary { cursor: pointer; }

dialog {
  background: var(--bg-elev);
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1.35rem;
  max-width: 32rem;
  width: calc(100vw - 2rem);
  box-shadow: var(--shadow);
}
dialog::backdrop { background: rgba(6, 10, 7, 0.72); }
.dialog-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem; }
#code input[name="code"] { max-width: 12rem; letter-spacing: 0.14em; }

@media (max-width: 860px) {
  .app-shell { grid-template-columns: 1fr; }
  .rail {
    position: sticky;
    top: 0;
    z-index: 5;
    min-height: 0;
    border-right: 0;
    border-bottom: 1px solid var(--line);
    padding: 0.85rem 1rem;
  }
  .rail-nav { flex-direction: row; overflow-x: auto; }
  .workspace { padding: 1.1rem 1rem 3rem; }
  .table-wrap table, .table-wrap thead, .table-wrap tbody, .table-wrap th, .table-wrap td, .table-wrap tr {
    display: block;
  }
  .table-wrap thead { display: none; }
  .table-wrap tr { padding: 0.6rem 0; border-bottom: 1px solid var(--line); }
  .table-wrap tr:last-child { border-bottom: 0; }
  .table-wrap td {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    border: 0;
    padding: 0.35rem 0.85rem;
  }
  .table-wrap td::before {
    content: attr(data-label);
    color: var(--muted);
    font-size: 0.8rem;
    font-weight: 600;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;
