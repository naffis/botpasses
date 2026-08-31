import assert from "node:assert/strict";
import { test } from "node:test";
import { hostedOperatorHtml } from "../src/hosted/operator-page.ts";

test("operator page can list both environments and rotate or delete", () => {
  const html = hostedOperatorHtml();
  assert.match(html, /Botpasses/);
  assert.doesNotMatch(html, /Agent Grant Vault/);
  assert.match(html, /\/api\/items\?environment=/);
  assert.match(html, /\["staging", "production"\]/);
  assert.match(html, /Issue Grok Bot token/);
  assert.match(html, /Operator token/);
  assert.match(html, /Authorization/);
});
