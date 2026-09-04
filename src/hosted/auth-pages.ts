import { authDocument, escapeAttr, escapeHtml } from "./auth-shell.ts";

export type AuthEntry = "sign-in" | "sign-up";

const ENTRY_COPY: Record<AuthEntry, { title: string; heading: string; otherHref: string; otherLabel: string }> = {
  "sign-in": { title: "Sign in", heading: "Sign in", otherHref: "/sign-up", otherLabel: "Create account" },
  "sign-up": { title: "Create account", heading: "Create account", otherHref: "/sign-in", otherLabel: "Sign in" },
};

/**
 * One page for `/sign-in` and `/sign-up`; only the heading and the footer link differ.
 * The send form hides after a successful send; the sent line, resend and code form take over.
 */
export function authEntryHtml(kind: AuthEntry): string {
  const copy = ENTRY_COPY[kind];
  return authDocument({
    title: copy.title,
    heading: copy.heading,
    testid: kind,
    body: `<p>Enter your email. We send an 8-digit code, then you confirm with your authenticator app.</p>
    <form id="otp-send">
      <label>Email <input name="email" type="email" autocomplete="username" required /></label>
      <button type="submit">Send code</button>
    </form>
    <div id="otp-sent" data-testid="otp-sent" hidden>
      <p>Sent to <strong id="sent-email"></strong>. <button type="button" id="otp-change" class="btn-ghost">Change</button></p>
      <p id="sent-message"></p>
      <button type="button" id="otp-resend" disabled>Resend in 30 s</button>
    </div>
    <form id="otp-verify" hidden>
      <input type="hidden" name="email" />
      <label>Code <input name="otp" inputmode="numeric" maxlength="8" autocomplete="one-time-code" required /></label>
      <button type="submit">Verify</button>
    </form>
    <p><a href="${escapeAttr(copy.otherHref)}">${escapeHtml(copy.otherLabel)}</a></p>`,
  });
}

export function signInHtml(): string {
  return authEntryHtml("sign-in");
}

export function signUpHtml(): string {
  return authEntryHtml("sign-up");
}

export function enrollTotpHtml(): string {
  return authDocument({
    title: "Set up your authenticator app",
    testid: "enroll-totp",
    wide: true,
    body: `<section id="enroll-step">
      <p>Scan the QR code with your authenticator app, or open the link on this device. If you cannot scan, enter the key by hand.</p>
      <figure id="totp-figure" hidden>
        <div id="totp-qr" class="totp-qr" data-testid="totp-qr"></div>
        <figcaption>Scan with your authenticator app</figcaption>
      </figure>
      <p><a id="otpauth-link" data-testid="otpauth-link" hidden>Open in authenticator app</a></p>
      <p>Cannot scan? Enter this key:</p>
      <p><code id="totp-secret" data-testid="totp-secret"></code></p>
      <details>
        <summary>Show URL</summary>
        <pre id="otpauth" data-testid="otpauth-url"></pre>
      </details>
      <form id="totp-confirm">
        <label>Authenticator code <input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required /></label>
        <button type="submit">Confirm</button>
      </form>
    </section>
    <section id="backup-step" data-testid="backup-codes" hidden>
      <h2>Save your backup codes</h2>
      <p>Each code signs you in once if you lose your authenticator app. They are shown only now. Store them somewhere safe.</p>
      <ol id="backups" data-testid="backup-list"></ol>
      <div class="auth-actions">
        <button type="button" id="backups-copy">Copy</button>
        <a id="backups-download" class="btn" download="botpasses-backup-codes.txt" hidden>Download</a>
        <a id="backups-continue" class="btn-primary" href="/console">Continue to console</a>
      </div>
    </section>`,
  });
}

/** Sign-in authenticator step. Accepts a 6-digit authenticator code or a 10-character backup code. */
export function verifyTotpHtml(): string {
  return authDocument({
    title: "Confirm it is you",
    testid: "verify-totp",
    body: `<p>Enter the 6-digit code from your authenticator app. Lost it? Enter one of your backup codes instead.</p>
    <form id="totp-verify">
      <label>Authenticator code <input name="code" inputmode="numeric" maxlength="10" autocomplete="one-time-code" required /></label>
      <button type="submit">Verify</button>
    </form>
    <p><button type="button" id="signout" class="btn-ghost">Use a different account</button></p>`,
  });
}

export { consentHtml, deviceHtml } from "./oauth-pages.ts";
export { escapeHtml };
