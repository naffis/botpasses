/** Invented dark visual tokens. Hex is the test source of truth. CSS also emits oklch twins. */

export const BRAND_HEX = {
  bg: "#0B0F0C",
  bgElev: "#151C17",
  fg: "#F2F5F2",
  muted: "#C5D0C7",
  line: "#2A332C",
  accent: "#7DDA88",
  accentDim: "#244024",
  danger: "#E07070",
} as const;

export const BRAND_OKLCH = {
  bg: "oklch(13.2% 0.012 145)",
  bgElev: "oklch(18.4% 0.014 145)",
  fg: "oklch(96.1% 0.005 145)",
  muted: "oklch(82.4% 0.016 145)",
  line: "oklch(27.6% 0.014 145)",
  accent: "oklch(82.1% 0.142 145)",
  accentDim: "oklch(30.2% 0.058 145)",
  danger: "oklch(67.8% 0.142 25)",
} as const;

export const BRAND_FONTS = {
  display: "Fraunces",
  body: "IBM Plex Sans",
  mono: "IBM Plex Mono",
} as const;

export const MARK_SIZE = 24;

export type BrandHexKey = keyof typeof BRAND_HEX;

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#([0-9A-Fa-f]{6})$/.exec(hex);
  if (!m?.[1]) throw new Error(`Invalid hex: ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function srgbChannel(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

export function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function cssVariables(): string {
  return [
    `--bg: ${BRAND_HEX.bg};`,
    `--bg-oklch: ${BRAND_OKLCH.bg};`,
    `--bg-elev: ${BRAND_HEX.bgElev};`,
    `--bg-elev-oklch: ${BRAND_OKLCH.bgElev};`,
    `--fg: ${BRAND_HEX.fg};`,
    `--fg-oklch: ${BRAND_OKLCH.fg};`,
    `--muted: ${BRAND_HEX.muted};`,
    `--muted-oklch: ${BRAND_OKLCH.muted};`,
    `--line: ${BRAND_HEX.line};`,
    `--line-oklch: ${BRAND_OKLCH.line};`,
    `--accent: ${BRAND_HEX.accent};`,
    `--accent-oklch: ${BRAND_OKLCH.accent};`,
    `--accent-dim: ${BRAND_HEX.accentDim};`,
    `--accent-dim-oklch: ${BRAND_OKLCH.accentDim};`,
    `--danger: ${BRAND_HEX.danger};`,
    `--danger-oklch: ${BRAND_OKLCH.danger};`,
  ].join("\n  ");
}
