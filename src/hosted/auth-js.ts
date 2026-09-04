/** Sign-in, sign-up, enroll, consent client script. Served at /assets/auth.js. */
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
