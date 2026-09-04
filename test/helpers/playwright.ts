/**
 * Minimal typed surface over the globally installed Playwright (not a project dependency).
 * Returns undefined when Chromium or Playwright is missing so tests can skip with a reason.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

export const CHROMIUM_PATH = "/opt/pw-browsers/chromium";
const PLAYWRIGHT_PKG = "/opt/node22/lib/node_modules/playwright/package.json";

export type PwBox = { x: number; y: number; width: number; height: number };

export type PwLocator = {
  count(): Promise<number>;
  first(): PwLocator;
  nth(i: number): PwLocator;
  click(opts?: { timeout?: number }): Promise<void>;
  fill(value: string): Promise<void>;
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  isVisible(): Promise<boolean>;
  boundingBox(): Promise<PwBox | null>;
  waitFor(opts?: { state?: "visible" | "hidden" | "attached" | "detached"; timeout?: number }): Promise<void>;
  getAttribute(name: string): Promise<string | null>;
  press(key: string): Promise<void>;
};

export type PwPage = {
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  goBack(): Promise<unknown>;
  url(): string;
  locator(selector: string): PwLocator;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  selectOption(selector: string, value: string): Promise<unknown>;
  waitForSelector(selector: string, opts?: { state?: "visible" | "hidden" | "attached" | "detached"; timeout?: number }): Promise<unknown>;
  waitForURL(url: RegExp | string, opts?: { timeout?: number }): Promise<void>;
  waitForFunction(fn: string, arg?: unknown, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  viewportSize(): { width: number; height: number } | null;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  on(event: "pageerror", fn: (err: Error) => void): void;
  emulateMedia(opts: { colorScheme?: "light" | "dark" }): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
};

export type PwContext = {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
};

export type PwBrowser = {
  newContext(opts?: { viewport?: { width: number; height: number }; colorScheme?: "light" | "dark" }): Promise<PwContext>;
  close(): Promise<void>;
};

type PlaywrightModule = {
  chromium: { launch(opts: { executablePath: string; headless: boolean }): Promise<PwBrowser> };
};

export function playwrightUnavailableReason(): string | undefined {
  if (!existsSync(CHROMIUM_PATH)) return `Chromium not found at ${CHROMIUM_PATH}`;
  if (!existsSync(PLAYWRIGHT_PKG)) return `Playwright not installed at ${PLAYWRIGHT_PKG}`;
  return undefined;
}

export async function launchChromium(): Promise<PwBrowser> {
  const reason = playwrightUnavailableReason();
  if (reason) throw new Error(reason);
  const loaded: unknown = createRequire(PLAYWRIGHT_PKG)("playwright");
  const pw = loaded as PlaywrightModule;
  return pw.chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
}
