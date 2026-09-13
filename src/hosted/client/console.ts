/// <reference lib="dom" />
/** Console boot: routing, session gate, dialogs, and the wiring between panels. */
import { formKindForItem, storeRequestBody } from "../store-form-fields.ts";
import { providerById } from "../providers/registry.ts";
import type { Provider } from "../providers/types.ts";
import { bindAccess, clientName, loadAccess, setAgentsTab } from "./access.ts";
import { bindAccount, loadAccount } from "./account.ts";
import { bindCredentials, closeDrawer, connectProviderFor, findItem, loadItems, openDrawer } from "./credentials.ts";
import { bindInbox, loadInbox, onDeny, onDenyNeed } from "./inbox.ts";
import { PANEL_COPY, type Panel, parseRoute, type Route } from "./routes.ts";
import {
  api,
  arr,
  bindDialogClosers,
  busy,
  byId,
  closeDialog,
  copyText,
  errorMessage,
  flash,
  isJson,
  loadErrorText,
  onUnauthorized,
  openDialog,
  setFormNotice,
  setHidden,
  text,
} from "./shared.ts";
import { bindStoreForm, fillConnectRedirectUri, readStoreValues, setField, storeValidationError, syncStoreFields } from "./store-form.ts";
import { bindOrgSwitcher, bindTeam, isTeamRoute, loadOrgs, loadTeam, TEAM_COPY } from "./team.ts";
import type { ItemRow } from "./types.ts";

const STORE_IDS = {
  usernameRow: "store-username",
  usernameLabel: "store-username-label",
  valueLabel: "store-value-label",
  injectSummary: "store-inject-summary",
  kindHint: "store-kind-hint",
  redirectRow: "store-redirect",
  redirectUri: "store-redirect-uri",
  redirectCopy: "store-redirect-copy",
};

let current: Route = parseRoute("");
let signedOut = false;

/* ---------- routing ---------- */

/** Team lives at `#account/team`: an Account route drawn as its own panel. */
function teamShown(route: Route): boolean {
  return route.panel === "account" && isTeamRoute(location.hash);
}

