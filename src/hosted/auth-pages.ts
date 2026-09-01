import { PRODUCT_NAME } from "../brand.ts";

function shell(title: string, testid: string, body: string, script = "/assets/auth.js"): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="stylesheet" href="/assets/auth.css" />
</head>
<body>
  <main data-testid="${testid}">
    <h1>${title}</h1>
    ${body}
    <p id="flash" class="flash"></p>
  </main>
  <script src="${script}"></script>
</body>
</html>`;
}

export function signInHtml(): string {
  return shell(
    "Sign in",
    "sign-in",
    `<p>Email and a one-time code. Then TOTP if you have not enrolled yet.</p>
    <form id="otp-send">
      <label>Email <input name="email" type="email" autocomplete="username" required /></label>
      <button type="submit">Send code</button>
    </form>
    <form id="otp-verify">
      <label>Email <input name="email" type="email" autocomplete="username" required /></label>
      <label>Code <input name="otp" inputmode="numeric" maxlength="8" autocomplete="one-time-code" required /></label>
      <button type="submit">Verify</button>
    </form>
    <p><a href="/sign-up">Create account</a></p>`,
  );
}

export function signUpHtml(): string {
  return shell(
    "Create account",
    "sign-up",
    `<p>We email an 8-digit code. After that you enroll TOTP.</p>
    <form id="otp-send">
      <label>Email <input name="email" type="email" autocomplete="username" required /></label>
      <button type="submit">Send code</button>
    </form>
    <form id="otp-verify">
      <label>Email <input name="email" type="email" autocomplete="username" required /></label>
      <label>Code <input name="otp" inputmode="numeric" maxlength="8" autocomplete="one-time-code" required /></label>
      <button type="submit">Verify</button>
    </form>
    <p><a href="/sign-in">Sign in</a></p>`,
  );
}

export function enrollTotpHtml(): string {
  return shell(
    "Enroll authenticator",
    "enroll-totp",
    `<p>Scan the QR code or open the link in your authenticator app. If you cannot scan, copy the key or the otpauth URL. Backup codes appear once after confirm.</p>
    <figure id="totp-figure" hidden>
      <div id="totp-qr" class="totp-qr" data-testid="totp-qr"></div>
      <figcaption>Scan with your authenticator app</figcaption>
    </figure>
    <p><a id="otpauth-link" data-testid="otpauth-link" hidden>Open in authenticator app</a></p>
    <p>Cannot scan? Enter this key:</p>
    <p><code id="totp-secret" data-testid="totp-secret"></code></p>
    <pre id="otpauth" data-testid="otpauth-url"></pre>
    <form id="totp-confirm">
      <label>Authenticator code <input name="code" inputmode="numeric" maxlength="6" required /></label>
      <button type="submit">Confirm</button>
    </form>
    <pre id="backups"></pre>`,
  );
}

export function consentHtml(clientName: string, uid: string): string {
  const name = escapeHtml(clientName || "MCP client");
  return shell(
    "Allow access",
    "oauth-consent",
    `<p>${name} wants an access token for this vault MCP. No remote images are loaded.</p>
    <form id="consent" method="post" action="/consent">
      <input type="hidden" name="uid" value="${escapeAttr(uid)}" />
      <button type="submit" name="decision" value="allow">Allow</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>`,
  );
}

export function deviceHtml(flash?: string): string {
  const note = flash ? `<p class="flash">${escapeHtml(flash)}</p>` : "";
  return shell(
    "Device login",
    "device-code",
    `<p>Enter the code shown in your terminal.</p>
    ${note}
    <form id="device" method="post" action="/device">
      <label>Device code <input name="user_code" inputmode="numeric" required /></label>
      <button type="submit">Continue</button>
    </form>`,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

export { escapeHtml };
