import assert from "node:assert/strict";
import { test } from "node:test";
import { COLLECT_JS, CONSOLE_JS } from "../src/hosted/hosted-assets.ts";
import { hostedOperatorHtml } from "../src/hosted/operator-page.ts";
import {
  environmentsForDeployPlane,
} from "../src/hosted/deploy-plane.ts";
import {
  defaultInjectForKind,
  injectSummary,
  needsLoginUsername,
} from "../src/hosted/store-form-fields.ts";

test("login username is only for kind login or inject basic", () => {
  assert.equal(needsLoginUsername("secret", "bearer"), false);
  assert.equal(needsLoginUsername("secret", "header:Authorization"), false);
  assert.equal(needsLoginUsername("secret", "basic"), true);
  assert.equal(needsLoginUsername("secret", "client_credentials"), true);
  assert.equal(needsLoginUsername("login", "bearer"), true);
  assert.equal(needsLoginUsername("login", "basic"), true);
});

test("kind picks the usual inject so operators do not choose an HTTP scheme", () => {
  assert.equal(defaultInjectForKind("secret"), "bearer");
  assert.equal(defaultInjectForKind("login"), "basic");
  assert.match(injectSummary("bearer"), /Bearer/);
  assert.match(injectSummary("basic"), /HTTP Basic/);
  assert.match(injectSummary("header:Authorization"), /no Bearer prefix/);
});

test("store form hides username and inject until they are needed", () => {
  const html = hostedOperatorHtml();
  assert.match(html, /id="store-username"[^>]*hidden/);
  assert.match(html, /HTTP Basic username/);
  assert.doesNotMatch(html, /Username \(login\)/);
  assert.match(html, /id="store-inject-summary"/);
  assert.match(html, /id="store-inject-advanced"/);
  assert.match(html, />API token</);
  assert.match(html, />Username and password</);
  assert.match(CONSOLE_JS, /store-inject-summary/);
  assert.match(CONSOLE_JS, /kind\.value === "login"/);
  assert.match(CONSOLE_JS, /client_credentials/);
  assert.match(COLLECT_JS, /fulfill-inject-summary/);
  assert.match(COLLECT_JS, /client_credentials/);
});

test("staging plane lists only staging; production plane lists both", () => {
  assert.deepEqual([...environmentsForDeployPlane("staging")], ["staging"]);
  assert.deepEqual([...environmentsForDeployPlane("production")], ["staging", "production"]);
  const staging = hostedOperatorHtml({ deployPlane: "staging" });
  assert.match(staging, /data-environments="staging"/);
  assert.doesNotMatch(staging, /<option value="production">/);
  const production = hostedOperatorHtml({ deployPlane: "production" });
  assert.match(production, /data-environments="staging,production"/);
  assert.match(production, /<option value="production">/);
});

test("console item list follows the page plane and surfaces store errors", () => {
  assert.match(CONSOLE_JS, /api\("\/api\/items"\)/);
  assert.doesNotMatch(CONSOLE_JS, /\/api\/items\?environment=/);
  assert.match(CONSOLE_JS, /j\.error \|\| "Store failed"/);
  assert.match(CONSOLE_JS, /j\.error \|\| "Rotate failed"/);
  assert.match(CONSOLE_JS, /f\.value\.value = ""/);
  assert.match(COLLECT_JS, /if \(r\.ok\) form\.value\.value = ""/);
});

test("store and rotate failures write into the open dialog, not only the page header", () => {
  const html = hostedOperatorHtml();
  assert.match(html, /id="store-dialog"[\s\S]*id="store-error"[\s\S]*<\/dialog>/);
  assert.match(html, /id="rotate-dialog"[\s\S]*id="rotate-error"[\s\S]*<\/dialog>/);
  assert.match(html, /id="confirm"[\s\S]*id="confirm-error"[\s\S]*<\/dialog>/);
  assert.match(html, /id="store-error"[^>]*role="alert"/);
  assert.match(CONSOLE_JS, /setFormNotice\("store-error"/);
  assert.match(CONSOLE_JS, /setFormNotice\("rotate-error"/);
  assert.match(CONSOLE_JS, /setFormNotice\("confirm-error"/);
  assert.match(html, /id="rotate"[\s\S]*name="value"[^>]*required/);
  assert.match(
    CONSOLE_JS,
    /if \(r\.ok\) \{\s*f\.value\.value = "";\s*flash\("Stored", true\);\s*closeDialog\("store-dialog"\);\s*\} else \{\s*setFormNotice\("store-error"/,
  );
});

test("grok issue uses the same plane environment list as store", () => {
  const grokForm = (html: string) => {
    const m = html.match(/<form id="grok">[\s\S]*?<\/form>/);
    assert.ok(m, "expected grok form");
    return m[0];
  };
  const stagingForm = grokForm(hostedOperatorHtml({ deployPlane: "staging" }));
  assert.match(stagingForm, /<select name="environment">/);
  assert.doesNotMatch(stagingForm, /value="production"/);
  const productionForm = grokForm(hostedOperatorHtml({ deployPlane: "production" }));
  assert.match(productionForm, /<option value="production">/);
  assert.doesNotMatch(CONSOLE_JS, /environment: "staging"/);
  assert.match(CONSOLE_JS, /environment: grok\.environment\.value/);
});

test("confirm-yes keeps the dialog open when the mutation fails", () => {
  assert.match(CONSOLE_JS, /setFormNotice\("confirm-error", j\.error \|\| "Request failed", false\);\s*return;/);
  assert.match(CONSOLE_JS, /if \(confirm && confirm\.close\) confirm\.close\(\)/);
});

test("access load failures show an error instead of an empty panel", () => {
  const html = hostedOperatorHtml();
  assert.match(html, /data-testid="access-error"/);
  assert.match(CONSOLE_JS, /Could not load access/);
  assert.match(CONSOLE_JS, /if \(!snap\.ok\)/);
  assert.match(CONSOLE_JS, /Could not load audit/);
});

test("collect fulfill failures mark the page flash as an error", () => {
  assert.match(COLLECT_JS, /collectFlash\(flash, r\.ok \? "Stored and granted" : \(data\.error \|\| "Store failed"\), r\.ok\)/);
  assert.match(COLLECT_JS, /classList\.toggle\("is-err"/);
});
