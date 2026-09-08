/**
 * The browser bundle is generated and committed. These tests keep it honest: regenerating
 * must produce no diff, the strip is structural, and the pure client modules behave.
 */
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { moduleToScript, renderBundleModule, topLevelNames } from "../scripts/build-client.ts";
import { agentRow, groupStandingApprovals, pageAfterFilter, type ScopedAccessGrant } from "../src/hosted/client/access.ts";
import type { AccessClient } from "../src/hosted/client/types.ts";
import { describeActivity, pageOf } from "../src/hosted/client/activity.ts";
import { filterItems } from "../src/hosted/client/credentials.ts";
import { agentsHash, itemHash, parseRoute, routeHash } from "../src/hosted/client/routes.ts";
import { CSRF_COOKIE_JS } from "../src/hosted/auth-js.ts";
import { countdown, csrfFromCookie, escapeHtml, html, raw, relativeTime, timeHtml } from "../src/hosted/client/shared.ts";
import { AUTH_JS, COLLECT_JS, CONSOLE_JS, hostedAsset } from "../src/hosted/hosted-assets.ts";
import { normalizeItemNameInput, splitHosts, storeRequestBody } from "../src/hosted/store-form-fields.ts";

test("committed client bundle matches a fresh build (run scripts/build-client.ts when this fails)", () => {
  const committed = readFileSync(join(process.cwd(), "src/hosted/client-bundle.ts"), "utf8");
  assert.equal(committed, renderBundleModule());
});

test("bundles are plain JS with no leftover module syntax and parse cleanly", () => {
  for (const js of [CONSOLE_JS, COLLECT_JS]) {
    assert.doesNotMatch(js, /^\s*import\s/m);
    assert.doesNotMatch(js, /^\s*export\s/m);
    assert.doesNotMatch(js, /<reference/);
    assert.doesNotThrow(() => new Script(js));
  }
  assert.equal(hostedAsset("/assets/console.js")?.body, CONSOLE_JS);
  assert.equal(hostedAsset("/assets/mark.svg")?.type, "image/svg+xml");
  assert.match(hostedAsset("/assets/mark.svg")?.body ?? "", /<svg/);
});

test("moduleToScript strips types, imports, references, and export keywords", () => {
  const out = moduleToScript(
    `/// <reference lib="dom" />\nimport { a, type B } from "./x.ts";\nimport type { C } from "./y.ts";\nexport type T = string;\nexport function f(x: string): string { return x; }\nexport const k: number = 1;\nexport { f as g };\n`,
  );
  assert.doesNotMatch(out, /import|export|reference|: string|: number/);
  assert.match(out, /function f\(x\s*\)\s*\{ return x; \}/);
  assert.deepEqual(topLevelNames(out), ["f", "k"]);
});

test("R1-7: the CSRF cookie readers prefer __Host-bp_csrf over a plain bp_csrf a subdomain could plant", () => {
  const cases: [string, string][] = [
    ["bp_csrf=planted; __Host-bp_csrf=real%3D", "real="],
    ["__Host-bp_csrf=real; bp_csrf=planted", "real"],
    ["bp_csrf=plain", "plain"],
    ["__Host-bp_csrf=only", "only"],
    ["xbp_csrf=no; other=1", ""],
    ["", ""],
  ];
  // The console and collect bundles read through the pure helper.
  for (const [cookie, want] of cases) assert.equal(csrfFromCookie(cookie), want, cookie);
  // The auth pages and the invite page inline the same reader as plain JS.
  const readCsrf = (cookie: string): unknown =>
    new Script(`${CSRF_COOKIE_JS}\ncsrf()`).runInNewContext({ document: { cookie } });
  for (const [cookie, want] of cases) assert.equal(readCsrf(cookie), want, cookie);
  assert.ok(AUTH_JS.startsWith(CSRF_COOKIE_JS), "auth.js starts with the shared reader");
});

test("html tag escapes interpolations and keeps nested html and arrays raw", () => {
  const user = `<img src=x onerror=alert(1)> "quoted" & 'single'`;
  const out = html`<p title="${user}">${user}</p>${[html`<b>${1}</b>`, "<i>"]}${raw("<hr>")}`.html;
  assert.equal(
    out,
    `<p title="&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &amp; &#39;single&#39;">&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &amp; &#39;single&#39;</p><b>1</b>&lt;i&gt;<hr>`,
  );
  assert.equal(html`${null}${undefined}${false}${true}`.html, "");
  assert.equal(escapeHtml("</script>"), "&lt;/script&gt;");
});

