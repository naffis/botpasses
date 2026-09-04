import assert from "node:assert/strict";
import { test } from "node:test";
import { COLLECT_JS, CONSOLE_JS } from "../src/hosted/hosted-assets.ts";
import { hostedOperatorHtml } from "../src/hosted/operator-page.ts";
import { environmentsForDeployPlane } from "../src/hosted/deploy-plane.ts";
import {
  ALLOWED_HOSTS_HELP,
  APP_SECRET_HOSTS,
  defaultInjectForKind,
  formKindForItem,
  injectSummary,
  isValidItemName,
  ITEM_NAME_HINT,
  kindHint,
  kindPillLabel,
  needsLoginUsername,
  STORE_KIND_OPTIONS,
  valueFieldLabel,
  usernameFieldLabel,
} from "../src/hosted/store-form-fields.ts";

test("login username is only for kind login or inject basic", () => {
  assert.equal(needsLoginUsername("secret", "bearer"), false);
  assert.equal(needsLoginUsername("secret", "header:Authorization"), false);
  assert.equal(needsLoginUsername("secret", "basic"), true);
  assert.equal(needsLoginUsername("secret", "client_credentials"), true);
  assert.equal(needsLoginUsername("client_secret", "client_credentials"), true);
  assert.equal(needsLoginUsername("login", "bearer"), true);
  assert.equal(needsLoginUsername("login", "basic"), true);
  assert.equal(needsLoginUsername("secret", "sigv4"), true, "SigV4 stores the access key id as the username");
  assert.equal(needsLoginUsername("secret", "refresh"), true, "refresh items carry the public client id");
});

test("SigV4 items label the two halves of an AWS key pair", () => {
  assert.equal(usernameFieldLabel("secret", "sigv4"), "AWS access key ID");
  assert.equal(valueFieldLabel("secret", "sigv4"), "AWS secret access key");
  assert.equal(usernameFieldLabel("secret", "basic"), "HTTP Basic username");
});

test("kind picks the usual inject so operators do not choose an HTTP scheme", () => {
  assert.equal(defaultInjectForKind("secret"), "bearer");
  assert.equal(defaultInjectForKind("login"), "basic");
  assert.equal(defaultInjectForKind("client_secret"), "client_credentials");
  assert.match(injectSummary("bearer"), /Bearer/);
  assert.match(injectSummary("basic"), /HTTP Basic/);
  assert.match(injectSummary("header:Authorization"), /no Bearer prefix/);
  assert.match(injectSummary("client_credentials"), /OAuth client secret/);
});

test("kind pill and form kind keep app secrets off the token label", () => {
  assert.equal(kindPillLabel("secret", "bearer"), "token");
  assert.equal(kindPillLabel("login", "basic"), "login");
  assert.equal(kindPillLabel("client_secret", "client_credentials"), "app secret");
  assert.equal(kindPillLabel("secret", "client_credentials"), "app secret");
  assert.equal(formKindForItem("secret", "bearer"), "secret");
  assert.equal(formKindForItem("client_secret", "client_credentials"), "client_secret");
  assert.equal(formKindForItem("secret", "client_credentials"), "client_secret");
  assert.equal(usernameFieldLabel("client_secret", "client_credentials"), "Client ID");
  assert.equal(valueFieldLabel("client_secret", "client_credentials"), "Client Secret");
  assert.equal(valueFieldLabel("secret", "bearer"), "Value");
  assert.deepEqual(
    STORE_KIND_OPTIONS.map((o) => o.label),
    ["API token", "Client ID and secret"],
  );
  assert.ok(!STORE_KIND_OPTIONS.some((o) => /client_credentials/i.test(o.label)));
});

