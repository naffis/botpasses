import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BRAND_FONTS,
  BRAND_HEX,
  BRAND_HEX_LIGHT,
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
  assert.equal(BRAND_HEX.bg, "#0B0F0C");
  assert.equal(BRAND_HEX.bgElev, "#151C17");
  assert.equal(BRAND_HEX.fg, "#F2F5F2");
  assert.equal(BRAND_HEX.muted, "#C5D0C7");
  assert.equal(BRAND_HEX.line, "#2A332C");
  assert.equal(BRAND_HEX.accent, "#7DDA88");
  assert.equal(BRAND_HEX.accentDim, "#244024");
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
  assert.match(css, /^:root \{\n  color-scheme: light dark;\n  --bg: #F4F7F4;/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme="light"\]\) \{\n {4}--bg: #0B0F0C;/);
  assert.match(css, /:root\[data-theme="dark"\] \{\n  --bg: #0B0F0C;/);
  assert.doesNotMatch(css, /oklch/);
  for (const name of Object.values(CSS_VAR_NAMES)) {
    assert.equal(css.split(`${name}:`).length - 1, 3, `${name} defined in all three blocks`);
  }
  assert.match(cssTokenLines("dark"), /--warn: #E9B857;/);
  assert.match(cssTokenLines("light"), /--warn: #8A5A00;/);
  assert.match(cssTokenLines("dark"), /--accent-fg: #0B0F0C;/);
});

test("self-hosted typefaces are named", () => {
  assert.equal(BRAND_FONTS.display, "Fraunces");
  assert.equal(BRAND_FONTS.body, "IBM Plex Sans");
  assert.equal(BRAND_FONTS.mono, "IBM Plex Mono");
});

test("mark SVG is 24x24 ticket shape", () => {
  const svg = readFileSync(join(process.cwd(), "src/brand-assets/mark.svg"), "utf8");
  assert.match(svg, /width="24"/);
  assert.match(svg, /height="24"/);
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.equal(MARK_SIZE, 24);
  const { r, g, b } = hexToRgb(BRAND_HEX.accent);
  assert.equal(r, 125);
  assert.equal(g, 218);
  assert.equal(b, 136);
});
