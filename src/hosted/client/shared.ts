/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Browser helpers shared by the console and collect bundles: CSRF headers, a fetch wrapper,
 * an auto-escaping `html` tag, flashes, dialogs, and time formatting.
 * No DOM access at load time so node tests can import the pure parts.
 */

export const FLASH_CLEAR_MS = 6000;

export function csrf(): string {
  const m = document.cookie.match(/(?:^|; )(?:__Host-bp_csrf|bp_csrf)=([^;]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : "";
}

export function bootstrapToken(): string {
  try {
    return sessionStorage.getItem("vault_op_token") ?? "";
  } catch {
    return "";
  }
}

export function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const t = csrf();
  if (t) h["X-CSRF-Token"] = t;
  const b = bootstrapToken();
  if (b) h.Authorization = `Bearer ${b}`;
  return h;
}

export type Json = Record<string, unknown>;

export type ApiResult = { ok: boolean; status: number; body: Json };

/** Thrown when the request never reached the server (offline, DNS, aborted). */
export class NetworkError extends Error {
  constructor(message = "Could not reach the server. Check your connection and retry.") {
    super(message);
    this.name = "NetworkError";
  }
}

export function isJson(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function arr<T>(v: unknown, guard: (x: unknown) => x is T): T[] {
  return Array.isArray(v) ? v.filter(guard) : [];
}

/**
 * Where a 403 `mfa_required` sends the browser: the `verify_url` (enrolled, this session has
 * not passed the authenticator step) or `enroll_url` (no authenticator yet) the server named.
 * Only same-origin paths are followed. Undefined for every other response.
 */
export function mfaRedirectUrl(status: number, body: Json): string | undefined {
  if (status !== 403 || body.error !== "mfa_required") return undefined;
  const next = str(body.verify_url) || str(body.enroll_url);
  return next.startsWith("/") && !next.startsWith("//") ? next : undefined;
}

export async function api(url: string, init: RequestInit = {}): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "include", headers: apiHeaders(), ...init });
  } catch {
    throw new NetworkError();
  }
  let body: Json = {};
  try {
    const parsed: unknown = await res.json();
    if (isJson(parsed)) body = parsed;
  } catch {
    body = {};
  }
  const next = mfaRedirectUrl(res.status, body);
  if (next && typeof location !== "undefined") location.assign(next);
  return { ok: res.ok, status: res.status, body };
}

export function errorMessage(result: ApiResult, fallback: string): string {
  const e = result.body.error;
  return typeof e === "string" && e ? e : `${fallback} (${result.status})`;
}

/* ---------- auto-escaping html ---------- */

export class SafeHtml {
  readonly html: string;
  constructor(html: string) {
    this.html = html;
  }
  toString(): string {
    return this.html;
  }
}

export type HtmlValue = string | number | boolean | null | undefined | SafeHtml | HtmlValue[];

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderValue(v: HtmlValue): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof SafeHtml) return v.html;
  if (Array.isArray(v)) return v.map(renderValue).join("");
  if (v === true) return "";
  return escapeHtml(String(v));
}

/** Tagged template: interpolations are escaped unless they are `SafeHtml` (from `html` or `raw`). */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i] ?? "";
    if (i < values.length) out += renderValue(values[i]);
  }
  return new SafeHtml(out);
}

/** Only for markup the server produced or constants. Never for user data. */
export function raw(trusted: string): SafeHtml {
  return new SafeHtml(trusted);
}

export function render(el: Element | null, content: SafeHtml): void {
  if (el) el.innerHTML = content.html;
}

/* ---------- DOM helpers ---------- */

export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function setHidden(id: string, hidden: boolean): void {
  const el = byId(id);
  if (el) el.hidden = hidden;
}

export function text(el: Element | null, value: string): void {
  if (el) el.textContent = value;
}

export function setFormNotice(id: string, message: string, ok: boolean): void {
  const el = byId(id);
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-ok", ok && Boolean(message));
  el.classList.toggle("is-err", !ok && Boolean(message));
}

let flashTimer: number | undefined;