test("relative time, countdown, and time elements", () => {
  const now = Date.parse("2026-09-04T12:00:00Z");
  assert.equal(relativeTime("2026-09-04T11:59:50Z", now), "just now");
  assert.equal(relativeTime("2026-09-04T11:56:00Z", now), "4 mins ago");
  assert.equal(relativeTime("2026-09-04T12:09:00Z", now), "in 9 mins");
  assert.equal(relativeTime("2026-09-02T12:00:00Z", now), "2 days ago");
  assert.equal(relativeTime("not a date", now), "");
  // A count that rounds up to the next unit reads in that unit, never "60 mins" or "24 hours".
  assert.equal(relativeTime("2026-09-04T11:00:24Z", now), "1 hour ago");
  assert.equal(relativeTime("2026-09-03T12:24:00Z", now), "1 day ago");
  assert.equal(relativeTime("2026-08-05T21:00:00Z", now), "1 month ago");
  assert.equal(relativeTime("2026-09-04T12:59:36Z", now), "in 1 hour");
  assert.equal(relativeTime("2026-09-04T11:01:00Z", now), "59 mins ago");
  assert.equal(relativeTime("2026-09-04T11:59:00Z", now), "1 min ago");
  // The activity page survives a refresh with the same filter and resets when the filter changes.
  const filter = { agent: "cli_1", credential: "" };
  assert.equal(pageAfterFilter(filter, { agent: "cli_1", credential: "" }, 3), 3);
  assert.equal(pageAfterFilter(filter, { agent: "cli_2", credential: "" }, 3), 0);
  assert.equal(pageAfterFilter(filter, { agent: "cli_1", credential: "X" }, 3), 0);
  assert.equal(countdown("2026-09-04T12:09:30Z", now), "9:30 left");
  assert.equal(countdown("2026-09-04T12:00:20Z", now), "20s left");
  assert.equal(countdown("2026-09-04T11:00:00Z", now), "expired");
  assert.match(timeHtml("2026-09-04T11:56:00Z", now).html, /^<time datetime="2026-09-04T11:56:00Z" title="[^"]+">4 mins ago<\/time>$/);
});

test("routes: deep links parse, legacy hashes map, and hashes round-trip", () => {
  assert.equal(parseRoute("").panel, "credentials");
  assert.equal(parseRoute("#vault").panel, "credentials");
  assert.equal(parseRoute("#inbox").panel, "inbox");
  assert.equal(parseRoute("#account").panel, "account");
  assert.equal(parseRoute("#breakglass").breakglass, true);
  assert.equal(parseRoute("#credentials/item/itm_1").itemId, "itm_1");
  const activity = parseRoute("#agents/activity?agent=cli_1&credential=STRIPE_SECRET_KEY");
  assert.equal(activity.panel, "agents");
  assert.equal(activity.tab, "activity");
  assert.equal(activity.agent, "cli_1");
  assert.equal(activity.credential, "STRIPE_SECRET_KEY");
  const legacy = parseRoute("#access/client/cli_2/item/GITHUB_TOKEN");
  assert.deepEqual([legacy.panel, legacy.tab, legacy.agent, legacy.credential], ["agents", "activity", "cli_2", "GITHUB_TOKEN"]);
  assert.equal(parseRoute("#connect").panel, "agents");
  assert.equal(parseRoute("#vault?connected=spotify").query.get("connected"), "spotify");
  assert.equal(agentsHash("activity", { agent: "a b" }), "#agents/activity?agent=a+b");
  assert.equal(itemHash("itm/1"), "#credentials/item/itm%2F1");
  for (const h of ["#inbox", "#account", "#breakglass", "#credentials", "#credentials/item/x", "#agents/sessions", "#agents/activity?agent=a"]) {
    assert.equal(routeHash(parseRoute(h)), h);
  }
});

