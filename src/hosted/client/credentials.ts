/// <reference lib="dom" />
/** Credentials panel: filterable, sortable table plus a detail drawer. */
import { kindPillLabel } from "../store-form-fields.ts";
import { providerForHost } from "../providers/registry.ts";
import type { Provider } from "../providers/types.ts";
import type { AccessGrant, ItemRow } from "./types.ts";
import {
  api,
  arr,
  byId,
  errorMessage,
  formatWhen,
  handleUnauthorized,
  html,
  isJson,
  loadErrorText,
  openDialog,
  render,
  SafeHtml,
  setHidden,
  showLoadError,
  timeHtml,
} from "./shared.ts";
import { itemHash } from "./routes.ts";

export type CredentialHandlers = {
  onEdit: (item: ItemRow) => void;
  onRotate: (item: ItemRow) => void;
  onDelete: (item: ItemRow) => void;
  onConnect: (item: ItemRow, provider: Provider) => void;
  /** Called with the new hash when the drawer opens or closes by user action. */
  navigate: (hash: string) => void;
};

export type ItemFilter = { q: string; environment: string; kind: string; sort: "name" | "updated" };

let items: ItemRow[] = [];
let credHandlers: CredentialHandlers | undefined;

function isItem(v: unknown): v is ItemRow {
  return isJson(v) && typeof v.id === "string" && typeof v.name === "string";
}

export function itemHosts(i: ItemRow): string[] {
  return i.allowedHosts ?? i.allowed_hosts ?? [];
}

/**
 * The provider whose user connect flow this item can start: one of its hosts belongs to a
 * registry provider with an authorize URL. A stored refresh token is the output of that flow,
 * not its input, so `refresh` items offer no connect.
 */
export function connectProviderFor(i: ItemRow): Provider | undefined {
  // The connect flow exchanges a code with the app's client secret; an API token has none.
  if (i.kind !== "client_secret" || i.inject === "refresh") return undefined;
  for (const host of itemHosts(i)) {
    const provider = providerForHost(host);
    if (provider?.authorizeUrl) return provider;
  }
  return undefined;
}

function updatedAt(i: ItemRow): string {
  return i.updated_at ?? i.updatedAt ?? i.created_at ?? i.createdAt ?? "";
}

/** Pure so tests can cover it: search matches name or host, filters are exact, sort is stable. */
export function filterItems(rows: ItemRow[], f: ItemFilter): ItemRow[] {
  const q = f.q.trim().toLowerCase();
  const out = rows.filter((i) => {
    if (f.environment && i.environment !== f.environment) return false;
    if (f.kind && kindPillLabel(i.kind, i.inject) !== f.kind) return false;
    if (!q) return true;
    return i.name.toLowerCase().includes(q) || itemHosts(i).some((h) => h.toLowerCase().includes(q));
  });
  out.sort((a, b) =>
    f.sort === "updated" ? updatedAt(b).localeCompare(updatedAt(a)) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name),
  );
  return out;
}

export function readFilter(): ItemFilter {
  const form = byId<HTMLFormElement>("items-filters");
  const get = (name: string): string => {
    const el = form?.elements.namedItem(name);
    return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : "";
  };
  return { q: get("q"), environment: get("environment"), kind: get("kind"), sort: get("sort") === "updated" ? "updated" : "name" };
}

