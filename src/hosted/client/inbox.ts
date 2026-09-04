/// <reference lib="dom" />
/** Inbox panel: pending requests, approve, deny, approve by code, 15 s polling. */
import type { InboxGrant, InboxNeed } from "./types.ts";
import {
  api,
  arr,
  busy,
  byId,
  countdown,
  errorMessage,
  flash,
  handleUnauthorized,
  html,
  isJson,
  isVisible,
  loadErrorText,
  render,
  SafeHtml,
  setHidden,
  showLoadError,
  timeHtml,
} from "./shared.ts";

/** Matches CODE_TTL_MS in the kernel until the API sends `code_expires_at`. */
export const APPROVAL_CODE_TTL_MS = 10 * 60 * 1000;
export const INBOX_POLL_MS = 15_000;

type InboxListeners = { onCount: (count: number) => void; onChanged: () => void };

let listeners: InboxListeners = { onCount: () => {}, onChanged: () => {} };
let pollTimer: number | undefined;
let countdownTimer: number | undefined;

function isNeed(v: unknown): v is InboxNeed {
  return isJson(v) && typeof v.id === "string";
}

function isInboxGrant(v: unknown): v is InboxGrant {
  return isJson(v) && typeof v.id === "string";
}

function codeExpiry(g: InboxGrant): string {
  if (g.code_expires_at) return g.code_expires_at;
  const t = new Date(g.created_at).getTime();
  return Number.isNaN(t) ? "" : new Date(t + APPROVAL_CODE_TTL_MS).toISOString();
}

function needCard(n: InboxNeed): SafeHtml {
  const detail = [n.host, n.task_description].filter(Boolean).join(" · ");
  return html`<article class="inbox-item" data-testid="inbox-need">
    <div class="inbox-copy">
      <h2 class="inbox-title">${n.client_name || "An agent"} needs ${n.suggested_name || "a credential"}</h2>
      <p>${detail}</p>
      <p class="inbox-meta">${n.created_at ? html`Asked ${timeHtml(n.created_at)} · ` : ""}${n.expires_at ? html`Request expires ${timeHtml(n.expires_at)}` : ""}</p>
    </div>
    <div class="inbox-actions"><a class="btn btn-primary" href="${n.collect_path || `/collect/${n.id}`}">Store the credential</a></div>
  </article>`;
}

function grantCard(g: InboxGrant, now: number): SafeHtml {
  const name = g.item_name ?? "credential";
  const client = g.client_name || "An agent";
  const last4 = g.item_last4 ? `····${g.item_last4}` : "";
  const detail = [last4, g.task_description].filter(Boolean).join(" · ");
  if (g.status === "active") {
    return html`<article class="inbox-item is-approved" data-testid="inbox-approved">
      <div class="inbox-copy">
        <h2 class="inbox-title">Approved: ${client} can use ${name}</h2>
        <p>${detail}</p>
        <p class="inbox-meta">Approved ${timeHtml(g.approved_at ?? g.created_at, now)}. The agent can retry now. A failed call reuses this approval; it does not need a new code.</p>
      </div>
      <div class="inbox-actions">
        <button type="button" class="btn-ghost" data-deny="${g.id}" data-deny-label="${client}|${name}">Revoke</button>
      </div>
    </article>`;
  }
  const expires = codeExpiry(g);
  const left = countdown(expires, now);
  return html`<article class="inbox-item" data-testid="inbox-request">
    <div class="inbox-copy">
      <h2 class="inbox-title">${client} wants ${name}</h2>
      <p>${detail}</p>
      <p class="inbox-meta">Requested ${timeHtml(g.created_at, now)}${left ? html` · <span class="pill pill-warn" data-countdown="${expires}">code ${left}</span>` : ""}</p>
    </div>
    <div class="inbox-actions">
      <button type="button" class="btn-primary" data-approve="${g.id}" data-testid="inbox-approve">Approve</button>
      <button type="button" class="btn-ghost" data-deny="${g.id}" data-deny-label="${client}|${name}" data-testid="inbox-deny">Deny</button>
    </div>
  </article>`;
}

