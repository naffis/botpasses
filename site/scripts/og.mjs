/**
 * Render site/public/og.png (1200x630) from an HTML template with the brand fonts and
 * tokens. Run after changing the wordmark, tagline, or palette, then commit the PNG.
 *
 *   node site/scripts/og.mjs [path-to-chromium]
 *
 * Playwright is resolved from the global install used in CI and dev containers; pass a
 * different `PLAYWRIGHT_PKG` env var if yours lives elsewhere.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, "..");
const repoRoot = join(siteRoot, "..");
const require = createRequire(import.meta.url);

const pwPkg = process.env.PLAYWRIGHT_PKG ?? "/opt/node22/lib/node_modules/playwright/package.json";
const pw = createRequire(pwPkg)("playwright");
const executablePath = process.argv[2] ?? process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

// Brand tokens come from the same file the site and console use.
const brand = readFileSync(join(repoRoot, "src/brand-visual.ts"), "utf8");
const hex = (key) => {
  const m = new RegExp(`${key}: "(#[0-9A-Fa-f]{6})"`).exec(brand);
  if (!m) throw new Error(`token ${key} not found in brand-visual.ts`);
  return m[1];
};
const bg = hex("bg");
const bgElev = hex("bgElev");
const fg = hex("fg");
const muted = hex("muted");
const line = hex("line");
const accent = hex("accent");

const fontFile = (pkg, file) => {
  const path = require.resolve(`@fontsource/${pkg}/files/${file}`, { paths: [siteRoot] });
  return `data:font/woff2;base64,${readFileSync(path).toString("base64")}`;
};
const fraunces = fontFile("fraunces", "fraunces-latin-700-normal.woff2");
const plex = fontFile("ibm-plex-sans", "ibm-plex-sans-latin-400-normal.woff2");
const mono = fontFile("ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2");

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @font-face { font-family: Fraunces; font-weight: 700; src: url(${fraunces}) format("woff2"); }
  @font-face { font-family: "IBM Plex Sans"; font-weight: 400; src: url(${plex}) format("woff2"); }
  @font-face { font-family: "IBM Plex Mono"; font-weight: 400; src: url(${mono}) format("woff2"); }
  html, body { margin: 0; width: 1200px; height: 630px; background: ${bg}; color: ${fg}; font-family: "IBM Plex Sans", sans-serif; }
  .card { position: absolute; inset: 0; padding: 64px 80px 96px; display: flex; flex-direction: column; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 18px; font-family: Fraunces, serif; font-weight: 700; font-size: 40px; letter-spacing: -0.01em; }
  .brand svg { width: 56px; height: 56px; }
  h1 { font-family: Fraunces, serif; font-weight: 700; font-size: 62px; line-height: 1.08; margin: 0; letter-spacing: -0.015em; max-width: 1040px; }
  h1 span { color: ${accent}; }
  .bottom { display: flex; align-items: flex-end; justify-content: space-between; gap: 40px; }
  .tag { font-size: 26px; color: ${muted}; max-width: 620px; line-height: 1.35; }
  .chip { font-family: "IBM Plex Mono", monospace; font-size: 24px; color: ${fg}; background: ${bgElev}; border: 2px solid ${line}; border-radius: 12px; padding: 16px 22px; white-space: nowrap; }
  .chip b { color: ${accent}; font-weight: 400; }
  .rule { position: absolute; left: 80px; right: 80px; bottom: 56px; height: 4px; background: linear-gradient(90deg, ${accent}, transparent); border-radius: 2px; }
</style></head>
<body>
  <div class="card">
    <div class="brand">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="3" fill="${accent}"/><circle cx="8" cy="12" r="1.6" fill="${bg}"/><path d="M12 9h7v2h-7V9zm0 4h5v2h-5v-2z" fill="${bg}"/></svg>
      Botpasses
    </div>
    <h1>Your agent can call Stripe.<br><span>It never gets the key.</span></h1>
    <div class="bottom">
      <div class="tag">Store an API key once. Your agent calls the API through Botpasses over MCP. The key never enters the chat, the model, or the logs.</div>
      <div class="chip">STRIPE_SECRET_KEY <b>••••4k2p</b></div>
    </div>
  </div>
  <div class="rule"></div>
</body></html>`;

const browser = await pw.chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const out = join(siteRoot, "public/og.png");
  await page.screenshot({ path: out, type: "png", clip: { x: 0, y: 0, width: 1200, height: 630 } });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
