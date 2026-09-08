import type { VaultEnvName } from "../hosted-types.ts";
import { envOptionsHtml } from "./console-panels.ts";
import {
  ALLOWED_HOSTS_HELP,
  APP_SECRET_HOSTS,
  ITEM_NAME_HINT,
  ITEM_NAME_PATTERN,
  injectOptionsHtml,
  injectSummary,
  storeKindOptionsHtml,
} from "./store-form-fields.ts";

function storeDialog(plane: VaultEnvName, defaultEnv: VaultEnvName): string {
  return `<dialog id="store-dialog" data-testid="store-dialog" aria-labelledby="store-title">
    <h2 id="store-title">Store credential</h2>
    <p id="store-error" class="flash" role="alert" data-testid="store-error"></p>
    <form id="store" novalidate>
      <input type="hidden" name="item_id" />
      <label for="store-name">Name</label>
      <input id="store-name" name="name" required pattern="${ITEM_NAME_PATTERN}" placeholder="GITHUB_TOKEN" autocomplete="off" spellcheck="false" aria-describedby="store-name-hint" />
      <p id="store-name-hint" class="hint field-hint">${ITEM_NAME_HINT}</p>
      <label for="store-kind">Kind</label>
      <select id="store-kind" name="kind">${storeKindOptionsHtml()}</select>
      <p id="store-kind-hint" class="hint field-hint" hidden></p>
      <label for="store-env">Environment</label>
      <select id="store-env" name="environment" aria-describedby="store-env-hint">${envOptionsHtml(plane, defaultEnv)}</select>
      <p id="store-env-hint" class="hint field-hint">Defaults to ${defaultEnv}, the environment agents on this deployment use unless you set another one on the agent.</p>
      <label for="store-value"><span id="store-value-label">Value</span></label>
      <input id="store-value" name="value" type="password" autocomplete="off" required />
      <div id="store-username" hidden>
        <label for="store-username-input"><span id="store-username-label">Client ID</span></label>
        <input id="store-username-input" name="username" autocomplete="off" />
      </div>
      <label for="store-hosts">Allowed hosts</label>
      <input id="store-hosts" name="allowed_hosts" required placeholder="api.example.com" autocomplete="off" spellcheck="false" aria-describedby="store-hosts-hint" />
      <p id="store-hosts-hint" class="hint field-hint">${ALLOWED_HOSTS_HELP}</p>
      <p id="store-inject-summary" class="hint">${injectSummary("bearer")}</p>
      <details id="store-inject-advanced">
        <summary>Change how it is sent</summary>
        <label for="store-inject">Send as</label>
        <select id="store-inject" name="inject">${injectOptionsHtml()}</select>
      </details>
      <details class="vendor-tip">
        <summary>Using an OAuth client secret?</summary>
        <p class="hint">Choose Kind "Client ID and secret" and list the token host with the API host, for example <code>${APP_SECRET_HOSTS}</code>. Botpasses mints the app token itself. Do not store a client secret as a Bearer token.</p>
      </details>
      <div class="dialog-actions">
        <button type="submit" id="store-submit" class="btn-primary">Store</button>
        <button type="button" class="btn-ghost" data-close data-testid="store-cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
}

function rotateDialog(): string {
  return `<dialog id="rotate-dialog" data-testid="rotate-dialog" aria-labelledby="rotate-title">
    <h2 id="rotate-title">Rotate value</h2>
    <p class="hint">Credential <span id="rotate-name" class="mono"></span>. Approvals stay in place; agents use the new value on their next call.</p>
    <p id="rotate-error" class="flash" role="alert" data-testid="rotate-error"></p>
    <form id="rotate" novalidate>
      <input type="hidden" name="id" />
      <label for="rotate-value">New value</label>
      <input id="rotate-value" name="value" type="password" autocomplete="off" required />
      <div class="dialog-actions">
        <button type="submit" class="btn-primary">Rotate</button>
        <button type="button" class="btn-ghost" data-close data-testid="rotate-cancel">Cancel</button>
      </div>
    </form>
  </dialog>`;
}

function confirmDialog(): string {
  return `<dialog id="confirm" data-testid="item-delete-confirm" aria-labelledby="confirm-title" aria-describedby="confirm-body">
    <h2 id="confirm-title">Confirm</h2>
    <p id="confirm-body"></p>
    <p id="confirm-error" class="flash" role="alert" data-testid="confirm-error"></p>
    <div class="dialog-actions">
      <button type="button" id="confirm-yes" class="btn-danger">Confirm</button>
      <button type="button" class="btn-ghost" data-close data-testid="confirm-cancel" autofocus>Cancel</button>
    </div>
  </dialog>`;
}

function tokenDialog(): string {
  return `<dialog id="token-dialog" data-testid="token-dialog" aria-labelledby="token-title">
    <h2 id="token-title">Token for <span id="token-agent"></span></h2>
    <p class="hint">Shown once. Paste it into the agent as its Bearer token. If you lose it, rotate the agent to get a new one.</p>
    <p class="once-shown" id="token-once" data-testid="token-once"><code id="token-value"></code></p>
    <p id="token-live" class="visually-hidden" role="status" aria-live="polite"></p>
    <div class="dialog-actions">
      <button type="button" id="token-copy" class="btn-primary" data-testid="token-copy">Copy token</button>
      <button type="button" class="btn-ghost" data-close data-testid="token-saved">I saved it</button>
    </div>
  </dialog>`;
}

/** Provider user connect. The bundle fills the provider name from the registry when it opens. */
function connectDialog(): string {
  return `<dialog id="connect-dialog" data-testid="connect-dialog" aria-labelledby="connect-title">
    <h2 id="connect-title">Connect account</h2>
    <p class="hint">Authorization Code (with PKCE when the provider supports it). The redirect is this site's callback or <code>http://127.0.0.1:8888/callback</code>; add that URI on the <span id="connect-provider-name">provider</span> app. The refresh token is stored next to this credential. The agent does not get it.</p>
    <p id="connect-error" class="flash" role="alert"></p>
    <form id="connect-provider" novalidate>
      <input type="hidden" name="provider_id" />
      <input type="hidden" name="item_name" />
      <input type="hidden" name="environment" />
      <input type="hidden" name="agent_client_id" />
      <input type="hidden" name="need_id" />
      <label for="connect-client-id"><span id="connect-client-id-label">Client ID</span></label>
      <input id="connect-client-id" name="client_id" required autocomplete="off" />
      <div id="connect-agent-row" hidden>
        <label class="inline-select" for="connect-allow-agent"><input type="checkbox" id="connect-allow-agent" name="allow_agent" checked data-testid="connect-allow-agent" /> <span id="connect-agent-label">Also allow this agent to use the connected account</span></label>
        <p class="hint field-hint">The agent gets a standing approval on the refresh token, so its next call goes through without another inbox card. Uncheck to approve it by hand later.</p>
      </div>
      <div class="dialog-actions">
        <button type="submit" id="connect-submit" class="btn-primary">Continue</button>
        <button type="button" class="btn-ghost" data-close>Cancel</button>
      </div>
    </form>
  </dialog>`;
}

function itemDrawer(): string {
  return `<dialog id="item-drawer" class="drawer" data-testid="item-drawer" aria-labelledby="drawer-title">
    <div class="drawer-head">
      <h2 id="drawer-title" class="mono">Credential</h2>
      <button type="button" class="btn-ghost" data-close aria-label="Close details" data-testid="drawer-close">Close</button>
    </div>
    <dl class="facts" id="drawer-facts"></dl>
    <h3>Agents with an approval</h3>
    <div id="drawer-approvals" class="access-list"></div>
    <p class="toolbar" id="drawer-actions"></p>
  </dialog>`;
}

function codeDialog(): string {
  return `<dialog id="code-dialog" data-testid="code-dialog" aria-labelledby="code-dialog-title">
    <h2 id="code-dialog-title">Enter your current code</h2>
    <p id="code-dialog-lede" class="hint"></p>
    <p id="code-dialog-error" class="flash" role="alert"></p>
    <form id="code-dialog-form" novalidate>
      <label for="code-dialog-input">Authenticator code or backup code</label>
      <input id="code-dialog-input" name="code" autocomplete="one-time-code" maxlength="10" required />
      <div class="dialog-actions">
        <button type="submit" class="btn-primary" id="code-dialog-submit">Continue</button>
        <button type="button" class="btn-ghost" data-close>Cancel</button>
      </div>
    </form>
  </dialog>`;
}

function backupCodesDialog(): string {
  return `<dialog id="backup-dialog" data-testid="backup-dialog" aria-labelledby="backup-title">
    <h2 id="backup-title">New backup codes</h2>
    <p class="hint">Each code signs you in once if you lose your authenticator. The old codes no longer work. These are shown once.</p>
    <pre id="backup-codes" class="once-shown" data-testid="backup-codes"></pre>
    <p id="backup-live" class="visually-hidden" role="status" aria-live="polite"></p>
    <div class="dialog-actions">
      <button type="button" id="backup-copy" class="btn-primary">Copy codes</button>
      <button type="button" id="backup-download" class="btn-ghost">Download</button>
      <button type="button" class="btn-ghost" data-close>I saved them</button>
    </div>
  </dialog>`;
}

export function consoleDialogsHtml(plane: VaultEnvName, defaultEnv: VaultEnvName): string {
  return [
    storeDialog(plane, defaultEnv),
    rotateDialog(),
    confirmDialog(),
    tokenDialog(),
    connectDialog(),
    itemDrawer(),
    codeDialog(),
    backupCodesDialog(),
  ].join("\n  ");
}
