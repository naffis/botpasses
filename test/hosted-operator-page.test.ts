import assert from "node:assert/strict";
import { test } from "node:test";
import { STAGING_ORIGIN } from "../src/brand.ts";
import { COLLECT_JS, CONSOLE_JS } from "../src/hosted/hosted-assets.ts";
import { hostedCollectHtml } from "../src/hosted/collect-page.ts";
import { hostedOperatorHtml } from "../src/hosted/operator-page.ts";

test("operator page can list both environments and rotate or delete", () => {
  const html = hostedOperatorHtml();
  assert.match(html, /Botpasses/);
  assert.doesNotMatch(html, /Agent Grant Vault/);
  assert.match(CONSOLE_JS, /\/api\/items\?environment=/);
  assert.match(CONSOLE_JS, /\["staging", "production"\]/);
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
  assert.match(html, /data-testid="access-revoke-confirm"/);
  assert.match(html, /<dialog/);
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
});
