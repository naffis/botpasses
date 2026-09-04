import { authDocument, escapeAttr, escapeHtml } from "./auth-shell.ts";

export type ConsentView = {
  /** Redirect hosts the client registered. Shown so the operator can spot a look-alike. */
  hosts?: string[];
  /** Operator account email, so the operator sees which account is approving. */
  email?: string;
  /** True when this account has never approved this client before. */
  firstTime?: boolean;
};

function hostList(hosts: string[]): string {
  if (hosts.length === 0) return "";
  const items = hosts.map((h) => `<li><code>${escapeHtml(h)}</code></li>`).join("");
  const label = hosts.length === 1 ? "It will receive the code at" : "It will receive the code at one of";
  return `<p>${label}</p><ul class="consent-hosts" data-testid="consent-hosts">${items}</ul>`;
}

export function consentHtml(clientName: string, uid: string, view: ConsentView = {}): string {
  const name = escapeHtml(clientName || "MCP client");
  const first = view.firstTime
    ? `<p class="consent-first" data-testid="consent-first-time">First time: this app has not connected to your vault before.</p>`
    : "";
  const account = view.email
    ? `<p class="consent-account" data-testid="consent-account">Approving as <strong>${escapeHtml(view.email)}</strong>.</p>`
    : "";
  return authDocument({
    title: "Allow access",
    testid: "oauth-consent",
    body: `<p><strong data-testid="consent-client">${name}</strong> wants an access token for this vault MCP. No remote images are loaded.</p>
    ${hostList(view.hosts ?? [])}
    ${first}
    ${account}
    <form id="consent" method="post" action="/consent">
      <input type="hidden" name="uid" value="${escapeAttr(uid)}" />
      <div class="auth-actions">
        <button type="submit" class="btn-primary" name="decision" value="allow">Allow</button>
        <button type="submit" name="decision" value="deny" class="btn-ghost">Deny</button>
      </div>
    </form>`,
  });
}

export function consentExpiredHtml(): string {
  return authDocument({
    title: "Request expired",
    testid: "oauth-consent-expired",
    body: `<p>This sign-in request has expired or was already completed. Go back to your app and connect again.</p>`,
  });
}

export type DeviceView = {
  /** oidc-provider's per-session form secret. The POST fails without it. */
  xsrf?: string;
};

export function deviceHtml(flash?: string, view: DeviceView = {}): string {
  const note = flash ? `<p class="flash is-err" role="alert">${escapeHtml(flash)}</p>` : "";
  const xsrf = view.xsrf ? `<input type="hidden" name="xsrf" value="${escapeAttr(view.xsrf)}" />` : "";
  return authDocument({
    title: "Device login",
    testid: "device-code",
    body: `<p>Enter the code shown in your terminal.</p>
    ${note}
    <form id="device" method="post" action="/device">
      ${xsrf}
      <label>Device code <input name="user_code" inputmode="numeric" autocomplete="off" required /></label>
      <button type="submit">Continue</button>
    </form>`,
  });
}

export function deviceConfirmHtml(input: { clientName: string; userCode: string; xsrf: string }): string {
  return authDocument({
    title: "Confirm device",
    testid: "device-confirm",
    body: `<p><strong data-testid="device-client">${escapeHtml(input.clientName)}</strong> is asking to connect to your vault.</p>
    <p>Your device shows this code:</p>
    <p><code class="device-user-code" data-testid="device-user-code">${escapeHtml(input.userCode)}</code></p>
    <p>If the code does not match, or you did not start this on a device you own, choose Cancel.</p>
    <form id="device-confirm" method="post" action="/device">
      <input type="hidden" name="xsrf" value="${escapeAttr(input.xsrf)}" />
      <input type="hidden" name="user_code" value="${escapeAttr(input.userCode)}" />
      <div class="auth-actions">
        <button type="submit" class="btn-primary" name="confirm" value="yes">Continue</button>
        <button type="submit" name="abort" value="yes" class="btn-ghost">Cancel</button>
      </div>
    </form>`,
  });
}

export function deviceSuccessHtml(clientName?: string): string {
  const who = clientName ? ` <strong>${escapeHtml(clientName)}</strong>` : "";
  return authDocument({
    title: "Device connected",
    testid: "device-success",
    body: `<p>${who ? `${who} is connected.` : "The device is connected."} You can close this page.</p>`,
    script: "",
  });
}

/** oidc-provider error page. Only the error code and description are shown, both escaped. */
export function oauthErrorHtml(out: Record<string, unknown>): string {
  const code = typeof out.error === "string" ? out.error : "error";
  const description = typeof out.error_description === "string" ? out.error_description : "";
  return authDocument({
    title: "Sign-in failed",
    testid: "oauth-error",
    body: `<p>The sign-in request could not be completed.</p>
    <p><code data-testid="oauth-error-code">${escapeHtml(code)}</code>${description ? ` ${escapeHtml(description)}` : ""}</p>
    <p>Go back to your app and try again.</p>`,
    script: "",
  });
}
