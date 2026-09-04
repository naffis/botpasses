/// <reference lib="dom" />
/** Agents panel: agents, approvals, sessions, and humanised activity with filters and paging. */
import { describeActivity, pageOf } from "./activity.ts";
import { describeScope, type ScopePublic } from "./inbox.ts";
import { agentsHash, type AgentsTab, AGENTS_TABS, type Route } from "./routes.ts";
import type { AccessClient, AccessGrant, AccessSession, AuditRow } from "./types.ts";
import {
  api,
  arr,
  byId,
  errorMessage,
  flash,
  handleUnauthorized,
  html,
  isJson,
  loadErrorText,
  qs,
  render,
  SafeHtml,
  setHidden,
  showLoadError,
  timeHtml,
} from "./shared.ts";

export type AccessHandlers = {
  onRevokeClient: (client: AccessClient) => void;
  onRotateClient: (client: AccessClient) => void;
  onRevokeGrant: (grant: AccessGrant) => void;
  onRevokeSession: (session: AccessSession) => void;
  navigate: (hash: string) => void;
};

type AccessState = {
  clients: AccessClient[];
  grants: AccessGrant[];
  sessions: AccessSession[];
  audit: AuditRow[];
  auditError: string;
  page: number;
  filter: { agent: string; credential: string };
};

const state: AccessState = {
  clients: [],
  grants: [],
  sessions: [],
  audit: [],
  auditError: "",
  page: 0,
  filter: { agent: "", credential: "" },
};
let accessHandlers: AccessHandlers | undefined;
let currentTab: AgentsTab = "agents";

const isClient = (v: unknown): v is AccessClient => isJson(v) && typeof v.id === "string" && typeof v.name === "string";
const isAccessGrant = (v: unknown): v is AccessGrant => isJson(v) && typeof v.id === "string";
const isSession = (v: unknown): v is AccessSession => isJson(v) && typeof v.id === "string";
const isAudit = (v: unknown): v is AuditRow => isJson(v) && typeof v.action === "string" && typeof v.at === "string";

export function clientName(id: string | null): string {
  if (!id) return "";
  return state.clients.find((c) => c.id === id)?.name ?? id;
}

function meta(parts: Array<SafeHtml | string>): SafeHtml {
  const kept = parts.filter((p) => (p instanceof SafeHtml ? p.html : p));
  return html`${kept.map((p, i) => html`${i ? " · " : ""}${p}`)}`;
}

function when(label: string, iso: string | null): SafeHtml | string {
  return iso ? html`${label} ${timeHtml(iso)}` : "";
}

function statusPill(status: string): SafeHtml {
  const cls = status === "active" ? "pill-ok" : status === "pending" ? "pill-warn" : "pill-muted";
  return html`<span class="pill ${cls}">${status}</span>`;
}

function agentRow(c: AccessClient, environments: string[]): SafeHtml {
  const canRotate = c.status === "active" && c.kind !== "oauth";
  const kind = c.kind === "oauth" ? "OAuth" : c.kind === "model" ? "token" : c.kind;
  return html`<div class="access-row" data-testid="agent-row" data-client="${c.id}">
    <div class="access-row-main">
      <p class="access-row-title">${c.name} <span class="pill">${kind}</span> ${statusPill(c.status)}</p>
      <p class="access-meta">${meta([
        c.last4 ? `Token ••••${c.last4}` : "",
        when("Created", c.created_at),
        when("First used", c.first_access_at),
        when("Last used", c.last_access_at),
        c.fetched.length ? `Used ${c.fetched.join(", ")}` : "",
      ])}</p>
      <label class="inline-select">Environment
        <select data-env-client="${c.id}" aria-label="Environment for ${c.name}"${c.status !== "active" ? " disabled" : ""}>
          ${environments.map((e) => html`<option value="${e}"${e === c.environment ? " selected" : ""}>${e}</option>`)}
        </select>
      </label>
      <p class="hint env-note" data-env-note="${c.id}" hidden></p>
    </div>
    <div class="access-row-actions">
      ${canRotate ? html`<button type="button" class="btn-ghost btn-small" data-client-rotate="${c.id}">Rotate token</button>` : ""}
      ${c.status === "active" ? html`<button type="button" class="btn-danger btn-small" data-client-revoke="${c.id}" data-testid="agent-revoke">Revoke</button>` : ""}
      <a class="access-log-link" href="${agentsHash("activity", { agent: c.id })}">Activity</a>
    </div>
  </div>`;
}

/** Approvals rows carry the grant's policy and limits (3.1); older servers omit them. */
type ScopedAccessGrant = AccessGrant & {
  policy?: string;
  grant_scope?: ScopePublic | null;
  expires_at?: string | null;
};

