/// <reference lib="dom" />
/** Inbox panel: pending requests, approve (one click or with limits), deny, approve by code, 15 s polling. */
import { providerById } from "../providers/registry.ts";
import { connectHash } from "./routes.ts";
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
  relativeTime,
  render,
  SafeHtml,
  setHidden,
  showLoadError,
  timeHtml,
} from "./shared.ts";

/** Matches CODE_TTL_MS in the kernel until the API sends `code_expires_at`. */
export const APPROVAL_CODE_TTL_MS = 10 * 60 * 1000;
export const INBOX_POLL_MS = 15_000;
export const SCOPE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
/** Durations the limits form offers. Up to a day is a `session` approval; longer is a standing one with an expiry. */
export const SCOPE_DURATIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "once", label: "This call only" },
  { value: "3600", label: "1 hour" },
  { value: "28800", label: "8 hours" },
  { value: "86400", label: "24 hours" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days" },
  { value: "standing", label: "Until revoked" },
];
const SESSION_MAX_SECONDS = 86_400;

export function isStandingPolicy(policy: string | undefined): boolean {
  return policy === "item_standing" || policy === "folder_standing";
}

export function standingPolicyLabel(policy: string | undefined): string {
  if (policy === "item_standing") return "Always approved";
  if (policy === "folder_standing") return "Folder standing";
  if (policy === "session") return "Session";
  if (!policy || policy === "prompt") return "";
  return policy.replace(/_/g, " ");
}

/** `grant_scope` as the API sends it. Null means unrestricted. */
export type ScopePublic = {
  methods: string[] | null;
  path_prefixes: string[] | null;
  hosts: string[] | null;
  max_calls: number | null;
  calls_used: number;
  expires_at: string | null;
};

/** `requested_scope`: what the agent said it would call. */
export type RequestedScopePublic = { host: string | null; method: string | null; path: string | null };

export type ScopedInboxGrant = InboxGrant & {
  requested_scope?: RequestedScopePublic | null;
  grant_scope?: ScopePublic | null;
  allowed_hosts?: string[];
  expires_at?: string | null;
};

type InboxListeners = { onCount: (count: number) => void; onChanged: () => void };

let listeners: InboxListeners = { onCount: () => {}, onChanged: () => {} };
let pollTimer: number | undefined;
let countdownTimer: number | undefined;

function isNeed(v: unknown): v is InboxNeed {
  return isJson(v) && typeof v.id === "string";
}

function isInboxGrant(v: unknown): v is ScopedInboxGrant {
  return isJson(v) && typeof v.id === "string";
}

function codeExpiry(g: InboxGrant): string {
  if (g.code_expires_at) return g.code_expires_at;
  const t = new Date(g.created_at).getTime();
  return Number.isNaN(t) ? "" : new Date(t + APPROVAL_CODE_TTL_MS).toISOString();
}

/** "GET api.stripe.com/v1/balance" from a requested scope; empty when nothing was stated. */
export function requestText(rs: RequestedScopePublic | null | undefined): string {
  if (!rs) return "";
  return `${rs.method ?? ""} ${rs.host ?? ""}${rs.path ?? ""}`.trim();
}

/** One line of limits: "GET only · paths under /v1 · api.stripe.com · 2 of 10 calls · expires in 7 hours". */
export function describeScope(scope: ScopePublic | null | undefined, now: number = Date.now()): string {
  if (!scope) return "";
  const parts: string[] = [];
  if (scope.methods) parts.push(`${scope.methods.join("/")} only`);
  if (scope.path_prefixes) parts.push(`paths under ${scope.path_prefixes.join(", ")}`);
  if (scope.hosts) parts.push(scope.hosts.join(", "));
  if (scope.max_calls !== null) parts.push(`${scope.calls_used} of ${scope.max_calls} calls used`);
  if (scope.expires_at) {
    const rel = relativeTime(scope.expires_at, now);
    if (rel) parts.push(`expires ${rel}`);
  }
  return parts.join(" · ");
}

