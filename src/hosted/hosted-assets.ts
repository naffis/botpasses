import { BRAND_HEX } from "../brand-visual.ts";

export const AUTH_CSS = `:root { color-scheme: dark; --bg:${BRAND_HEX.bg}; --bg-elev:${BRAND_HEX.bgElev}; --fg:${BRAND_HEX.fg}; --muted:${BRAND_HEX.muted}; --line:${BRAND_HEX.line}; --accent:${BRAND_HEX.accent}; --accent-dim:${BRAND_HEX.accentDim}; --danger:${BRAND_HEX.danger}; }
html, body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { font-family: Fraunces, ui-serif, serif; font-size: 1.75rem; }
p, label { color: var(--muted); }
label { display:block; margin: 0.75rem 0 0.25rem; }
input, button, select { font: inherit; min-height: 24px; }
input, select { width: 100%; box-sizing: border-box; background: var(--bg-elev); color: var(--fg); border: 1px solid var(--line); padding: 0.5rem 0.6rem; }
button, .btn { display:inline-flex; align-items:center; justify-content:center; min-height: 44px; min-width: 44px; background: var(--accent-dim); color: var(--fg); border: 1px solid var(--accent); padding: 0.5rem 0.9rem; cursor: pointer; }
a { color: var(--accent); }
.flash { min-height: 1.4em; color: var(--danger); }
.banner { border: 1px solid var(--line); padding: 0.75rem 1rem; margin: 1rem 0; }
pre { white-space: pre-wrap; word-break: break-all; background: var(--bg-elev); padding: 0.6rem; border: 1px solid var(--line); }
dialog { background: var(--bg-elev); color: var(--fg); border: 1px solid var(--line); padding: 1.25rem; }
#items > div, #inbox > div, #access-clients > div, #access-grants > div, #access-sessions > div { border-bottom: 1px solid var(--line); padding: 0.5rem 0; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

export const AUTH_JS = `function csrf() {
  const m = document.cookie.match(/(?:^|; )(?:__Host-bp_csrf|bp_csrf)=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
function headers(json) {
  const h = {};
  if (json) h["content-type"] = "application/json";
  const t = csrf();
  if (t) h["X-CSRF-Token"] = t;
  return h;
}
async function post(url, body) {
  const r = await fetch(url, { method: "POST", credentials: "include", headers: headers(true), body: JSON.stringify(body) });
  const j = await r.json().catch(function() { return {}; });
  return { ok: r.ok, status: r.status, body: j };
}
function flash(el, msg) { if (el) el.textContent = msg; }
const sendForm = document.getElementById("otp-send");
const verifyForm = document.getElementById("otp-verify");
const totpForm = document.getElementById("totp-confirm");
const note = document.getElementById("flash");
if (sendForm) {
  sendForm.addEventListener("submit", async function(e) {
    e.preventDefault();
    const email = sendForm.email.value.trim();
    const r = await post("/api/auth/otp/send", { email: email });
    flash(note, r.ok ? "Check your inbox for a sign-in code." : (r.body.error || "Could not send code"));
  });
}
if (verifyForm) {
  verifyForm.addEventListener("submit", async function(e) {
    e.preventDefault();
    const r = await post("/api/auth/otp/verify", { email: verifyForm.email.value.trim(), otp: verifyForm.otp.value.trim() });
    if (!r.ok) { flash(note, r.body.error || "Invalid code"); return; }
    if (r.body.enroll) { location.href = "/enroll-totp"; return; }
    location.href = "/console";
  });
}
if (totpForm) {
  (async function() {
    const start = await fetch("/api/auth/totp/start", { method: "POST", credentials: "include", headers: headers(true), body: "{}" });
    const j = await start.json().catch(function() { return {}; });
    const uri = document.getElementById("otpauth");
    if (uri && j.otpauth_url) uri.textContent = j.otpauth_url;
  })();
  totpForm.addEventListener("submit", async function(e) {
    e.preventDefault();
    const r = await post("/api/auth/totp/confirm", { code: totpForm.code.value.trim() });
    if (!r.ok) { flash(note, r.body.error || "Invalid code"); return; }
    const box = document.getElementById("backups");
    if (box && r.body.backup_codes) box.textContent = r.body.backup_codes.join("\\n");
    location.href = "/console";
  });
}
const consentForm = document.getElementById("consent");
if (consentForm) {
  consentForm.addEventListener("submit", async function(e) {
    e.preventDefault();
    const fd = new FormData(consentForm);
    const btn = e.submitter;
    const r = await fetch("/consent", {
      method: "POST",
      credentials: "include",
      headers: headers(true),
      redirect: "manual",
      body: JSON.stringify({ uid: fd.get("uid"), decision: btn && btn.value ? btn.value : fd.get("decision") }),
    });
    const loc = r.headers.get("location");
    if (loc) { location.href = loc; return; }
    flash(note, "Consent failed");
  });
}
`;

export const CONSOLE_JS = `function csrf() {
  const m = document.cookie.match(/(?:^|; )(?:__Host-bp_csrf|bp_csrf)=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
function bootstrapToken() { return sessionStorage.getItem("vault_op_token") || ""; }
function headers() {
  const h = { "content-type": "application/json" };
  const t = csrf();
  if (t) h["X-CSRF-Token"] = t;
  const b = bootstrapToken();
  if (b) h.Authorization = "Bearer " + b;
  return h;
}
async function api(url, opts) {
  return fetch(url, Object.assign({ credentials: "include", headers: headers() }, opts || {}));
}
function flash(m) { const el = document.getElementById("flash"); if (el) el.textContent = m; }
const pendingDelete = { kind: "", id: "" };
function openConfirm(kind, id) {
  pendingDelete.kind = kind; pendingDelete.id = id;
  const d = document.getElementById("confirm");
  if (d && d.showModal) d.showModal();
}
async function loadItems() {
  const el = document.getElementById("items");
  if (!el) return;
  el.innerHTML = "";
  for (const environment of ["staging", "production"]) {
    const r = await api("/api/items?environment=" + environment);
    const j = await r.json().catch(function() { return {}; });
    for (const i of j.items || []) {
      const row = document.createElement("div");
      row.textContent = environment + " " + i.name + " " + i.kind + " ····" + i.last4 + " " + (i.username || "");
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", function() { openConfirm("item", i.id); });
      row.appendChild(del);
      el.appendChild(row);
    }
  }
}
async function loadInbox() {
  const el = document.getElementById("inbox");
  if (!el) return;
  el.innerHTML = "";
  const r = await api("/api/inbox");
  const j = await r.json().catch(function() { return {}; });
  for (const n of j.needs || []) {
    const row = document.createElement("div");
    row.textContent = [n.client_name, "needs", n.suggested_name, n.host, n.task_description].filter(Boolean).join(" ");
    const a = document.createElement("a");
    a.href = n.collect_path || ("/collect/" + n.id);
    a.textContent = "Open collect";
    row.appendChild(a);
    el.appendChild(row);
  }
  for (const g of j.grants || []) {
    const row = document.createElement("div");
    row.textContent = g.id + " " + g.status + " " + (g.task_description || "");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Approve prompt";
    b.addEventListener("click", async function() {
      await api("/api/grants/" + g.id + "/approve", { method: "POST", body: JSON.stringify({ policy: "prompt" }) });
      loadInbox();
    });
    row.appendChild(b);
    el.appendChild(row);
  }
}
function rowText(parts) {
  const row = document.createElement("div");
  row.textContent = parts.filter(Boolean).join(" ");
  return row;
}
async function loadAccess() {
  const panel = document.getElementById("access-panel");
  if (!panel) return;
  const snap = await api("/api/access");
  if (snap.status === 401) {
    const signin = document.getElementById("console-signin");
    if (signin) signin.hidden = false;
    return;
  }
  const data = await snap.json().catch(function() { return {}; });
  const ev = await api("/api/access/events");
  const ledger = ev.ok ? await ev.json() : { events: [] };
  const clients = data.clients || [];
  const grants = data.grants || [];
  const sessions = data.sessions || [];
  const empty = clients.length === 0 && grants.length === 0 && sessions.filter(function(s) { return !s.current; }).length === 0;
  const emptyEl = document.getElementById("access-empty");
  if (emptyEl) emptyEl.hidden = !empty;
  const cEl = document.getElementById("access-clients");
  const gEl = document.getElementById("access-grants");
  const sEl = document.getElementById("access-sessions");
  const aEl = document.getElementById("access-activity");
  if (cEl) {
    cEl.innerHTML = "";
    for (const c of clients) {
      const row = rowText([c.name, c.kind, c.status, c.environment]);
      if (c.status === "active") {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Revoke";
        b.addEventListener("click", function() { openConfirm("client", c.id); });
        row.appendChild(b);
      }
      cEl.appendChild(row);
    }
  }
  if (gEl) {
    gEl.innerHTML = "";
    for (const g of grants) {
      const row = rowText([g.item_name, g.client_name, g.status]);
      if (g.status === "active" || g.status === "pending") {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Revoke";
        b.addEventListener("click", function() { openConfirm("grant", g.id); });
        row.appendChild(b);
      }
      gEl.appendChild(row);
    }
  }
  if (sEl) {
    sEl.innerHTML = "";
    for (const s of sessions) {
      const row = rowText([s.id, s.current ? "current" : ""]);
      if (!s.current) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Revoke";
        b.addEventListener("click", function() { openConfirm("session", s.id); });
        row.appendChild(b);
      }
      sEl.appendChild(row);
    }
  }
  if (aEl) {
    aEl.innerHTML = "";
    for (const e of ledger.events || []) {
      aEl.appendChild(rowText([e.kind, e.issued_at, e.revoked_at ? "revoked" : ""]));
    }
  }
}
document.addEventListener("DOMContentLoaded", function() {
  const mcp = document.getElementById("mcp_url");
  if (mcp) mcp.textContent = location.origin + "/mcp";
  const boot = document.getElementById("bootstrap");
  if (boot) {
    boot.addEventListener("submit", function(e) {
      e.preventDefault();
      sessionStorage.setItem("vault_op_token", boot.token.value.trim());
      boot.token.value = "";
      flash("Bootstrap token saved in this tab");
      loadItems(); loadInbox(); loadAccess();
    });
  }
  const store = document.getElementById("store");
  if (store) store.addEventListener("submit", async function(e) {
    e.preventDefault();
    const f = store;
    const hosts = f.allowed_hosts.value.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
    const r = await api("/api/items", { method: "POST", body: JSON.stringify({
      name: f.name.value, kind: f.kind.value, environment: f.environment.value,
      value: f.value.value, username: f.username.value || undefined,
      allowed_hosts: hosts, inject: f.inject.value
    }) });
    f.value.value = "";
    flash(r.ok ? "Stored" : "Store failed");
    loadItems();
  });
  const rotate = document.getElementById("rotate");
  if (rotate) rotate.addEventListener("submit", async function(e) {
    e.preventDefault();
    const r = await api("/api/items/" + rotate.id.value + "/rotate", { method: "POST", body: JSON.stringify({ value: rotate.value.value }) });
    rotate.value.value = "";
    flash(r.ok ? "Rotated" : "Rotate failed");
    loadItems();
  });
  const code = document.getElementById("code");
  if (code) code.addEventListener("submit", async function(e) {
    e.preventDefault();
    const r = await api("/api/grants/approve-by-code", { method: "POST", body: JSON.stringify({ code: code.code.value }) });
    flash(r.ok ? "Approved" : "Code rejected");
    loadInbox();
  });
  const grok = document.getElementById("grok");
  if (grok) grok.addEventListener("submit", async function(e) {
    e.preventDefault();
    const r = await api("/api/clients/model", { method: "POST", body: JSON.stringify({ name: grok.name.value || "grok", environment: "staging" }) });
    const j = await r.json().catch(function() { return {}; });
    const box = document.getElementById("grok_once");
    if (!r.ok || !j.token) { flash("Could not issue Grok token"); if (box) box.textContent = ""; return; }
    if (box) box.textContent = "Shown once. Grok Bot connector Authorization:\\nBearer " + j.token;
    flash("Grok token issued. Copy it now.");
    loadAccess();
  });
  const confirm = document.getElementById("confirm");
  const yes = document.getElementById("confirm-yes");
  if (yes) yes.addEventListener("click", async function() {
    if (pendingDelete.kind === "item") await api("/api/items/" + pendingDelete.id, { method: "DELETE" });
    if (pendingDelete.kind === "client") await api("/api/clients/" + pendingDelete.id + "/revoke", { method: "POST", body: "{}" });
    if (pendingDelete.kind === "grant") await api("/api/grants/" + pendingDelete.id + "/revoke", { method: "POST", body: "{}" });
    if (pendingDelete.kind === "session") await api("/api/sessions/" + pendingDelete.id + "/revoke", { method: "POST", body: "{}" });
    if (confirm && confirm.close) confirm.close();
    loadItems(); loadInbox(); loadAccess();
  });
  loadItems(); loadInbox(); loadAccess();
});
`;

export const COLLECT_JS = `function csrf() {
  const m = document.cookie.match(/(?:^|; )(?:__Host-bp_csrf|bp_csrf)=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
function bootstrapToken() { return sessionStorage.getItem("vault_op_token") || ""; }
function headers() {
  const h = { "content-type": "application/json" };
  const t = csrf();
  if (t) h["X-CSRF-Token"] = t;
  const b = bootstrapToken();
  if (b) h.Authorization = "Bearer " + b;
  return h;
}
document.addEventListener("DOMContentLoaded", function() {
  const flash = document.getElementById("flash");
  const boot = document.getElementById("bootstrap");
  const details = document.getElementById("details");
  const needId = details && details.dataset.needId;
  async function loadNeed() {
    if (!details || !needId) return;
    const r = await fetch("/api/need-items/" + needId, { credentials: "include", headers: headers() });
    if (!r.ok) {
      if (flash) flash.textContent = r.status === 401 ? "Sign in to load this collect request" : "Need not found";
      return;
    }
    const need = await r.json();
    const pending = need.status === "pending";
    const heading = pending ? (need.client_name + " needs a credential") : "This collect request is no longer pending";
    const task = need.task_description ? "<p>Task: " + escapeHtml(need.task_description) + "</p>" : "";
    const formHtml = pending ? (
      '<form id="fulfill" data-need-id="' + escapeAttr(needId) + '">' +
      '<label>Name <input name="name" required value="' + escapeAttr(need.suggested_name || "") + '" /></label>' +
      '<label>Allowed hosts (comma) <input name="allowed_hosts" required value="' + escapeAttr(need.host || "") + '" /></label>' +
      '<label>Inject <select name="inject"><option value="bearer" selected>bearer</option><option value="basic">basic</option><option value="header:Authorization">header:Authorization</option></select></label>' +
      '<label>Kind <select name="kind"><option value="secret" selected>secret</option><option value="login">login</option></select></label>' +
      '<label>Username (login) <input name="username" /></label>' +
      '<label>Value <input name="value" type="password" autocomplete="off" required /></label>' +
      '<button type="submit">Store and grant</button></form>'
    ) : "";
    details.innerHTML = '<div class="banner">' + escapeHtml(heading) + "</div>" + task + formHtml;
    bindFulfill();
  }
  function escapeHtml(s) {
    return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function bindFulfill() {
    const form = document.getElementById("fulfill");
    if (!form) return;
    form.addEventListener("submit", async function(e) {
      e.preventDefault();
      const hosts = form.allowed_hosts.value.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
      const r = await fetch("/api/need-items/" + form.dataset.needId + "/fulfill", {
        method: "POST", credentials: "include", headers: headers(),
        body: JSON.stringify({
          name: form.name.value, value: form.value.value, allowed_hosts: hosts,
          inject: form.inject.value, kind: form.kind.value, username: form.username.value || undefined
        })
      });
      const data = await r.json().catch(function() { return {}; });
      form.value.value = "";
      if (flash) flash.textContent = r.ok ? "Stored and granted" : (data.error || "Store failed");
    });
  }
  if (boot) boot.addEventListener("submit", function(e) {
    e.preventDefault();
    sessionStorage.setItem("vault_op_token", boot.token.value.trim());
    boot.token.value = "";
    if (flash) flash.textContent = "Bootstrap token saved in this tab";
    loadNeed();
  });
  loadNeed();
});
`;

export function hostedAsset(path: string): { type: string; body: string } | undefined {
  if (path === "/assets/auth.css" || path === "/assets/console.css") {
    return { type: "text/css; charset=utf-8", body: AUTH_CSS };
  }
  if (path === "/assets/auth.js") return { type: "text/javascript; charset=utf-8", body: AUTH_JS };
  if (path === "/assets/console.js") return { type: "text/javascript; charset=utf-8", body: CONSOLE_JS };
  if (path === "/assets/collect.js") return { type: "text/javascript; charset=utf-8", body: COLLECT_JS };
  return undefined;
}
