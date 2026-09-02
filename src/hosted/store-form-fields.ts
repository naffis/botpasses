/** Username is HTTP Basic or an OAuth client id. Secret + bearer/header items do not use it. */
export function needsLoginUsername(kind: string, inject: string): boolean {
  return (
    kind === "login" ||
    kind === "client_secret" ||
    inject === "basic" ||
    inject === "client_credentials" ||
    inject === "refresh"
  );
}

/** Kind picks the usual send method. Operators should not have to know HTTP schemes. */
export function defaultInjectForKind(kind: string): "bearer" | "basic" | "client_credentials" {
  if (kind === "login") return "basic";
  if (kind === "client_secret") return "client_credentials";
  return "bearer";
}

export const APP_SECRET_HOSTS = "api.spotify.com, accounts.spotify.com";

export function injectSummary(inject: string): string {
  if (inject === "basic") return "Sent as HTTP Basic (username + password).";
  if (inject === "client_credentials") {
    return "OAuth client secret. Token mint uses HTTP Basic (client_id:secret) and a form body. Not a user access token.";
  }
  if (inject === "header:Authorization") {
    return "Sent as a raw Authorization header, with no Bearer prefix.";
  }
  return "Sent as Authorization: Bearer. Typical for API tokens. A Client Secret is not an access token.";
}

export function storedItemUsername(kind: string, inject: string, username?: string | null): string | null {
  if (!needsLoginUsername(kind, inject)) return null;
  const value = username?.trim();
  return value ? value : null;
}

/** Kind dropdown values. Do not put inject jargon such as client_credentials on the label. */
export const STORE_KIND_OPTIONS = [
  { value: "secret", label: "API token" },
  { value: "client_secret", label: "Client ID and secret" },
] as const;

export function storeKindOptionsHtml(): string {
  return STORE_KIND_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
}

/** Map a stored row onto the two Kind choices operators see. */
export function formKindForItem(kind: string, inject: string): "secret" | "client_secret" {
  if (kind === "client_secret" || inject === "client_credentials") return "client_secret";
  return "secret";
}

/** Vault table pill. App secrets must not read as token. */
export function kindPillLabel(kind: string, inject?: string): string {
  if (kind === "client_secret" || inject === "client_credentials") return "app secret";
  if (kind === "login") return "login";
  return "token";
}

export function usernameFieldLabel(kind: string, inject: string): string {
  if (kind === "client_secret" || inject === "client_credentials") return "Client ID";
  return "HTTP Basic username";
}

export function valueFieldLabel(kind: string, inject: string): string {
  if (kind === "client_secret" || inject === "client_credentials") return "Client Secret";
  return "Value";
}

export function itemStoresLoginPayload(kind: string): boolean {
  return kind === "login";
}