/** "<Agent> needs a <Provider> account for <ITEM>": Connect opens the item's connect dialog with the agent and need carried along. */
function connectNeedCard(n: InboxNeed): SafeHtml {
  const client = n.client_name || "An agent";
  const providerName = providerById(n.provider ?? "")?.displayName ?? "provider";
  const item = n.source_item_name || n.suggested_name.replace(/_REFRESH$/, "") || "this credential";
  const detail = [n.host, n.task_description].filter(Boolean).join(" · ");
  const link = n.source_item_id && n.provider ? connectHash(n.source_item_id, { provider: n.provider, agent: n.client_id, need: n.id }) : "";
  return html`<article class="inbox-item" data-testid="inbox-connect-need">
    <div class="inbox-copy">
      <h2 class="inbox-title">${client} needs a ${providerName} account for ${item}</h2>
      <p>${detail}</p>
      <p class="inbox-meta">${n.created_at ? html`Asked ${timeHtml(n.created_at)} · ` : ""}${n.expires_at ? html`Request expires ${timeHtml(n.expires_at)} · ` : ""}The refresh token is stored as ${n.suggested_name}. The agent does not get it.</p>
    </div>
    <div class="inbox-actions">
      ${link ? html`<a class="btn btn-primary" href="${link}" data-testid="inbox-connect">Connect ${providerName}</a>` : html`<span class="hint">The credential this request was for is gone.</span>`}
      <button type="button" class="btn-ghost" data-deny-need="${n.id}" data-deny-label="${client}|${providerName}" data-testid="inbox-need-deny">Deny</button>
    </div>
  </article>`;
}

