import { environmentsForDeployPlane } from "./deploy-plane.ts";
import type { VaultEnvName } from "../hosted-types.ts";

export function envOptionsHtml(plane: VaultEnvName, selected: VaultEnvName): string {
  return environmentsForDeployPlane(plane)
    .map((e) => `<option value="${e}"${e === selected ? " selected" : ""}>${e}</option>`)
    .join("");
}

function inboxPanel(): string {
  return `<section class="panel" data-panel="inbox" aria-labelledby="page-title">
          <div id="inbox-error" class="error-box" role="alert" hidden data-testid="inbox-error"></div>
          <div id="inbox-empty" class="empty" hidden data-testid="inbox-empty">
            <strong>Nothing waiting</strong>
            When an agent needs a credential, its request appears here. This list refreshes every 15 seconds.
          </div>
          <div id="inbox" class="inbox-list" data-testid="inbox-list"></div>
          <details class="card">
            <summary>Approve by code</summary>
            <p class="hint">The agent shows an 8-digit code when it asks for a credential. Enter it here to approve that request.</p>
            <form id="code">
              <label for="code-input">8-digit code</label>
              <input id="code-input" name="code" maxlength="8" inputmode="numeric" autocomplete="one-time-code" required />
              <button type="submit" class="btn-primary">Approve</button>
            </form>
          </details>
        </section>`;
}

function credentialsPanel(plane: VaultEnvName): string {
  const envFilter = environmentsForDeployPlane(plane)
    .map((e) => `<option value="${e}">${e}</option>`)
    .join("");
  return `<section class="panel is-active" data-panel="credentials" aria-labelledby="page-title">
          <form class="filters" id="items-filters" role="search" aria-label="Filter credentials" hidden>
            <label class="filter">
              <span>Search</span>
              <input type="search" name="q" placeholder="Name or host" autocomplete="off" data-testid="items-search" />
            </label>
            <label class="filter">
              <span>Environment</span>
              <select name="environment"><option value="">All</option>${envFilter}</select>
            </label>
            <label class="filter">
              <span>Kind</span>
              <select name="kind"><option value="">All</option><option value="token">API token</option><option value="app secret">Client ID and secret</option><option value="login">Login</option></select>
            </label>
            <label class="filter">
              <span>Sort</span>
              <select name="sort"><option value="name">Name</option><option value="updated">Recently updated</option></select>
            </label>
          </form>
          <div id="items-error" class="error-box" role="alert" hidden data-testid="items-error"></div>
          <div id="items-empty" class="empty" hidden data-testid="items-empty">
            <strong>No credentials yet</strong>
            Ask a connected agent to set up a provider, or store a named credential here. Agents request it, you approve, and the key stays in the vault.
            <p class="toolbar"><button type="button" id="empty-store" class="btn-primary" data-testid="empty-store">Store credential</button></p>
          </div>
          <p id="items-none" class="empty" hidden data-testid="items-none">No credentials match these filters.</p>
          <div class="table-wrap" id="items-table" hidden>
            <table class="items-table">
              <colgroup>
                <col class="col-name" /><col class="col-kind" /><col class="col-env" /><col class="col-hosts" /><col class="col-last4" /><col class="col-actions" />
              </colgroup>
              <thead>
                <tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Environment</th><th scope="col">Hosts</th><th scope="col">Last four</th><th scope="col">Actions</th></tr>
              </thead>
              <tbody id="items"></tbody>
            </table>
          </div>
        </section>`;
}

