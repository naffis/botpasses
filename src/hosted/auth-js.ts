/** Sign-in, sign-up, enroll, verify, consent client script. Served at /assets/auth.js. */
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
function errorText(r, fallback) {
  const b = r.body || {};
  if (r.status === 429 && typeof b.retry_after === "number") {
    return (b.error || "Too many attempts.") + " Try again in " + Math.max(1, Math.ceil(b.retry_after / 60)) + " min.";
  }
  let text = b.error || fallback;
  if (typeof b.attempts_remaining === "number") {
    text += " " + b.attempts_remaining + (b.attempts_remaining === 1 ? " attempt left." : " attempts left.");
  }
  return text;
}
const note = document.getElementById("flash");
const sendForm = document.getElementById("otp-send");
const sentBox = document.getElementById("otp-sent");
const verifyForm = document.getElementById("otp-verify");
const totpForm = document.getElementById("totp-confirm");
const totpVerifyForm = document.getElementById("totp-verify");
if (verifyForm) verifyForm.hidden = true;
let resendTimer = 0;
function startResendCountdown() {
  const btn = document.getElementById("otp-resend");
  if (!btn) return;
  let left = 30;
  btn.disabled = true;
  btn.textContent = "Resend in " + left + " s";
  clearInterval(resendTimer);
  resendTimer = setInterval(function() {
    left -= 1;
    if (left <= 0) {
      clearInterval(resendTimer);
      btn.disabled = false;
      btn.textContent = "Resend";
      return;
    }
    btn.textContent = "Resend in " + left + " s";
  }, 1000);
}
async function sendCode(email) {
  const r = await post("/api/auth/otp/send", { email: email });
  if (!r.ok) { flash(note, errorText(r, "Could not send code"), false); return; }
  flash(note, "", true);
  if (sendForm) sendForm.hidden = true;
  if (sentBox) {
    sentBox.hidden = false;
    const who = document.getElementById("sent-email");
    if (who) who.textContent = email;
    const msg = document.getElementById("sent-message");
    if (msg) msg.textContent = r.body.message || "";
  }
  if (verifyForm) {
    verifyForm.hidden = false;
    if (verifyForm.email) verifyForm.email.value = email;
    const otp = verifyForm.querySelector("[name=otp]");
    if (otp) otp.focus();
  }
  startResendCountdown();
}
if (sendForm) {
  sendForm.addEventListener("submit", async function(e) {
    e.preventDefault();
    await sendCode(sendForm.email.value.trim());
  });
  const change = document.getElementById("otp-change");
  if (change) {
    change.addEventListener("click", function() {
      clearInterval(resendTimer);
      if (sentBox) sentBox.hidden = true;
      if (verifyForm) verifyForm.hidden = true;
      sendForm.hidden = false;
      flash(note, "", true);
      sendForm.email.focus();
    });
  }
  const resend = document.getElementById("otp-resend");
  if (resend) {
    resend.addEventListener("click", async function() {
      await sendCode(sendForm.email.value.trim());
    });
  }
}
if (verifyForm) {
  verifyForm.addEventListener("submit", async function(e) {
    e.preventDefault();
    const r = await post("/api/auth/otp/verify", { email: verifyForm.email.value.trim(), otp: verifyForm.otp.value.trim() });
    if (!r.ok) { flash(note, errorText(r, "Invalid code"), false); return; }
    if (r.body.enroll) { location.href = "/enroll-totp"; return; }
    if (r.body.verify) { location.href = "/verify-totp"; return; }
    location.href = "/console";
  });
}
function showBackupCodes(codes) {
  const enroll = document.getElementById("enroll-step");
  const step = document.getElementById("backup-step");
  const list = document.getElementById("backups");
  if (!step || !list) { location.href = "/console"; return; }
  list.replaceChildren();
  codes.forEach(function(code) {
    const li = document.createElement("li");
    li.textContent = code;
    list.appendChild(li);
  });
  const text = codes.join("\\n") + "\\n";
  const dl = document.getElementById("backups-download");
  if (dl) {
    dl.setAttribute("href", "data:text/plain;charset=utf-8," + encodeURIComponent("Botpasses backup codes\\n\\n" + text));
    dl.hidden = false;
  }
  const copy = document.getElementById("backups-copy");
  if (copy) {
    copy.addEventListener("click", async function() {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
      } catch (err) {
        flash(note, "Copy failed. Select the codes and copy them by hand.", false);
      }
    });
  }
  if (enroll) enroll.hidden = true;
  step.hidden = false;
  flash(note, "Authenticator confirmed. Save your backup codes, then continue.", true);
  const cont = document.getElementById("backups-continue");
  if (cont) cont.focus();
}
if (totpForm) {
  (async function() {
    const start = await fetch("/api/auth/totp/start", { method: "POST", credentials: "include", headers: headers(true), body: "{}" });
    const j = await start.json().catch(function() { return {}; });
    if (!start.ok || !j.otpauth_url) {
      flash(note, j.error || "Could not start authenticator setup", false);
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
        svg.setAttribute("aria-label", "QR code for authenticator app setup");
        box.replaceChildren(svg);
        if (figure) figure.hidden = false;
      }
    }
  })().catch(function() { flash(note, "Could not start authenticator setup", false); });
  totpForm.addEventListener("submit", async function(e) {
    e.preventDefault();
    const r = await post("/api/auth/totp/confirm", { code: totpForm.code.value.trim() });
    if (!r.ok) { flash(note, errorText(r, "Invalid code"), false); return; }
    showBackupCodes(Array.isArray(r.body.backup_codes) ? r.body.backup_codes : []);
  });
}
if (totpVerifyForm) {
  totpVerifyForm.addEventListener("submit", async function(e) {
    e.preventDefault();
    const r = await post("/api/auth/totp/verify", { code: totpVerifyForm.code.value.trim() });
    if (!r.ok) {
      flash(note, errorText(r, "Invalid code"), false);
      totpVerifyForm.code.select();
      return;
    }
    location.href = "/console";
  });
}
const signout = document.getElementById("signout");
if (signout) {
  signout.addEventListener("click", async function() {
    await post("/api/auth/logout", {});
    location.href = "/sign-in";
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
