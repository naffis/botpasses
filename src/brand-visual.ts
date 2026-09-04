/**
 * Visual tokens. Hex is the test source of truth for both themes.
 * Dark is the brand default; light follows `prefers-color-scheme` or `data-theme="light"`.
 * Roles: `accent` is for actions only. `ok` is a success surface, `warn` is pending or
 * once-shown state, `info` is neutral guidance, `danger` is destructive.
 */

export type BrandTheme = "dark" | "light";

export type BrandPalette = {
  bg: string;
  bgElev: string;
  fg: string;
  muted: string;
  line: string;
  accent: string;
  accentFg: string;
  accentDim: string;
  danger: string;
  dangerDim: string;
  warn: string;
  warnDim: string;
  info: string;
  infoDim: string;
  ok: string;
  okDim: string;
};

export const BRAND_HEX: BrandPalette = {
  bg: "#0B0F0C",
  bgElev: "#151C17",
  fg: "#F2F5F2",
  muted: "#C5D0C7",
  line: "#2A332C",
  accent: "#7DDA88",
  accentFg: "#0B0F0C",
  accentDim: "#244024",
  danger: "#E07070",
  dangerDim: "#3A1C1C",
  warn: "#E9B857",
  warnDim: "#3A2E12",
  info: "#8CC4EE",
  infoDim: "#17303F",
  ok: "#A6E4AD",
  okDim: "#17331E",
};

export const BRAND_HEX_LIGHT: BrandPalette = {
  bg: "#F4F7F4",
  bgElev: "#FFFFFF",
  fg: "#121A14",
  muted: "#4B5A4F",
  line: "#D3DCD5",
  accent: "#1F7A34",
  accentFg: "#FFFFFF",
  accentDim: "#DDF2E0",
  danger: "#B3261E",
  dangerDim: "#FBE3E1",
  warn: "#8A5A00",
  warnDim: "#FBEFD3",
  info: "#1B5E8F",
  infoDim: "#DDEBF7",
  ok: "#1B6B2C",
  okDim: "#E1F3E4",
};

export const BRAND_THEMES: Record<BrandTheme, BrandPalette> = {
  dark: BRAND_HEX,
  light: BRAND_HEX_LIGHT,
};

export const BRAND_FONTS = {
  display: "Fraunces",
  body: "IBM Plex Sans",
  mono: "IBM Plex Mono",
} as const;

export const MARK_SIZE = 24;

export type BrandHexKey = keyof BrandPalette;

/** CSS custom property name for each palette key. */
export const CSS_VAR_NAMES: Record<BrandHexKey, string> = {
  bg: "--bg",
  bgElev: "--bg-elev",
  fg: "--fg",
  muted: "--muted",
  line: "--line",
  accent: "--accent",
  accentFg: "--accent-fg",
  accentDim: "--accent-dim",
  danger: "--danger",
  dangerDim: "--danger-dim",
  warn: "--warn",
  warnDim: "--warn-dim",
  info: "--info",
  infoDim: "--info-dim",
  ok: "--ok",
  okDim: "--ok-dim",
};

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

/** Text-on-surface pairs every theme must keep at WCAG AA (4.5:1). */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [BrandHexKey, BrandHexKey]> = [
  ["fg", "bg"],
  ["fg", "bgElev"],
  ["muted", "bg"],
  ["muted", "bgElev"],
  ["danger", "bg"],
  ["danger", "bgElev"],
  ["danger", "dangerDim"],
  ["accentFg", "accent"],
  ["accent", "bg"],
  ["warn", "bg"],
  ["warn", "warnDim"],
  ["info", "bg"],
  ["info", "infoDim"],
  ["ok", "bg"],
  ["ok", "okDim"],
  ["fg", "accentDim"],
];

/** `--name: #hex;` lines for one theme, indented for a rule body. */
export function cssTokenLines(theme: BrandTheme): string {
  const palette = BRAND_THEMES[theme];
  return (Object.keys(CSS_VAR_NAMES) as BrandHexKey[])
    .map((key) => `${CSS_VAR_NAMES[key]}: ${palette[key]};`)
    .join("\n  ");
}

/**
 * Complete token rules for both themes. Light sits on bare `:root`; dark applies under
 * `prefers-color-scheme: dark` (unless the page opts into light) and under an explicit
 * `data-theme="dark"`, so a toggle wins in both directions.
 */
export function cssVariables(): string {
  const light = cssTokenLines("light");
  const dark = cssTokenLines("dark");
  const darkNested = dark.replace(/\n {2}/g, "\n    ");
  return [
    `:root {\n  color-scheme: light dark;\n  ${light}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n    ${darkNested}\n  }\n}`,
    `:root[data-theme="dark"] {\n  ${dark}\n}`,
  ].join("\n");
}
