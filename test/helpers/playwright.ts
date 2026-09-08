/**
 * Minimal typed surface over Playwright, which is not a project dependency. The module is
 * found through `BOTPASSES_PLAYWRIGHT_PKG`, the project's own node_modules, or the global
 * install this repo's dev container ships; Chromium through `BOTPASSES_CHROMIUM`, the
 * container's `/opt/pw-browsers/chromium`, or Playwright's own download. Returns a reason
 * instead of a browser when either is missing so tests can skip with it.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function npmGlobalPlaywrightPkg(): string | undefined {
  const root = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
  if (!root) return undefined;
  const pkg = join(root, "playwright/package.json");
  return existsSync(pkg) ? pkg : undefined;
}

const PLAYWRIGHT_CANDIDATES = [
  process.env.BOTPASSES_PLAYWRIGHT_PKG,
  npmGlobalPlaywrightPkg(),
  "/opt/node22/lib/node_modules/playwright/package.json",
  "/usr/local/lib/node_modules/playwright/package.json",
  "/usr/lib/node_modules/playwright/package.json",
].filter((p): p is string => typeof p === "string" && p.length > 0);

const CHROMIUM_CANDIDATES = [process.env.BOTPASSES_CHROMIUM, "/opt/pw-browsers/chromium"].filter(
  (p): p is string => typeof p === "string" && p.length > 0,
);

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
  chromium: {
    launch(opts: { executablePath?: string; headless: boolean }): Promise<PwBrowser>;
    executablePath(): string;
  };
};

const projectRequire = createRequire(import.meta.url);

/** The Playwright package.json to load from, or undefined when none is installed. */
function playwrightPackage(): string | undefined {
  try {
    return projectRequire.resolve("playwright/package.json");
  } catch {
    // Not a project dependency; fall through to the global candidates.
  }
  return PLAYWRIGHT_CANDIDATES.find((p) => existsSync(p));
}

function loadPlaywright(pkg: string): PlaywrightModule {
  const loaded: unknown = createRequire(pkg)("playwright");
  return loaded as PlaywrightModule;
}

/** A Chromium binary: an explicit path, the container's, or Playwright's own download. */
function chromiumPath(pw: PlaywrightModule): string | undefined {
  const pinned = CHROMIUM_CANDIDATES.find((p) => existsSync(p));
  if (pinned) return pinned;
  try {
    const own = pw.chromium.executablePath();
    return existsSync(own) ? own : undefined;
  } catch {
    return undefined;
  }
}

export function playwrightUnavailableReason(): string | undefined {
  const pkg = playwrightPackage();
  if (!pkg) return "Playwright not installed (npm i -g playwright, or set BOTPASSES_PLAYWRIGHT_PKG)";
  if (!chromiumPath(loadPlaywright(pkg))) {
    return "Chromium not found (playwright install chromium, or set BOTPASSES_CHROMIUM)";
  }
  return undefined;
}

export async function launchChromium(): Promise<PwBrowser> {
  const pkg = playwrightPackage();
  if (!pkg) throw new Error(playwrightUnavailableReason());
  const pw = loadPlaywright(pkg);
  const executablePath = chromiumPath(pw);
  if (!executablePath) throw new Error(playwrightUnavailableReason());
  return pw.chromium.launch({ executablePath, headless: true });
}
