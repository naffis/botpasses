import assert from "node:assert/strict";
import { test } from "node:test";
import { STAGING_ORIGIN } from "../src/brand.ts";
import { hostedCollectHtml } from "../src/hosted/collect-page.ts";
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
  assert.match(html, /<select name="inject">/);
  assert.match(html, /api\.spotify\.com/);
  assert.match(html, /Open collect/);
  assert.match(html, /n\.task_description/);
});

test("collect HTML surfaces the fulfill error body (duplicate-name conflict)", () => {
  const html = hostedCollectHtml({
    needId: "nid_test",
    clientName: "grok",
    suggestedName: "TAKEN",
    host: "api.example.com",
    taskDescription: "fetch playlists",
    status: "pending",
    origin: STAGING_ORIGIN,
  });
  assert.match(html, /type="password"/);
  assert.match(html, /grok/);
  assert.match(html, /fetch playlists/);
  assert.match(html, /data\.error/);
  assert.match(html, /f\.value\.value = ""/);
});
