/** Cards, tables, pills, lists, forms, buttons, flashes, dialogs, drawer, and the mobile layout. */
export const CONSOLE_CSS_COMPONENTS = `.card {
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1.1rem 1.2rem;
  box-shadow: var(--shadow);
}
.card + .card, .inbox-list + .card, .banner + .card, .connect-card + .tabs { margin-top: 1rem; }
.card h2, .card h3, .drawer h2, .drawer h3, dialog h2 {
  margin: 0 0 0.5rem;
  font-family: var(--font-display);
  font-size: var(--title-size);
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.25;
}
.drawer h3 { font-size: 1.05rem; margin-top: 1.25rem; }
details.card > summary { font-weight: 600; color: var(--fg); font-size: 1rem; }

.empty, .error-box {
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  padding: 2rem 1.25rem;
  text-align: center;
  color: var(--muted);
  background: color-mix(in oklab, var(--bg-elev) 55%, transparent);
  margin: 0 0 1rem;
}
.empty strong, .error-box strong { display: block; color: var(--fg); margin-bottom: 0.35rem; }
.empty .toolbar { justify-content: center; margin-top: 1.1rem; }
.error-box { border-style: solid; border-color: color-mix(in oklab, var(--danger) 45%, var(--line)); color: var(--fg); }
.error-box .toolbar { justify-content: center; margin-top: 0.9rem; }

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1rem;
  align-items: flex-end;
  margin: 0 0 1rem;
}
.filter { display: flex; flex-direction: column; gap: 0.25rem; margin: 0; min-width: 9rem; flex: 1 1 9rem; }
.filter span { color: var(--muted); font-size: 0.8rem; font-weight: 600; letter-spacing: 0.02em; }
.filter input, .filter select { margin: 0; }
.filters .filter:first-child { flex: 2 1 14rem; }
.filter-clear { align-self: center; font-size: 0.9rem; }

.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-elev); }
table { width: 100%; border-collapse: collapse; }
.items-table { table-layout: fixed; min-width: 0; }
.items-table .col-name { width: 23%; }
.items-table .col-kind { width: 10%; }
.items-table .col-env { width: 13%; }
.items-table .col-hosts { width: 24%; }
.items-table .col-last4 { width: 9%; }
.items-table .col-actions { width: 21%; }
th, td {
  text-align: left;
  padding: 0.7rem 0.85rem;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
  overflow-wrap: anywhere;
}
th { color: var(--muted); font-size: 0.85rem; font-weight: 600; letter-spacing: 0.02em; overflow-wrap: normal; }
tr:last-child td { border-bottom: 0; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: color-mix(in oklab, var(--accent-dim) 35%, transparent); }
td.name { font-weight: 600; }
.cell-label { display: none; }
.mono, code, pre, #mcp_url, #totp-secret { font-family: var(--font-mono); }
td.last4 { color: var(--muted); letter-spacing: 0.04em; white-space: nowrap; }
td.actions .row-actions { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.host-list { display: flex; flex-direction: column; gap: 0.1rem; }

.pill {
  display: inline-flex;
  align-items: center;
  min-height: 1.5rem;
  padding: 0 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: color-mix(in oklab, var(--bg-elev) 70%, var(--line));
  color: var(--muted);
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: lowercase;
  vertical-align: middle;
  white-space: nowrap;
}
.pill-ok { background: var(--ok-dim); color: var(--ok); border-color: color-mix(in oklab, var(--ok) 40%, var(--line)); }
.pill-warn { background: var(--warn-dim); color: var(--warn); border-color: color-mix(in oklab, var(--warn) 40%, var(--line)); }
.pill-muted { opacity: 0.85; }

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
.inbox-item.is-approved { background: var(--ok-dim); border-color: color-mix(in oklab, var(--ok) 35%, var(--line)); }
.inbox-item p, .access-row p { margin: 0; color: var(--muted); }
.inbox-copy { flex: 1 1 18rem; min-width: 0; }
.inbox-title { margin: 0 0 0.2rem; font-family: var(--font-display); font-size: var(--title-size); font-weight: 700; color: var(--fg); }
.inbox-meta, .access-meta { margin: 0.4rem 0 0; font-size: 0.85rem; color: var(--muted); }
.inbox-actions, .access-row-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
.access-row-main { flex: 1 1 16rem; min-width: 0; }
.access-row-title { color: var(--fg); display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
.activity-row { align-items: center; }
.activity-row .access-meta { margin: 0; white-space: nowrap; }
.access-log-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0.5rem 0.85rem;
  color: var(--fg);
  text-decoration: underline;
  text-underline-offset: 0.15em;
}
.section-empty { margin: 0; color: var(--muted); }
.inline-select { display: inline-flex; align-items: center; gap: 0.5rem; margin: 0.5rem 0 0; font-size: 0.85rem; }
.inline-select select { width: auto; min-height: 36px; padding: 0.25rem 0.5rem; }
.env-note { margin-top: 0.35rem; }

.steps { margin: 0.5rem 0 0; padding-left: 1.4rem; display: grid; gap: 1rem; }
.steps li > strong { display: block; margin-bottom: 0.25rem; }
.steps p { margin: 0.25rem 0 0; }
.inline-form { display: grid; grid-template-columns: minmax(10rem, 1fr) minmax(8rem, 12rem) auto; gap: 0.35rem 0.75rem; align-items: end; margin-top: 0.75rem; }
.inline-form label { grid-row: 1; margin: 0; }
.inline-form input, .inline-form select { grid-row: 2; }
.inline-form .flash { grid-column: 1 / -1; grid-row: 3; margin: 0.4rem 0 0; }
.inline-form button { grid-row: 2; grid-column: 3; }
.vendor-tip { margin: 1rem 0 0; }
.vendor-tip summary { color: var(--muted); }
.copy-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0.25rem 0 0;
}
.copy-row code { flex: 1 1 12rem; min-width: 0; word-break: break-all; }

.tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--line); margin: 1rem 0; overflow-x: auto; }
.tabs a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0.5rem 0.9rem;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  white-space: nowrap;
}
.tabs a:hover { color: var(--fg); }
.tabs a[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }

.facts { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem; margin: 0.5rem 0 1rem; }
.facts dt { color: var(--muted); font-size: 0.9rem; }
.facts dd { margin: 0; overflow-wrap: anywhere; }

label { display: block; margin: 0.85rem 0 0.3rem; color: var(--muted); font-size: 0.9rem; }
input, select, textarea {
  width: 100%;
  font: inherit;
  min-height: 44px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid color-mix(in oklab, var(--line) 70%, var(--muted));
  border-radius: var(--radius-small);
  padding: 0.5rem 0.7rem;
}
input:focus, select:focus { border-color: var(--accent); }
.field-hint { margin: 0.3rem 0 0; font-size: 0.85rem; }

button, .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  min-width: 44px;
  padding: 0.5rem 0.95rem;
  border-radius: var(--radius-small);
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
button[disabled] { opacity: 0.6; cursor: progress; }
.btn-primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.btn-ghost { background: transparent; color: var(--fg); }
.btn-danger { color: var(--danger); border-color: color-mix(in oklab, var(--danger) 40%, var(--line)); }
.btn-small { min-height: 36px; padding: 0.3rem 0.7rem; font-size: 0.9rem; }

.flash {
  min-height: 1.3em;
  margin: 0 0 1rem;
  padding: 0.55rem 0.75rem;
  border-radius: var(--radius-small);
  border: 1px solid transparent;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.flash:empty { display: none; }
.flash.is-ok { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 35%, var(--line)); background: var(--ok-dim); }
.flash.is-err { color: var(--danger); border-color: color-mix(in oklab, var(--danger) 40%, var(--line)); background: var(--danger-dim); }
.flash-dismiss { min-height: 32px; min-width: 32px; padding: 0 0.5rem; border: 0; color: inherit; font-size: 1.1rem; }
.hint.is-err { color: var(--danger); }

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
  border-radius: var(--radius-small);
}
.once-shown {
  margin: 0.5rem 0;
  padding: 0.75rem;
  border: 1px solid color-mix(in oklab, var(--warn) 45%, var(--line));
  background: var(--warn-dim);
  color: var(--fg);
  border-radius: var(--radius-small);
  word-break: break-all;
}
.once-shown code { font-size: 0.95rem; }

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
dialog::backdrop { background: rgba(6, 10, 7, 0.6); }
.dialog-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem; }
#code input[name="code"], #code-dialog-input { max-width: 12rem; letter-spacing: 0.14em; }
#code button { margin-top: 0.75rem; }

dialog.drawer {
  position: fixed;
  inset: 0 0 0 auto;
  margin: 0;
  height: 100vh;
  max-height: 100vh;
  width: min(30rem, 100vw);
  max-width: 100vw;
  border-radius: 0;
  border-width: 0 0 0 1px;
  overflow-y: auto;
}
.drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.drawer-head h2 { overflow-wrap: anywhere; }

@media (max-width: 860px) {
  .app-shell { grid-template-columns: 1fr; }
  .rail {
    position: static;
    min-height: 0;
    border-right: 0;
    border-bottom: 1px solid var(--line);
    padding: 0.85rem 1rem;
    gap: 0.75rem;
  }
  .rail-nav, .rail-foot { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
  .rail-foot { margin-top: 0; }
  .nav-link { width: auto; white-space: nowrap; }
  .signin { display: none; margin: 0; flex: 1 1 100%; }
  body[data-session="out"] .signin { display: block; }
  #breakglass { flex: 1 1 100%; }
  .workspace { padding: 1.1rem 1rem 3rem; }
  .items-table colgroup { display: none; }
  .items-table, .items-table thead, .items-table tbody, .items-table th, .items-table td, .items-table tr { display: block; }
  .items-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .items-table tr { padding: 0.6rem 0; border-bottom: 1px solid var(--line); }
  .items-table tr:last-child { border-bottom: 0; }
  .items-table td { border: 0; padding: 0.35rem 0.85rem; display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .items-table .cell-label { display: inline; flex: 0 0 auto; white-space: nowrap; color: var(--muted); font-size: 0.8rem; font-weight: 600; }
  .items-table .cell-value { flex: 1 1 auto; text-align: right; min-width: 0; }
  .items-table .host-list { align-items: flex-end; }
  td.actions .row-actions { justify-content: flex-end; }
  .inline-form { grid-template-columns: 1fr; }
  .inline-form label, .inline-form input, .inline-form select, .inline-form button, .inline-form .flash { grid-row: auto; grid-column: 1; }
  .activity-row .access-meta { white-space: normal; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;
