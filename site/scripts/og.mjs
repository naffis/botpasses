/**
 * Render social cards into site/public from the brand tokens and the product
 * tagline. Run after changing the wordmark, tagline, or palette, then commit
 * the PNGs. Astro copies public/ into dist.
 *
 *   npm --prefix site run og -- [path-to-chromium]
 *
 * Writes:
 *   og.png        1200x630  Open Graph / X large card
 *   og-square.png 1200x1200 LinkedIn, Slack, iMessage, WhatsApp square slot
 *
 * Playwright is resolved from a project install, `npm root -g`, or the container
 * paths CI uses. Override with `PLAYWRIGHT_PKG` / `BOTPASSES_PLAYWRIGHT_PKG` and
 * `CHROMIUM_PATH` / `BOTPASSES_CHROMIUM`, or pass a Chromium binary as argv[2].
 */
import { BRAND_HEX } from "../../src/brand-visual.ts";
import { PRODUCT_TAGLINE } from "../src/lib/site-meta.ts";
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

const { bg, bgElev, fg, muted, line, accent } = BRAND_HEX;
const [lead, punch] = PRODUCT_TAGLINE.split(/(?<=\.)\s+/);
if (!lead || !punch) throw new Error("PRODUCT_TAGLINE must have two sentences");

const fontFile = (pkg, file) => {
  const path = require.resolve(`@fontsource/${pkg}/files/${file}`, { paths: [siteRoot] });
  return `data:font/woff2;base64,${readFileSync(path).toString("base64")}`;
};
const inter400 = fontFile("inter", "inter-latin-400-normal.woff2");
const inter600 = fontFile("inter", "inter-latin-600-normal.woff2");
const inter700 = fontFile("inter", "inter-latin-700-normal.woff2");
const mono = fontFile("ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2");

// Embed the complete SVG as an image. Removing every width/height attribute also
// removed the mask rectangle, and repeated inline mask IDs collide within one card.
const markImage = `<img alt="" src="data:image/svg+xml;base64,${readFileSync(join(repoRoot, "src/brand-assets/mark-on-dark.svg")).toString("base64")}">`;

const faces = `
  @font-face { font-family: Inter; font-weight: 400; src: url(${inter400}) format("woff2"); }
  @font-face { font-family: Inter; font-weight: 600; src: url(${inter600}) format("woff2"); }
  @font-face { font-family: Inter; font-weight: 700; src: url(${inter700}) format("woff2"); }
  @font-face { font-family: "IBM Plex Mono"; font-weight: 400; src: url(${mono}) format("woff2"); }
`;

const shared = `
  ${faces}
  * { box-sizing: border-box; }
  html, body { margin: 0; background: ${bg}; color: ${fg}; font-family: Inter, sans-serif; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 32px; font-weight: 700; letter-spacing: -.04em; }
  .brand img { width: 42px; height: 42px; }
  h1 { font-size: 76px; line-height: 1.06; font-weight: 700; letter-spacing: -.065em; margin: 36px 0 26px; }
  h1 span { color: ${accent}; }
  .description { font-size: 22px; line-height: 1.6; color: ${muted}; max-width: 580px; }
  .foot { position: absolute; bottom: 42px; left: 64px; right: 64px; display: flex; justify-content: space-between; padding-top: 22px; border-top: 1px solid ${line}; color: ${muted}; font-size: 16px; }
  .ticket { background: ${bgElev}; border: 1px solid ${line}; border-radius: 20px; padding: 30px; }
  .ticket img { width: 64px; height: 64px; }
  .ticket .label { font: 13px "IBM Plex Mono"; color: ${muted}; letter-spacing: .06em; margin: 28px 0 12px; }
  .ticket .name { font: 18px "IBM Plex Mono"; margin: 0; }
  .ticket .masked { font: 22px "IBM Plex Mono"; color: ${muted}; padding-bottom: 25px; border-bottom: 1px dashed ${line}; }
  .ticket .approved { font-size: 16px; color: ${accent}; margin: 24px 0 0; }
`;
const ticket = `<div class="ticket">${markImage}<p class="label">YOUR CREDENTIAL</p><p class="name">GITHUB_TOKEN</p><p class="masked">•••• •••• 4k2p</p><p class="approved">✓ Approved access. Private keys.</p></div>`;
const landscape = `<!doctype html><html><head><meta charset="utf-8"><style>
  ${shared}
  html, body { width: 1200px; height: 630px; }
  .card { padding: 56px 64px; }
  .content { display: grid; grid-template-columns: 1fr 340px; gap: 48px; align-items: center; }
  .ticket { transform: rotate(-4deg); margin-top: 28px; }
</style></head><body><div class="card"><div class="brand">${markImage} botpasses</div><div class="content"><div><h1>${lead}<br><span>${punch}</span></h1><p class="description">Give AI agents access to your APIs.<br>Keep secrets out of the conversation.</p></div>${ticket}</div><div class="foot"><span>Open source · MCP · Free while in beta</span><span>botpasses.com ↗</span></div></div></body></html>`;
const square = `<!doctype html><html><head><meta charset="utf-8"><style>
  ${shared}
  html, body { width: 1200px; height: 1200px; }
  .card { padding: 70px 80px; }
  h1 { font-size: 106px; margin-top: 68px; }
  .description { font-size: 28px; max-width: 900px; }
  .ticket { width: 880px; margin: 50px auto; display: grid; grid-template-columns: 80px 1fr 1fr; align-items: center; gap: 20px; padding: 38px; }
  .ticket .label { grid-column: 2 / -1; margin: 0; }
  .ticket img { grid-row: 1 / 4; }
  .ticket .name { grid-column: 2; }
  .ticket .masked { grid-column: 3; padding: 0; border: 0; margin: 0; }
  .ticket .approved { grid-column: 2 / -1; margin: 0; }
  .foot { bottom: 64px; left: 80px; right: 80px; font-size: 21px; }
</style></head><body><div class="card"><div class="brand">${markImage} botpasses</div><h1>${lead}<br><span>${punch}</span></h1><p class="description">Give AI agents access to your APIs.<br>Keep secrets out of the conversation.</p>${ticket}<div class="foot"><span>Open source · MCP · Free while in beta</span><span>botpasses.com ↗</span></div></div></body></html>`;

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
