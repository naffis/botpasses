/**
 * Browser smoke tests for the operator console. The first signs up, enrolls TOTP, stores a
 * credential, issues a token, requests a grant over MCP, approves from the Inbox, revokes from
 * Agents, and signs out; it also checks Cancel closes dialogs and the Actions column is visible
 * at 1280 and 390 px. The second completes a real OAuth consent (DCR, /authorize, Allow, code on
 * the redirect URI, token exchange) and re-enrolls the authenticator from the console. The third
 * drives an agent's user_connect_required handoff: the Inbox card with its Connect button, the
 * connect dialog it opens (agent checkbox checked, Client ID prefilled), the same dialog from the
 * connect_url deep link, and Deny. All skip with a reason when the preinstalled Chromium is absent.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import * as OTPAuth from "otpauth";
import { bootConsoleServer, type ConsoleServer } from "./helpers/console-boot.ts";
import { launchChromium, playwrightUnavailableReason, type PwPage } from "./helpers/playwright.ts";

const skipReason = playwrightUnavailableReason();
/** 20 s is the budget; raise SMOKE_TIMEOUT_MS locally to see where a slow run stalls. */
const SMOKE_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 20_000);

async function within(page: PwPage, selector: string, width: number): Promise<void> {
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 5_000 });
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, `${selector} has no box`);
  assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${selector} overflows ${width}px: x=${box.x} w=${box.width}`);
  assert.ok(await page.locator(selector).first().isVisible(), `${selector} not visible`);
}

/** How many times this page has fetched `path` since it loaded (resource timing entries). */
async function loads(page: PwPage, path: string): Promise<number> {
  // A string is evaluated as an expression (an arrow function would be created, not called).
  return page.evaluate<number>(`performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname === '${path}').length`);
}

async function cancelCloses(page: PwPage, open: () => Promise<void>, dialog: string, cancel: string): Promise<void> {
  await open();
  await page.waitForSelector(`${dialog}[open]`);
  await page.click(cancel);
  await page.waitForSelector(`${dialog}:not([open])`, { state: "attached" });
}

async function mcpCall(base: string, token: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200, `mcp ${name} status`);
  return (await res.json()) as Record<string, unknown>;
}

type Authenticator = ReturnType<typeof OTPAuth.URI.parse>;

/** On /enroll-totp: read the otpauth URL the page shows, submit a current code, return the authenticator. */
async function confirmEnrollment(page: PwPage): Promise<Authenticator> {
  await page.waitForFunction("() => (document.getElementById('otpauth')?.textContent || '').startsWith('otpauth://')");
  const otpauth = (await page.locator("#otpauth").textContent()) ?? "";
  const totp = OTPAuth.URI.parse(otpauth.trim());
  await page.fill("input[name=code]", totp.generate());
  await page.locator("input[name=code]").press("Enter");
  await page.waitForSelector("[data-testid=backup-codes]:not([hidden])");
  return totp;
}

/** Sign up with the email code, enroll, keep one backup code, continue to the console. */
async function signUpInBrowser(page: PwPage, server: ConsoleServer, email: string): Promise<{ totp: Authenticator; backupCode: string }> {
  await page.goto(`${server.base}/sign-up`);
  await page.fill("input[name=email]", email);
  await page.locator("input[name=email]").first().press("Enter");
  await page.waitForSelector("input[name=otp]", { state: "visible" });
  const otp = server.otpFor(email);
  assert.match(otp, /^\d{8}$/, "otp captured from mailbox");
  await page.fill("input[name=otp]", otp);
  await page.locator("input[name=otp]").press("Enter");
  await page.waitForURL(/\/enroll-totp/);
  const totp = await confirmEnrollment(page);
  const backupCode = ((await page.locator("#backups li").first().textContent()) ?? "").trim();
  assert.match(backupCode, /^[A-Z2-9]{10}$/, "a backup code is shown");
  await page.click("#backups-continue");
  await page.waitForURL(/\/console/);
  return { totp, backupCode };
}

/** Where the OAuth client "lives": records the redirect the browser lands on. */
async function startRedirectTarget(): Promise<{ redirectUri: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("callback received");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}/cb`,
    hits,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test("console smoke: sign up, store, connect, approve, revoke, sign out at 1280 and 390", { skip: skipReason, timeout: SMOKE_TIMEOUT_MS * 2 }, async () => {
  const server = await bootConsoleServer();
  const browser = await launchChromium();
  const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const email = `smoke-${Date.now()}@example.com`;

    // Sign up with email OTP, enroll TOTP, land in the console
    const { backupCode } = await signUpInBrowser(page, server, email);

    // Credentials: empty state, Cancel closes, auto-uppercase, store
    await page.waitForSelector("[data-testid=items-empty]:not([hidden])");
    await cancelCloses(page, () => page.click("[data-testid=open-store]"), "#store-dialog", "[data-testid=store-cancel]");
    await page.click("[data-testid=open-store]");
    await page.waitForSelector("#store-dialog[open]");
    assert.equal(await page.locator("#store-env").inputValue(), "production", "store defaults to the plane environment");
    await page.fill("#store-name", "github token");
    assert.equal(await page.locator("#store-name").inputValue(), "GITHUB_TOKEN");
    await page.fill("#store-value", "ghp_smoke_value_1234");
    await page.fill("#store-hosts", "api.github.com");
    await page.click("#store-submit");
    await page.waitForSelector("tr[data-item]");
    await page.waitForSelector("#store-dialog:not([open])", { state: "attached" });
    await within(page, "[data-testid=item-delete]", 1280);
    await within(page, "td.last4", 1280);

    // Row click opens the drawer and deep-links; Close returns to #credentials
    await page.click("tr[data-item] td.name");
    await page.waitForSelector("#item-drawer[open]");
    assert.match(page.url(), /#credentials\/item\//);
    const itemUrl = page.url();
    await page.click("[data-testid=drawer-close]");
    await page.waitForSelector("#item-drawer:not([open])", { state: "attached" });

    // Enter on a focused row opens the drawer, and the same keypress must not close it again.
    // Closing the drawer refreshes the list (the rows are re-rendered), so let that settle first.
    const itemLoadsBeforeEnter = await loads(page, "/api/items");
    // waitForFunction takes the arrow form (a bare expression is eval'd in the page, which the CSP refuses).
    await page.waitForFunction(`() => performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname === '/api/items').length > ${itemLoadsBeforeEnter}`);
    await page.waitForTimeout(200);
    await page.locator("tr[data-item]").first().press("Enter");
    assert.equal(await page.evaluate<string>("document.activeElement?.tagName || ''"), "BUTTON", "focus moved into the drawer");
    await page.waitForSelector("#item-drawer[open]");
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#item-drawer[open]").count(), 1, "the drawer stays open after Enter");
    await page.click("[data-testid=drawer-close]");
    await page.waitForSelector("#item-drawer:not([open])", { state: "attached" });

    // A deep link on a fresh page load opens the drawer once the list is loaded; the list loads once.
    // Via about:blank so this is a full document load, not a same-document hash change.
    await page.goto("about:blank");
    await page.goto(itemUrl);
    try {
      await page.waitForSelector("#item-drawer[open]", { timeout: 5_000 });
    } catch (err) {
      const state = await page.evaluate<string>(
        "JSON.stringify({ hash: location.hash, open: document.getElementById('item-drawer')?.open, rows: document.querySelectorAll('tr[data-item]').length, flash: document.getElementById('flash')?.textContent })",
      );
      throw new Error(`deep link did not open the drawer: ${state}; page errors: ${JSON.stringify(errors)}`, { cause: err });
    }
    assert.equal(((await page.locator("#drawer-title").textContent()) ?? "").trim(), "GITHUB_TOKEN");
    await page.waitForTimeout(500);
    assert.equal(await loads(page, "/api/items"), 1, "boot loads the credential list once");
    await page.click("[data-testid=drawer-close]");
    await page.waitForSelector("#item-drawer:not([open])", { state: "attached" });

    // An id no credential has says so and returns to the list
    await page.goto(`${server.base}/console#credentials/item/itm_missing`);
    await page.waitForSelector("#flash.is-err");
    await page.waitForFunction("() => location.hash === '#credentials'");
    assert.equal(await page.locator("#item-drawer[open]").count(), 0);

    // Navigating by hash loads the panel once (hashchange only; popstate used to fire a second load)
    const accessBefore = await loads(page, "/api/access");
    await page.click("[data-testid=nav-agents]");
    await page.waitForSelector("[data-panel=agents].is-active");
    await page.waitForTimeout(500);
    assert.equal((await loads(page, "/api/access")) - accessBefore, 1, "one load per navigation");

    // Agents: issue a token, shown once in a modal
    await page.click("[data-testid=nav-agents]");
    await page.fill("#issue-name", "cursor");
    await page.click("[data-testid=issue-token]");
    await page.waitForSelector("#token-dialog[open]");
    const token = ((await page.locator("#token-value").textContent()) ?? "").trim();
    assert.match(token, /^avm_/);
    await page.click("[data-testid=token-saved]");
    await page.waitForSelector("[data-testid=agent-row]");

    // Agent requests the credential over MCP
    const result = await mcpCall(server.base, token, "request_grant", { item_name: "GITHUB_TOKEN", task_description: "List open PRs" });
    assert.equal(result.error, undefined, JSON.stringify(result));

    // Inbox: the request appears (polling or navigation) and can be approved
    await page.click("[data-testid=nav-inbox]");
    await page.waitForSelector("[data-testid=inbox-approve]");
    const title = (await page.locator("[data-testid=inbox-request] .inbox-title").first().textContent()) ?? "";
    assert.match(title, /cursor wants GITHUB_TOKEN/);
    await page.click("[data-testid=inbox-approve]");
    await page.waitForSelector("[data-testid=inbox-approved]");

    // Agents > Approvals: specific confirm copy, Cancel closes, Confirm revokes
    await page.goto(`${server.base}/console#agents/approvals`);
    await page.waitForSelector("[data-testid=grant-revoke]");
    await cancelCloses(page, () => page.click("[data-testid=grant-revoke]"), "#confirm", "[data-testid=confirm-cancel]");
    await page.click("[data-testid=grant-revoke]");
    await page.waitForSelector("#confirm[open]");
    assert.equal(await page.locator("#confirm-title").textContent(), "Revoke cursor's approval for GITHUB_TOKEN?");
    assert.equal(
      await page.evaluate<string>("document.activeElement?.getAttribute('data-testid') || ''"),
      "confirm-cancel",
      "the confirm dialog focuses Cancel, not the destructive button",
    );
    await page.click("#confirm-yes");
    await page.waitForSelector("#confirm:not([open])", { state: "attached" });
    await page.waitForSelector("[data-testid=grant-row] .pill:has-text('revoked')");

    // Agents tab: revoke the agent itself
    await page.click("#tab-agents");
    await page.click("[data-testid=agent-revoke]");
    await page.waitForSelector("#confirm[open]");
    assert.equal(await page.locator("#confirm-title").textContent(), "Revoke access for cursor?");
    assert.equal(await page.locator("#confirm-yes").textContent(), "Revoke access");
    await page.click("#confirm-yes");
    await page.waitForSelector("[data-testid=agent-row] .pill:has-text('revoked')");
    const denied = await fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_items", arguments: {} } }),
    });
    assert.equal(denied.status, 401, "revoked token is rejected");

    // Activity is humanised and deep links restore the tab; Back works
    await page.goto(`${server.base}/console#agents/activity`);
    await page.waitForSelector("#tabpanel-activity:not([hidden])");
    const activity = (await page.locator("[data-testid=access-audit]").textContent()) ?? "";
    assert.match(activity, /cursor requested GITHUB_TOKEN/);
    assert.match(activity, /Token issued to cursor/);
    assert.match(activity, /Stored GITHUB_TOKEN/);
    await page.click("[data-testid=nav-inbox]");
    await page.waitForSelector("[data-panel=inbox].is-active");
    await page.goBack();
    await page.waitForSelector("#tabpanel-activity:not([hidden])");
    assert.match(page.url(), /#agents\/activity$/);

    // Account: backup-code Copy works on every click, and a regenerate copies the new codes, not the old
    await page.goto(`${server.base}/console#account`);
    await page.waitForSelector("[data-testid=account-regen]");
    await page.evaluate("(window.__copied = [], navigator.clipboard.writeText = (t) => { window.__copied.push(t); return Promise.resolve(); }, 0)");
    await page.click("[data-testid=account-regen]");
    await page.waitForSelector("#code-dialog[open]");
    await page.fill("#code-dialog-input", backupCode);
    await page.locator("#code-dialog-input").press("Enter");
    await page.waitForSelector("#backup-dialog[open]");
    const firstCodes = ((await page.locator("#backup-codes").textContent()) ?? "").trim();
    assert.match(firstCodes, /^[A-Z2-9]{10}(\n[A-Z2-9]{10})+$/);
    await page.click("#backup-copy");
    await page.click("#backup-copy");
    assert.equal(await page.evaluate<number>("window.__copied.length"), 2, "Copy works on the second click too");
    await page.click("#backup-dialog [data-close]");
    await page.waitForSelector("#backup-dialog:not([open])", { state: "attached" });
    await page.click("[data-testid=account-regen]");
    await page.waitForSelector("#code-dialog[open]");
    await page.fill("#code-dialog-input", firstCodes.split("\n")[0] ?? "");
    await page.locator("#code-dialog-input").press("Enter");
    await page.waitForSelector("#backup-dialog[open]");
    const secondCodes = ((await page.locator("#backup-codes").textContent()) ?? "").trim();
    assert.notEqual(secondCodes, firstCodes);
    await page.click("#backup-copy");
    const copied = await page.evaluate<string[]>("window.__copied");
    assert.equal(copied.length, 3, "no stale handler from the first dialog fires");
    assert.equal(copied[2], secondCodes, "the second dialog copies the new codes");
    await page.click("#backup-dialog [data-close]");
    await page.waitForSelector("#backup-dialog:not([open])", { state: "attached" });

    // 390 px: Actions visible, Cancel closes
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${server.base}/console#credentials`);
    await page.waitForSelector("tr[data-item]");
    await within(page, "[data-testid=item-delete]", 390);
    await within(page, "td.last4", 390);
    await cancelCloses(page, () => page.click("[data-testid=open-store]"), "#store-dialog", "[data-testid=store-cancel]");
    await cancelCloses(page, () => page.click("[data-testid=item-rotate]"), "#rotate-dialog", "[data-testid=rotate-cancel]");

    // Sign out from the rail
    await page.click("[data-testid=sign-out]");
    await page.waitForURL(/\/sign-in/);
    const status = await page.evaluate<number>("fetch('/api/items', { credentials: 'include' }).then((r) => r.status)");
    assert.equal(status, 401, "session cookie cleared");
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await browser.close();
    await server.close();
  }
});