/** Page flash: auto-clears after 6 s and can be dismissed. */
export function flash(message: string, ok: boolean): void {
  const el = byId("flash");
  if (!el) return;
  if (flashTimer !== undefined) window.clearTimeout(flashTimer);
  if (!message) {
    el.replaceChildren();
    el.className = "flash";
    return;
  }
  render(
    el,
    html`<span class="flash-text">${message}</span><button type="button" class="flash-dismiss" aria-label="Dismiss">&times;</button>`,
  );
  el.className = ok ? "flash is-ok" : "flash is-err";
  el.querySelector("button")?.addEventListener("click", () => flash("", true));
  flashTimer = window.setTimeout(() => flash("", true), FLASH_CLEAR_MS);
}

/** Inline error state for a loader: message plus a Retry button. */
export function showLoadError(boxId: string, message: string, retry: () => void): void {
  const box = byId(boxId);
  if (!box) return;
  render(
    box,
    html`<strong>Something went wrong</strong><span>${message}</span><p class="toolbar"><button type="button" class="btn-ghost" data-retry>Retry</button></p>`,
  );
  box.hidden = false;
  box.querySelector<HTMLButtonElement>("[data-retry]")?.addEventListener("click", () => {
    box.hidden = true;
    retry();
  });
}

export function loadErrorText(err: unknown, fallback: string): string {
  if (err instanceof NetworkError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** Disable a control while an async action runs; restore afterwards even on failure. */
export async function busy<T>(control: HTMLButtonElement | HTMLFormElement | null, fn: () => Promise<T>): Promise<T> {
  const buttons: HTMLButtonElement[] = [];
  if (control instanceof HTMLButtonElement) buttons.push(control);
  else if (control instanceof HTMLFormElement) buttons.push(...control.querySelectorAll<HTMLButtonElement>("button"));
  const prior = buttons.map((b) => b.disabled);
  buttons.forEach((b) => {
    b.disabled = true;
    b.setAttribute("aria-busy", "true");
  });
  try {
    return await fn();
  } finally {
    buttons.forEach((b, i) => {
      b.disabled = prior[i] ?? false;
      b.removeAttribute("aria-busy");
    });
  }
}

export function openDialog(id: string): HTMLDialogElement | null {
  const d = byId<HTMLDialogElement>(id);
  if (d && typeof d.showModal === "function" && !d.open) d.showModal();
  return d;
}

export function closeDialog(id: string): void {
  const d = byId<HTMLDialogElement>(id);
  if (d && d.open) d.close();
}

/** Any `[data-close]` button closes its enclosing dialog. Replaces inline onclick (CSP). */
export function bindDialogClosers(): void {
  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-close]") : null;
    if (!target) return;
    const dialog = target.closest("dialog");
    if (dialog && dialog.open) dialog.close();
  });
}

export function copyText(value: string, okMsg: string): void {
  if (!value) return;
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
    flash("Copy is not available in this browser. Select the text and copy it by hand.", false);
    return;
  }
  navigator.clipboard.writeText(value).then(
    () => flash(okMsg, true),
    () => flash("Copy failed", false),
  );
}

export function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- time ---------- */

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

/** "just now", "4 min ago", "in 9 min", "2 days ago". */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = t - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  // The unit is chosen from the rounded count, so 59.6 minutes reads "1 hour", never "60 min".
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  let phrase: string;
  if (abs < 45_000) return future ? "in under a minute" : "just now";
  else if (minutes < 60) phrase = unit(minutes, "min");
  else if (hours < 24) phrase = unit(hours, "hour");
  else if (days < 30) phrase = unit(days, "day");
  else phrase = unit(Math.round(abs / (30 * 86_400_000)), "month");
  return future ? `in ${phrase}` : `${phrase} ago`;
}

/** `<time datetime>` with a relative label and the absolute value as the title. */
export function timeHtml(iso: string | null | undefined, now: number = Date.now()): SafeHtml {
  if (!iso) return new SafeHtml("");
  return html`<time datetime="${iso}" title="${formatWhen(iso)}">${relativeTime(iso, now)}</time>`;
}

/** Countdown text for an expiry; empty once past. */
export function countdown(expiresIso: string | null | undefined, now: number = Date.now()): string {
  if (!expiresIso) return "";
  const t = new Date(expiresIso).getTime();
  if (Number.isNaN(t)) return "";
  const left = t - now;
  if (left <= 0) return "expired";
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")} left` : `${s}s left`;
}

let unauthorizedHandler: () => void = () => {};

export function onUnauthorized(fn: () => void): void {
  unauthorizedHandler = fn;
}

export function handleUnauthorized(): void {
  unauthorizedHandler();
}

export function isVisible(): boolean {
  return document.visibilityState === "visible";
}

export function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}
