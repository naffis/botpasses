/// <reference lib="dom" />
/** Collect page: the operator types a requested credential here, never in chat. */
import { ALLOWED_HOSTS_HELP, INJECT_OPTIONS, injectSummary, ITEM_NAME_HINT, STORE_KIND_OPTIONS, storeRequestBody } from "../store-form-fields.ts";
import {
  api,
  busy,
  byId,
  errorMessage,
  flash,
  html,
  loadErrorText,
  render,
  str,
} from "./shared.ts";
import type { CollectRecipe } from "./types.ts";
import { bindStoreForm, readStoreValues, setField, storeValidationError } from "./store-form.ts";

const FULFILL_IDS = {
  usernameRow: "fulfill-username",
  usernameLabel: "fulfill-username-label",
  valueLabel: "fulfill-value-label",
  injectSummary: "fulfill-inject-summary",
  kindHint: "fulfill-kind-hint",
  redirectRow: "fulfill-redirect",
  redirectUri: "fulfill-redirect-uri",
  redirectCopy: "fulfill-redirect-copy",
};

function recipeOf(need: { recipe?: CollectRecipe }): CollectRecipe | undefined {
  const recipe = need.recipe;
  return recipe && typeof recipe === "object" ? recipe : undefined;
}

function fulfillForm(needId: string, suggestedName: string, host: string, recipe?: CollectRecipe): ReturnType<typeof html> {
  const name = str(recipe?.suggested_name, suggestedName);
  const hosts = recipe?.allowed_hosts?.length ? recipe.allowed_hosts.join(", ") : host;
  const kind = recipe?.kind === "client_secret" ? "client_secret" : "secret";
  const inject = str(recipe?.inject, kind === "client_secret" ? "client_credentials" : "bearer");
  const hint = str(recipe?.hint);
  const dashboard = str(recipe?.dashboard_url);
  return html`<form id="fulfill" data-need-id="${needId}" novalidate>
    ${hint ? html`<p class="hint" id="fulfill-recipe-hint">${hint}</p>` : ""}
    ${dashboard ? html`<p class="hint">Create the app at <a href="${dashboard}" rel="noreferrer">${dashboard}</a>.</p>` : ""}
    <label for="fulfill-name">Name</label>
    <input id="fulfill-name" name="name" required value="${name}" autocomplete="off" spellcheck="false" aria-describedby="fulfill-name-hint" />
    <p id="fulfill-name-hint" class="hint field-hint">${ITEM_NAME_HINT}</p>
    <label for="fulfill-kind">Kind</label>
    <select id="fulfill-kind" name="kind">${STORE_KIND_OPTIONS.map((o) => html`<option value="${o.value}"${o.value === kind ? " selected" : ""}>${o.label}</option>`)}</select>
    <p id="fulfill-kind-hint" class="hint field-hint" hidden></p>
    <div id="fulfill-redirect" hidden data-testid="fulfill-redirect">
      <p class="hint">Add this exact redirect URI on the app (Redirect URIs or callback URL). Same URI for every provider.</p>
      <p class="copy-row"><code id="fulfill-redirect-uri" data-testid="fulfill-redirect-uri"></code> <button type="button" id="fulfill-redirect-copy" class="btn-ghost" data-testid="fulfill-redirect-copy">Copy URI</button></p>
    </div>
    <label for="fulfill-hosts">Allowed hosts</label>
    <input id="fulfill-hosts" name="allowed_hosts" required value="${hosts}" autocomplete="off" spellcheck="false" aria-describedby="fulfill-hosts-hint" />
    <p id="fulfill-hosts-hint" class="hint field-hint">${ALLOWED_HOSTS_HELP}</p>
    <div id="fulfill-username" hidden>
      <label for="fulfill-username-input"><span id="fulfill-username-label">Client ID</span></label>
      <input id="fulfill-username-input" name="username" autocomplete="off" />
    </div>
    <p id="fulfill-inject-summary" class="hint">${injectSummary(inject)}</p>
    <details id="fulfill-inject-advanced">
      <summary>Change how it is sent</summary>
      <label for="fulfill-inject">Send as</label>
      <select id="fulfill-inject" name="inject">${INJECT_OPTIONS.map((o) => html`<option value="${o.value}"${o.value === inject ? " selected" : ""}>${o.label}</option>`)}</select>
    </details>
    <label for="fulfill-value"><span id="fulfill-value-label">Value</span></label>
    <input id="fulfill-value" name="value" type="password" autocomplete="off" required />
    <label class="inline-select">
      <input type="checkbox" id="fulfill-always-allow" name="always_allow" />
      Always allow this agent to use this credential
    </label>
    <button type="submit" class="btn-primary">Store and grant</button>
  </form>`;
}

function bindFulfill(recipe?: CollectRecipe): void {
  const form = byId<HTMLFormElement>("fulfill");
  if (!form) return;
  bindStoreForm(form, FULFILL_IDS);
  const inject = recipe?.inject || (recipe?.kind === "client_secret" ? "client_credentials" : "bearer");
  setField(form, "inject", inject);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const values = readStoreValues(form);
    const problem = storeValidationError(values, { editing: false });
    if (problem) {
      flash(problem, false);
      return;
    }
    const always = byId<HTMLInputElement>("fulfill-always-allow");
    void busy(form, async () => {
      try {
        const r = await api(`/api/need-items/${encodeURIComponent(form.dataset.needId ?? "")}/fulfill`, {
          method: "POST",
          body: JSON.stringify({
            ...storeRequestBody(values, { editing: false }),
            ...(always?.checked ? { always_allow: true } : {}),
          }),
        });
        if (r.ok) setField(form, "value", "");
        flash(r.ok ? "Stored and granted. You can close this tab." : errorMessage(r, "Store failed"), r.ok);
      } catch (err) {
        flash(loadErrorText(err, "Store failed"), false);
      }
    });
  });
}

async function loadNeed(): Promise<void> {
  const details = byId("details");
  const needId = details?.dataset.needId;
  if (!details || !needId) return;
  try {
    const r = await api(`/api/need-items/${encodeURIComponent(needId)}`);
    if (!r.ok) {
      flash(r.status === 401 ? "Sign in to load this request" : errorMessage(r, "Request not found"), false);
      return;
    }
    const need = r.body;
    if (need.kind === "connect") {
      // A connect need has nothing to type in: the operator connects the account from the inbox card.
      render(
        details,
        html`<div class="banner">${str(need.client_name, "An agent")} needs a connected account, not a typed secret</div>
        <p>Open the <a href="/console#inbox">Botpasses inbox</a> and use Connect on its card. Never paste a token here.</p>`,
      );
      return;
    }
    const pending = need.status === "pending";
    const heading = pending ? `${str(need.client_name, "An agent")} needs a credential` : "This request is no longer pending";
    const task = str(need.task_description);
    const recipe = recipeOf(need);
    render(
      details,
      html`<div class="banner">${heading}</div>${task ? html`<p>Task: ${task}</p>` : ""}${
        pending ? fulfillForm(needId, str(need.suggested_name), str(need.host), recipe) : ""
      }`,
    );
    bindFulfill(recipe);
  } catch (err) {
    flash(loadErrorText(err, "Could not load this request"), false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
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
    void loadNeed();
  });
  void loadNeed();
});
