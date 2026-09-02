import { CONSOLE_ACCESS_JS } from "./console-access-js.ts";
import { CONSOLE_CSS } from "./console-css.ts";
import { CONSOLE_JS as CONSOLE_CORE_JS } from "./console-js.ts";

export { CONSOLE_CSS };
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
function flash(el, msg, ok) {
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("is-ok", Boolean(ok) && Boolean(msg));
  el.classList.toggle("is-err", !ok && Boolean(msg));
}
const sendForm = document.getElementById("otp-send");
const verifyForm = document.getElementById("otp-verify");
const totpForm = document.getElementById("totp-confirm");
const note = document.getElementById("flash");
if (verifyForm) verifyForm.hidden = true;
if (sendForm) {
  sendForm.addEventListener("submit", async function(e) {
    e.preventDefault();
    const email = sendForm.email.value.trim();
    const r = await post("/api/auth/otp/send", { email: email });
    if (r.ok) {
      flash(note, "Check your inbox for a sign-in code. A code already sent is still valid for 10 minutes.", true);
      if (verifyForm) {
        verifyForm.hidden = false;
        if (verifyForm.email) verifyForm.email.value = email;
        const otp = verifyForm.querySelector("[name=otp]");
        if (otp) otp.focus();
      }
      return;
    }
    flash(note, r.body.error || "Could not send code", false);
  });
}
if (verifyForm) {
  verifyForm.addEventListener("submit", async function(e) {
    e.preventDefault();
    const r = await post("/api/auth/otp/verify", { email: verifyForm.email.value.trim(), otp: verifyForm.otp.value.trim() });
    if (!r.ok) { flash(note, r.body.error || "Invalid code", false); return; }
    if (r.body.enroll) { location.href = "/enroll-totp"; return; }
    location.href = "/console";
  });
}
if (totpForm) {
  (async function() {
    const start = await fetch("/api/auth/totp/start", { method: "POST", credentials: "include", headers: headers(true), body: "{}" });
    const j = await start.json().catch(function() { return {}; });
    if (!start.ok || !j.otpauth_url) {
      flash(note, j.error || "Could not start authenticator enrollment", false);
      return;
    }
    const link = document.getElementById("otpauth-link");
    if (link) {
      link.setAttribute("href", j.otpauth_url);
      link.hidden = false;
    }
    const uri = document.getElementById("otpauth");
    if (uri) uri.textContent = j.otpauth_url;
    const key = document.getElementById("totp-secret");
    if (key) {
      const secret = new URL(j.otpauth_url).searchParams.get("secret") || "";
      key.textContent = secret.replace(/(.{4})(?=.)/g, "$1 ");
    }
    const box = document.getElementById("totp-qr");
    const figure = document.getElementById("totp-figure");
    if (box && typeof j.qr_svg === "string" && j.qr_svg.indexOf("<svg") === 0) {
      const parsed = new DOMParser().parseFromString(j.qr_svg, "image/svg+xml");
      const svg = parsed.documentElement;
      if (svg && svg.nodeName.toLowerCase() === "svg" && !parsed.querySelector("parsererror")) {
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", "QR code for authenticator enrollment");
        box.replaceChildren(svg);
        if (figure) figure.hidden = false;
      }
    }
  })().catch(function() { flash(note, "Could not start authenticator enrollment", false); });
  totpForm.addEventListener("submit", async function(e) {
    e.preventDefault();
    const r = await post("/api/auth/totp/confirm", { code: totpForm.code.value.trim() });
    if (!r.ok) { flash(note, r.body.error || "Invalid code", false); return; }
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
    flash(note, "Consent failed", false);
  });
}
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
      '<label>Kind <select name="kind"><option value="secret" selected>API token</option><option value="client_secret">OAuth client secret (Spotify app)</option><option value="login">Username and password</option></select></label>' +
      '<label id="fulfill-username" hidden>Client ID or HTTP Basic username <input name="username" autocomplete="username" /></label>' +
      '<p id="fulfill-inject-summary" class="hint">Sent as Authorization: Bearer. Typical for API tokens. A Client Secret is not an access token.</p>' +
      '<details id="fulfill-inject-advanced"><summary>Change how it is sent</summary>' +
      '<label>Send as <select name="inject"><option value="bearer" selected>Authorization: Bearer (typical API token)</option><option value="client_credentials">OAuth client secret (mint app token)</option><option value="basic">HTTP Basic (username + password)</option><option value="header:Authorization">Raw Authorization header</option></select></label>' +
      '</details>' +
      '<label>Value <input name="value" type="password" autocomplete="off" required /></label>' +
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
    function sync() {
      const show = form.kind.value === "login" || form.kind.value === "client_secret" || form.inject.value === "basic" || form.inject.value === "client_credentials";
      if (row) {
        row.hidden = !show;
        if (!show) form.username.value = "";
      }
      if (summary) {
        if (form.inject.value === "basic") summary.textContent = "Sent as HTTP Basic (username + password).";
        else if (form.inject.value === "client_credentials") summary.textContent = "OAuth client secret. Token mint uses HTTP Basic (client_id:secret) and a form body. Not a user access token.";
        else if (form.inject.value === "header:Authorization") summary.textContent = "Sent as a raw Authorization header, with no Bearer prefix.";
        else summary.textContent = "Sent as Authorization: Bearer. Typical for API tokens. A Client Secret is not an access token.";
      }
    }
    form.kind.addEventListener("change", function() {
      if (form.kind.value === "login") form.inject.value = "basic";
      else if (form.kind.value === "client_secret") form.inject.value = "client_credentials";
      else form.inject.value = "bearer";
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
          kind: form.kind.value === "login" ? "login" : "secret",
          username: (form.kind.value === "login" || form.kind.value === "client_secret" || form.inject.value === "basic" || form.inject.value === "client_credentials") ? (form.username.value || undefined) : undefined
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