function grantRow(g: ScopedAccessGrant): SafeHtml {
  const live = g.status === "active" || g.status === "pending";
  const scope = describeScope(g.grant_scope);
  return html`<div class="access-row" data-testid="grant-row">
    <div class="access-row-main">
      <p class="access-row-title">${g.client_name} → <span class="mono">${g.item_name || "credential"}</span> ${statusPill(g.status)}${g.policy && g.policy !== "prompt" ? html` <span class="pill">${g.policy.replace("_", " ")}</span>` : ""}</p>
      <p class="access-meta">${meta([
        scope ? html`<span data-testid="grant-scope">${scope}</span>` : "",
        !scope && g.expires_at ? html`Expires ${timeHtml(g.expires_at)}` : "",
        when("Requested", g.created_at),
        when("Approved", g.approved_at),
        when("Last used", g.last_access_at),
      ])}</p>
    </div>
    <div class="access-row-actions">
      ${live ? html`<button type="button" class="btn-danger btn-small" data-grant-revoke="${g.id}" data-testid="grant-revoke">${g.status === "pending" ? "Deny" : "Revoke"}</button>` : ""}
      <a class="access-log-link" href="${agentsHash("activity", { agent: g.client_id, credential: g.item_name })}">Activity</a>
    </div>
  </div>`;
}

function sessionRow(s: AccessSession): SafeHtml {
  return html`<div class="access-row" data-testid="session-row">
    <div class="access-row-main">
      <p class="access-row-title"><span class="mono">${s.id}</span> ${s.current ? html`<span class="pill pill-ok">This device</span>` : ""}</p>
      <p class="access-meta">${meta([when("Signed in", s.created_at), when("Last seen", s.last_seen_at ?? s.last_access_at)])}</p>
    </div>
    <div class="access-row-actions">${s.current ? "" : html`<button type="button" class="btn-danger btn-small" data-session-revoke="${s.id}">Sign out device</button>`}</div>
  </div>`;
}

function activityRow(e: AuditRow): SafeHtml {
  return html`<div class="access-row activity-row">
    <div class="access-row-main"><p class="access-row-title">${describeActivity(e, { clientName })}</p></div>
    <p class="access-meta">${timeHtml(e.at)}</p>
  </div>`;
}

function renderActivity(): void {
  const list = byId("activity-list");
  if (!list) return;
  const rows = state.filter.credential ? state.audit.filter((e) => e.itemName === state.filter.credential) : state.audit;
  const page = pageOf(rows, state.page);
  if (state.auditError) render(list, html`<p class="section-empty hint is-err">${state.auditError}</p>`);
  else if (!page.rows.length) render(list, html`<p class="section-empty hint">No activity yet.</p>`);
  else render(list, html`${page.rows.map(activityRow)}`);
  const more = byId<HTMLButtonElement>("activity-more");
  if (more) more.hidden = !page.hasMore;
  const clear = byId("activity-clear");
  if (clear) clear.hidden = !(state.filter.agent || state.filter.credential);
}

function renderFilters(): void {
  const form = byId<HTMLFormElement>("activity-filters");
  if (!form) return;
  const agent = form.elements.namedItem("agent");
  const cred = form.elements.namedItem("credential");
  const names = Array.from(new Set(state.grants.map((g) => g.item_name).concat(state.audit.map((e) => e.itemName ?? "")).filter(Boolean))).sort();
  if (agent instanceof HTMLSelectElement) {
    render(agent, html`<option value="">All agents</option>${state.clients.map((c) => html`<option value="${c.id}">${c.name}</option>`)}`);
    agent.value = state.filter.agent;
  }
  if (cred instanceof HTMLSelectElement) {
    render(cred, html`<option value="">All credentials</option>${names.map((n) => html`<option value="${n}">${n}</option>`)}`);
    cred.value = state.filter.credential;
  }
}

function renderLists(): void {
  const environments = (document.documentElement.dataset.environments ?? "staging,production").split(",");
  const agents = byId("agents-list");
  if (agents) {
    render(
      agents,
      state.clients.length
        ? html`${state.clients.map((c) => agentRow(c, environments))}`
        : html`<p class="section-empty hint">No agents yet. Issue a token above, or connect from the agent with OAuth.</p>`,
    );
  }
  const grants = byId("grants-list");
  if (grants) {
    render(
      grants,
      state.grants.length
        ? html`${state.grants.map(grantRow)}`
        : html`<p class="section-empty hint">No approvals yet. They appear here once you approve a request in the Inbox.</p>`,
    );
  }
  const sessions = byId("sessions-list");
  if (sessions) render(sessions, html`${state.sessions.map(sessionRow)}`);
  renderFilters();
  renderActivity();
}

