/** Local loopback console (3.8): shared vocabulary and no string-built markup. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { operatorHtml } from "../src/operator-page.ts";

test("local console builds rows with textContent, never innerHTML, and uses the shared vocabulary", () => {
  const html = operatorHtml();
  assert.doesNotMatch(html, /innerHTML/, "no innerHTML anywhere");
  assert.doesNotMatch(html, /insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(html, /td\.textContent = /);
  assert.match(html, /createElement\("td"\)/);
  assert.match(html, /<h2>Credentials<\/h2>/);
  assert.match(html, /<h2>Approvals<\/h2>/);
  assert.match(html, /<h2>Activity<\/h2>/);
  assert.doesNotMatch(html, /<h2>Secrets<\/h2>|<h2>Grants<\/h2>|<h2>Audit<\/h2>/);
  assert.match(html, /id="loopback-token"/);
  assert.match(html, /id="hosts"/);
  assert.match(html, /id="inject"/);
  // R2-7: the inject select offers HTTP Basic, so the form takes the username that mode needs.
  assert.match(html, /<option value="basic">/);
  assert.match(html, /id="username"/);
  assert.match(html, /HTTP Basic needs a username/);
  assert.match(html, /allowed_hosts/);
  assert.match(html, /http_request/);
  assert.doesNotMatch(html, /—/);
  assert.equal((html.match(/<th(?=[\s>])(?![^>]*scope="col")[^>]*>/g) ?? []).length, 0, "every th has scope=col");
  assert.match(html, /<p id="flash" role="status">/);
});
