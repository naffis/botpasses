import assert from "node:assert/strict";
import { test } from "node:test";
import { STAGING_ORIGIN } from "../src/brand.ts";
import { COLLECT_JS, CONSOLE_CSS, CONSOLE_JS } from "../src/hosted/hosted-assets.ts";
import { hostedFont } from "../src/hosted/console-fonts.ts";
import { hostedCollectHtml } from "../src/hosted/collect-page.ts";
import { hostedOperatorHtml } from "../src/hosted/operator-page.ts";

test("operator page can list both environments and rotate or delete", () => {
  const html = hostedOperatorHtml();
  assert.match(html, /Botpasses/);
  assert.doesNotMatch(html, /Agent Grant Vault/);
  assert.match(CONSOLE_JS, /api\("\/api\/items"\)/);
  assert.doesNotMatch(CONSOLE_JS, /\/api\/items\?environment=/);
  assert.match(html, /data-environments="staging,production"/);
  assert.match(html, /Issue Grok Bot token/);
  assert.match(html, /ask it in plain language/);
  assert.match(html, /Grok calls the API in the same turn/);
  assert.match(html, /You do not need to tell it to use Botpasses/);
  assert.match(html, /data-testid="console-signin"/);
  assert.match(html, /Authorization/);
  assert.match(html, /<select name="inject">/);
  assert.match(html, /api\.spotify\.com/);
  assert.match(html, /data-testid="item-delete-confirm"/);
  assert.match(html, /data-testid="access-panel"/);
  assert.match(html, /data-testid="access-audit"/);
  assert.match(html, /data-testid="access-revoke-confirm"/);
  assert.match(CONSOLE_JS, /\/api\/audit/);
  assert.match(CONSOLE_JS, /access-log-link/);
  assert.match(CONSOLE_JS, /First access/);
  assert.match(CONSOLE_JS, /Fetched /);
  assert.match(html, /<dialog/);
});

test("operator console is an app shell with jobs, empty states, and brand fonts", () => {
  const html = hostedOperatorHtml();
  assert.match(html, /data-testid="app-shell"/);
  assert.match(html, /data-testid="nav-inbox"/);
  assert.match(html, /data-testid="nav-vault"/);
  assert.doesNotMatch(html, /data-testid="nav-connect"/);
  assert.match(html, /data-testid="nav-access"/);
  assert.match(html, /Issue token/);
  assert.match(CONSOLE_JS, /Token ••••/);
  assert.match(CONSOLE_JS, /client-rotate/);
  assert.match(html, /data-testid="open-store"/);
  assert.match(html, /data-testid="store-dialog"/);
  assert.match(html, /data-testid="items-empty"/);
  assert.match(html, /data-testid="items-error"/);
  assert.match(html, /data-testid="access-error"/);
  assert.match(html, /data-testid="inbox-empty"/);
  assert.match(html, /<tbody id="items">/);
  assert.match(html, /data-testid="empty-store"/);
  assert.match(html, /id="copy-mcp"/);
  assert.match(html, /id="signed-out-gate"/);
  assert.match(html, /<label hidden>Item id/);
  assert.match(CONSOLE_CSS, /\.app-shell/);
  assert.match(CONSOLE_CSS, /ibm-plex-sans-400\.woff2/);
  assert.match(CONSOLE_CSS, /background: var\(--accent\)/);
  assert.match(CONSOLE_JS, /items-error/);
  assert.match(CONSOLE_JS, /inbox-empty/);
  assert.match(CONSOLE_JS, /showPanel/);
  assert.match(CONSOLE_JS, /Store the credential/);
  assert.match(CONSOLE_JS, /copyText/);
  assert.match(CONSOLE_JS, /sessionOut\(true\)/);
  const font = hostedFont("/assets/fonts/ibm-plex-sans-400.woff2");
  assert.ok(font);
  assert.equal(font.type, "font/woff2");
  assert.ok(font.body.length > 1000);
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
  assert.match(COLLECT_JS, /data\.error/);
  assert.match(html, /\/sign-in/);
  assert.match(html, /\/assets\/console\.css/);
  assert.match(html, /class="auth-body"/);
  assert.doesNotMatch(html, /<img/);
});
