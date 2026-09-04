/// <reference lib="dom" />
/** Console boot: routing, session gate, dialogs, and the wiring between panels. */
import { formKindForItem, storeRequestBody } from "../store-form-fields.ts";
import { bindAccess, loadAccess, setAgentsTab } from "./access.ts";
import { bindAccount, loadAccount } from "./account.ts";
import { bindCredentials, closeDrawer, loadItems, openDrawer } from "./credentials.ts";
import { bindInbox, loadInbox, onDeny } from "./inbox.ts";
import { PANEL_COPY, type Panel, parseRoute, type Route } from "./routes.ts";
import {
  api,
  bindDialogClosers,
  busy,
  byId,
  closeDialog,
  copyText,
  errorMessage,
  flash,
  loadErrorText,
  onUnauthorized,
  openDialog,
  setFormNotice,
  setHidden,
  text,
} from "./shared.ts";
import { bindStoreForm, readStoreValues, setField, storeValidationError, syncStoreFields } from "./store-form.ts";
import type { ItemRow } from "./types.ts";

const STORE_IDS = {
  usernameRow: "store-username",
  usernameLabel: "store-username-label",
  valueLabel: "store-value-label",
  injectSummary: "store-inject-summary",
  kindHint: "store-kind-hint",
};

let current: Route = parseRoute("");
let signedOut = false;

/* ---------- routing ---------- */

function applyRoute(route: Route): void {
  current = route;
  const panel: Panel = route.panel;
  document.querySelectorAll<HTMLElement>("[data-panel]").forEach((p) => {
    p.classList.toggle("is-active", p.dataset.panel === panel);
  });
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((a) => {
    if (a.dataset.nav === panel) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const copy = PANEL_COPY[panel];
  if (!signedOut) {
    text(byId("page-title"), copy.title);
    text(byId("page-lede"), copy.lede);
  }
  const storeBtn = byId("open-store");
  if (storeBtn) storeBtn.hidden = signedOut || panel !== "credentials";
  setHidden("breakglass", !route.breakglass);
  if (panel === "agents") setAgentsTab(route.tab);
  if (panel === "credentials" && route.itemId) void openDrawer(route.itemId);
  else closeDrawer();
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
  else if (route.panel === "account") await loadAccount();
  else if (route.panel === "inbox") await loadInbox();
  else await loadItems();
}

function onHashOrPop(): void {
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
  if (current.panel === "account") void loadAccount();
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

/* ---------- spotify user connect (only for spotify-host items) ---------- */

function openSpotify(item: ItemRow): void {
  const form = byId<HTMLFormElement>("spotify-user");
  if (!form) return;
  setFormNotice("spotify-error", "", true);
  setField(form, "item_name", item.name);
  setField(form, "environment", item.environment || "staging");
  if (item.username) setField(form, "client_id", item.username);
  openDialog("spotify-dialog");
}

function bindSpotify(): void {
  const form = byId<HTMLFormElement>("spotify-user");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    setFormNotice("spotify-error", "", true);
    const read = (n: string): string => (form.elements.namedItem(n) as HTMLInputElement | null)?.value ?? "";
    void busy(form, async () => {
      try {
        const r = await api("/api/integrations/spotify/start", {
          method: "POST",
          body: JSON.stringify({ item_name: read("item_name"), environment: read("environment"), client_id: read("client_id") }),
        });
        const url = r.body.authorize_url;
        if (!r.ok || typeof url !== "string") {
          setFormNotice("spotify-error", errorMessage(r, "Could not start Spotify connect"), false);
          return;
        }
        window.location.href = url;
      } catch (err) {
        setFormNotice("spotify-error", loadErrorText(err, "Could not start Spotify connect"), false);
      }
    });
  });
  const q = current.query;
  if (q.get("spotify") === "connected") flash("Spotify user connected. The refresh token is stored; the model never sees it.", true);
  if (q.get("spotify") === "error") flash("Spotify user connect failed. Check the Client ID and the redirect URI on the Spotify app.", false);
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
  bindSpotify();
  bindIssue();
  bindBreakglass();
  bindAccount();
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
      run: async () => {
        await run();
        return { ok: true, message: "" };
      },
    });
  });
  const revokeGrant = (id: string, client: string, name: string): void =>
    openConfirm({
      title: `Revoke ${client}'s approval for ${name}?`,
      body: "The agent must ask again before it can use this credential.",
      button: "Revoke approval",
      run: () => postAction(`/api/grants/${encodeURIComponent(id)}/revoke`, "Revoke failed"),
    });
  bindCredentials(
    {
      onEdit: (item) => openStore(item),
      onRotate: openRotate,
      onSpotify: openSpotify,
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
    onRevokeGrant: (g) => revokeGrant(g.id, g.client_name, g.item_name || "this credential"),
    onRevokeSession: (s) =>
      openConfirm({
        title: "Sign out that device?",
        body: `Session ${s.id} ends now. Anyone using it must sign in again.`,
        button: "Sign out device",
        run: () => postAction(`/api/sessions/${encodeURIComponent(s.id)}/revoke`, "Could not end the session"),
      }),
    navigate,
  });
  window.addEventListener("hashchange", onHashOrPop);
  window.addEventListener("popstate", onHashOrPop);
  const initial = parseRoute(location.hash);
  applyRoute(initial);
  void loadItems();
  void loadInbox();
  void loadForRoute(initial);
});