function needCard(n: InboxNeed): SafeHtml {
  if (n.kind === "connect") return connectNeedCard(n);
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

function limitsForm(g: ScopedInboxGrant, name: string): SafeHtml {
  const rs = g.requested_scope ?? null;
  const method = rs?.method ?? null;
  const path = rs?.path ? rs.path.split("?")[0] ?? "" : "";
  return html`<details class="approve-limits" data-limits="${g.id}" data-testid="inbox-limits">
    <summary>Approve with limits</summary>
    <form data-limits-form="${g.id}" data-host="${rs?.host ?? ""}" aria-label="Limits for ${name}">
      <fieldset>
        <legend class="hint">Methods</legend>
        ${SCOPE_METHODS.map(
          (m) => html`<label class="inline-select"><input type="checkbox" name="methods" value="${m}"${method === null || method === m ? " checked" : ""}> ${m}</label>`,
        )}
      </fieldset>
      <label>Path prefix <input name="path_prefix" value="${path}" placeholder="/v1 (empty: any path)" autocomplete="off"></label>
      <label>Max calls <input name="max_calls" type="number" min="1" step="1" placeholder="unlimited" inputmode="numeric"></label>
      <label>Duration <select name="duration">${SCOPE_DURATIONS.map((d) => html`<option value="${d.value}">${d.label}</option>`)}</select></label>
      <label class="inline-select"><input type="checkbox" name="always_approve" data-testid="inbox-always-approve-limits"> Always approve for this agent</label>
      <p class="hint">${rs?.host ? `Limited to ${rs.host}.` : g.allowed_hosts?.length ? `Any of ${g.allowed_hosts.join(", ")}.` : ""} Always approve covers every host already on the credential.</p>
      <button type="submit" class="btn-primary btn-small" data-testid="inbox-approve-limits">Approve with these limits</button>
    </form>
  </details>`;
}

export function grantCard(g: ScopedInboxGrant, now: number): SafeHtml {
  const name = g.item_name ?? "credential";
  const client = g.client_name || "An agent";
  const last4 = g.item_last4 ? `····${g.item_last4}` : "";
  const request = requestText(g.requested_scope);
  const scope = describeScope(g.grant_scope, now);
  if (g.status === "active") {
    const detail = [last4, g.task_description, scope].filter(Boolean).join(" · ");
    return html`<article class="inbox-item is-approved" data-testid="inbox-approved">
      <div class="inbox-copy">
        <h2 class="inbox-title">Approved: ${client} can ${request ? html`${request} using ${name}` : html`use ${name}`}</h2>
        <p>${detail}</p>
        <p class="inbox-meta">Approved ${timeHtml(g.approved_at ?? g.created_at, now)}. The agent can call now.${g.policy === "prompt" ? " A one-call approval is spent by any answer from the API, including an error; use Approve with limits (max calls or a duration) when the agent needs to retry." : ""}</p>
      </div>
      <div class="inbox-actions">
        <button type="button" class="btn-ghost" data-deny="${g.id}" data-deny-label="${client}|${name}">Revoke</button>
      </div>
    </article>`;
  }
  const expires = codeExpiry(g);
  const left = countdown(expires, now);
  const detail = [request ? `using ${name} ${last4}`.trim() : last4, g.task_description].filter(Boolean).join(" · ");
  return html`<article class="inbox-item" data-testid="inbox-request">
    <div class="inbox-copy">
      <h2 class="inbox-title">${client} wants ${request ? `to ${request}` : name}</h2>
      <p>${detail}</p>
      <p class="inbox-meta">Requested ${timeHtml(g.created_at, now)}${left ? html` · <span class="pill pill-warn" data-countdown="${expires}">code ${left}</span>` : ""}${request ? html` · <span class="hint">Approve limits it to this call.</span>` : ""}</p>
      ${limitsForm(g, name)}
    </div>
    <div class="inbox-actions">
      <button type="button" class="btn-primary" data-approve="${g.id}" data-testid="inbox-approve">Approve</button>
      <button type="button" class="btn-ghost" data-approve-standing="${g.id}" data-method="${g.requested_scope?.method ?? ""}" data-path="${g.requested_scope?.path ?? ""}" data-testid="inbox-always-approve">Always approve for this agent</button>
      <button type="button" class="btn-ghost" data-deny="${g.id}" data-deny-label="${client}|${name}" data-testid="inbox-deny">Deny</button>
    </div>
    <p class="hint">Always approve skips the inbox for this agent and this credential on its allowed hosts. You can clear it anytime from Agents or the credential.</p>
  </article>`;
}

function tickCountdowns(): void {
  const now = Date.now();
  document.querySelectorAll<HTMLElement>("[data-countdown]").forEach((el) => {
    const left = countdown(el.dataset.countdown, now);
    el.textContent = left ? `code ${left}` : "code expired";
  });
}

/** Approve body. `scope` absent means "inherit the requested call"; present means "exactly these limits". */
export type LimitsBody = { policy: string; scope?: Record<string, unknown> };

/**
 * Turns the limits form into the approve body. Pure so it can be tested without a DOM.
 * Duration: "once" is a prompt approval, up to a day a session, longer a standing one with expiry.
 */
export function limitsBody(input: {
  methods: string[];
  pathPrefix: string;
  maxCalls: string;
  duration: string;
  host: string;
  alwaysApprove?: boolean;
}): LimitsBody | { error: string } {
  if (input.methods.length === 0) return { error: "Pick at least one method." };
  const scope: Record<string, unknown> = { methods: input.methods };
  const prefix = input.pathPrefix.trim();
  if (prefix) {
    if (!prefix.startsWith("/")) return { error: "Path prefix must start with /." };
    scope.path_prefixes = [prefix];
  }
  if (input.host) scope.hosts = [input.host];
  const max = input.maxCalls.trim();
  if (max) {
    const n = Number(max);
    if (!Number.isInteger(n) || n < 1) return { error: "Max calls must be a whole number of 1 or more." };
    scope.max_calls = n;
  }
  let policy = "prompt";
  if (input.alwaysApprove || input.duration === "standing") policy = "item_standing";
  else if (input.duration !== "once") {
    const seconds = Number(input.duration);
    if (!Number.isInteger(seconds) || seconds < 60) return { error: "Pick a duration." };
    policy = seconds <= SESSION_MAX_SECONDS ? "session" : "item_standing";
    scope.ttl_seconds = seconds;
  }
  if (input.alwaysApprove) {
    delete scope.hosts;
    delete scope.ttl_seconds;
  }
  return { policy, scope };
}

/**
 * Always-approve body. Method and path follow one-click rules when the agent stated them.
 * Hosts are omitted so every host already on the item is covered (the connector still
 * enforces the allowlist).
 */
export function alwaysApproveBody(method?: string, path?: string): LimitsBody {
  const scope: Record<string, unknown> = {};
  const m = method?.trim().toUpperCase();
  if (m) scope.methods = [m];
  const prefix = path?.trim().split("?")[0] ?? "";
  if (prefix) scope.path_prefixes = [prefix];
  return Object.keys(scope).length ? { policy: "item_standing", scope } : { policy: "item_standing", scope: {} };
}

function readLimits(form: HTMLFormElement): LimitsBody | { error: string } {
  const methods = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="methods"]:checked')).map((i) => i.value);
  const value = (name: string): string => {
    const el = form.elements.namedItem(name);
    return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : "";
  };
  const always = form.elements.namedItem("always_approve");
  return limitsBody({
    methods,
    pathPrefix: value("path_prefix"),
    maxCalls: value("max_calls"),
    duration: value("duration"),
    host: form.dataset.host ?? "",
    alwaysApprove: always instanceof HTMLInputElement && always.checked,
  });
}