function applyRoute(route: Route): void {
  current = route;
  const panel: Panel = route.panel;
  const shown: Panel | "team" = teamShown(route) ? "team" : panel;
  document.querySelectorAll<HTMLElement>("[data-panel]").forEach((p) => {
    p.classList.toggle("is-active", p.dataset.panel === shown);
  });
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((a) => {
    if (a.dataset.nav === shown) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const copy = shown === "team" ? TEAM_COPY : PANEL_COPY[panel];
  if (!signedOut) {
    text(byId("page-title"), copy.title);
    text(byId("page-lede"), copy.lede);
  }
  const storeBtn = byId("open-store");
  if (storeBtn) storeBtn.hidden = signedOut || panel !== "credentials";
  setHidden("breakglass", !route.breakglass);
  if (panel === "agents") setAgentsTab(route.tab);
  // The drawer opens from loadCredentials, once the item list it reads from is loaded.
  if (panel !== "credentials" || !route.itemId) closeDrawer();
}

/** Programmatic navigation: push a history entry then render. */
function navigate(hash: string): void {
  if (location.hash !== hash) history.pushState(null, "", hash);
  const route = parseRoute(hash);
  applyRoute(route);
  void loadForRoute(route);
}

/** Arriving on a panel refreshes it, so a switch never shows data older than the last poll. */
async function loadForRoute(route: Route): Promise<void> {
  if (route.panel === "agents") await loadAccess(route);
  else if (teamShown(route)) await loadTeam();
  else if (route.panel === "account") await loadAccount();
  else if (route.panel === "inbox") await loadInbox();
  else await loadCredentials(route);
}

/**
 * What a `#credentials/item/<id>` route opens once the item is loaded: the connect dialog when
 * the query names a provider (`?connect=`, the link an agent's user_connect_required result
 * carries, or an inbox Connect button), else the detail drawer. False when no loaded item has the id.
 */
async function openItemRoute(route: Route): Promise<boolean> {
  if (!route.connect) return openDrawer(route.itemId);
  const item = findItem(route.itemId);
  if (!item) return false;
  const provider = connectProviderFor(item);
  if (!provider || provider.id !== route.connect) {
    flash(`${item.name} has no ${providerById(route.connect)?.displayName ?? route.connect} connect.`, false);
    return true;
  }
  await openConnect(item, provider, { agentId: route.agent, needId: route.need });
  return true;
}

/**
 * The credentials panel, and the drawer (or connect dialog) when the route names an item. A
 * row click opens the drawer at once from the loaded list; a deep link on a fresh page waits
 * for the list first. An id no loaded item has (deleted, or from another org) says so and
 * returns to the list.
 */
async function loadCredentials(route: Route): Promise<void> {
  if (!route.itemId) {
    await loadItems();
    return;
  }
  if (findItem(route.itemId)) {
    void openItemRoute(route);
    await loadItems();
    return;
  }
  const loaded = await loadItems();
  // Navigation may have changed while the credential list was in flight.
  if (current !== route) return;
  if (!loaded || (await openItemRoute(route))) return;
  flash("That credential was not found. It may have been deleted.", false);
  navigate("#credentials");
}

function onHashChange(): void {
  const route = parseRoute(location.hash);
  applyRoute(route);
  void loadForRoute(route);
}

/* ---------- session ---------- */

function sessionOut(out: boolean): void {
  signedOut = out;
  document.body.dataset.session = out ? "out" : "in";
  setHidden("signed-out-gate", !out);
  const main = byId("main");
  if (main) main.hidden = out;
  const signin = byId("console-signin");
  if (signin && signin.querySelector("a")) signin.hidden = !out;
  setHidden("sign-out", out);
  if (out) {
    text(byId("page-title"), "Sign in");
    text(byId("page-lede"), "This tab needs an operator session.");
    const storeBtn = byId("open-store");
    if (storeBtn) storeBtn.hidden = true;
  } else applyRoute(current);
}

function reloadAll(): void {
  void loadItems();
  void loadInbox();
  void loadAccess(current);
  if (teamShown(current)) void loadTeam();
  else if (current.panel === "account") void loadAccount();
}

/* ---------- confirm ---------- */

type ConfirmSpec = {
  title: string;
  body: string;
  button: string;
  run: () => Promise<{ ok: boolean; message: string }>;
  after?: () => void;
};

let pendingConfirm: ConfirmSpec | undefined;

function openConfirm(spec: ConfirmSpec): void {
  pendingConfirm = spec;
  text(byId("confirm-title"), spec.title);
  text(byId("confirm-body"), spec.body);
  text(byId("confirm-yes"), spec.button);
  setFormNotice("confirm-error", "", true);
  openDialog("confirm");
}

async function postAction(url: string, fallback: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await api(url, { method: "POST", body: "{}" });
    return { ok: r.ok, message: r.ok ? "" : errorMessage(r, fallback) };
  } catch (err) {
    return { ok: false, message: loadErrorText(err, fallback) };
  }
}

function bindConfirm(): void {
  const yes = byId<HTMLButtonElement>("confirm-yes");
  yes?.addEventListener("click", () => {
    const spec = pendingConfirm;
    if (!spec) return;
    void busy(yes, async () => {
      const result = await spec.run();
      if (!result.ok) {
        setFormNotice("confirm-error", result.message || "Request failed", false);
        return;
      }
      closeDialog("confirm");
      spec.after?.();
      reloadAll();
    });
  });
}

/* ---------- once-shown token ---------- */

function showIssuedToken(agentName: string, token: string): void {
  text(byId("token-agent"), agentName);
  text(byId("token-value"), token);
  text(byId("token-live"), `A token for ${agentName} is shown once. Copy it now.`);
  const copy = byId<HTMLButtonElement>("token-copy");
  if (copy) copy.onclick = () => copyText(token, "Token copied");
  openDialog("token-dialog");
  byId<HTMLDialogElement>("token-dialog")?.addEventListener(
    "close",
    () => {
      text(byId("token-value"), "");
      text(byId("token-live"), "");
    },
    { once: true },
  );
}

/* ---------- store / edit / rotate ---------- */

function setStoreMode(editing: boolean): void {
  text(byId("store-title"), editing ? "Edit credential" : "Store credential");
  text(byId("store-submit"), editing ? "Save" : "Store");
}

function openStore(item?: ItemRow): void {
  const form = byId<HTMLFormElement>("store");
  if (!form) return;
  setFormNotice("store-error", "", true);
  form.reset();
  const value = byId<HTMLInputElement>("store-value");
  const env = byId<HTMLSelectElement>("store-env");
  if (item) {
    setField(form, "item_id", item.id);
    setField(form, "name", item.name);
    setField(form, "kind", formKindForItem(item.kind, item.inject));
    if (env && item.environment) env.value = item.environment;
    setField(form, "username", item.username ?? "");
    setField(form, "allowed_hosts", (item.allowedHosts ?? item.allowed_hosts ?? []).join(", "));
    setField(form, "inject", item.inject || (form.elements.namedItem("kind") instanceof HTMLSelectElement && formKindForItem(item.kind, item.inject) === "client_secret" ? "client_credentials" : "bearer"));
    if (value) {
      value.required = false;
      value.placeholder = "Leave blank to keep the current secret";
    }
  } else {
    setField(form, "item_id", "");
    if (env) env.value = document.documentElement.dataset.defaultEnvironment ?? env.value;
    setField(form, "inject", "bearer");
    if (value) {
      value.required = true;
      value.placeholder = "";
    }
  }
  const adv = byId<HTMLDetailsElement>("store-inject-advanced");
  if (adv) adv.open = false;
  setStoreMode(Boolean(item));
  syncStoreFields(form, STORE_IDS);
  openDialog("store-dialog");
  byId<HTMLInputElement>("store-name")?.focus();
}

function bindStore(): void {
  const form = byId<HTMLFormElement>("store");
  if (!form) return;
  bindStoreForm(form, STORE_IDS);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const values = readStoreValues(form);
    const itemId = (form.elements.namedItem("item_id") as HTMLInputElement | null)?.value ?? "";
    const editing = Boolean(itemId);
    const problem = storeValidationError(values, { editing });
    if (problem) {
      setFormNotice("store-error", problem, false);
      return;
    }
    setFormNotice("store-error", "", true);
    void busy(form, async () => {
      const body = storeRequestBody(values, { editing });
      const url = editing ? `/api/items/${encodeURIComponent(itemId)}` : "/api/items";
      try {
        const r = await api(url, { method: "POST", body: JSON.stringify(body) });
        if (r.ok) {
          setField(form, "value", "");
          flash(editing ? `Updated ${values.name}` : `Stored ${values.name}`, true);
          closeDialog("store-dialog");
          void loadItems();
        } else {
          setFormNotice("store-error", errorMessage(r, editing ? "Update failed" : "Store failed"), false);
        }
      } catch (err) {
        setFormNotice("store-error", loadErrorText(err, editing ? "Update failed" : "Store failed"), false);
      }
    });
  });
  byId("open-store")?.addEventListener("click", () => openStore());
  byId("empty-store")?.addEventListener("click", () => openStore());
}