test("name rule and kind-specific hints", () => {
  assert.equal(isValidItemName("GITHUB_TOKEN"), true);
  assert.equal(isValidItemName("github_token"), false);
  assert.equal(isValidItemName("1TOKEN"), false);
  assert.equal(isValidItemName("A".repeat(128)), true);
  assert.equal(isValidItemName("A".repeat(129)), false);
  assert.equal(kindHint("secret"), "");
  assert.match(kindHint("client_secret"), /token host/);
  assert.match(kindHint("client_secret"), new RegExp(APP_SECRET_HOSTS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("store dialog explains hosts and names, hides username until needed, keeps vendor tips collapsed", () => {
  const html = hostedOperatorHtml();
  const kindBlock = html.match(/<select id="store-kind" name="kind">([\s\S]*?)<\/select>/);
  assert.ok(kindBlock, "expected Kind select");
  assert.match(kindBlock[0], />API token</);
  assert.match(kindBlock[0], />Client ID and secret</);
  assert.doesNotMatch(kindBlock[0], /client_credentials/);
  assert.doesNotMatch(html, /Username and password/);
  assert.match(html, /<div id="store-username" hidden>/);
  assert.match(html, /id="store-username-label">Client ID</);
  assert.match(html, /id="store-value-label">Value</);
  assert.match(html, /id="store-inject-summary"/);
  assert.match(html, /id="store-inject-advanced"/);
  assert.match(html, /HTTP Basic \(username \+ password\)/);
  assert.match(html, new RegExp(ITEM_NAME_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, new RegExp(ALLOWED_HOSTS_HELP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /placeholder="GITHUB_TOKEN"/);
  assert.match(html, /placeholder="api\.example\.com"/);
  assert.match(html, /pattern="\[A-Z\]\[A-Z0-9_\]\{0,127\}"/);
  // Spotify hosts appear only inside the collapsed OAuth client-secret tip.
  const tip = html.match(/<summary>Using an OAuth client secret\?<\/summary>[\s\S]*?<\/details>/);
  assert.ok(tip);
  assert.match(tip[0], /api\.spotify\.com/);
  assert.doesNotMatch(html.replace(tip[0], ""), /placeholder="[^"]*spotify/);
  for (const js of [CONSOLE_JS, COLLECT_JS]) {
    assert.match(js, /function needsLoginUsername/);
    assert.match(js, /function storeRequestBody/);
    assert.match(js, /function normalizeItemNameInput/);
  }
  assert.match(COLLECT_JS, /fulfill-inject-summary/);
  assert.doesNotMatch(COLLECT_JS, /Username and password/);
});

test("staging plane lists only staging; production plane lists both", () => {
  assert.deepEqual([...environmentsForDeployPlane("staging")], ["staging"]);
  assert.deepEqual([...environmentsForDeployPlane("production")], ["staging", "production"]);
  const staging = hostedOperatorHtml({ deployPlane: "staging" });
  assert.match(staging, /data-environments="staging"/);
  assert.doesNotMatch(staging, /<option value="production">/);
  const production = hostedOperatorHtml({ deployPlane: "production" });
  assert.match(production, /data-environments="staging,production"/);
  assert.match(production, /<option value="production"/);
});

test("store, rotate, and confirm failures write into the open dialog", () => {
  const html = hostedOperatorHtml();
  assert.match(html, /id="store-dialog"[\s\S]*id="store-error"[\s\S]*<\/dialog>/);
  assert.match(html, /id="rotate-dialog"[\s\S]*id="rotate-error"[\s\S]*<\/dialog>/);
  assert.match(html, /id="confirm"[\s\S]*id="confirm-error"[\s\S]*<\/dialog>/);
  assert.match(html, /id="store-error"[^>]*role="alert"/);
  assert.match(html, /id="rotate"[\s\S]*name="value"[^>]*required/);
  assert.match(CONSOLE_JS, /setFormNotice\("store-error"/);
  assert.match(CONSOLE_JS, /setFormNotice\("rotate-error"/);
  assert.match(CONSOLE_JS, /setFormNotice\("confirm-error", result\.message \|\| "Request failed", false\);\s*return;/);
  assert.match(CONSOLE_JS, /Leave blank to keep the current secret/);
});

test("issue form uses the plane environment list and defaults to the plane environment", () => {
  const issueForm = (html: string) => {
    const m = html.match(/<form id="issue"[\s\S]*?<\/form>/);
    assert.ok(m, "expected issue form");
    return m[0];
  };
  const stagingForm = issueForm(hostedOperatorHtml({ deployPlane: "staging" }));
  assert.match(stagingForm, /<option value="staging" selected>/);
  assert.doesNotMatch(stagingForm, /value="production"/);
  const productionForm = issueForm(hostedOperatorHtml({ deployPlane: "production" }));
  assert.match(productionForm, /<option value="production" selected>/);
  assert.doesNotMatch(CONSOLE_JS, /environment: "staging"/);
});
