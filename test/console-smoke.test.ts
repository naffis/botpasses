/**
 * Browser smoke test for the operator console: sign up, enroll TOTP, store a credential,
 * issue a token, request a grant over MCP, approve from the Inbox, revoke from Agents,
 * sign out. Also checks Cancel closes dialogs and the Actions column is visible at 1280
 * and 390 px. Skips with a reason when the preinstalled Chromium is absent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as OTPAuth from "otpauth";
import { bootConsoleServer } from "./helpers/console-boot.ts";
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

test("console smoke: sign up, store, connect, approve, revoke, sign out at 1280 and 390", { skip: skipReason, timeout: SMOKE_TIMEOUT_MS }, async () => {
  const server = await bootConsoleServer();
  const browser = await launchChromium();
  const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const email = `smoke-${Date.now()}@example.com`;

    // Sign up with email OTP
    await page.goto(`${server.base}/sign-up`);
    await page.fill("input[name=email]", email);
    await page.locator("input[name=email]").first().press("Enter");
    await page.waitForSelector("input[name=otp]", { state: "visible" });
    await page.waitForFunction("() => true");
    const otp = server.otpFor(email);
    assert.match(otp, /^\d{8}$/, "otp captured from mailbox");
    await page.fill("input[name=otp]", otp);
    await page.locator("input[name=otp]").press("Enter");

    // Enroll TOTP
    await page.waitForURL(/\/enroll-totp/);
    await page.waitForFunction("() => (document.getElementById('otpauth')?.textContent || '').startsWith('otpauth://')");
    const otpauth = (await page.locator("#otpauth").textContent()) ?? "";
    const totp = OTPAuth.URI.parse(otpauth.trim());
    await page.fill("input[name=code]", totp.generate());
    await page.locator("input[name=code]").press("Enter");
    try {
      await page.waitForURL(/\/console/, { timeout: 4000 });
    } catch {
      // A backup-codes step with an explicit Continue may sit between enroll and the console.
      await page.locator("button:has-text('Continue'), a:has-text('Continue'), button:has-text('saved')").first().click();
      await page.waitForURL(/\/console/);
    }

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
    await page.click("[data-testid=drawer-close]");
    await page.waitForSelector("#item-drawer:not([open])", { state: "attached" });

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
