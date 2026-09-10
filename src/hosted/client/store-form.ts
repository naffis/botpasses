/// <reference lib="dom" />
/**
 * Store / edit / fulfill form behaviour shared by the console dialog and the collect page.
 * All vocabulary comes from ../store-form-fields.ts so the server and browser agree.
 */
import { defaultConnectRedirect } from "../providers/connect-redirect.ts";
import {
  defaultInjectForKind,
  injectSummary,
  isValidItemName,
  ITEM_NAME_HINT,
  kindHint,
  needsLoginUsername,
  normalizeItemNameInput,
  usernameFieldLabel,
  valueFieldLabel,
  type StoreFormValues,
} from "../store-form-fields.ts";
import { byId, copyText } from "./shared.ts";

/** Element ids around one form, e.g. `store-*` in the console and `fulfill-*` on collect. */
export type StoreFormIds = {
  usernameRow: string;
  usernameLabel: string;
  valueLabel: string;
  injectSummary: string;
  kindHint?: string;
  redirectRow?: string;
  redirectUri?: string;
  redirectCopy?: string;
};

/** The exact redirect URI this origin will send on a user connect. */
export function fillConnectRedirectUri(codeId: string): string {
  const uri = defaultConnectRedirect(location.origin);
  const code = byId(codeId);
  if (code) code.textContent = uri;
  return uri;
}

export function field<T extends HTMLInputElement | HTMLSelectElement>(form: HTMLFormElement, name: string): T | null {
  const el = form.elements.namedItem(name);
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? (el as T) : null;
}

export function fieldValue(form: HTMLFormElement, name: string): string {
  return field(form, name)?.value ?? "";
}

export function setField(form: HTMLFormElement, name: string, value: string): void {
  const el = field(form, name);
  if (el) el.value = value;
}

/** Show the username row only when the Kind or send method needs it; relabel Value. */
export function syncStoreFields(form: HTMLFormElement, ids: StoreFormIds): void {
  const kind = fieldValue(form, "kind");
  const inject = fieldValue(form, "inject");
  const show = needsLoginUsername(kind, inject);
  const row = byId(ids.usernameRow);
  if (row) {
    row.hidden = !show;
    if (!show) setField(form, "username", "");
  }
  const userLabel = byId(ids.usernameLabel);
  if (userLabel) userLabel.textContent = usernameFieldLabel(kind, inject);
  const valueLabel = byId(ids.valueLabel);
  if (valueLabel) valueLabel.textContent = valueFieldLabel(kind, inject);
  const summary = byId(ids.injectSummary);
  if (summary) summary.textContent = injectSummary(inject);
  if (ids.kindHint) {
    const hint = byId(ids.kindHint);
    const textHint = kindHint(kind);
    if (hint) {
      hint.textContent = textHint;
      hint.hidden = !textHint;
    }
  }
  if (ids.redirectRow) {
    const row = byId(ids.redirectRow);
    const show = kind === "client_secret";
    if (row) row.hidden = !show;
    if (show && ids.redirectUri) {
      const code = byId(ids.redirectUri);
      if (code) code.textContent = defaultConnectRedirect(location.origin);
    }
  }
}

/** Kind change picks the send method; inject change and typing keep the rest in sync. */
export function bindStoreForm(form: HTMLFormElement, ids: StoreFormIds): void {
  const kind = field<HTMLSelectElement>(form, "kind");
  const inject = field<HTMLSelectElement>(form, "inject");
  const name = field<HTMLInputElement>(form, "name");
  kind?.addEventListener("change", () => {
    setField(form, "inject", defaultInjectForKind(kind.value));
    syncStoreFields(form, ids);
  });
  inject?.addEventListener("change", () => syncStoreFields(form, ids));
  name?.addEventListener("input", () => {
    const next = normalizeItemNameInput(name.value);
    if (next !== name.value) {
      const pos = name.selectionStart ?? next.length;
      name.value = next;
      const at = Math.min(pos, next.length);
      try {
        name.setSelectionRange(at, at);
      } catch {
        /* type=search or unfocused inputs may refuse; harmless */
      }
    }
  });
  if (ids.redirectCopy && ids.redirectUri) {
    const uriId = ids.redirectUri;
    byId(ids.redirectCopy)?.addEventListener("click", () => {
      copyText(byId(uriId)?.textContent ?? "", "Redirect URI copied");
    });
  }
  syncStoreFields(form, ids);
}

export function readStoreValues(form: HTMLFormElement): StoreFormValues {
  return {
    name: fieldValue(form, "name").trim(),
    kind: fieldValue(form, "kind"),
    inject: fieldValue(form, "inject"),
    username: fieldValue(form, "username"),
    allowedHosts: fieldValue(form, "allowed_hosts"),
    value: fieldValue(form, "value"),
    environment: fieldValue(form, "environment") || undefined,
  };
}

/** Client-side check before the request. Empty string means valid. */
export function storeValidationError(values: StoreFormValues, opts: { editing: boolean }): string {
  if (!values.name) return "Name is required.";
  if (!isValidItemName(values.name)) return `Name must match the pattern. ${ITEM_NAME_HINT}`;
  if (!values.allowedHosts.trim()) return "Add at least one allowed host.";
  if (!opts.editing && !values.value) return "Value is required.";
  return "";
}
