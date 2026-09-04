import { PRODUCT_NAME } from "../brand.ts";
import type { VaultEnvName } from "../hosted-types.ts";
import { environmentsForDeployPlane } from "./deploy-plane.ts";
import { consoleDialogsHtml } from "./console-dialogs.ts";
import { consolePanelsHtml } from "./console-panels.ts";
import { assetPath } from "./hosted-assets.ts";

/** Store and issue default to the plane's own environment (D13). */
export function defaultEnvironmentForPlane(plane: VaultEnvName): VaultEnvName {
  return plane === "staging" ? "staging" : "production";
}

/** Team panel (3.7), routed at `#account/team`. Lists are filled by client/team.ts. */
export function teamPanelHtml(): string {
  return `<section class="panel" data-panel="team" aria-labelledby="page-title">
          <div id="team-error" class="error-box" role="alert" hidden data-testid="team-error"></div>
          <div class="card" id="team-invite-card" data-testid="team-invite-card" hidden>
            <h2>Invite a teammate</h2>
            <p class="hint">They get an email with a link that works for seven days. Owners manage members and credentials; operators approve requests and use the vault.</p>
            <form id="invite" class="inline-form" data-testid="invite-form">
              <label for="invite-email">Email</label>
              <input id="invite-email" name="email" type="email" autocomplete="off" required />
              <label for="invite-role">Role</label>
              <select id="invite-role" name="role"><option value="operator">operator</option><option value="owner">owner</option></select>
              <p id="invite-error" class="flash" role="alert"></p>
              <button type="submit" class="btn-primary" data-testid="invite-submit">Send invite</button>
            </form>
            <div id="invite-result" hidden data-testid="invite-result">
              <p id="invite-result-note" class="hint"></p>
              <p class="copy-row"><code id="invite-link"></code> <button type="button" id="invite-copy" class="btn-ghost">Copy link</button></p>
            </div>
          </div>
          <div class="card" data-testid="members-card">
            <h2>Members</h2>
            <div id="members-list" class="access-list" data-testid="members-list"></div>
          </div>
          <div class="card" data-testid="invites-card">
            <h2>Pending invites</h2>
            <p id="invites-empty" class="hint" hidden>No pending invites.</p>
            <div id="invites-list" class="access-list" data-testid="invites-list"></div>
          </div>
        </section>`;
}

/** Plan usage (3.9) shown at the top of the Account panel; values come from `GET /api/plan`. */
export function planCardHtml(): string {
  return `<div class="card" id="plan-card" data-testid="plan-card">
            <h2>Plan</h2>
            <p class="hint">Free while in beta. <span id="plan-period"></span></p>
            <dl class="facts">
              <dt>Credentials</dt><dd id="plan-credentials">Loading</dd>
              <dt>Agents</dt><dd id="plan-agents">Loading</dd>
              <dt>Members and pending invites</dt><dd id="plan-members">Loading</dd>
              <dt>API calls this month</dt><dd id="plan-calls">Loading</dd>
            </dl>
          </div>`;
}

const ACCOUNT_ANCHOR = `<div id="account-error" class="error-box" role="alert" hidden data-testid="account-error"></div>`;

/** Splices the plan card into the Account panel right after its error box. Loud when the anchor moves. */
export function withPlanCard(panels: string): string {
  if (!panels.includes(ACCOUNT_ANCHOR)) throw new Error("Account panel anchor not found; update withPlanCard");
  return panels.replace(ACCOUNT_ANCHOR, `${ACCOUNT_ANCHOR}\n          ${planCardHtml()}`);
}

/** Operator console HTML. `deployPlane` controls which environments Store, Issue, and the list expose. */
export function hostedOperatorHtml(
  opts: { hosted?: boolean; nonce?: string; deployPlane?: VaultEnvName } = {},
): string {
  const hosted = Boolean(opts.hosted);
  const plane = opts.deployPlane ?? "production";
  const defaultEnv = defaultEnvironmentForPlane(plane);
  const envAttr = environmentsForDeployPlane(plane).join(",");
  const signin = hosted
    ? `<p id="console-signin" class="signin" data-testid="console-signin" hidden><a href="/sign-in">Sign in</a> or <a href="/sign-up">Create account</a></p>`
    : `<p id="console-signin" class="signin" data-testid="console-signin">Local operator console. Sign in is not required on loopback.</p>`;
  const planeLabel = plane === "staging" ? `<p class="plane-label" data-testid="plane-label">Staging</p>` : "";
  const mark = assetPath("mark.svg");
  return `<!doctype html>
<html lang="en" data-deploy-plane="${plane}" data-environments="${envAttr}" data-default-environment="${defaultEnv}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>${PRODUCT_NAME} console</title>
  <link rel="icon" href="${mark}" type="image/svg+xml" />
  <link rel="stylesheet" href="${assetPath("console.css")}" />
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="app-shell" data-testid="app-shell">
    <aside class="rail">
      <a class="brand" href="/console#inbox"><img src="${mark}" alt="" width="28" height="28" /><span class="brand-mark">${PRODUCT_NAME}</span></a>
      ${planeLabel}
      <label id="org-switch" class="org-switch" hidden><span class="visually-hidden">Workspace</span><select id="org-switcher" data-testid="org-switcher"></select></label>
      <nav class="rail-nav" aria-label="Console">
        <a class="nav-link" href="#inbox" data-nav="inbox" data-testid="nav-inbox">Inbox <span id="inbox-badge" class="badge" data-count="0" aria-label="0 waiting">0</span></a>
        <a class="nav-link" href="#credentials" data-nav="credentials" data-testid="nav-credentials">Credentials</a>
        <a class="nav-link" href="#agents" data-nav="agents" data-testid="nav-agents">Agents</a>
      </nav>
      <div class="rail-foot">
        <a class="nav-link" href="#account" data-nav="account" data-testid="nav-account">Account</a>
        <a class="nav-link" href="#account/team" data-nav="team" data-testid="nav-team">Team</a>
        <button type="button" id="sign-out" class="nav-link nav-button" data-testid="sign-out">Sign out</button>
        ${signin}
        <details id="breakglass" hidden data-testid="breakglass">
          <summary>Bootstrap token</summary>
          <form id="bootstrap">
            <label for="bootstrap-token">Break-glass token</label>
            <input id="bootstrap-token" name="token" type="password" autocomplete="off" />
            <button type="submit" class="btn-ghost">Use token</button>
          </form>
        </details>
      </div>
    </aside>
    <div class="workspace">
      <header class="page-head">
        <div>
          <h1 id="page-title">Credentials</h1>
          <p id="page-lede" class="lede">Named credentials your agents can use. Values are never shown, only the last four characters.</p>
        </div>
        <div class="toolbar">
          <button type="button" id="open-store" class="btn-primary" data-testid="open-store">Store credential</button>
        </div>
      </header>
      <div id="flash" class="flash" role="status"></div>
      <div id="signed-out-gate" class="card gate-card" hidden>
        <h2>Sign in to continue</h2>
        <p>This tab has no operator session.</p>
        <p class="toolbar">
          <a class="btn btn-primary" href="/sign-in">Sign in</a>
          <a class="btn btn-ghost" href="/sign-up">Create account</a>
        </p>
      </div>
      <main id="main">
        ${withPlanCard(consolePanelsHtml(plane, defaultEnv))}
        ${teamPanelHtml()}
      </main>
    </div>
  </div>
  ${consoleDialogsHtml(plane, defaultEnv)}
  <script${opts.nonce ? ` nonce="${opts.nonce}"` : ""} src="${assetPath("console.js")}"></script>
</body>
</html>`;
}
