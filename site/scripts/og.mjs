/**
 * Render social cards into site/public from the brand tokens and the product
 * tagline. Run after changing the wordmark, tagline, or palette, then commit
 * the PNGs. Astro copies public/ into dist.
 *
 *   node site/scripts/og.mjs [path-to-chromium]
 *
 * Writes:
 *   og.png        1200x630  Open Graph / X large card
 *   og-square.png 1200x1200 LinkedIn, Slack, iMessage, WhatsApp square slot
 *
 * Playwright is resolved from a project install, `npm root -g`, or the container
 * paths CI uses. Override with `PLAYWRIGHT_PKG` / `BOTPASSES_PLAYWRIGHT_PKG` and
 * `CHROMIUM_PATH` / `BOTPASSES_CHROMIUM`, or pass a Chromium binary as argv[2].
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, "..");
const repoRoot = join(siteRoot, "..");
const require = createRequire(import.meta.url);

function npmGlobalPlaywrightPkg() {
  const root = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
  if (!root) return undefined;
  const pkg = join(root, "playwright/package.json");
  return existsSync(pkg) ? pkg : undefined;
}

function resolvePlaywrightPkg() {
  const env = process.env.PLAYWRIGHT_PKG ?? process.env.BOTPASSES_PLAYWRIGHT_PKG;
  if (env && existsSync(env)) return env;
  try {
    return createRequire(join(repoRoot, "package.json")).resolve("playwright/package.json");
  } catch {
    // Not a project dependency.
  }
  const candidates = [
    npmGlobalPlaywrightPkg(),
    "/opt/node22/lib/node_modules/playwright/package.json",
    "/usr/local/lib/node_modules/playwright/package.json",
    "/usr/lib/node_modules/playwright/package.json",
  ];
  const found = candidates.find((p) => typeof p === "string" && existsSync(p));
  if (!found) {
    throw new Error("Playwright not installed (npm i -g playwright, or set PLAYWRIGHT_PKG)");
  }
  return found;
}

const pw = createRequire(resolvePlaywrightPkg())("playwright");
const pinnedChromium =
  process.argv[2] ?? process.env.CHROMIUM_PATH ?? process.env.BOTPASSES_CHROMIUM ?? "/opt/pw-browsers/chromium";
const executablePath = existsSync(pinnedChromium) ? pinnedChromium : pw.chromium.executablePath();

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

const metaSrc = readFileSync(join(siteRoot, "src/lib/site-meta.ts"), "utf8");
const tagline = /export const PRODUCT_TAGLINE = "([^"]+)"/.exec(metaSrc)?.[1];
if (!tagline) throw new Error("PRODUCT_TAGLINE not found in site-meta.ts");
const [lead, punch] = tagline.split(/(?<=\.)\s+/);
if (!lead || !punch) throw new Error(`PRODUCT_TAGLINE must be two sentences: ${tagline}`);
const leadVerb = "Your agent can call";
if (!lead.startsWith(leadVerb)) throw new Error(`PRODUCT_TAGLINE lead must start with "${leadVerb}"`);
const leadNames = lead.slice(leadVerb.length).trim();

const fontFile = (pkg, file) => {
  const path = require.resolve(`@fontsource/${pkg}/files/${file}`, { paths: [siteRoot] });
  return `data:font/woff2;base64,${readFileSync(path).toString("base64")}`;
};
const inter400 = fontFile("inter", "inter-latin-400-normal.woff2");
const inter600 = fontFile("inter", "inter-latin-600-normal.woff2");
const inter700 = fontFile("inter", "inter-latin-700-normal.woff2");
const mono = fontFile("ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2");

const markSvg = readFileSync(join(repoRoot, "src/brand-assets/mark-on-dark.svg"), "utf8").replace(
  /\s+(width|height)="32"/g,
  "",
);

const faces = `
  @font-face { font-family: Inter; font-weight: 400; src: url(${inter400}) format("woff2"); }
  @font-face { font-family: Inter; font-weight: 600; src: url(${inter600}) format("woff2"); }
  @font-face { font-family: Inter; font-weight: 700; src: url(${inter700}) format("woff2"); }
  @font-face { font-family: "IBM Plex Mono"; font-weight: 400; src: url(${mono}) format("woff2"); }
`;

const landscape = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  ${faces}
  html, body { margin: 0; width: 1200px; height: 630px; background: ${bg}; color: ${fg}; font-family: Inter, Helvetica, Arial, sans-serif; }
  .card { position: absolute; inset: 0; padding: 64px 80px 88px; display: flex; flex-direction: column; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 16px; font-family: Inter, Helvetica, Arial, sans-serif; font-weight: 700; font-size: 36px; letter-spacing: -0.03em; }
  .brand svg { width: 52px; height: 52px; }
  h1 { font-family: Inter, Helvetica, Arial, sans-serif; font-weight: 700; font-size: 54px; line-height: 1.12; margin: 0; letter-spacing: -0.03em; max-width: 1040px; }
  h1 .punch { color: ${accent}; }
  .bottom { display: flex; align-items: flex-end; justify-content: space-between; gap: 36px; }
  .tag { font-size: 22px; color: ${muted}; max-width: 640px; line-height: 1.4; font-weight: 400; }
  .chip { font-family: "IBM Plex Mono", monospace; font-size: 22px; color: ${fg}; background: ${bgElev}; border: 2px solid ${line}; border-radius: 12px; padding: 14px 20px; white-space: nowrap; }
  .chip b { color: ${accent}; font-weight: 400; }
  .rule { position: absolute; left: 80px; right: 80px; bottom: 48px; height: 4px; background: linear-gradient(90deg, ${accent}, transparent); border-radius: 2px; }
</style></head>
<body>
  <div class="card">
    <div class="brand">${markSvg} botpasses</div>
    <h1>${leadVerb}<br>${leadNames}<br><span class="punch">${punch}</span></h1>
    <div class="bottom">
      <div class="tag">Store an API key once. Your agent calls the API through Botpasses. The key never enters the chat, the model, or the logs.</div>
      <div class="chip">STRIPE_SECRET_KEY <b>••••4k2p</b></div>
    </div>
  </div>
  <div class="rule"></div>
</body></html>`;

const square = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  ${faces}
  html, body { margin: 0; width: 1200px; height: 1200px; background: ${bg}; color: ${fg}; font-family: Inter, Helvetica, Arial, sans-serif; }
  .card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 80px; }
  .mark { width: 196px; height: 196px; margin-bottom: 48px; }
  .mark svg { width: 196px; height: 196px; }
  .name { font-family: Inter, Helvetica, Arial, sans-serif; font-weight: 700; font-size: 72px; letter-spacing: -0.03em; margin: 0 0 28px; }
  .punch { font-family: Inter, Helvetica, Arial, sans-serif; font-weight: 700; font-size: 40px; line-height: 1.25; color: ${accent}; margin: 0 0 56px; max-width: 900px; }
  .host { font-size: 28px; color: ${muted}; font-weight: 600; letter-spacing: 0.02em; }
  .rule { position: absolute; left: 160px; right: 160px; bottom: 80px; height: 4px; background: linear-gradient(90deg, transparent, ${accent}, transparent); border-radius: 2px; }
</style></head>
<body>
  <div class="card">
    <div class="mark">${markSvg}</div>
    <p class="name">botpasses</p>
    <p class="punch">${punch}</p>
    <p class="host">botpasses.com</p>
  </div>
  <div class="rule"></div>
</body></html>`;

const browser = await pw.chromium.launch({ executablePath, headless: true });
try {
  async function shot(html, width, height, file) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const out = join(siteRoot, "public", file);
    await page.screenshot({ path: out, type: "png", clip: { x: 0, y: 0, width, height } });
    await page.close();
    console.log(`wrote ${out}`);
  }
  await shot(landscape, 1200, 630, "og.png");
  await shot(square, 1200, 1200, "og-square.png");
} finally {
  await browser.close();
}
