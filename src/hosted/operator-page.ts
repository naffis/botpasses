import { PRODUCT_NAME } from "../brand.ts";
import type { VaultEnvName } from "../hosted-types.ts";
import { environmentsForDeployPlane } from "./deploy-plane.ts";
import { APP_SECRET_HOSTS, storeKindOptionsHtml } from "./store-form-fields.ts";

/** Operator console HTML. `deployPlane` controls which environments Store, Grok issue, and the item list expose. */
export function hostedOperatorHtml(
  opts: { hosted?: boolean; nonce?: string; deployPlane?: VaultEnvName } = {},
): string {
  const hosted = Boolean(opts.hosted);
  const plane = opts.deployPlane ?? "production";
  const environments = environmentsForDeployPlane(plane);
  const envOptions = environments.map((e) => `<option value="${e}">${e}</option>`).join("");
  const envAttr = environments.join(",");
  const signin = hosted
    ? `<p id="console-signin" class="signin" data-testid="console-signin"><a href="/sign-in">Sign in</a> or <a href="/sign-up">Create account</a></p>`
    : `<p id="console-signin" class="signin" data-testid="console-signin">Local operator console. Sign in is not required on loopback.</p>`;
  return `<!doctype html>
<html lang="en" data-deploy-plane="${plane}" data-environments="${envAttr}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${PRODUCT_NAME} console</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/assets/console.css" />
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="app-shell" data-testid="app-shell">
    <aside class="rail">
      <a class="brand" href="/console"><img src="/favicon.svg" alt="" width="28" height="28" /><span class="brand-mark">${PRODUCT_NAME}</span></a>
      <p class="plane">Environment plane <strong>${plane}</strong></p>
      <nav class="rail-nav" aria-label="Console">
        <button type="button" class="nav-link" data-nav="inbox" data-testid="nav-inbox">Inbox <span id="inbox-badge" class="badge" data-count="0">0</span></button>
        <button type="button" class="nav-link" data-nav="vault" data-testid="nav-vault">Vault</button>
        <button type="button" class="nav-link" data-nav="access" data-testid="nav-access">Access</button>
      </nav>
      <div class="rail-foot">
        ${signin}
        <details>
          <summary>Bootstrap token</summary>
          <form id="bootstrap">
            <label>Break-glass token <input name="token" type="password" autocomplete="off" /></label>
            <button type="submit">Use token</button>
          </form>
        </details>
      </div>
    </aside>
    <div class="workspace">
      <header class="page-head">
        <div>
          <h1 id="page-title">Vault</h1>
          <p id="page-lede" class="lede">Named credentials. Last-4 only. Edit, rotate, or delete from the row.</p>
        </div>
        <div class="toolbar">
          <button type="button" id="open-store" class="btn-primary" data-testid="open-store">Store credential</button>
        </div>
      </header>
      <p id="flash" class="flash" role="status"></p>
      <div id="signed-out-gate" class="card gate-card" hidden>
        <h2>Sign in to continue</h2>
        <p>This tab has no operator session. Sign in, or paste a break-glass token under Bootstrap token.</p>
        <p class="toolbar">
          <a class="btn btn-primary" href="/sign-in">Sign in</a>
          <a class="btn btn-ghost" href="/sign-up">Create account</a>
        </p>
      </div>
      <main id="main">
        <section class="panel" data-panel="inbox" aria-labelledby="page-title">
          <div id="inbox-error" class="error-box" hidden data-testid="inbox-error"></div>
          <div id="inbox-empty" class="empty" hidden data-testid="inbox-empty">
            <strong>Nothing waiting</strong>
            When an agent needs a credential, it appears here. Approve once. A failed Spotify or origin 4xx does not use up that approve.
          </div>
          <div id="inbox" class="inbox-list"></div>
          <details class="card">
            <summary>Approve by code</summary>
            <p>Use a code only for the first approve. After that, failed API calls reuse the same grant — do not enter a new code.</p>
            <form id="code">
              <label>8-digit code <input name="code" maxlength="8" inputmode="numeric" autocomplete="one-time-code" /></label>
              <button type="submit">Approve</button>
            </form>
          </details>
        </section>
        <section class="panel is-active" data-panel="vault" aria-labelledby="page-title">
          <div id="items-error" class="error-box" hidden data-testid="items-error"></div>
          <div id="items-empty" class="empty" hidden data-testid="items-empty">
            <strong>No credentials yet</strong>
            Store a named item. Agents request it. You approve. The model never sees the value.
            <p class="toolbar"><button type="button" id="empty-store" class="btn-primary" data-testid="empty-store">Store credential</button></p>
          </div>
          <div class="table-wrap" id="items-table" hidden>
            <table>
              <thead>
                <tr><th>Name</th><th>Kind</th><th>Environment</th><th>Hosts</th><th>Last-4</th><th>Actions</th></tr>
              </thead>
              <tbody id="items"></tbody>
            </table>
          </div>
        </section>
        <section class="panel" data-panel="access" aria-labelledby="page-title">
          <div class="banner">Issue an <code>avm_</code> token once. Paste only that token into Grok (Grok adds Bearer). That header is enough — skip the OAuth connect card. Grok/Cursor connect cards fail if the redirect is not https, loopback http, or a desktop app scheme. After connect, ask in plain language. You approve here if asked. Never paste a Client Secret or access token into Grok. A Client Secret is not a user access token.</div>
          <div class="card">
            <h2>Issue token</h2>
            <p class="copy-row">MCP URL <code id="mcp_url"></code> <button type="button" id="copy-mcp" class="btn-ghost">Copy URL</button></p>
            <p>MCP URL plus <code>Authorization: Bearer avm_…</code> is sufficient. Do not complete an OAuth connect card unless you want browser sign-in. Then say what you want (search Spotify for a track). <code>GET /v1/me</code> needs a user connect on the vault item, not client credentials.</p>
            <form id="grok">
              <label>Client name <input name="name" value="grok" /></label>
              <label>Environment
                <select name="environment">${envOptions}</select>
              </label>
              <p id="grok-error" class="flash" role="alert" data-testid="grok-error"></p>
              <button type="submit">Issue Grok Bot token</button>
            </form>
            <pre id="grok_once"></pre>
            <p class="toolbar"><button type="button" id="copy-grok" class="btn-ghost" hidden>Copy token</button></p>
          </div>
          <section id="access-panel" data-testid="access-panel">
            <div id="access-error" class="error-box" hidden data-testid="access-error"></div>
            <p id="access-empty" data-testid="access-empty" hidden>No clients, grants, or other sessions.</p>
            <div class="card">
              <h2>Clients</h2>
              <div id="access-clients" class="access-list"></div>
            </div>
            <div class="card">
              <h3>Grants</h3>
              <div id="access-grants" class="access-list"></div>
            </div>
            <div class="card">
              <h3>Sessions</h3>
              <div id="access-sessions" class="access-list"></div>
            </div>
            <div class="card">
              <h3>Audit log</h3>
              <p class="hint">Actions and credential names only. Values are never stored here.</p>
              <p id="access-audit-filter" class="hint" hidden></p>
              <p class="toolbar"><a href="#access" id="access-audit-clear" hidden>Show all activity</a></p>
              <div id="access-audit" class="access-list" data-testid="access-audit"></div>
            </div>
          </section>
        </section>
      </main>
    </div>
  </div>
  <dialog id="store-dialog" data-testid="store-dialog">
    <h2 id="store-title">Store credential</h2>
    <p id="store-error" class="flash" role="alert" data-testid="store-error"></p>
    <form id="store">
      <input type="hidden" name="item_id" />
      <label>Name <input name="name" required placeholder="SPOTIFY_SECRET" /></label>
      <label>Kind
        <select name="kind">
          ${storeKindOptionsHtml()}
        </select>
      </label>
      <label>Environment
        <select name="environment">${envOptions}</select>
      </label>
      <label><span id="store-value-label">Value</span> <input name="value" type="password" autocomplete="off" required /></label>
      <label id="store-username" hidden><span id="store-username-label">Client ID</span> <input name="username" autocomplete="username" placeholder="Spotify Client ID" /></label>
      <label>Allowed hosts (comma) <input name="allowed_hosts" required placeholder="${APP_SECRET_HOSTS}" /></label>
      <p id="store-inject-summary" class="hint">Sent as Authorization: Bearer. Typical for API tokens. A Client Secret is not an access token.</p>
      <details id="store-inject-advanced">
        <summary>Change how it is sent</summary>
        <label>Send as
          <select name="inject">
            <option value="bearer" selected>Authorization: Bearer (typical API token)</option>
            <option value="client_credentials">OAuth client secret (mint app token)</option>
            <option value="basic">HTTP Basic (username + password)</option>
            <option value="header:Authorization">Raw Authorization header</option>
          </select>
        </label>
      </details>
      <p class="hint">Spotify token mint: Kind Client ID and secret, hosts <code>${APP_SECRET_HOSTS}</code>. Botpasses sends Basic + form body. Do not store the secret as a Bearer user token.</p>
      <div class="dialog-actions">
        <button type="submit" id="store-submit">Store</button>
        <button type="button" class="btn-ghost" onclick="this.closest('dialog').close()">Cancel</button>
      </div>
    </form>
  </dialog>
  <dialog id="spotify-dialog" data-testid="spotify-dialog">
    <h2>Connect Spotify user</h2>
    <p class="hint">Authorization Code + PKCE. Redirect is this origin’s callback or <code>http://127.0.0.1:8888/callback</code>. Add that URI on the Spotify app. The refresh token is stored in the vault. The model never sees it. Needed for <code>/v1/me</code> and playlist writes. Public search uses the app token.</p>
    <p id="spotify-error" class="flash" role="alert"></p>
    <form id="spotify-user">
      <label hidden>Item name <input name="item_name" /></label>
      <label hidden>Environment <input name="environment" /></label>
      <label>Spotify Client ID <input name="client_id" required autocomplete="off" /></label>
      <div class="dialog-actions">
        <button type="submit">Open Spotify</button>
        <button type="button" class="btn-ghost" onclick="this.closest('dialog').close()">Cancel</button>
      </div>
    </form>
  </dialog>
  <dialog id="rotate-dialog" data-testid="rotate-dialog">
    <h2>Rotate value</h2>
    <p class="hint">Item <span id="rotate-name" class="mono"></span></p>
    <p id="rotate-error" class="flash" role="alert" data-testid="rotate-error"></p>
    <form id="rotate">
      <label hidden>Item id <input name="id" /></label>
      <label>New value <input name="value" type="password" autocomplete="off" required /></label>
      <div class="dialog-actions">
        <button type="submit">Rotate</button>
        <button type="button" class="btn-ghost" onclick="this.closest('dialog').close()">Cancel</button>
      </div>
    </form>
  </dialog>
  <dialog id="confirm" data-testid="item-delete-confirm">
    <p>Confirm this change. It is not sent until you click Confirm.</p>
    <p id="confirm-error" class="flash" role="alert" data-testid="confirm-error"></p>
    <div class="dialog-actions">
      <button type="button" id="confirm-yes">Confirm</button>
      <button type="button" class="btn-ghost" onclick="this.closest('dialog').close()">Cancel</button>
    </div>
  </dialog>
  <dialog id="access-revoke" data-testid="access-revoke-confirm">
    <p>Revoke this credential?</p>
    <button type="button" id="revoke-yes">Confirm</button>
  </dialog>
  <script${opts.nonce ? ` nonce="${opts.nonce}"` : ""} src="/assets/console.js"></script>
</body>
</html>`;
}
