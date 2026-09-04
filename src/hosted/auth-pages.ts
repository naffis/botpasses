import { authDocument, escapeAttr, escapeHtml } from "./auth-shell.ts";

export function signInHtml(): string {
  return authDocument({
    title: "Sign in",
    testid: "sign-in",
    body: `<p>Email and a one-time code. Then TOTP if you have not enrolled yet.</p>
    <form id="otp-send">
      <label>Email <input name="email" type="email" autocomplete="username" required /></label>
      <button type="submit">Send code</button>
    </form>
    <form id="otp-verify" hidden>
      <label>Email <input name="email" type="email" autocomplete="username" required /></label>
      <label>Code <input name="otp" inputmode="numeric" maxlength="8" autocomplete="one-time-code" required /></label>
      <button type="submit">Verify</button>
    </form>
    <p><a href="/sign-up">Create account</a></p>`,
  });
}

export function signUpHtml(): string {
  return authDocument({
    title: "Create account",
    testid: "sign-up",
    body: `<p>We email an 8-digit code. After that you enroll TOTP.</p>
    <form id="otp-send">
      <label>Email <input name="email" type="email" autocomplete="username" required /></label>
      <button type="submit">Send code</button>
    </form>
    <form id="otp-verify" hidden>
      <label>Email <input name="email" type="email" autocomplete="username" required /></label>
      <label>Code <input name="otp" inputmode="numeric" maxlength="8" autocomplete="one-time-code" required /></label>
      <button type="submit">Verify</button>
    </form>
    <p><a href="/sign-in">Sign in</a></p>`,
  });
}

export function enrollTotpHtml(): string {
  return authDocument({
    title: "Enroll authenticator",
    testid: "enroll-totp",
    wide: true,
    body: `<p>Scan the QR code or open the link in your authenticator app. If you cannot scan, copy the key or the otpauth URL. Backup codes appear once after confirm.</p>
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
  });
}

export { consentHtml, deviceHtml } from "./oauth-pages.ts";
export { escapeHtml };
