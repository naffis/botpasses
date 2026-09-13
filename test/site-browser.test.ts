/** Real-browser checks against the hosted router and its production CSP. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { bootConsoleServer } from "./helpers/console-boot.ts";
import { launchChromium, playwrightUnavailableReason } from "./helpers/playwright.ts";

const skip = playwrightUnavailableReason();

test("marketing: responsive navigation, approval example, clipboard recovery, docs search", { skip, timeout: 60_000 }, async () => {
  const server = await bootConsoleServer({ siteRoot: join(process.cwd(), "site/dist") });
  const browser = await launchChromium();
  try {
    for (const colorScheme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(server.base);
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate<boolean>("document.documentElement.scrollWidth > innerWidth"), false, `${colorScheme} ${width}px has no horizontal overflow`);
        assert.equal(await page.locator("#hero-title").isVisible(), true);
        assert.equal(await page.locator("[data-demo-approve]").isVisible(), true);
      }
      await page.click(".mobile-menu summary");
      assert.equal(await page.locator('.mobile-menu a[href="/docs"]').isVisible(), true);
      await page.click(".mobile-menu summary");
      await page.click("[data-demo-approve]");
      await page.waitForSelector("[data-demo-approved]:not([hidden])");
      assert.match((await page.locator("[data-demo-status]").textContent()) ?? "", /200 OK.*does not get the key/);
      assert.equal(await page.evaluate<string>("document.activeElement?.getAttribute('data-demo-reset') ?? 'missing'"), "", "keyboard focus follows the example");
      assert.equal(await page.evaluate<number>("performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname.startsWith('/api/')).length"), 0, "the example never makes a real API call");
      await page.click("[data-demo-reset]");
      assert.equal(await page.locator("[data-demo-approve]").isVisible(), true);
      await page.evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('permission denied'); } } })");
      await page.click('[data-copy-prompt="hosted"]');
      await page.waitForFunction("() => document.querySelector('[data-copy-prompt=hosted]').textContent === 'Copy unavailable'");
      assert.match((await page.locator('[data-copy-prompt="hosted"]').getAttribute("title")) ?? "", /full prompt/);
      await page.locator('.faq-list summary').first().click();
      assert.equal(await page.locator(".faq-list details[open]").count(), 1);
      await page.goto(`${server.base}/docs/start`);
      await page.waitForSelector("#docs-q");
      await page.fill("#docs-q", "credential");
      await page.waitForSelector(".pagefind-ui__result-link");
      assert.ok(await page.locator(".pagefind-ui__result-link").count() > 0);
      assert.equal(await page.evaluate<boolean>("document.documentElement.scrollWidth > innerWidth"), false, "mobile docs stay within the viewport");
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