function agentsPanel(plane: VaultEnvName, defaultEnv: VaultEnvName): string {
  return `<section class="panel" data-panel="agents" aria-labelledby="page-title">
          <div class="card connect-card" data-testid="connect-card">
            <h2>Connect an agent</h2>
            <ol class="steps">
              <li>
                <strong>Add the MCP URL to your agent.</strong>
                <p class="copy-row"><code id="mcp_url"></code> <button type="button" id="copy-mcp" class="btn-ghost">Copy URL</button></p>
              </li>
              <li>
                <strong>Issue a token, or connect from the agent with OAuth.</strong>
                <p class="hint">A token is shown once. The agent sends it as <code>Authorization: Bearer</code>. Agents that support OAuth can instead sign in from the agent, in which case no token is needed.</p>
                <form id="issue" class="inline-form">
                  <label for="issue-name">Agent name</label>
                  <input id="issue-name" name="name" placeholder="claude-desktop" autocomplete="off" />
                  <label for="issue-env">Environment</label>
                  <select id="issue-env" name="environment">${envOptionsHtml(plane, defaultEnv)}</select>
                  <p id="issue-error" class="flash" role="alert" data-testid="issue-error"></p>
                  <button type="submit" class="btn-primary" data-testid="issue-token">Issue agent token</button>
                </form>
              </li>
            </ol>
            <details class="vendor-tip">
              <summary>Connecting Grok?</summary>
              <p class="hint">Paste only the token; Grok adds the Bearer prefix. The token is enough, so skip the OAuth connect card. Grok Bot in the cloud cannot finish OAuth. Never paste a client secret or access token into the chat.</p>
            </details>
          </div>
          <div class="tabs" role="tablist" aria-label="Agents sections" id="agents-tabs">
            <a role="tab" id="tab-agents" href="#agents/agents" data-tab="agents" aria-controls="tabpanel-agents" aria-selected="true">Agents</a>
            <a role="tab" id="tab-approvals" href="#agents/approvals" data-tab="approvals" aria-controls="tabpanel-approvals" aria-selected="false" tabindex="-1">Approvals</a>
            <a role="tab" id="tab-sessions" href="#agents/sessions" data-tab="sessions" aria-controls="tabpanel-sessions" aria-selected="false" tabindex="-1">Sessions</a>
            <a role="tab" id="tab-activity" href="#agents/activity" data-tab="activity" aria-controls="tabpanel-activity" aria-selected="false" tabindex="-1">Activity</a>
          </div>
          <div id="access-error" class="error-box" role="alert" hidden data-testid="access-error"></div>
          <section id="tabpanel-agents" role="tabpanel" aria-labelledby="tab-agents" data-tabpanel="agents" data-testid="access-panel">
            <div id="agents-list" class="access-list" data-testid="agents-list"></div>
          </section>
          <section id="tabpanel-approvals" role="tabpanel" aria-labelledby="tab-approvals" data-tabpanel="approvals" hidden>
            <div id="grants-list" class="access-list" data-testid="grants-list"></div>
          </section>
          <section id="tabpanel-sessions" role="tabpanel" aria-labelledby="tab-sessions" data-tabpanel="sessions" hidden>
            <p class="hint">Browser sessions signed in to this account. Revoke any you do not recognise.</p>
            <div id="sessions-list" class="access-list" data-testid="sessions-list"></div>
          </section>
          <section id="tabpanel-activity" role="tabpanel" aria-labelledby="tab-activity" data-tabpanel="activity" hidden>
            <form class="filters" id="activity-filters" aria-label="Filter activity">
              <label class="filter"><span>Agent</span><select name="agent"><option value="">All agents</option></select></label>
              <label class="filter"><span>Credential</span><select name="credential"><option value="">All credentials</option></select></label>
              <a href="#agents/activity" id="activity-clear" class="filter-clear" hidden>Show all activity</a>
            </form>
            <p class="hint">Actions and credential names only. Secrets are not written to this log.</p>
            <div id="activity-list" class="access-list" data-testid="access-audit"></div>
            <p class="toolbar"><button type="button" id="activity-more" class="btn-ghost" hidden>Load more</button></p>
          </section>
        </section>`;
}

function accountPanel(): string {
  return `<section class="panel" data-panel="account" aria-labelledby="page-title">
          <div id="account-error" class="error-box" role="alert" hidden data-testid="account-error"></div>
          <div class="card" id="account-card" data-testid="account-card">
            <h2>Sign-in</h2>
            <dl class="facts">
              <dt>Email</dt><dd id="account-email">Loading</dd>
              <dt>Authenticator</dt><dd id="account-totp">Loading</dd>
              <dt>Backup codes left</dt><dd id="account-backups">Loading</dd>
              <dt>Account created</dt><dd id="account-created">Loading</dd>
            </dl>
            <p class="toolbar">
              <button type="button" id="account-reenroll" class="btn-ghost" data-testid="account-reenroll">Re-enroll authenticator</button>
              <button type="button" id="account-regen" class="btn-ghost" data-testid="account-regen">Regenerate backup codes</button>
              <a class="btn btn-ghost" href="#agents/sessions">Sessions</a>
              <button type="button" id="account-signout" class="btn-danger">Sign out</button>
            </p>
          </div>
        </section>`;
}

/** The four routed panels inside `<main>`. */
export function consolePanelsHtml(plane: VaultEnvName, defaultEnv: VaultEnvName): string {
  return [inboxPanel(), credentialsPanel(plane), agentsPanel(plane, defaultEnv), accountPanel()].join("\n        ");
}
