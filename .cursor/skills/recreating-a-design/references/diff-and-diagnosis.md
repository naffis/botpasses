# Measuring the difference, reading it, and knowing what to fix

## A minimal measurement harness (when the project has none)

Two screenshots at the same viewport + a pixel diff. ~10 minutes to set up:

```bash
mkdir -p /tmp/fidelity && cd /tmp/fidelity
npm init -y >/dev/null && npm i playwright pixelmatch pngjs >/dev/null
```

`capture.mjs` — screenshot a URL at a fixed viewport
(`node capture.mjs <url> <out.png> [width] [height]`):

```js
import { chromium } from "playwright";
const [, , url, out, w = "1440", h = "2400"] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
await page.goto(url, { waitUntil: "networkidle" });
await page.screenshot({ path: out, fullPage: true });
await browser.close();
```

`diff.mjs` — overlay + mismatch score
(`node diff.mjs target.png render.png overlay.png`):

```js
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { readFileSync, writeFileSync } from "node:fs";

const [a, b] = [process.argv[2], process.argv[3]].map((p) => PNG.sync.read(readFileSync(p)));
const width = Math.min(a.width, b.width);
const height = Math.min(a.height, b.height);
const crop = (img) => {
  const out = new PNG({ width, height });
  PNG.bitblt(img, out, 0, 0, width, height, 0, 0);
  return out;
};
const [ca, cb] = [crop(a), crop(b)];
const overlay = new PNG({ width, height });
const bad = pixelmatch(ca.data, cb.data, overlay.data, width, height, { threshold: 0.1 });
writeFileSync(process.argv[4] ?? "overlay.png", PNG.sync.write(overlay));
console.log(`mismatch=${((bad / (width * height)) * 100).toFixed(2)}% (${bad} px)`);
if (a.height !== b.height) console.log(`height differs: target=${a.height} render=${b.height} (missing/extra content)`);
```

Alternatives: ImageMagick `compare -metric SSIM target.png render.png overlay.png`
(if installed); a project's own fidelity/eval command always wins over this.

Rules of measurement:

- **Same viewport, fresh build, full page** every round. A cached render or a partial
  screenshot invalidates the comparison.
- Track the *trajectory*, not just the last number. Keep every round's score and
  overlay; keep the best-scoring version of the code.
- A big height mismatch means missing or extra content — fix that before chasing
  pixel-level polish.

## Reading the difference overlay

Bright = deviation, black/dark = match. The *shape* of the brightness tells you the
defect class:

| Overlay symptom | Meaning |
| --- | --- |
| Bright solid block where the target has content | **missing element** — the render didn't draw it |
| Bright block where the target is blank | **extra element** — remove or hide it |
| Bright edges / ghosting around text or shapes | right element, **wrong position/size/spacing** (a few px off) |
| Uniform color wash over a region | **wrong color/palette** (background, text, or accent hue off) |
| Doubled / haloed glyphs | **wrong font family, weight, size, or letter-spacing** |
| Everything below a point shifted | one section's **height/spacing** is off — fix it and everything below realigns |
| Faint noise everywhere, no hotspot | **cumulative drift** — global type scale, container width, or vertical rhythm slightly off |

Fix order: missing/extra content → section-level geometry (the shift cascades) → palette
→ typography → pixel polish. Killing the biggest bright region first usually collapses
several smaller ones.

## Symptom → where to fix

Generalized; map to the project's actual structure:

| Symptom | Likely fix location |
| --- | --- |
| whole-page color wash | design tokens / theme variables, not per-element styles |
| headline/body ghosting | global font stack and type scale first; per-element classes second |
| block missing | the page/section source; if generated, the structured tree/spec the generator emitted |
| section shifted | that section's padding/margin/gap; check band geometry before nudging children |
| image area bright or garbled | the asset itself (failed cutout, wrong crop) or the `<img>` sizing |
| mobile overflow/overlap | the section's flex/grid + responsive prefixes; never fix with fixed pixel widths |

## Judgment beyond pixels

The pixel diff can't see everything; each round also sanity-check:

- **Semantics survived** — headings are headings, lists are lists, links go somewhere.
  A perfect-scoring screenshot of div soup is a fail.
- **Interactivity** — hover/focus states exist where the target implies them.
- **The in-between width** (~1000–1100px) — layouts that match at desktop and mobile
  often break between breakpoints.