function openRotate(item: ItemRow): void {
  const form = byId<HTMLFormElement>("rotate");
  if (!form) return;
  setFormNotice("rotate-error", "", true);
  setField(form, "id", item.id);
  setField(form, "value", "");
  text(byId("rotate-name"), item.name);
  openDialog("rotate-dialog");
  byId<HTMLInputElement>("rotate-value")?.focus();
}

function bindRotate(): void {
  const form = byId<HTMLFormElement>("rotate");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = (form.elements.namedItem("id") as HTMLInputElement | null)?.value ?? "";
    const value = (form.elements.namedItem("value") as HTMLInputElement | null)?.value ?? "";
    if (!value) {
      setFormNotice("rotate-error", "Enter the new value.", false);
      return;
    }
    setFormNotice("rotate-error", "", true);
    void busy(form, async () => {
      try {
        const r = await api(`/api/items/${encodeURIComponent(id)}/rotate`, { method: "POST", body: JSON.stringify({ value }) });
        if (r.ok) {
          setField(form, "value", "");
          flash("Rotated. Agents use the new value on their next call.", true);
          closeDialog("rotate-dialog");
          void loadItems();
        } else setFormNotice("rotate-error", errorMessage(r, "Rotate failed"), false);
      } catch (err) {
        setFormNotice("rotate-error", loadErrorText(err, "Rotate failed"), false);
      }
    });
  });
}

