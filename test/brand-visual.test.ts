import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BRAND_FONTS,
  BRAND_HEX,
  BRAND_HEX_LIGHT,
  BRAND_NAVY,
  BRAND_TEAL,
  BRAND_THEMES,
  CONTRAST_PAIRS,
  CSS_VAR_NAMES,
  MARK_SIZE,
  contrastRatio,
  cssTokenLines,
  cssVariables,
  hexToRgb,
} from "../src/brand-visual.ts";

test("dark hex tokens match the locked palette", () => {
  assert.equal(BRAND_NAVY, "#14213D");
  assert.equal(BRAND_TEAL, "#00C2A8");
  assert.equal(BRAND_HEX.bg, "#0B1020");
  assert.equal(BRAND_HEX.bgElev, BRAND_NAVY);
  assert.equal(BRAND_HEX.fg, "#F4F6FA");
  assert.equal(BRAND_HEX.muted, "#B4BDD0");
  assert.equal(BRAND_HEX.line, "#2C3A58");
  assert.equal(BRAND_HEX.accent, BRAND_TEAL);
  assert.equal(BRAND_HEX.accentDim, "#123D38");
  assert.equal(BRAND_HEX.danger, "#E07070");
});

test("every theme keeps text-on-surface pairs at WCAG 2.2 AA (4.5:1)", () => {
  for (const [theme, palette] of Object.entries(BRAND_THEMES)) {
    for (const [fg, bg] of CONTRAST_PAIRS) {
      const ratio = contrastRatio(palette[fg], palette[bg]);
      assert.ok(ratio >= 4.5, `${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("warn, info, ok, and danger are distinct hues from the accent in both themes", () => {
  for (const palette of Object.values(BRAND_THEMES)) {
    const set = new Set([palette.accent, palette.warn, palette.info, palette.ok, palette.danger]);
    assert.equal(set.size, 5);
    assert.notEqual(palette.okDim, palette.accentDim, "success surface must not reuse the action surface");
  }
});

test("light theme is light and dark theme is dark", () => {
  assert.ok(contrastRatio("#FFFFFF", BRAND_HEX_LIGHT.bg) < 1.2);
  assert.ok(contrastRatio("#000000", BRAND_HEX.bg) < 1.2);
});

test("css variables emit light on :root and dark under both guards", () => {
  const css = cssVariables();
  assert.match(css, /^:root \{\n {2}color-scheme: light dark;\n {2}--bg: #F4F6FA;/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-theme="light"\]\) \{\n {4}--bg: #0B1020;/);
  assert.match(css, /:root\[data-theme="dark"\] \{\n {2}--bg: #0B1020;/);
  assert.doesNotMatch(css, /oklch/);
  for (const name of Object.values(CSS_VAR_NAMES)) {
    assert.equal(css.split(`${name}:`).length - 1, 3, `${name} defined in all three blocks`);
  }
  assert.match(cssTokenLines("dark"), /--warn: #E9B857;/);
  assert.match(cssTokenLines("light"), /--warn: #8A5A00;/);
  assert.match(cssTokenLines("dark"), /--accent-fg: #0B1020;/);
});

test("self-hosted typefaces are named", () => {
  assert.equal(BRAND_FONTS.display, "Inter");
  assert.equal(BRAND_FONTS.body, "Inter");
  assert.equal(BRAND_FONTS.mono, "IBM Plex Mono");
  assert.equal(BRAND_FONTS.stack, "Inter, Helvetica, Arial, sans-serif");
});

test("mark SVG is the ticket bot on navy", () => {
  const svg = readFileSync(join(process.cwd(), "src/brand-assets/mark.svg"), "utf8");
  assert.match(svg, /width="32"/);
  assert.match(svg, /height="32"/);
  assert.match(svg, /viewBox="0 0 32 32"/);
  assert.match(svg, /#14213D/);
  assert.match(svg, /#00C2A8/);
  assert.match(svg, /mask id="ticket"/);
  assert.equal(MARK_SIZE, 32);
  const navy = hexToRgb(BRAND_NAVY);
  assert.equal(navy.r, 20);
  assert.equal(navy.g, 33);
  assert.equal(navy.b, 61);
  const teal = hexToRgb(BRAND_TEAL);
  assert.equal(teal.r, 0);
  assert.equal(teal.g, 194);
  assert.equal(teal.b, 168);
});

test("on-dark mark is the white ticket", () => {
  const svg = readFileSync(join(process.cwd(), "src/brand-assets/mark-on-dark.svg"), "utf8");
  assert.match(svg, /#F4F6FA/);
  assert.match(svg, /#00C2A8/);
  assert.match(svg, /#14213D/);
  assert.match(svg, /mask id="ticket-on-dark"/);
});

test("favicon SVG is the simplified navy tile, not the ticket silhouette", () => {
  const svg = readFileSync(join(process.cwd(), "src/brand-assets/favicon.svg"), "utf8");
  assert.match(svg, /#14213D/);
  assert.match(svg, /#00C2A8/);
  assert.doesNotMatch(svg, /mask id="ticket"/);
});

test("official source rasters are stored", () => {
  const dir = join(process.cwd(), "src/brand-assets/source");
  for (const name of [
    "favicon-512.png",
    "favicon.png",
    "mark-color.png",
    "mark-mono-white.png",
    "mark-mono-black.png",
    "lockup-color.png",
    "lockup-color-2x.png",
    "lockup-color-on-dark.png",
    "lockup-mono-white.png",
    "lockup-mono-black.png",
  ]) {
    assert.equal(existsSync(join(dir, name)), true, name);
  }
});