export function setAgentsTab(tab: AgentsTab): void {
  currentTab = tab;
  for (const t of AGENTS_TABS) {
    const link = byId(`tab-${t}`);
    if (link) {
      link.setAttribute("aria-selected", t === tab ? "true" : "false");
      link.setAttribute("tabindex", t === tab ? "0" : "-1");
    }
    setHidden(`tabpanel-${t}`, t !== tab);
  }
}

export async function loadAccess(route?: Route): Promise<void> {
  if (route) state.filter = { agent: route.agent, credential: route.credential };
  setHidden("access-error", true);
  try {
    const snap = await api("/api/access");
    if (snap.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!snap.ok) throw new Error(errorMessage(snap, "Could not load agents"));
    state.clients = arr(snap.body.clients, isClient);
    state.grants = arr(snap.body.grants, isAccessGrant);
    state.sessions = arr(snap.body.sessions, isSession);
    state.page = 0;
    try {
      const audit = await api(`/api/audit${qs({ client_id: state.filter.agent, item_name: state.filter.credential })}`);
      state.audit = audit.ok ? arr(audit.body.audit, isAudit) : [];
      state.auditError = audit.ok ? "" : errorMessage(audit, "Could not load activity");
    } catch (err) {
      state.audit = [];
      state.auditError = loadErrorText(err, "Could not load activity");
    }
    renderLists();
  } catch (err) {
    showLoadError("access-error", loadErrorText(err, "Could not load agents"), () => {
      void loadAccess();
    });
  }
}

async function changeEnvironment(select: HTMLSelectElement, clientId: string): Promise<void> {
  const note = document.querySelector<HTMLElement>(`[data-env-note="${clientId}"]`);
  const prior = state.clients.find((c) => c.id === clientId)?.environment ?? "";
  select.disabled = true;
  try {
    const r = await api(`/api/clients/${encodeURIComponent(clientId)}/environment`, {
      method: "POST",
      body: JSON.stringify({ environment: select.value }),
    });
    if (r.status === 404) {
      select.value = prior;
      if (note) {
        note.textContent = "This server cannot change an agent's environment yet.";
        note.hidden = false;
      }
      return;
    }
    if (!r.ok) {
      select.value = prior;
      flash(errorMessage(r, "Could not change the environment"), false);
      return;
    }
    flash(`${clientName(clientId)} now uses ${select.value}.`, true);
    await loadAccess();
  } catch (err) {
    select.value = prior;
    flash(loadErrorText(err, "Could not change the environment"), false);
  } finally {
    select.disabled = false;
  }
}

export function bindAccess(h: AccessHandlers): void {
  accessHandlers = h;
  const panel = document.querySelector<HTMLElement>('[data-panel="agents"]');
  panel?.addEventListener("click", (e) => {
    if (!(e.target instanceof Element) || !accessHandlers) return;
    const b = e.target.closest<HTMLButtonElement>("button[data-client-rotate],button[data-client-revoke],button[data-grant-revoke],button[data-session-revoke]");
    if (!b) return;
    const d = b.dataset;
    if (d.clientRotate) {
      const c = state.clients.find((x) => x.id === d.clientRotate);
      if (c) accessHandlers.onRotateClient(c);
    } else if (d.clientRevoke) {
      const c = state.clients.find((x) => x.id === d.clientRevoke);
      if (c) accessHandlers.onRevokeClient(c);
    } else if (d.grantRevoke) {
      const g = state.grants.find((x) => x.id === d.grantRevoke);
      if (g) accessHandlers.onRevokeGrant(g);
    } else if (d.sessionRevoke) {
      const s = state.sessions.find((x) => x.id === d.sessionRevoke);
      if (s) accessHandlers.onRevokeSession(s);
    }
  });
  panel?.addEventListener("change", (e) => {
    const t = e.target;
    if (t instanceof HTMLSelectElement && t.dataset.envClient) void changeEnvironment(t, t.dataset.envClient);
  });
  const filters = byId<HTMLFormElement>("activity-filters");
  filters?.addEventListener("change", () => {
    const agent = filters.elements.namedItem("agent");
    const cred = filters.elements.namedItem("credential");
    accessHandlers?.navigate(
      agentsHash("activity", {
        agent: agent instanceof HTMLSelectElement ? agent.value : "",
        credential: cred instanceof HTMLSelectElement ? cred.value : "",
      }),
    );
  });
  filters?.addEventListener("submit", (e) => e.preventDefault());
  byId("activity-more")?.addEventListener("click", () => {
    state.page += 1;
    renderActivity();
  });
  byId("agents-tabs")?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = AGENTS_TABS.indexOf(currentTab);
    const next = AGENTS_TABS[(i + (e.key === "ArrowRight" ? 1 : AGENTS_TABS.length - 1)) % AGENTS_TABS.length];
    if (next) {
      e.preventDefault();
      accessHandlers?.navigate(agentsHash(next, state.filter));
      byId(`tab-${next}`)?.focus();
    }
  });
}