function rowHtml(i: ItemRow): SafeHtml {
  const hosts = itemHosts(i);
  const provider = connectProviderFor(i);
  return html`<tr data-item="${i.id}" tabindex="0" role="row" data-testid="item-row">
    <td role="cell" class="name"><span class="cell-label">Name</span><span class="cell-value mono">${i.name}</span></td>
    <td role="cell"><span class="cell-label">Kind</span><span class="cell-value"><span class="pill">${kindPillLabel(i.kind, i.inject)}</span></span></td>
    <td role="cell"><span class="cell-label">Environment</span><span class="cell-value"><span class="pill pill-env">${i.environment}</span></span></td>
    <td role="cell" class="hosts"><span class="cell-label">Hosts</span><span class="cell-value mono host-list">${hosts.map((h) => html`<span>${h}</span>`)}</span></td>
    <td role="cell" class="last4"><span class="cell-label">Last four</span><span class="cell-value mono">····${i.last4}</span></td>
    <td role="cell" class="actions"><span class="cell-label">Actions</span><span class="cell-value row-actions">
      <button type="button" class="btn-ghost btn-small" data-act="edit" data-testid="item-edit">Edit</button>
      <button type="button" class="btn-ghost btn-small" data-act="rotate" data-testid="item-rotate">Rotate</button>
      ${provider ? html`<button type="button" class="btn-ghost btn-small" data-act="connect" data-testid="item-connect">Connect ${provider.displayName} account</button>` : ""}
      <button type="button" class="btn-danger btn-small" data-act="delete" data-testid="item-delete">Delete</button>
    </span></td>
  </tr>`;
}

export function renderItems(): void {
  const body = byId("items");
  if (!body) return;
  const visible = filterItems(items, readFilter());
  setHidden("items-none", !(items.length && !visible.length));
  setHidden("items-table", !visible.length);
  render(body, html`${visible.map(rowHtml)}`);
}

/** Resolves true when the list is fresh; false when the load failed or the session is gone. */
export async function loadItems(): Promise<boolean> {
  const body = byId("items");
  if (!body) return false;
  setHidden("items-error", true);
  try {
    const r = await api("/api/items");
    if (r.status === 401) {
      handleUnauthorized();
      return false;
    }
    if (!r.ok) throw new Error(errorMessage(r, "Could not load credentials"));
    items = arr(r.body.items, isItem);
    setHidden("items-empty", items.length > 0);
    setHidden("items-filters", items.length === 0);
    renderItems();
    return true;
  } catch (err) {
    items = [];
    body.replaceChildren();
    setHidden("items-table", true);
    setHidden("items-empty", true);
    setHidden("items-filters", true);
    // "No credentials match" belongs to a list that loaded; an error box next to it is two answers.
    setHidden("items-none", true);
    showLoadError("items-error", loadErrorText(err, "Could not load credentials"), () => {
      void loadItems();
    });
    return false;
  }
}

export function findItem(id: string): ItemRow | undefined {
  return items.find((i) => i.id === id);
}

function isGrantRow(v: unknown): v is AccessGrant {
  return isJson(v) && typeof v.id === "string";
}

function fact(label: string, value: SafeHtml | string): SafeHtml {
  return html`<dt>${label}</dt><dd>${value}</dd>`;
}

/** Opens the detail drawer for a loaded item. Resolves false when no loaded item has this id. */
export async function openDrawer(id: string): Promise<boolean> {
  const item = findItem(id);
  const drawer = byId<HTMLDialogElement>("item-drawer");
  if (!item || !drawer) return false;
  const title = byId("drawer-title");
  if (title) title.textContent = item.name;
  const created = item.created_at ?? item.createdAt;
  const updated = item.updated_at ?? item.updatedAt;
  render(
    byId("drawer-facts"),
    html`${fact("Kind", kindPillLabel(item.kind, item.inject))}
    ${fact("Environment", item.environment)}
    ${fact("Sent as", item.inject)}
    ${item.username ? fact("Username or client ID", item.username) : ""}
    ${fact("Allowed hosts", itemHosts(item).join(", ") || "None")}
    ${fact("Last four", `····${item.last4}`)}
    ${fact("Created", created ? html`${timeHtml(created)} (${formatWhen(created)})` : "Not reported by this server")}
    ${fact("Updated", updated ? html`${timeHtml(updated)} (${formatWhen(updated)})` : "Not reported by this server")}`,
  );
  render(
    byId("drawer-actions"),
    html`<button type="button" class="btn-ghost" data-act="edit">Edit</button>
    <button type="button" class="btn-ghost" data-act="rotate">Rotate</button>
    <button type="button" class="btn-danger" data-act="delete">Delete</button>`,
  );
  drawer.dataset.item = item.id;
  const approvals = byId("drawer-approvals");
  render(approvals, html`<p class="hint">Loading approvals</p>`);
  openDialog("item-drawer");
  try {
    const r = await api("/api/access");
    const grants = arr(r.body.grants, isGrantRow).filter(
      (g) => g.item_name === item.name && (g.status === "active" || g.status === "pending"),
    );
    render(
      approvals,
      grants.length
        ? html`${grants.map(
            (g) => html`<div class="access-row"><div class="access-row-main"><p class="access-row-title">${g.client_name}</p><p class="access-meta">${g.status} · last used ${g.last_access_at ? timeHtml(g.last_access_at) : "never"}</p></div><div class="access-row-actions"><button type="button" class="btn-danger btn-small" data-revoke-grant="${g.id}" data-revoke-label="${g.client_name}|${item.name}">Revoke</button></div></div>`,
          )}`
        : html`<p class="hint">No agent has an approval for this credential.</p>`,
    );
  } catch (err) {
    render(approvals, html`<p class="hint is-err">${loadErrorText(err, "Could not load approvals")}</p>`);
  }
  return true;
}

