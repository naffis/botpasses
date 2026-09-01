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
function flash(m, ok) {
  setFormNotice("flash", m, ok);
}
function setFormNotice(id, m, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = m || "";
  el.classList.toggle("is-ok", Boolean(ok) && Boolean(m));
  el.classList.toggle("is-err", !ok && Boolean(m));
}
function setHidden(id, hidden) {
  const el = document.getElementById(id);
  if (el) el.hidden = hidden;
}
function text(el, value) { if (el) el.textContent = value; }
let landingHash = "";
let inboxAutoland = true;
function copyText(value, okMsg) {
  if (!value) return;
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    flash("Copy is not available in this browser", false);
    return;
  }
  navigator.clipboard.writeText(value).then(function() { flash(okMsg, true); }, function() { flash("Copy failed", false); });
}
const pendingDelete = { kind: "", id: "" };
function openConfirm(kind, id) {
  pendingDelete.kind = kind;
  pendingDelete.id = id;
  setFormNotice("confirm-error", "", true);
  const d = document.getElementById("confirm");
  if (d && d.showModal) d.showModal();
}
function showPanel(name) {
  const titles = {
    inbox: ["Inbox", "Approve an agent when it needs a credential. The model never sees the value."],
    vault: ["Vault", "Named credentials. Last-4 only. Rotate or delete from the row."],
    connect: ["Connect", "Issue a token once. Then ask the agent in plain language."],
    access: ["Access", "Who holds a token, grant, or session. Revoke from here."]
  };
  const info = titles[name] || titles.vault;
  document.querySelectorAll("[data-panel]").forEach(function(p) {
    p.classList.toggle("is-active", p.getAttribute("data-panel") === name);
  });
  document.querySelectorAll("[data-nav]").forEach(function(a) {
    if (a.getAttribute("data-nav") === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  text(document.getElementById("page-title"), info[0]);
  text(document.getElementById("page-lede"), info[1]);
  const storeBtn = document.getElementById("open-store");
  if (storeBtn) storeBtn.hidden = document.body.dataset.session === "out" || name !== "vault";
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
}
function currentPanel() {
  const active = document.querySelector("[data-panel].is-active");
  return active ? active.getAttribute("data-panel") : "vault";
}
function sessionOut(out) {
  document.body.dataset.session = out ? "out" : "in";
  const gate = document.getElementById("signed-out-gate");
  const signin = document.getElementById("console-signin");
  const main = document.getElementById("main");
  if (gate) gate.hidden = !out;
  if (main) main.hidden = out;
  if (signin && signin.querySelector("a")) signin.hidden = !out;
  const storeBtn = document.getElementById("open-store");
  if (storeBtn) storeBtn.hidden = out || currentPanel() !== "vault";
  if (out) {
    text(document.getElementById("page-title"), "Sign in");
    text(document.getElementById("page-lede"), "This tab needs an operator session.");
  } else {
    const panel = currentPanel();
    if (panel) showPanel(panel);
  }
}
function pill(value) {
  const span = document.createElement("span");
  span.className = "pill";
  span.textContent = value || "";
  return span;
}
async function loadItems() {
  const body = document.getElementById("items");
  const empty = document.getElementById("items-empty");
  const err = document.getElementById("items-error");
  if (!body) return;
  body.innerHTML = "";
  setHidden("items-empty", true);
  setHidden("items-error", true);
  setHidden("items-table", true);
  const r = await api("/api/items");
  const j = await r.json().catch(function() { return {}; });
  if (r.status === 401) { sessionOut(true); return; }
  if (!r.ok) {
    text(err, j.error || ("Could not load items (" + r.status + ")"));
    setHidden("items-error", false);
    return;
  }
  sessionOut(false);
  const items = j.items || [];
  if (!items.length) { setHidden("items-empty", false); return; }
  setHidden("items-table", false);
  for (const i of items) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "name";
    name.setAttribute("data-label", "Name");
    name.textContent = i.name;
    const kind = document.createElement("td");
    kind.setAttribute("data-label", "Kind");
    kind.appendChild(pill(i.kind === "login" ? "login" : "token"));
    const env = document.createElement("td");
    env.setAttribute("data-label", "Environment");
    env.appendChild(pill(i.environment || ""));
    const hosts = document.createElement("td");
    hosts.className = "mono";
    hosts.setAttribute("data-label", "Hosts");
    hosts.textContent = (i.allowedHosts || i.allowed_hosts || []).join(", ");
    const last = document.createElement("td");
    last.className = "last4 mono";
    last.setAttribute("data-label", "Last-4");
    last.textContent = "····" + (i.last4 || "");
    const actions = document.createElement("td");
    actions.className = "row-actions";
    actions.setAttribute("data-label", "Actions");
    const rot = document.createElement("button");
    rot.type = "button";
    rot.className = "btn-ghost";
    rot.textContent = "Rotate";
    rot.addEventListener("click", function() { openRotate(i.id, i.name); });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-danger";
    del.textContent = "Delete";
    del.addEventListener("click", function() { openConfirm("item", i.id); });
    actions.append(rot, del);
    tr.append(name, kind, env, hosts, last, actions);
    body.appendChild(tr);
  }
}
function inboxCard(title, detail, action) {
  const row = document.createElement("div");
  row.className = "inbox-item";
  const copy = document.createElement("div");
  const h = document.createElement("strong");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = detail;
  copy.append(h, p);
  row.appendChild(copy);
  if (action) row.appendChild(action);
  return row;
}
async function loadInbox() {
  const el = document.getElementById("inbox");
  const empty = document.getElementById("inbox-empty");
  const err = document.getElementById("inbox-error");
  const badge = document.getElementById("inbox-badge");
  if (!el) return;
  el.innerHTML = "";
  setHidden("inbox-empty", true);
  setHidden("inbox-error", true);
  const r = await api("/api/inbox");
  const j = await r.json().catch(function() { return {}; });
  if (r.status === 401) { sessionOut(true); return; }
  if (!r.ok) {
    text(err, j.error || ("Could not load inbox (" + r.status + ")"));
    setHidden("inbox-error", false);
    return;
  }
  const needs = j.needs || [];
  const grants = j.grants || [];
  const count = needs.length + grants.length;
  if (badge) {
    badge.textContent = String(count);
    badge.setAttribute("data-count", String(count));
  }
  if (!count) { setHidden("inbox-empty", false); inboxAutoland = false; return; }
  if (inboxAutoland && !landingHash) showPanel("inbox");
  inboxAutoland = false;
  for (const n of needs) {
    const a = document.createElement("a");
    a.className = "btn btn-primary";
    a.href = n.collect_path || ("/collect/" + n.id);
    a.textContent = "Store the credential";
    el.appendChild(inboxCard(
      (n.client_name || "Agent") + " needs " + (n.suggested_name || "a credential"),
      [n.host, n.task_description].filter(Boolean).join(" · "),
      a
    ));
  }
  for (const g of grants) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-primary";
    b.textContent = "Approve prompt";
    b.addEventListener("click", async function() {
      const res = await api("/api/grants/" + g.id + "/approve", { method: "POST", body: JSON.stringify({ policy: "prompt" }) });
      const body = await res.json().catch(function() { return {}; });
      flash(res.ok ? "Approved" : (body.error || "Approve failed"), res.ok);
      loadInbox();
    });
    el.appendChild(inboxCard(
      "Grant " + g.status,
      [g.id, g.taskDescription || g.task_description].filter(Boolean).join(" · "),
      b
    ));
  }
}
function accessRow(parts, action) {
  const row = document.createElement("div");
  row.className = "access-row";
  const p = document.createElement("p");
  p.textContent = parts.filter(Boolean).join(" · ");
  row.appendChild(p);
  if (action) row.appendChild(action);
  return row;
}
function revokeBtn(kind, id) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn-danger";
  b.textContent = "Revoke";
  b.addEventListener("click", function() { openConfirm(kind, id); });
  return b;
}
function listEmpty(el, message) {
  if (!el) return;
  el.innerHTML = "";
  const p = document.createElement("p");
  p.className = "section-empty hint";
  p.textContent = message;
  el.appendChild(p);
}
async function loadAccess() {
  const panel = document.getElementById("access-panel");
  const err = document.getElementById("access-error");
  if (!panel) return;
  setHidden("access-error", true);
  const snap = await api("/api/access");
  const data = await snap.json().catch(function() { return {}; });
  if (snap.status === 401) { sessionOut(true); return; }
  if (!snap.ok) {
    text(err, data.error || ("Could not load access (" + snap.status + ")"));
    setHidden("access-error", false);
    return;
  }
  const ev = await api("/api/access/events");
  const ledger = await ev.json().catch(function() { return {}; });
  if (!ev.ok) {
    text(err, ledger.error || ("Could not load activity (" + ev.status + ")"));
    setHidden("access-error", false);
  }
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
    if (!clients.length) listEmpty(cEl, "No clients yet. Issue a token from Connect.");
    else for (const c of clients) {
      cEl.appendChild(accessRow([c.name, c.kind, c.status, c.environment], c.status === "active" ? revokeBtn("client", c.id) : null));
    }
  }
  if (gEl) {
    gEl.innerHTML = "";
    if (!grants.length) listEmpty(gEl, "No grants yet.");
    else for (const g of grants) {
      const live = g.status === "active" || g.status === "pending";
      gEl.appendChild(accessRow([g.item_name, g.client_name, g.status], live ? revokeBtn("grant", g.id) : null));
    }
  }
  if (sEl) {
    sEl.innerHTML = "";
    if (!sessions.length) listEmpty(sEl, "No other sessions.");
    else for (const s of sessions) {
      sEl.appendChild(accessRow([s.id, s.current ? "current" : ""], s.current ? null : revokeBtn("session", s.id)));
    }
  }
  if (aEl) {
    aEl.innerHTML = "";
    const events = ev.ok ? (ledger.events || []) : [];
    if (!ev.ok) listEmpty(aEl, "Could not load activity.");
    else if (!events.length) listEmpty(aEl, "No activity yet.");
    else for (const e of events) {
      aEl.appendChild(accessRow([e.kind, e.issued_at, e.revoked_at ? "revoked" : ""]));
    }
  }
}
function openStore() {
  setFormNotice("store-error", "", true);
  const d = document.getElementById("store-dialog");
  if (d && d.showModal) d.showModal();
}
function openRotate(id, name) {
  setFormNotice("rotate-error", "", true);
  const form = document.getElementById("rotate");
  if (form) {
    form.id.value = id || "";
    const hint = document.getElementById("rotate-name");
    if (hint) hint.textContent = name || id || "";
  }
  const d = document.getElementById("rotate-dialog");
  if (d && d.showModal) d.showModal();
}
function storeAuthSummary(inject) {
  if (inject === "basic") return "Sent as HTTP Basic (username + password).";
  if (inject === "header:Authorization") return "Sent as a raw Authorization header, with no Bearer prefix.";
  return "Sent as Authorization: Bearer. Typical for API tokens.";
}
function syncStoreAuthFields(form) {
  const row = document.getElementById("store-username");
  const summary = document.getElementById("store-inject-summary");
  if (!form) return;
  const show = form.kind.value === "login" || form.inject.value === "basic";
  if (row) {
    row.hidden = !show;
    if (!show) form.username.value = "";
  }
  if (summary) summary.textContent = storeAuthSummary(form.inject.value);
}
function closeDialog(id) {
  const d = document.getElementById(id);
  if (d && d.close) d.close();
}
document.addEventListener("DOMContentLoaded", function() {
  const mcp = document.getElementById("mcp_url");
  if (mcp) mcp.textContent = location.origin + "/mcp";
  landingHash = (location.hash || "").replace("#", "");
  document.querySelectorAll("[data-nav]").forEach(function(btn) {
    btn.addEventListener("click", function() { showPanel(btn.getAttribute("data-nav")); });
  });
  showPanel(landingHash === "inbox" || landingHash === "connect" || landingHash === "access" ? landingHash : "vault");
  const boot = document.getElementById("bootstrap");
  if (boot) {
    boot.addEventListener("submit", function(e) {
      e.preventDefault();
      sessionStorage.setItem("vault_op_token", boot.token.value.trim());
      boot.token.value = "";
      flash("Bootstrap token saved in this tab", true);
      loadItems(); loadInbox(); loadAccess();
    });
  }
  const store = document.getElementById("store");
  if (store) {
    store.kind.addEventListener("change", function() {
      store.inject.value = store.kind.value === "login" ? "basic" : "bearer";
      syncStoreAuthFields(store);
    });
    store.inject.addEventListener("change", function() { syncStoreAuthFields(store); });
    syncStoreAuthFields(store);
    store.addEventListener("submit", async function(e) {
      e.preventDefault();
      const f = store;
      setFormNotice("store-error", "", true);
      const hosts = f.allowed_hosts.value.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
      const r = await api("/api/items", { method: "POST", body: JSON.stringify({
        name: f.name.value, kind: f.kind.value, environment: f.environment.value,
        value: f.value.value,
        username: (f.kind.value === "login" || f.inject.value === "basic") ? (f.username.value || undefined) : undefined,
        allowed_hosts: hosts, inject: f.inject.value
      }) });
      const j = await r.json().catch(function() { return {}; });
      if (r.ok) {
        f.value.value = "";
        flash("Stored", true);
        closeDialog("store-dialog");
      } else {
        setFormNotice("store-error", j.error || "Store failed", false);
      }
      loadItems();
    });
  }
  const openStoreBtn = document.getElementById("open-store");
  if (openStoreBtn) openStoreBtn.addEventListener("click", openStore);
  const emptyStore = document.getElementById("empty-store");
  if (emptyStore) emptyStore.addEventListener("click", openStore);
  const copyMcp = document.getElementById("copy-mcp");
  if (copyMcp) copyMcp.addEventListener("click", function() {
    const el = document.getElementById("mcp_url");
    copyText(el ? el.textContent : "", "MCP URL copied");
  });
  let grokToken = "";
  const copyGrok = document.getElementById("copy-grok");
  if (copyGrok) copyGrok.addEventListener("click", function() { copyText(grokToken, "Token copied"); });
  const rotate = document.getElementById("rotate");
  if (rotate) rotate.addEventListener("submit", async function(e) {
    e.preventDefault();
    setFormNotice("rotate-error", "", true);
    const r = await api("/api/items/" + rotate.id.value + "/rotate", { method: "POST", body: JSON.stringify({ value: rotate.value.value }) });
    const j = await r.json().catch(function() { return {}; });
    if (r.ok) {
      rotate.value.value = "";
      flash("Rotated", true);
      closeDialog("rotate-dialog");
    } else {
      setFormNotice("rotate-error", j.error || "Rotate failed", false);
    }
    loadItems();
  });
  const code = document.getElementById("code");
  if (code) code.addEventListener("submit", async function(e) {
    e.preventDefault();
    const r = await api("/api/grants/approve-by-code", { method: "POST", body: JSON.stringify({ code: code.code.value }) });
    const j = await r.json().catch(function() { return {}; });
    flash(r.ok ? "Approved" : (j.error || "Code rejected"), r.ok);
    loadInbox();
  });
  const grok = document.getElementById("grok");
  if (grok) grok.addEventListener("submit", async function(e) {
    e.preventDefault();
    setFormNotice("grok-error", "", true);
    const r = await api("/api/clients/model", { method: "POST", body: JSON.stringify({ name: grok.name.value || "grok", environment: grok.environment.value }) });
    const j = await r.json().catch(function() { return {}; });
    const box = document.getElementById("grok_once");
    if (!r.ok || !j.token) {
      const msg = j.error || "Could not issue Grok token";
      setFormNotice("grok-error", msg, false);
      flash(msg, false);
      if (box) box.textContent = "";
      if (copyGrok) copyGrok.hidden = true;
      grokToken = "";
      return;
    }
    grokToken = j.token;
    if (box) box.textContent = "Shown once. Grok Bot connector Authorization:\\nBearer " + j.token;
    if (copyGrok) copyGrok.hidden = false;
    flash("Grok token issued. Copy it now.", true);
    loadAccess();
  });
  const confirm = document.getElementById("confirm");
  const yes = document.getElementById("confirm-yes");
  if (yes) yes.addEventListener("click", async function() {
    let r;
    if (pendingDelete.kind === "item") r = await api("/api/items/" + pendingDelete.id, { method: "DELETE" });
    else if (pendingDelete.kind === "client") r = await api("/api/clients/" + pendingDelete.id + "/revoke", { method: "POST", body: "{}" });
    else if (pendingDelete.kind === "grant") r = await api("/api/grants/" + pendingDelete.id + "/revoke", { method: "POST", body: "{}" });
    else if (pendingDelete.kind === "session") r = await api("/api/sessions/" + pendingDelete.id + "/revoke", { method: "POST", body: "{}" });
    else {
      setFormNotice("confirm-error", "Unknown action", false);
      return;
    }
    const j = await r.json().catch(function() { return {}; });
    if (!r.ok) {
      setFormNotice("confirm-error", j.error || "Request failed", false);
      return;
    }
    if (confirm && confirm.close) confirm.close();
    loadItems(); loadInbox(); loadAccess();
  });
  loadItems(); loadInbox(); loadAccess();
});
`;
