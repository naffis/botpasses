import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BRAND_FONTS,
  BRAND_HEX,
  BRAND_OKLCH,
  MARK_SIZE,
  contrastRatio,
  cssVariables,
  hexToRgb,
} from "../src/brand-visual.ts";

test("hex tokens match the locked palette", () => {
  assert.equal(BRAND_HEX.bg, "#0B0F0C");
  assert.equal(BRAND_HEX.bgElev, "#151C17");
  assert.equal(BRAND_HEX.fg, "#F2F5F2");
  assert.equal(BRAND_HEX.muted, "#C5D0C7");
  assert.equal(BRAND_HEX.line, "#2A332C");
  assert.equal(BRAND_HEX.accent, "#7DDA88");
  assert.equal(BRAND_HEX.accentDim, "#244024");
  assert.equal(BRAND_HEX.danger, "#E07070");
});

test("text on background meets WCAG 2.2 AA (4.5:1)", () => {
  assert.ok(contrastRatio(BRAND_HEX.fg, BRAND_HEX.bg) >= 4.5);
  assert.ok(contrastRatio(BRAND_HEX.muted, BRAND_HEX.bg) >= 4.5);
  assert.ok(contrastRatio(BRAND_HEX.fg, BRAND_HEX.bgElev) >= 4.5);
  assert.ok(contrastRatio(BRAND_HEX.danger, BRAND_HEX.bg) >= 4.5);
});

test("accent on background meets large-text AA (3:1)", () => {
  assert.ok(contrastRatio(BRAND_HEX.accent, BRAND_HEX.bg) >= 3);
});

test("css variables emit hex and oklch twins", () => {
  const css = cssVariables();
  assert.match(css, /--bg: #0B0F0C;/);
  assert.match(css, /--bg-oklch: oklch\(/);
  assert.match(css, new RegExp(BRAND_OKLCH.accent.replace("(", "\\(").replace(")", "\\)")));
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