test("console smoke: OAuth consent in Chromium lands on the redirect URI with a code; re-enroll shows the pending QR", { skip: skipReason, timeout: SMOKE_TIMEOUT_MS * 2 }, async () => {
  const server = await bootConsoleServer({ oauth: true });
  const target = await startRedirectTarget();
  const browser = await launchChromium();
  const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const email = `consent-${Date.now()}@example.com`;
    const { totp, backupCode } = await signUpInBrowser(page, server, email);

    // The MCP client registers itself (DCR) and sends the browser to /authorize.
    const registered = await fetch(`${server.base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Smoke Desktop",
        redirect_uris: [target.redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    const registeredText = await registered.text();
    assert.ok(registered.status === 200 || registered.status === 201, registeredText);
    const { client_id: clientId } = JSON.parse(registeredText) as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const audience = `${server.base}/mcp`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: target.redirectUri,
      response_type: "code",
      scope: "openid mcp",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: audience,
      state: "smoke-state",
    });
    await page.goto(`${server.base}/oauth/authorize?${params}`);
    await page.waitForSelector("[data-testid=oauth-consent]");
    assert.match(page.url(), /\/consent\?uid=/);
    assert.equal(((await page.locator("[data-testid=consent-client]").textContent()) ?? "").trim(), "Smoke Desktop");

    // Allow: the page posts the decision, follows the resume URL, and the AS redirects to the client.
    await page.click("button[name=decision][value=allow]");
    await page.waitForURL(/\/cb\?/);
    const landed = new URL(page.url());
    assert.equal(landed.origin + landed.pathname, target.redirectUri);
    const code = landed.searchParams.get("code") ?? "";
    assert.ok(code, "authorization code on the redirect URI");
    assert.equal(landed.searchParams.get("state"), "smoke-state");
    assert.equal(landed.searchParams.get("iss"), server.base);
    // Chromium also asks the target for /favicon.ico; only the callback itself counts.
    assert.equal(target.hits.filter((u) => u.startsWith("/cb?")).length, 1, "the client received the redirect once");

    // The code is real: it exchanges for a JWT that the MCP endpoint accepts.
    const issued = await fetch(`${server.base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: target.redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: audience,
      }),
    });
    const issuedText = await issued.text();
    assert.equal(issued.status, 200, issuedText);
    const tokens = JSON.parse(issuedText) as { access_token?: string };
    assert.match(tokens.access_token ?? "", /^eyJ/);
    const tools = await fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${tokens.access_token ?? ""}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(tools.status, 200);

    // Re-enroll from the console: a current factor (a backup code), then the enroll page shows the
    // pending secret rather than redirecting to the console or starting a second one.
    await page.goto(`${server.base}/console#account`);
    await page.waitForSelector("[data-testid=account-reenroll]");
    await page.click("[data-testid=account-reenroll]");
    await page.waitForSelector("#code-dialog[open]");
    await page.fill("#code-dialog-input", backupCode);
    await page.locator("#code-dialog-input").press("Enter");
    await page.waitForURL(/\/enroll-totp/);
    await page.waitForSelector("[data-testid=totp-qr] svg");
    const pendingUrl = await page.evaluate<string>(
      "fetch('/api/auth/totp/pending', { credentials: 'include' }).then((r) => r.json()).then((j) => j.otpauth_url || '')",
    );
    const second = await confirmEnrollment(page);
    assert.notEqual(second.secret.base32, totp.secret.base32, "re-enroll issued a new secret");
    assert.equal(new URL(pendingUrl).searchParams.get("secret"), second.secret.base32, "the page shows the secret the server holds");
    await page.click("#backups-continue");
    await page.waitForURL(/\/console/);
    const me = await page.evaluate<{ totp_enabled?: boolean; backup_codes_remaining?: number }>(
      "fetch('/api/auth/me', { credentials: 'include' }).then((r) => r.json())",
    );
    assert.equal(me.totp_enabled, true);
    assert.equal(me.backup_codes_remaining, 10, "a fresh set of backup codes");
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await browser.close();
    await target.close();
    await server.close();
  }
});