export function closeDrawer(): void {
  const drawer = byId<HTMLDialogElement>("item-drawer");
  if (drawer?.open) drawer.close();
}

export function bindCredentials(h: CredentialHandlers, onRevokeGrant: (id: string, client: string, name: string) => void): void {
  credHandlers = h;
  byId("items-filters")?.addEventListener("input", renderItems);
  byId("items-filters")?.addEventListener("change", renderItems);
  byId("items-filters")?.addEventListener("submit", (e) => e.preventDefault());
  const body = byId("items");
  const act = (item: ItemRow, action: string): void => {
    if (!credHandlers) return;
    if (action === "edit") credHandlers.onEdit(item);
    else if (action === "rotate") credHandlers.onRotate(item);
    else if (action === "delete") credHandlers.onDelete(item);
    else if (action === "connect") {
      const provider = connectProviderFor(item);
      if (provider) credHandlers.onConnect(item, provider);
    }
  };
  body?.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    const row = e.target.closest<HTMLTableRowElement>("tr[data-item]");
    if (!row?.dataset.item) return;
    const item = findItem(row.dataset.item);
    if (!item) return;
    const button = e.target.closest<HTMLButtonElement>("button[data-act]");
    if (button?.dataset.act) {
      act(item, button.dataset.act);
      return;
    }
    credHandlers?.navigate(itemHash(item.id));
  });
  body?.addEventListener("keydown", (e) => {
    if (!(e.target instanceof HTMLTableRowElement)) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    // Without preventDefault the same Enter keypress lands on the drawer's Close button, which
    // took focus when the dialog opened, and closes it again; Space would also scroll the page.
    e.preventDefault();
    const id = e.target.dataset.item;
    if (id) credHandlers?.navigate(itemHash(id));
  });
  const drawer = byId<HTMLDialogElement>("item-drawer");
  drawer?.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    const revoke = e.target.closest<HTMLButtonElement>("[data-revoke-grant]");
    if (revoke?.dataset.revokeGrant) {
      const [client, name] = (revoke.dataset.revokeLabel ?? "|").split("|");
      onRevokeGrant(revoke.dataset.revokeGrant, client ?? "the agent", name ?? "this credential");
      return;
    }
    const button = e.target.closest<HTMLButtonElement>("button[data-act]");
    const item = drawer.dataset.item ? findItem(drawer.dataset.item) : undefined;
    if (button?.dataset.act && item) {
      drawer.close();
      act(item, button.dataset.act);
    }
  });
  // Closing the drawer returns to the list only while the route still names this drawer's item.
  // The close event is delivered a task later than the `open` attribute is removed, so a route
  // set in between (another item, a deep link) must not be clobbered by this navigation.
  drawer?.addEventListener("close", () => {
    const id = drawer.dataset.item;
    if (id && location.hash === itemHash(id)) credHandlers?.navigate("#credentials");
  });
}