/* ---------- provider user connect (items whose hosts belong to a registry provider) ---------- */

/** The agent's display name: from the loaded Agents snapshot, else one fetch, else a generic label. */
async function agentLabel(id: string): Promise<string> {
  const known = clientName(id);
  if (known !== id) return known;
  try {
    const r = await api("/api/access");
    const found = arr(r.body.clients, isJson).find((c) => c.id === id);
    if (found && typeof found.name === "string" && found.name) return found.name;
  } catch {
    // Fall through: the label is cosmetic; the id still rides on the request.
  }
  return "this agent";
}

/**
 * Opens the connect dialog for an item. With `agentId` (an inbox card or a `?connect=` deep link)
 * the "also allow" checkbox is shown checked, so the connect also stands that agent on this
 * credential (and the refresh item); `needId` lets the callback close the inbox card.
 */
async function openConnect(item: ItemRow, provider: Provider, opts: { agentId?: string; needId?: string } = {}): Promise<void> {
  const form = byId<HTMLFormElement>("connect-provider");
  if (!form) return;
  setFormNotice("connect-error", "", true);
  setField(form, "provider_id", provider.id);
  setField(form, "item_name", item.name);
  setField(form, "environment", item.environment || "staging");
  setField(form, "client_id", item.username ?? "");
  setField(form, "agent_client_id", opts.agentId ?? "");
  setField(form, "need_id", opts.needId ?? "");
  text(byId("connect-title"), `Connect ${provider.displayName} account`);
  text(byId("connect-provider-name"), provider.displayName);
  text(byId("connect-client-id-label"), `${provider.displayName} Client ID`);
  text(byId("connect-submit"), `Open ${provider.displayName}`);
  const allow = byId<HTMLInputElement>("connect-allow-agent");
  if (allow) allow.checked = Boolean(opts.agentId);
  setHidden("connect-agent-row", !opts.agentId);
  if (opts.agentId) text(byId("connect-agent-label"), `Also allow ${await agentLabel(opts.agentId)} to use the connected account`);
  fillConnectRedirectUri("connect-redirect-uri");
  openDialog("connect-dialog");
  byId<HTMLInputElement>("connect-client-id")?.focus();
}

function bindConnect(): void {
  byId("connect-redirect-copy")?.addEventListener("click", () => {
    const uri = byId("connect-redirect-uri")?.textContent ?? "";
    copyText(uri, "Redirect URI copied");
  });
  const form = byId<HTMLFormElement>("connect-provider");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    setFormNotice("connect-error", "", true);
    const read = (n: string): string => (form.elements.namedItem(n) as HTMLInputElement | null)?.value ?? "";
    const name = providerById(read("provider_id"))?.displayName ?? "provider";
    const allowAgent = byId<HTMLInputElement>("connect-allow-agent")?.checked === true;
    const agentId = allowAgent ? read("agent_client_id") : "";
    const needId = read("need_id");
    void busy(form, async () => {
      try {
        const r = await api(`/api/integrations/${encodeURIComponent(read("provider_id"))}/start`, {
          method: "POST",
          body: JSON.stringify({
            item_name: read("item_name"),
            environment: read("environment"),
            client_id: read("client_id"),
            ...(agentId ? { agent_client_id: agentId } : {}),
            ...(needId ? { need_id: needId } : {}),
          }),
        });
        const url = r.body.authorize_url;
        if (!r.ok || typeof url !== "string") {
          setFormNotice("connect-error", errorMessage(r, `Could not start the ${name} connect`), false);
          return;
        }
        window.location.href = url;
      } catch (err) {
        setFormNotice("connect-error", loadErrorText(err, `Could not start the ${name} connect`), false);
      }
    });
  });
  // Closing a dialog a `?connect=` deep link opened returns to the list, so a reload does not
  // reopen it. Only while the route still names the item this dialog was opened for: the close
  // event lands a task after the dialog closes, and a newer route must not be clobbered.
  byId<HTMLDialogElement>("connect-dialog")?.addEventListener("close", () => {
    const route = parseRoute(location.hash);
    const name = (byId<HTMLFormElement>("connect-provider")?.elements.namedItem("item_name") as HTMLInputElement | null)?.value;
    if (route.connect && route.itemId && name && findItem(route.itemId)?.name === name) navigate("#credentials");
  });
  // The callback lands on `#vault?connected=<provider>` or `#vault?connect_error=<provider>`.
  const q = parseRoute(location.hash).query;
  const connected = q.get("connected");
  const failed = q.get("connect_error");
  if (connected) {
    const name = providerById(connected)?.displayName ?? "Account";
    const forAgent = q.get("agent") ? " The agent can retry its call now." : "";
    flash(`${name} account connected. The refresh token is stored. The agent does not get it.${forAgent}`, true);
  }
  if (failed) {
    const name = providerById(failed)?.displayName ?? "The provider";
    flash(`${name} connect failed. Check the Client ID and the redirect URI on the ${name} app.`, false);
  }
}