test("activity rows read as sentences for every action the kernel writes", () => {
  const names = { clientName: (id: string | null) => (id === "cli_1" ? "cursor" : id ?? "") };
  const row = (action: string, itemName: string | null = "STRIPE_SECRET_KEY", clientId: string | null = "cli_1") =>
    describeActivity({ action, actor: "x", itemName, clientId }, names);
  assert.equal(row("request_grant"), "cursor requested STRIPE_SECRET_KEY");
  assert.equal(row("token_issued", null), "Token issued to cursor");
  assert.equal(row("store", "GITHUB_TOKEN", null), "Stored GITHUB_TOKEN");
  assert.equal(row("grant"), "Approved cursor for STRIPE_SECRET_KEY");
  assert.equal(row("auto_approved"), "Standing approval let cursor use STRIPE_SECRET_KEY");
  assert.equal(
    describeActivity({ action: "auto_approved", actor: "x", itemName: "STRIPE_SECRET_KEY", clientId: "cli_1", host: "api.stripe.com" }, names),
    "Standing approval let cursor use STRIPE_SECRET_KEY on api.stripe.com",
  );
  assert.equal(row("revoke"), "Revoked cursor for STRIPE_SECRET_KEY");
  assert.equal(row("inject"), "cursor used STRIPE_SECRET_KEY");
  assert.equal(row("client_revoked", null), "Access revoked for cursor");
  assert.equal(row("client_rotate", null), "Token rotated for cursor");
  assert.equal(row("notify_failed"), "Email notice failed for STRIPE_SECRET_KEY");
  assert.equal(row("need_created", "NOTION_TOKEN"), "cursor asked for NOTION_TOKEN to be stored");
  assert.equal(row("session_created", null, null), "You signed in");
  assert.equal(row("some_new_thing", null, null), "some new thing");
  const page0 = pageOf(Array.from({ length: 120 }, (_, i) => i), 0);
  assert.equal(page0.rows.length, 50);
  assert.equal(page0.hasMore, true);
  assert.equal(pageOf(Array.from({ length: 120 }, (_, i) => i), 2).hasMore, false);
});

test("credential filters search name or host, filter exactly, and sort", () => {
  const rows = [
    { id: "1", name: "STRIPE_SECRET_KEY", kind: "secret", last4: "xyz9", username: null, environment: "production", inject: "bearer", allowedHosts: ["api.stripe.com"], updated_at: "2026-09-01T00:00:00Z" },
    { id: "2", name: "GITHUB_TOKEN", kind: "secret", last4: "7788", username: null, environment: "staging", inject: "bearer", allowedHosts: ["api.github.com"], updated_at: "2026-09-03T00:00:00Z" },
    { id: "3", name: "SPOTIFY_SECRET", kind: "client_secret", last4: "abcd", username: "id", environment: "staging", inject: "client_credentials", allowedHosts: ["api.spotify.com"], updated_at: "2026-09-02T00:00:00Z" },
  ];
  const names = (f: Partial<Parameters<typeof filterItems>[1]>) =>
    filterItems(rows, { q: "", environment: "", kind: "", sort: "name", ...f }).map((r) => r.name);
  assert.deepEqual(names({}), ["GITHUB_TOKEN", "SPOTIFY_SECRET", "STRIPE_SECRET_KEY"]);
  assert.deepEqual(names({ q: "github" }), ["GITHUB_TOKEN"]);
  assert.deepEqual(names({ q: "stripe.com" }), ["STRIPE_SECRET_KEY"]);
  assert.deepEqual(names({ environment: "staging" }), ["GITHUB_TOKEN", "SPOTIFY_SECRET"]);
  assert.deepEqual(names({ kind: "app secret" }), ["SPOTIFY_SECRET"]);
  assert.deepEqual(names({ sort: "updated" }), ["GITHUB_TOKEN", "SPOTIFY_SECRET", "STRIPE_SECRET_KEY"]);
});

test("store body builder and name normalisation are shared with the server", () => {
  assert.equal(normalizeItemNameInput("github token"), "GITHUB_TOKEN");
  assert.equal(normalizeItemNameInput("my-api.key v2"), "MY_API_KEY_V2");
  assert.deepEqual(splitHosts(" https://api.stripe.com/v1, api.github.com ,"), ["api.stripe.com", "api.github.com"]);
  const body = storeRequestBody(
    { name: "X", kind: "client_secret", inject: "bearer", username: " id ", allowedHosts: "a.com", value: "", environment: "staging" },
    { editing: true },
  );
  assert.deepEqual(body, { name: "X", kind: "client_secret", inject: "client_credentials", username: "id", allowed_hosts: ["a.com"], environment: "staging" });
  const fresh = storeRequestBody({ name: "X", kind: "secret", inject: "bearer", username: "u", allowedHosts: "a.com", value: "v" }, { editing: false });
  assert.equal(fresh.username, undefined);
  assert.equal(fresh.value, "v");
});

