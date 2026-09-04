/** Collect page client script. Served at /assets/collect.js. */
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
function collectFlash(el, msg, ok) {
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("is-ok", Boolean(ok) && Boolean(msg));
  el.classList.toggle("is-err", !ok && Boolean(msg));
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
      collectFlash(flash, r.status === 401 ? "Sign in to load this collect request" : "Need not found", false);
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
      '<label>Kind <select name="kind"><option value="secret" selected>API token</option><option value="client_secret">Client ID and secret</option></select></label>' +
      '<label id="fulfill-username" hidden><span id="fulfill-username-label">Client ID</span> <input name="username" autocomplete="username" /></label>' +
      '<p id="fulfill-inject-summary" class="hint">Sent as Authorization: Bearer. Typical for API tokens. A Client Secret is not an access token.</p>' +
      '<details id="fulfill-inject-advanced"><summary>Change how it is sent</summary>' +
      '<label>Send as <select name="inject"><option value="bearer" selected>Authorization: Bearer (typical API token)</option><option value="client_credentials">OAuth client secret (mint app token)</option><option value="basic">HTTP Basic (username + password)</option><option value="header:Authorization">Raw Authorization header</option></select></label>' +
      '</details>' +
      '<label><span id="fulfill-value-label">Value</span> <input name="value" type="password" autocomplete="off" required /></label>' +
      '<button type="submit">Store and grant</button></form>'
    ) : "";
    details.innerHTML = '<div class="banner">' + escapeHtml(heading) + "</div>" + task + formHtml;
    bindFulfill();
    bindFulfillUsername();
  }
  function escapeHtml(s) {
    return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function bindFulfillUsername() {
    const form = document.getElementById("fulfill");
    const row = document.getElementById("fulfill-username");
    const summary = document.getElementById("fulfill-inject-summary");
    if (!form) return;
    const userLabel = document.getElementById("fulfill-username-label");
    const valueLabel = document.getElementById("fulfill-value-label");
    function sync() {
      const show = form.kind.value === "client_secret" || form.inject.value === "basic" || form.inject.value === "client_credentials";
      if (row) {
        row.hidden = !show;
        if (!show) form.username.value = "";
      }
      if (userLabel) {
        userLabel.textContent = (form.kind.value === "client_secret" || form.inject.value === "client_credentials") ? "Client ID" : "HTTP Basic username";
      }
      if (valueLabel) {
        valueLabel.textContent = (form.kind.value === "client_secret" || form.inject.value === "client_credentials") ? "Client Secret" : "Value";
      }
      if (summary) {
        if (form.inject.value === "basic") summary.textContent = "Sent as HTTP Basic (username + password).";
        else if (form.inject.value === "client_credentials") summary.textContent = "OAuth client secret. Token mint uses HTTP Basic (client_id:secret) and a form body. Not a user access token.";
        else if (form.inject.value === "header:Authorization") summary.textContent = "Sent as a raw Authorization header, with no Bearer prefix.";
        else summary.textContent = "Sent as Authorization: Bearer. Typical for API tokens. A Client Secret is not an access token.";
      }
    }
    form.kind.addEventListener("change", function() {
      if (form.kind.value === "client_secret") {
        form.inject.value = "client_credentials";
        if (!form.allowed_hosts.value) form.allowed_hosts.value = "api.spotify.com, accounts.spotify.com";
      } else form.inject.value = "bearer";
      sync();
    });
    form.inject.addEventListener("change", sync);
    sync();
  }
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
          inject: form.kind.value === "client_secret" ? "client_credentials" : form.inject.value,
          kind: form.kind.value === "client_secret" ? "client_secret" : "secret",
          username: (form.kind.value === "client_secret" || form.inject.value === "basic" || form.inject.value === "client_credentials") ? (form.username.value || undefined) : undefined
        })
      });
      const data = await r.json().catch(function() { return {}; });
      if (r.ok) form.value.value = "";
      collectFlash(flash, r.ok ? "Stored and granted" : (data.error || "Store failed"), r.ok);
    });
  }
  if (boot) boot.addEventListener("submit", function(e) {
    e.preventDefault();
    sessionStorage.setItem("vault_op_token", boot.token.value.trim());
    boot.token.value = "";
    collectFlash(flash, "Bootstrap token saved in this tab", true);
    loadNeed();
  });
  loadNeed();
});
`;
