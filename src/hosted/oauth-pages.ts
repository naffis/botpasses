import { authDocument, escapeAttr, escapeHtml } from "./auth-shell.ts";

export function consentHtml(clientName: string, uid: string): string {
  const name = escapeHtml(clientName || "MCP client");
  return authDocument({
    title: "Allow access",
    testid: "oauth-consent",
    body: `<p>${name} wants an access token for this vault MCP. No remote images are loaded.</p>
    <form id="consent" method="post" action="/consent">
      <input type="hidden" name="uid" value="${escapeAttr(uid)}" />
      <div class="auth-actions">
        <button type="submit" class="btn-primary" name="decision" value="allow">Allow</button>
        <button type="submit" name="decision" value="deny" class="btn-ghost">Deny</button>
      </div>
    </form>`,
  });
}

export function deviceHtml(flash?: string): string {
  const note = flash ? `<p class="flash is-err">${escapeHtml(flash)}</p>` : "";
  return authDocument({
    title: "Device login",
    testid: "device-code",
    body: `<p>Enter the code shown in your terminal.</p>
    ${note}
    <form id="device" method="post" action="/device">
      <label>Device code <input name="user_code" inputmode="numeric" required /></label>
      <button type="submit">Continue</button>
    </form>`,
  });
}