function tickCountdowns(): void {
  const now = Date.now();
  document.querySelectorAll<HTMLElement>("[data-countdown]").forEach((el) => {
    const left = countdown(el.dataset.countdown, now);
    el.textContent = left ? `code ${left}` : "code expired";
  });
}

async function approve(id: string, button: HTMLButtonElement): Promise<void> {
  await busy(button, async () => {
    try {
      const r = await api(`/api/grants/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify({ policy: "prompt" }),
      });
      flash(r.ok ? "Approved. The agent can retry now." : errorMessage(r, "Approve failed"), r.ok);
    } catch (err) {
      flash(loadErrorText(err, "Approve failed"), false);
    }
  });
  await loadInbox();
  listeners.onChanged();
}

async function deny(id: string, button: HTMLButtonElement): Promise<void> {
  await busy(button, async () => {
    try {
      const r = await api(`/api/grants/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
      flash(r.ok ? "Denied. The agent gets no access to this credential." : errorMessage(r, "Deny failed"), r.ok);
    } catch (err) {
      flash(loadErrorText(err, "Deny failed"), false);
    }
  });
  await loadInbox();
  listeners.onChanged();
}

export async function loadInbox(): Promise<void> {
  const el = byId("inbox");
  if (!el) return;
  setHidden("inbox-error", true);
  try {
    const r = await api("/api/inbox");
    if (r.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!r.ok) throw new Error(errorMessage(r, "Could not load the inbox"));
    const needs = arr(r.body.needs, isNeed);
    const grants = arr(r.body.grants, isInboxGrant);
    const count = needs.length + grants.filter((g) => g.status !== "active").length;
    listeners.onCount(count);
    setHidden("inbox-empty", needs.length + grants.length > 0);
    const now = Date.now();
    render(el, html`${needs.map(needCard)}${grants.map((g) => grantCard(g, now))}`);
  } catch (err) {
    el.replaceChildren();
    setHidden("inbox-empty", true);
    showLoadError("inbox-error", loadErrorText(err, "Could not load the inbox"), () => {
      void loadInbox();
    });
  }
}

function startPolling(): void {
  if (pollTimer !== undefined) return;
  pollTimer = window.setInterval(() => {
    if (isVisible()) void loadInbox();
  }, INBOX_POLL_MS);
  countdownTimer = window.setInterval(tickCountdowns, 1000);
}

export function stopInboxPolling(): void {
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
  if (countdownTimer !== undefined) window.clearInterval(countdownTimer);
  pollTimer = undefined;
  countdownTimer = undefined;
}

export function bindInbox(on: InboxListeners): void {
  listeners = on;
  const el = byId("inbox");
  el?.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target.closest<HTMLButtonElement>("button") : null;
    if (!t) return;
    if (t.dataset.approve) void approve(t.dataset.approve, t);
    else if (t.dataset.deny) {
      const [client, name] = (t.dataset.denyLabel ?? "|").split("|");
      void requestDeny(t.dataset.deny, client ?? "the agent", name ?? "this credential", t);
    }
  });
  const code = byId<HTMLFormElement>("code");
  code?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = code.elements.namedItem("code");
    const value = input instanceof HTMLInputElement ? input.value.trim() : "";
    void busy(code, async () => {
      try {
        const r = await api("/api/grants/approve-by-code", { method: "POST", body: JSON.stringify({ code: value }) });
        flash(r.ok ? "Approved" : errorMessage(r, "Code rejected"), r.ok);
        if (r.ok && input instanceof HTMLInputElement) input.value = "";
      } catch (err) {
        flash(loadErrorText(err, "Code rejected"), false);
      }
      await loadInbox();
      listeners.onChanged();
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (isVisible()) void loadInbox();
  });
  startPolling();
}

/** Console wires this to the confirm dialog so the copy is specific. */
let denyHandler: (id: string, client: string, name: string, button: HTMLButtonElement) => Promise<void> = (id, _client, _name, button) =>
  deny(id, button);

export function onDeny(fn: (id: string, client: string, name: string, run: () => Promise<void>) => Promise<void>): void {
  denyHandler = (id, client, name, button) => fn(id, client, name, () => deny(id, button));
}

async function requestDeny(id: string, client: string, name: string, button: HTMLButtonElement): Promise<void> {
  await denyHandler(id, client, name, button);
}