/* ---------- issue token ---------- */

function bindIssue(): void {
  const form = byId<HTMLFormElement>("issue");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    setFormNotice("issue-error", "", true);
    const nameEl = form.elements.namedItem("name");
    const envEl = form.elements.namedItem("environment");
    const name = (nameEl instanceof HTMLInputElement ? nameEl.value.trim() : "") || "claude-desktop";
    const environment = envEl instanceof HTMLSelectElement ? envEl.value : "";
    void busy(form, async () => {
      try {
        const r = await api("/api/clients/model", { method: "POST", body: JSON.stringify({ name, environment }) });
        const token = r.body.token;
        if (!r.ok || typeof token !== "string") {
          setFormNotice("issue-error", errorMessage(r, "Could not issue a token"), false);
          return;
        }
        showIssuedToken(name, token);
        if (nameEl instanceof HTMLInputElement) nameEl.value = "";
        void loadAccess(current);
      } catch (err) {
        setFormNotice("issue-error", loadErrorText(err, "Could not issue a token"), false);
      }
    });
  });
  const mcp = byId("mcp_url");
  if (mcp) mcp.textContent = `${location.origin}/mcp`;
  byId("copy-mcp")?.addEventListener("click", () => copyText(`${location.origin}/mcp`, "MCP URL copied"));
}

/* ---------- boot ---------- */