async function postApprove(id: string, body: LimitsBody, control: HTMLButtonElement | HTMLFormElement): Promise<void> {
  await busy(control, async () => {
    try {
      const r = await api(`/api/grants/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify(body) });
      const standing = body.policy === "item_standing" || body.policy === "folder_standing";
      flash(
        r.ok
          ? standing
            ? "Always approved for this agent. You can clear this from Agents or the credential."
            : "Approved. The agent can retry now."
          : errorMessage(r, "Approve failed"),
        r.ok,
      );
    } catch (err) {
      flash(loadErrorText(err, "Approve failed"), false);
    }
  });
  await loadInbox({ force: true });
  listeners.onChanged();
}

/** One click: no `scope`, so the server narrows to the requested call when the agent stated one. */
async function approve(id: string, button: HTMLButtonElement): Promise<void> {
  await postApprove(id, { policy: "prompt" }, button);
}

async function alwaysApprove(id: string, button: HTMLButtonElement): Promise<void> {
  await postApprove(id, alwaysApproveBody(button.dataset.method, button.dataset.path), button);
}

async function approveWithLimits(id: string, form: HTMLFormElement): Promise<void> {
  const body = readLimits(form);
  if ("error" in body) {
    flash(body.error, false);
    return;
  }
  await postApprove(id, body, form);
}

/** Outcome of an operator action; the confirm dialog shows `message` and stays open when `ok` is false. */
export type ActionResult = { ok: boolean; message: string };

async function deny(id: string, button: HTMLButtonElement): Promise<ActionResult> {
  return busy(button, async () => {
    try {
      const r = await api(`/api/grants/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
      if (!r.ok) return { ok: false, message: errorMessage(r, "Deny failed") };
    } catch (err) {
      return { ok: false, message: loadErrorText(err, "Deny failed") };
    }
    flash("Denied. The agent gets no access to this credential.", true);
    await loadInbox({ force: true });
    listeners.onChanged();
    return { ok: true, message: "" };
  });
}

async function denyNeed(id: string, button: HTMLButtonElement): Promise<ActionResult> {
  return busy(button, async () => {
    try {
      const r = await api(`/api/need-items/${encodeURIComponent(id)}/deny`, { method: "POST", body: "{}" });
      if (!r.ok) return { ok: false, message: errorMessage(r, "Deny failed") };
    } catch (err) {
      return { ok: false, message: loadErrorText(err, "Deny failed") };
    }
    flash("Denied. The agent is told nothing was connected.", true);
    await loadInbox({ force: true });
    listeners.onChanged();
    return { ok: true, message: "" };
  });
}

/** `force` re-renders even while a limits form is open (after an approve or deny). */
export async function loadInbox(opts: { force?: boolean } = {}): Promise<void> {
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
    // A poll must not wipe a limits form the operator is filling in.
    if (!opts.force && el.querySelector("details[data-limits][open]")) return;
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
    if (t.dataset.approveStanding) void alwaysApprove(t.dataset.approveStanding, t);
    else if (t.dataset.approve) void approve(t.dataset.approve, t);
    else if (t.dataset.deny) {
      const [client, name] = (t.dataset.denyLabel ?? "|").split("|");
      void requestDeny(t.dataset.deny, client ?? "the agent", name ?? "this credential", t);
    } else if (t.dataset.denyNeed) {
      const [client, provider] = (t.dataset.denyLabel ?? "|").split("|");
      void denyNeedHandler(t.dataset.denyNeed, client ?? "the agent", provider ?? "the provider", t);
    }
  });
  el?.addEventListener("submit", (e) => {
    const form = e.target instanceof HTMLFormElement ? e.target : null;
    if (!form?.dataset.limitsForm) return;
    e.preventDefault();
    void approveWithLimits(form.dataset.limitsForm, form);
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
      await loadInbox({ force: true });
      listeners.onChanged();
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (isVisible()) void loadInbox();
  });
  startPolling();
}

/** Console wires this to the confirm dialog so the copy is specific. */
let denyHandler: (id: string, client: string, name: string, button: HTMLButtonElement) => Promise<void> = async (id, _client, _name, button) => {
  const result = await deny(id, button);
  if (!result.ok) flash(result.message, false);
};

export function onDeny(fn: (id: string, client: string, name: string, run: () => Promise<ActionResult>) => Promise<void>): void {
  denyHandler = (id, client, name, button) => fn(id, client, name, () => deny(id, button));
}

async function requestDeny(id: string, client: string, name: string, button: HTMLButtonElement): Promise<void> {
  await denyHandler(id, client, name, button);
}

/** Deny on a connect card; the console wires the confirm dialog like `onDeny`. */
let denyNeedHandler: (id: string, client: string, provider: string, button: HTMLButtonElement) => Promise<void> = async (id, _client, _provider, button) => {
  const result = await denyNeed(id, button);
  if (!result.ok) flash(result.message, false);
};

export function onDenyNeed(fn: (id: string, client: string, provider: string, run: () => Promise<ActionResult>) => Promise<void>): void {
  denyNeedHandler = (id, client, provider, button) => fn(id, client, provider, () => denyNeed(id, button));
}