function standingGrant(id: string, item: string, extras: Partial<ScopedAccessGrant> = {}): ScopedAccessGrant {
  return {
    id,
    item_name: item,
    client_id: "cli_1",
    client_name: "botpasses-vp-dogfood",
    status: "active",
    policy: "item_standing",
    created_at: "2026-09-08T08:00:00Z",
    first_access_at: "2026-09-08T08:30:00Z",
    last_access_at: "2026-09-08T12:00:00Z",
    approved_at: "2026-09-08T08:00:00Z",
    fetched: [],
    ...extras,
  };
}

const dogfoodAgent: AccessClient = {
  id: "cli_1",
  name: "botpasses-vp-dogfood",
  kind: "model",
  environment: "staging",
  status: "active",
  created_at: "2026-09-08T08:00:00Z",
  first_access_at: "2026-09-08T08:30:00Z",
  last_access_at: "2026-09-08T12:00:00Z",
  last_token_at: null,
  last_seen_at: null,
  fetched: ["SPOTIFY_SECRET", "SPOTIFY_REFRESH"],
  last4: "c089",
  consented_by_email: null,
};

test("agent row groups standing approvals by credential and keeps one clear control", () => {
  const standing = [
    standingGrant("g1", "SPOTIFY_SECRET", { last_access_at: "2026-09-08T09:00:00Z", grant_scope: { methods: null, path_prefixes: null, hosts: ["api.spotify.com"], max_calls: null, calls_used: 0, expires_at: null } }),
    standingGrant("g2", "SPOTIFY_SECRET", { last_access_at: "2026-09-08T12:00:00Z", grant_scope: { methods: null, path_prefixes: null, hosts: ["accounts.spotify.com"], max_calls: null, calls_used: 0, expires_at: null } }),
    standingGrant("g3", "SPOTIFY_SECRET"),
    standingGrant("g4", "SPOTIFY_SECRET"),
    standingGrant("g5", "SPOTIFY_SECRET"),
    standingGrant("g6", "SPOTIFY_REFRESH", { last_access_at: "2026-09-08T11:00:00Z" }),
    standingGrant("g7", "SPOTIFY_REFRESH"),
  ];
  const groups = groupStandingApprovals(standing);
  assert.deepEqual(
    groups.map((g) => ({ itemName: g.itemName, grantId: g.grantId, lastAccessAt: g.lastAccessAt, hosts: g.hosts })),
    [
      { itemName: "SPOTIFY_SECRET", grantId: "g1", lastAccessAt: "2026-09-08T12:00:00Z", hosts: ["api.spotify.com", "accounts.spotify.com"] },
      { itemName: "SPOTIFY_REFRESH", grantId: "g6", lastAccessAt: "2026-09-08T12:00:00Z", hosts: [] },
    ],
  );
  const markup = agentRow(dogfoodAgent, ["staging", "production"], standing).html;
  assert.equal(markup.match(/data-testid="standing-approval"/g)?.length, 2);
  assert.equal(markup.match(/data-testid="clear-standing"/g)?.length, 2);
  assert.match(markup, /data-grant-revoke="g1"/);
  assert.match(markup, /data-grant-revoke="g6"/);
  assert.doesNotMatch(markup, /Always approved for/);
  assert.doesNotMatch(markup, /Used SPOTIFY_SECRET/);
  assert.match(markup, /api\.spotify\.com, accounts\.spotify\.com/);
  assert.match(markup, /aria-label="Clear standing approval for SPOTIFY_SECRET"/);
  assert.match(markup, /<span class="access-row-name">botpasses-vp-dogfood<\/span>/);
  const escaped = agentRow({ ...dogfoodAgent, name: `<img src=x>` }, ["staging"], [standingGrant("gx", `<script>alert(1)</script>`)]).html;
  assert.match(escaped, /&lt;img src=x&gt;/);
  assert.match(escaped, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(agentRow(dogfoodAgent, ["staging"], []).html, /standing-list/);
});
