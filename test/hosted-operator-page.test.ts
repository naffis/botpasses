import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STAGING_ORIGIN } from "../src/brand.ts";
import { COLLECT_JS, CONSOLE_CSS, CONSOLE_JS } from "../src/hosted/hosted-assets.ts";
import { hostedFont } from "../src/hosted/console-fonts.ts";
import { hostedCollectHtml } from "../src/hosted/collect-page.ts";
import { defaultEnvironmentForPlane, hostedOperatorHtml } from "../src/hosted/operator-page.ts";

test("operator page uses the product vocabulary and no vendor names in generic copy", () => {
  const html = hostedOperatorHtml();
  assert.match(html, /Botpasses/);
  assert.doesNotMatch(html, /Agent Grant Vault/);
  assert.match(html, /data-testid="nav-inbox"/);
  assert.match(html, /data-testid="nav-credentials"/);
  assert.match(html, /data-testid="nav-agents"/);
  assert.match(html, /data-testid="nav-account"/);
  assert.match(html, /data-testid="sign-out"/);
  assert.doesNotMatch(html, /data-testid="nav-vault"|data-testid="nav-access"/);
  assert.match(html, />Issue agent token</);
  assert.match(html, /placeholder="claude-desktop"/);
  assert.doesNotMatch(html, /Issue Grok Bot token|value="grok"|Environment plane/);
  assert.doesNotMatch(html, /—/);
  // Vendor tips only inside collapsed disclosures.
  const grok = html.match(/<details class="vendor-tip">\s*<summary>Connecting Grok\?<\/summary>[\s\S]*?<\/details>/);
  assert.ok(grok, "Grok tip is a collapsed details");
  const withoutTips = html.replace(/<details class="vendor-tip">[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(withoutTips, /Grok|Spotify|spotify/);
  // The connect dialog is vendor-free markup; the bundle names the provider when it opens.
  assert.match(html, /<dialog id="connect-dialog" data-testid="connect-dialog" aria-labelledby="connect-title">/);
  const connect = html.match(/<dialog id="connect-dialog"[\s\S]*?<\/dialog>/);
  assert.ok(connect, "connect dialog is in the operator page");
  assert.match(connect[0], /data-testid="connect-redirect-uri"/);
  assert.doesNotMatch(connect[0], /127\.0\.0\.1:8888/, "hosted copy must not advertise the loopback callback");
  assert.match(html, /data-testid="store-redirect"/);
  const storeKind = html.indexOf('id="store-kind"');
  const storeRedirect = html.indexOf('id="store-redirect"');
  const storeValue = html.indexOf('id="store-value"');
  assert.ok(storeKind > 0 && storeRedirect > storeKind && storeRedirect < storeValue, "store redirect sits next to Kind, before the secret fields");
  assert.match(html, /<input type="hidden" name="provider_id" \/>/);
  assert.match(html, /data-testid="item-delete-confirm"/);
  assert.doesNotMatch(html, /access-revoke/);
  assert.match(html, /data-testid="access-panel"/);
  assert.match(html, /data-testid="access-audit"/);
});

test("console shell: routed panels, tabs, account, breakglass hidden, mark from assets", () => {
  const html = hostedOperatorHtml();
  assert.match(html, /data-testid="app-shell"/);
  assert.match(html, /src="\/assets\/mark\.[0-9a-f]{8}\.svg"/);
  assert.match(html, /src="\/assets\/mark-on-dark\.[0-9a-f]{8}\.svg"/);
  assert.match(html, /<link rel="icon" href="\/favicon\.svg"/);
  assert.match(html, /<meta name="color-scheme" content="light dark"/);
  for (const panel of ["inbox", "credentials", "agents", "account"]) assert.match(html, new RegExp(`data-panel="${panel}"`));
  assert.match(html, /role="tablist"/);
  for (const tab of ["agents", "approvals", "sessions", "activity"]) {
    assert.match(html, new RegExp(`href="#agents/${tab}" data-tab="${tab}"`));
    assert.match(html, new RegExp(`id="tabpanel-${tab}" role="tabpanel"`));
  }
  assert.match(html, /<details id="breakglass" hidden/);
  assert.match(html, /data-testid="connect-card"/);
  assert.match(html, /id="copy-mcp"/);
  assert.match(html, /id="signed-out-gate"/);
  assert.match(html, /data-testid="account-card"/);
  assert.match(html, /data-testid="account-reenroll"/);
  assert.match(html, /data-testid="account-regen"/);
  assert.match(html, /id="items-filters" role="search"/);
  assert.match(html, /<select name="sort">/);
});

test("console accessibility: dialogs named, alerts, th scope, hidden inputs, live region", () => {
  const html = hostedOperatorHtml();
  const dialogs = html.match(/<dialog [^>]*>/g) ?? [];
  assert.ok(dialogs.length >= 7);
  for (const d of dialogs) assert.match(d, /aria-labelledby="/, d);
  for (const id of ["inbox-error", "items-error", "access-error", "account-error"]) {
    assert.match(html, new RegExp(`id="${id}" class="error-box" role="alert"`));
  }
  assert.ok((html.match(/<th[\s>]/g) ?? []).length >= 6, "table has headers");
  assert.equal((html.match(/<th(?=[\s>])(?![^>]*scope="col")[^>]*>/g) ?? []).length, 0, "every th has scope=col");
  assert.doesNotMatch(html, /<label hidden/);
  assert.match(html, /<input type="hidden" name="item_id"/);
  assert.match(html, /<input type="hidden" name="id"/);
  assert.match(html, /id="token-live" class="visually-hidden" role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /onclick=/);
  assert.match(html, /data-close data-testid="store-cancel"/);
  assert.match(html, /data-close data-testid="rotate-cancel"/);
  assert.match(html, /data-close data-testid="confirm-cancel"/);
  assert.match(html, /<button type="button" class="btn-ghost" data-close data-testid="token-saved">I saved it</);
});

test("staging plane shows a small label and defaults store and issue to staging", () => {
  const staging = hostedOperatorHtml({ deployPlane: "staging" });
  assert.match(staging, /data-testid="plane-label">Staging</);
  assert.match(staging, /data-default-environment="staging"/);
  assert.match(staging, /id="store-env"[^>]*><option value="staging" selected>/);
  assert.doesNotMatch(staging, /<option value="production"/);
  const production = hostedOperatorHtml({ deployPlane: "production" });
  assert.doesNotMatch(production, /plane-label/);
  assert.match(production, /data-default-environment="production"/);
  assert.match(production, /id="store-env"[^>]*>[^]*?<option value="production" selected>/);
  assert.match(production, /id="issue-env"[^>]*>[^]*?<option value="production" selected>/);
  assert.match(production, /Defaults to production, the environment agents on this deployment use/);
  assert.equal(defaultEnvironmentForPlane("staging"), "staging");
  assert.equal(defaultEnvironmentForPlane("production"), "production");
  assert.equal(defaultEnvironmentForPlane("dev"), "staging");
});

test("team panel, org switcher, and plan card are in the shell and the bundle drives them", () => {
  const html = hostedOperatorHtml();
  assert.match(html, /<section class="panel" data-panel="team"/);
  assert.match(html, /href="#account\/team" data-nav="team" data-testid="nav-team">Team</);
  assert.match(html, /<label id="org-switch" class="org-switch" hidden>[^]*?<select id="org-switcher" data-testid="org-switcher">/);
  assert.match(html, /id="team-error" class="error-box" role="alert" hidden/);
  assert.match(html, /id="team-invite-card" data-testid="team-invite-card" hidden/);
  assert.match(html, /<form id="invite" class="inline-form" data-testid="invite-form">/);
  assert.match(html, /<input id="invite-email" name="email" type="email"/);
  assert.match(html, /<select id="invite-role" name="role"><option value="operator">operator<\/option><option value="owner">owner<\/option><\/select>/);
  assert.match(html, /id="invite-result" hidden/);
  assert.match(html, /<code id="invite-link"><\/code> <button type="button" id="invite-copy"/);
  assert.match(html, /id="members-list" class="access-list" data-testid="members-list"/);
  assert.match(html, /id="invites-list" class="access-list" data-testid="invites-list"/);
  // Plan card sits inside the Account panel, after its error box.
  const account = /<section class="panel" data-panel="account"[^]*?<\/section>/.exec(html)?.[0] ?? "";
  assert.match(account, /data-testid="account-error"><\/div>\s*<div class="card" id="plan-card" data-testid="plan-card">/);
  for (const kind of ["credentials", "agents", "members", "calls"]) assert.match(account, new RegExp(`<dd id="plan-${kind}">Loading</dd>`));
  assert.doesNotMatch(html, /—/);
  assert.match(CONSOLE_JS, /api\("\/api\/members"\)/);
  assert.match(CONSOLE_JS, /\/api\/members\/invite/);
  assert.match(CONSOLE_JS, /\/api\/invites\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(CONSOLE_JS, /\/role`/);
  assert.match(CONSOLE_JS, /api\("\/api\/plan"\)/);
  assert.match(CONSOLE_JS, /api\("\/api\/orgs"\)/);
  assert.match(CONSOLE_JS, /"\/api\/session\/org"/);
  assert.match(CONSOLE_JS, /Remove member/);
  assert.match(CONSOLE_JS, /Cancel invite/);
  assert.match(CONSOLE_JS, /Invite link copied/);
});

test("console css: two themes, action accent, warn and success surfaces, fixed table, title size", () => {
  assert.match(CONSOLE_CSS, /\.app-shell/);
  assert.match(CONSOLE_CSS, /inter-400\.woff2/);
  assert.match(CONSOLE_CSS, /color-scheme: light dark/);
  assert.match(CONSOLE_CSS, /@media \(prefers-color-scheme: dark\)/);
  assert.match(CONSOLE_CSS, /:root\[data-theme="dark"\]/);
  assert.match(CONSOLE_CSS, /\.btn-primary \{ background: var\(--accent\); color: var\(--accent-fg\)/);
  assert.match(CONSOLE_CSS, /\.flash\.is-ok \{ color: var\(--ok\)[^}]*background: var\(--ok-dim\)/);
  assert.match(CONSOLE_CSS, /\.once-shown \{[^}]*var\(--warn-dim\)/);
  assert.match(CONSOLE_CSS, /\.pill-warn \{ background: var\(--warn-dim\)/);
  assert.match(CONSOLE_CSS, /\.items-table \{ table-layout: fixed/);
  assert.match(CONSOLE_CSS, /overflow-wrap: anywhere/);
  assert.doesNotMatch(CONSOLE_CSS, /\.table-wrap td \{\s*display: flex/);
  assert.match(CONSOLE_CSS, /--title-size: 1\.25rem/);
  assert.match(CONSOLE_CSS, /th \{ color: var\(--muted\); font-size: 0\.85rem/);
  assert.match(CONSOLE_CSS, /\.pill \{[^}]*background:/);
  assert.match(CONSOLE_CSS, /a \{ color: var\(--fg\); text-decoration: underline/);
  const font = hostedFont("/assets/fonts/inter-400.woff2");
  assert.ok(font);
  assert.equal(font.type, "font/woff2");
  assert.ok(font.body.length > 1000);
});

test("console bundle carries the routed behaviours", () => {
  assert.match(CONSOLE_JS, /api\("\/api\/items"\)/);
  assert.doesNotMatch(CONSOLE_JS, /\/api\/items\?environment=/);
  assert.match(CONSOLE_JS, /history\.pushState/);
  assert.match(CONSOLE_JS, /addEventListener\("hashchange"/);
  // popstate fires for every hash navigation too; binding both loaded each panel twice.
  assert.doesNotMatch(CONSOLE_JS, /addEventListener\("popstate"/);
  assert.match(CONSOLE_JS, /\/api\/auth\/logout/);
  assert.match(CONSOLE_JS, /\/api\/auth\/me/);
  assert.match(CONSOLE_JS, /\/api\/auth\/backup-codes\/regenerate/);
  assert.match(CONSOLE_JS, /\/environment`/);
  assert.match(CONSOLE_JS, /INBOX_POLL_MS = 15_000/);
  assert.match(CONSOLE_JS, /FLASH_CLEAR_MS = 6000/);
  assert.match(CONSOLE_JS, /Agents with an approval lose access now/);
  assert.match(CONSOLE_JS, /The current token stops working now/);
  assert.doesNotMatch(CONSOLE_JS, /—/);
  assert.doesNotMatch(CONSOLE_JS, /innerHTML = [^;]*\+/, "no string-concatenated innerHTML");
});

test("collect HTML is a shell until the operator loads need details", () => {
  const html = hostedCollectHtml({
    needId: "nid_test",
    origin: STAGING_ORIGIN,
    nonce: "n1",
  });
  assert.doesNotMatch(html, /grok/);
  assert.doesNotMatch(html, /fetch playlists/);
  assert.doesNotMatch(html, /type="password"/);
  assert.match(html, /nid_test/);
  assert.match(html, /nonce="n1"/);
  assert.match(COLLECT_JS, /\/api\/need-items\//);
  assert.match(COLLECT_JS, /errorMessage\(r, "Store failed"\)/);
  const collectSrc = readFileSync(new URL("../src/hosted/client/collect.ts", import.meta.url), "utf8");
  const fulfillKind = collectSrc.indexOf('id="fulfill-kind"');
  const fulfillRedirect = collectSrc.indexOf('id="fulfill-redirect"');
  const fulfillHosts = collectSrc.indexOf('id="fulfill-hosts"');
  assert.ok(
    fulfillKind > 0 && fulfillRedirect > fulfillKind && fulfillRedirect < fulfillHosts,
    "collect redirect sits next to Kind, before the host and secret fields",
  );
  assert.match(html, /\/sign-in/);
  assert.match(html, /\/assets\/console\.[0-9a-f]{8}\.css/);
  assert.match(html, /class="auth-body"/);
  assert.doesNotMatch(html, /<img/);
});
