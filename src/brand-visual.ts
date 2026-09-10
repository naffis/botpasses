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

export const BRAND_NAVY = "#14213D";
export const BRAND_TEAL = "#00C2A8";

export const BRAND_HEX: BrandPalette = {
  bg: "#0B1020",
  bgElev: BRAND_NAVY,
  fg: "#F4F6FA",
  muted: "#B4BDD0",
  line: "#2C3A58",
  accent: BRAND_TEAL,
  accentFg: "#0B1020",
  accentDim: "#123D38",
  danger: "#E07070",
  dangerDim: "#3A1C1C",
  warn: "#E9B857",
  warnDim: "#3A2E12",
  info: "#8CC4EE",
  infoDim: "#17303F",
  ok: "#8FD4A8",
  okDim: "#17331E",
};

export const BRAND_HEX_LIGHT: BrandPalette = {
  bg: "#F4F6FA",
  bgElev: "#FFFFFF",
  fg: BRAND_NAVY,
  muted: "#4A5568",
  line: "#D5DBE6",
  accent: "#0A7A6C",
  accentFg: "#FFFFFF",
  accentDim: "#D5F3EE",
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
  display: "Inter",
  body: "Inter",
  mono: "IBM Plex Mono",
  stack: "Inter, Helvetica, Arial, sans-serif",
} as const;

export const MARK_SIZE = 32;

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
  ["accent", "bgElev"],
  ["info", "bgElev"],
  ["ok", "bgElev"],
  ["warn", "bgElev"],
];

/**
 * Shiki `css-variables` roles. Each maps to a brand token that CONTRAST_PAIRS
 * already requires against `bgElev`, so docs fences cannot paint a third palette.
 */
export type CodeHighlightRole =
  | "foreground"
  | "background"
  | "token-comment"
  | "token-punctuation"
  | "token-keyword"
  | "token-constant"
  | "token-function"
  | "token-string"
  | "token-string-expression"
  | "token-parameter"
  | "token-link"
  | "token-inserted"
  | "token-deleted"
  | "token-changed";

export const CODE_HIGHLIGHT_ROLES: Record<CodeHighlightRole, BrandHexKey> = {
  foreground: "fg",
  background: "bgElev",
  "token-comment": "muted",
  "token-punctuation": "muted",
  "token-keyword": "accent",
  "token-constant": "info",
  "token-function": "info",
  "token-string": "ok",
  "token-string-expression": "ok",
  "token-parameter": "warn",
  "token-link": "accent",
  "token-inserted": "ok",
  "token-deleted": "danger",
  "token-changed": "warn",
};

/** `--astro-code-*: var(--token);` aliases. Follows the active theme because the tokens switch. */
export function cssCodeHighlightLines(): string {
  return (Object.keys(CODE_HIGHLIGHT_ROLES) as CodeHighlightRole[])
    .map((role) => `--astro-code-${role}: var(${CSS_VAR_NAMES[CODE_HIGHLIGHT_ROLES[role]]});`)
    .join("\n  ");
}

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
  const code = cssCodeHighlightLines();
  return [
    `:root {\n  color-scheme: light dark;\n  ${light}\n  ${code}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n    ${darkNested}\n  }\n}`,
    `:root[data-theme="dark"] {\n  ${dark}\n}`,
  ].join("\n");
}