function bindBreakglass(): void {
  const boot = byId<HTMLFormElement>("bootstrap");
  boot?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = boot.elements.namedItem("token");
    const token = input instanceof HTMLInputElement ? input.value.trim() : "";
    try {
      sessionStorage.setItem("vault_op_token", token);
    } catch {
      flash("This browser blocks session storage; the token cannot be kept.", false);
      return;
    }
    if (input instanceof HTMLInputElement) input.value = "";
    flash("Bootstrap token saved in this tab", true);
    sessionOut(false);
    reloadAll();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindDialogClosers();
  onUnauthorized(() => sessionOut(true));
  bindConfirm();
  bindStore();
  bindRotate();
  bindConnect();
  bindIssue();
  bindBreakglass();
  bindAccount();
  bindOrgSwitcher();
  bindTeam({
    onRemoveMember: (m, run) =>
      openConfirm({
        title: `Remove ${m.email || m.user_id} from this workspace?`,
        body: "They lose access to every credential and approval here now. You can invite them again later.",
        button: "Remove member",
        run,
        after: () => flash(`Removed ${m.email || m.user_id}`, true),
      }),
    onCancelInvite: (inv, run) =>
      openConfirm({
        title: `Cancel the invite for ${inv.email}?`,
        body: "The link in their email stops working now.",
        button: "Cancel invite",
        run,
        after: () => flash(`Cancelled the invite for ${inv.email}`, true),
      }),
  });
  bindInbox({
    onCount: (count) => {
      const badge = byId("inbox-badge");
      if (badge) {
        badge.textContent = String(count);
        badge.dataset.count = String(count);
        badge.setAttribute("aria-label", `${count} waiting`);
      }
    },
    onChanged: () => void loadAccess(current),
  });
  onDeny(async (_id, client, name, run) => {
    openConfirm({
      title: `Deny ${client}'s request for ${name}?`,
      body: "The agent gets no access to this credential. It can ask again later.",
      button: "Deny request",
      // A failed deny keeps the dialog open with the server's message, like every other confirm.
      run,
    });
  });
  onDenyNeed(async (_id, client, provider, run) => {
    openConfirm({
      title: `Deny ${client}'s request to connect a ${provider} account?`,
      body: "No account is connected and the agent keeps only the app credential. It can ask again later.",
      button: "Deny request",
      run,
    });
  });
  const revokeGrant = (id: string, client: string, name: string, standing = false): void =>
    openConfirm({
      title: standing ? `Clear standing approval for ${client} on ${name}?` : `Revoke ${client}'s approval for ${name}?`,
      body: standing
        ? `${client} will need Inbox approval the next time it uses ${name}.`
        : "The agent must ask again before it can use this credential.",
      button: standing ? "Clear standing approval" : "Revoke approval",
      run: () => postAction(`/api/grants/${encodeURIComponent(id)}/revoke`, "Revoke failed"),
    });
  bindCredentials(
    {
      onEdit: (item) => openStore(item),
      onRotate: openRotate,
      onConnect: (item, provider) => void openConnect(item, provider),
      onDelete: (item) =>
        openConfirm({
          title: `Delete ${item.name}?`,
          body: "Agents with an approval lose access now. This cannot be undone.",
          button: `Delete ${item.name}`,
          run: async () => {
            try {
              const r = await api(`/api/items/${encodeURIComponent(item.id)}`, { method: "DELETE" });
              return { ok: r.ok, message: r.ok ? "" : errorMessage(r, "Delete failed") };
            } catch (err) {
              return { ok: false, message: loadErrorText(err, "Delete failed") };
            }
          },
          after: () => flash(`Deleted ${item.name}`, true),
        }),
      navigate,
    },
    revokeGrant,
  );
  bindAccess({
    onRevokeClient: (c) =>
      openConfirm({
        title: `Revoke access for ${c.name}?`,
        body: "Its token and every approval stop working now. The agent must be connected again to get access back.",
        button: "Revoke access",
        run: () => postAction(`/api/clients/${encodeURIComponent(c.id)}/revoke`, "Revoke failed"),
        after: () => flash(`Access revoked for ${c.name}`, true),
      }),
    onRotateClient: (c) =>
      openConfirm({
        title: `Rotate the token for ${c.name}?`,
        body: "The current token stops working now. You will see the new token once.",
        button: "Rotate token",
        run: async () => {
          try {
            const r = await api(`/api/clients/${encodeURIComponent(c.id)}/rotate`, { method: "POST", body: "{}" });
            const token = r.body.token;
            if (!r.ok) return { ok: false, message: errorMessage(r, "Rotate failed") };
            if (typeof token !== "string") return { ok: false, message: "Rotate did not return a token" };
            showIssuedToken(c.name, token);
            return { ok: true, message: "" };
          } catch (err) {
            return { ok: false, message: loadErrorText(err, "Rotate failed") };
          }
        },
      }),
    onRevokeGrant: (g) =>
      revokeGrant(g.id, g.client_name, g.item_name || "this credential", g.policy === "item_standing" || g.policy === "folder_standing"),
    onRevokeSession: (s) =>
      openConfirm({
        title: "Sign out that device?",
        body: `Session ${s.id} ends now. Anyone using it must sign in again.`,
        button: "Sign out device",
        run: () => postAction(`/api/sessions/${encodeURIComponent(s.id)}/revoke`, "Could not end the session"),
      }),
    navigate,
  });
  // hashchange alone: browsers fire popstate for every hash navigation too, so binding both
  // loaded each panel twice. Boot loads the route's panel once, plus the inbox for its badge.
  window.addEventListener("hashchange", onHashChange);
  const initial = parseRoute(location.hash);
  applyRoute(initial);
  void loadForRoute(initial);
  if (initial.panel !== "inbox") void loadInbox();
  void loadOrgs();
});