/** The JSON a tools/call answered with. */
function toolJson(rpc: Record<string, unknown>): Record<string, unknown> {
  const result = rpc.result as { content?: { text?: string }[] } | undefined;
  return JSON.parse(result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

async function expectConnectDialogForAgent(page: PwPage, clientId: string): Promise<void> {
  await page.waitForSelector("#connect-dialog[open]", { timeout: 5_000 });
  assert.equal(await page.locator("#connect-client-id").inputValue(), clientId, "the Client ID comes from the item's username");
  assert.equal(await page.locator("#connect-agent-row:not([hidden])").count(), 1, "the agent row is shown");
  assert.equal(await page.evaluate<boolean>("document.getElementById('connect-allow-agent').checked"), true, "allow the agent is checked by default");
  await page.waitForFunction("() => /Also allow cursor to use the connected account/.test(document.getElementById('connect-agent-label')?.textContent || '')");
  assert.equal(((await page.locator("#connect-title").textContent()) ?? "").trim(), "Connect Spotify account");
}

test("console smoke: user_connect_required lands in the Inbox; Connect and the deep link open the dialog prefilled for the agent; Deny settles it", { skip: skipReason, timeout: SMOKE_TIMEOUT_MS * 2 }, async () => {
  const server = await bootConsoleServer();
  const browser = await launchChromium();
  const errors: string[] = [];
  const clientId = "97540628b46c43059710d66714d75870";
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await signUpInBrowser(page, server, `connect-${Date.now()}@example.com`);

    // Store the app credential: Kind "Client ID and secret" shows the Client ID field.
    await page.waitForSelector("[data-testid=items-empty]:not([hidden])");
    await page.click("[data-testid=open-store]");
    await page.waitForSelector("#store-dialog[open]");
    await page.fill("#store-name", "spotify secret");
    await page.selectOption("#store-kind", "client_secret");
    await page.waitForSelector("#store-username:not([hidden])");
    await page.fill("#store-username-input", clientId);
    await page.fill("#store-value", "spotify_client_secret_smoke_1234");
    await page.fill("#store-hosts", "api.spotify.com, accounts.spotify.com");
    await page.click("#store-submit");
    await page.waitForSelector("tr[data-item]");
    await page.waitForSelector("#store-dialog:not([open])", { state: "attached" });
    await page.waitForSelector("[data-testid=item-connect]");

    // An agent gets a token, is approved on the client secret, and calls a user-only path.
    await page.click("[data-testid=nav-agents]");
    await page.fill("#issue-name", "cursor");
    await page.click("[data-testid=issue-token]");
    await page.waitForSelector("#token-dialog[open]");
    const token = ((await page.locator("#token-value").textContent()) ?? "").trim();
    await page.click("[data-testid=token-saved]");
    const asked = await mcpCall(server.base, token, "request_grant", { item_name: "SPOTIFY_SECRET", task_description: "Show my profile" });
    assert.equal(asked.error, undefined, JSON.stringify(asked));
    await page.click("[data-testid=nav-inbox]");
    await page.waitForSelector("[data-testid=inbox-approve]");
    await page.click("[data-testid=inbox-approve]");
    await page.waitForSelector("[data-testid=inbox-approved]");
    const me = toolJson(await mcpCall(server.base, token, "http_request", { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me" }));
    assert.equal(me.status, "user_connect_required", JSON.stringify(me));
    const connectUrl = new URL(String(me.connect_url));

    // The Inbox card names the agent, the provider, and the item, and offers Connect.
    await page.reload();
    await page.waitForSelector("[data-testid=inbox-connect-need]");
    const title = (await page.locator("[data-testid=inbox-connect-need] .inbox-title").first().textContent()) ?? "";
    assert.match(title, /cursor needs a Spotify account for SPOTIFY_SECRET/);
    await within(page, "[data-testid=inbox-connect]", 1280);
    await page.click("[data-testid=inbox-connect]");
    await expectConnectDialogForAgent(page, clientId);
    assert.match(page.url(), /#credentials\/item\/.*connect=spotify.*agent=.*need=nid_/);
    await page.click("#connect-dialog [data-close]");
    await page.waitForSelector("#connect-dialog:not([open])", { state: "attached" });

    // The connect_url the agent got opens the same dialog on a fresh page load, once the list is loaded.
    await page.goto("about:blank");
    await page.goto(`${server.base}${connectUrl.pathname}${connectUrl.hash}`);
    await expectConnectDialogForAgent(page, clientId);
    await page.click("#connect-dialog [data-close]");
    await page.waitForSelector("#connect-dialog:not([open])", { state: "attached" });

    // Deny from the card: specific confirm copy, then the card is gone and the need is denied.
    await page.goto(`${server.base}/console#inbox`);
    await page.waitForSelector("[data-testid=inbox-need-deny]");
    await page.click("[data-testid=inbox-need-deny]");
    await page.waitForSelector("#confirm[open]");
    assert.equal(await page.locator("#confirm-title").textContent(), "Deny cursor's request to connect a Spotify account?");
    await page.click("#confirm-yes");
    await page.waitForSelector("#confirm:not([open])", { state: "attached" });
    await page.waitForSelector("[data-testid=inbox-connect-need]", { state: "detached" });
    const inbox = await page.evaluate<{ needs: unknown[] }>("fetch('/api/inbox', { credentials: 'include' }).then((r) => r.json())");
    assert.deepEqual(inbox.needs, []);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await browser.close();
    await server.close();
  }
});

test("credential drawer: isolate environments, retry failures, and ignore stale responses", { skip: skipReason, timeout: SMOKE_TIMEOUT_MS * 3 }, async () => {
  const server = await bootConsoleServer();
  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signUpInBrowser(page, server, `drawer-${Date.now()}@example.com`);
    for (const environment of ["production", "staging"]) {
      await page.click("[data-testid=open-store]");
      await page.fill("#store-name", "SHARED_TOKEN");
      await page.fill("#store-value", "drawer_test_canary_1234");
      await page.fill("#store-hosts", "api.github.com");
      await page.selectOption("#store-env", environment);
      await page.click("#store-submit");
      await page.waitForSelector("#store-dialog:not([open])", { state: "attached" });
    }
    await page.waitForFunction("() => document.querySelectorAll('tr[data-item]').length === 2");
    const rows = await page.evaluate<{ id: string; environment: string }[]>("Array.from(document.querySelectorAll('tr[data-item]')).map(row => ({ id: row.dataset.item, environment: row.querySelector('.pill-env').textContent }))");
    const prod = rows.find((r) => r.environment === "production")?.id;
    const staging = rows.find((r) => r.environment === "staging")?.id;
    assert.ok(prod && staging);
    const grants = rows.map((r) => ({ id: `grant_${r.environment}`, item_id: r.id, item_name: "SHARED_TOKEN", client_name: `${r.environment} agent`, client_id: `client_${r.environment}`, status: "active", policy: "prompt" }));
    let fail = true;
    let hold = false;
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    await page.route("**/api/access", async (route) => {
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => { release = resolve; started?.(); });
      }
      await route.fulfill({ status: fail ? 503 : 200, contentType: "application/json", body: JSON.stringify(fail ? { error: "Temporarily unavailable" } : { clients: [], sessions: [], grants }) });
    });
    await page.click(`tr[data-item="${prod}"] td.name`);
    await page.waitForSelector("[data-retry-approvals]");
    assert.match((await page.locator("#drawer-approvals").textContent()) ?? "", /Temporarily unavailable/);
    assert.doesNotMatch((await page.locator("#drawer-approvals").textContent()) ?? "", /No agent has an approval/);
    fail = false;
    await page.click("[data-retry-approvals]");
    await page.waitForSelector('[data-revoke-grant="grant_production"]');
    assert.equal(await page.locator('[data-revoke-grant="grant_staging"]').count(), 0, "same-name staging approvals stay out of the production drawer");
    await page.click("[data-testid=drawer-close]");
    await page.waitForSelector("#item-drawer:not([open])", { state: "attached" });
    hold = true;
    const oldRequest = new Promise<void>((resolve) => { started = resolve; });
    await page.click(`tr[data-item="${staging}"] td.name`);
    await oldRequest;
    await page.click("[data-testid=drawer-close]");
    await page.waitForSelector("#item-drawer:not([open])", { state: "attached" });
    await page.click(`tr[data-item="${prod}"] td.name`);
    await page.waitForSelector('[data-revoke-grant="grant_production"]');
    const beforeRelease = await loads(page, "/api/access");
    release?.();
    await page.waitForFunction(`() => performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname === '/api/access').length > ${beforeRelease}`);
    assert.equal(await page.locator('[data-revoke-grant="grant_staging"]').count(), 0, "late staging response cannot overwrite the production drawer");
    assert.equal(await page.locator('[data-revoke-grant="grant_production"]').count(), 1);
    await page.click("[data-testid=drawer-close]");
    await page.waitForSelector("#item-drawer:not([open])", { state: "attached" });
    await page.fill('[data-testid="items-search"]', "does-not-exist");
    await page.waitForSelector("#items-none:not([hidden])");
    await page.click("#items-clear");
    assert.equal(await page.locator("tr[data-item]").count(), 2);
    assert.equal(await page.locator('[data-testid="items-search"]').inputValue(), "");
    let releaseItems: (() => void) | undefined;
    let itemsStarted: (() => void) | undefined;
    const waitingForItems = new Promise<void>((resolve) => { itemsStarted = resolve; });
    await page.route("**/api/items", async (route) => {
      await new Promise<void>((resolve) => { releaseItems = resolve; itemsStarted?.(); });
      await route.continue();
    });
    await page.evaluate("location.hash = '#credentials/item/itm_missing_after_navigation'");
    await waitingForItems;
    await page.click("[data-testid=nav-agents]");
    const beforeItemsRelease = await loads(page, "/api/items");
    releaseItems?.();
    await page.waitForFunction(`() => performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname === '/api/items').length > ${beforeItemsRelease}`);
    assert.match(page.url(), /#agents$/);
    assert.equal(await page.locator("#item-drawer[open]").count(), 0, "late credential lookup cannot reopen the previous route");
    await page.unroute("**/api/items");
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await browser.close();
    await server.close();
  }
});
