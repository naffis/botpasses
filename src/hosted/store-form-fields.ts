/**
 * Store-form vocabulary shared by the server (kernel, need-ops, page templates) and the
 * browser (bundled into /assets/console.js and /assets/collect.js by scripts/build-client.ts).
 * Keep this module free of value imports and Node APIs so the bundle can inline it (type-only
 * imports are stripped by the build).
 */
import type { HmacScheme, InjectMode } from "../hosted-types.ts";

/** Request-signing schemes accepted after `hmac:`. Mirrors the HmacScheme type. */
export const HMAC_SCHEMES: readonly HmacScheme[] = ["stripe_sig", "slack_sig", "github_sig"];

/** RFC 7230 token: what an HTTP header name or cookie name may contain. Format check only. */
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Query parameter name. Conservative so the value never needs escaping in the key position. */
const QUERY_NAME_RE = /^[A-Za-z0-9_.-]+$/;

export const INJECT_MODE_HELP =
  "Accepted send modes: bearer, basic, client_credentials, refresh, sigv4, header:<name>, query:<param>, cookie:<name>, hmac:stripe_sig, hmac:slack_sig, hmac:github_sig.";

/**
 * The one place that decides whether a string is an InjectMode. Returns null for anything else
 * so both the browser form and the server can refuse it with the same message.
 */
export function injectModeOf(raw: string): InjectMode | null {
  const value = raw.trim();
  switch (value) {
    case "bearer":
    case "basic":
    case "client_credentials":
    case "refresh":
    case "sigv4":
      return value;
    default:
      break;
  }
  const sep = value.indexOf(":");
  if (sep <= 0) return null;
  const prefix = value.slice(0, sep);
  const arg = value.slice(sep + 1);
  if (prefix === "header") return HTTP_TOKEN_RE.test(arg) ? `header:${arg}` : null;
  if (prefix === "cookie") return HTTP_TOKEN_RE.test(arg) ? `cookie:${arg}` : null;
  if (prefix === "query") return QUERY_NAME_RE.test(arg) ? `query:${arg}` : null;
  if (prefix === "hmac") {
    const scheme = HMAC_SCHEMES.find((s) => s === arg);
    return scheme ? `hmac:${scheme}` : null;
  }
  return null;
}

/** Message for an unknown mode. Shared by the browser form and the server's 400. */
export function invalidInjectMessage(raw: string): string {
  return `Unknown send mode "${raw.trim()}". ${INJECT_MODE_HELP}`;
}

/**
 * Username is HTTP Basic, an OAuth client id, or an AWS access key id. Secret + bearer/header
 * items do not use it.
 */
export function needsLoginUsername(kind: string, inject: string): boolean {
  return (
    kind === "login" ||
    kind === "client_secret" ||
    inject === "basic" ||
    inject === "client_credentials" ||
    inject === "refresh" ||
    inject === "sigv4"
  );
}

/** Kind picks the usual send method. Operators should not have to know HTTP schemes. */
export function defaultInjectForKind(kind: string): "bearer" | "basic" | "client_credentials" {
  if (kind === "login") return "basic";
  if (kind === "client_secret") return "client_credentials";
  return "bearer";
}

/** Example hosts for an OAuth client secret. Shown only inside the client-secret disclosure. */
export const APP_SECRET_HOSTS = "api.spotify.com, accounts.spotify.com";

/** Server rule for credential names. Mirrored client-side as a hint and auto-uppercase. */
export const ITEM_NAME_PATTERN = "[A-Z][A-Z0-9_]{0,127}";
export const ITEM_NAME_HINT = "Uppercase letters, digits, and underscores. Starts with a letter. Example: GITHUB_TOKEN.";

/** Uppercase and replace separators so typing "github token" yields GITHUB_TOKEN. */
export function normalizeItemNameInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s\-.]+/g, "_")
    .replace(/[^A-Z0-9_]/g, "")
    .slice(0, 128);
}

export function isValidItemName(name: string): boolean {
  return new RegExp(`^${ITEM_NAME_PATTERN}$`).test(name);
}

export function injectSummary(inject: string): string {
  if (inject === "basic") return "Sent as HTTP Basic (username + password).";
  if (inject === "client_credentials") {
    return "OAuth client secret. Botpasses mints an app token at the provider token endpoint (HTTP Basic or form body, per provider). Not a user access token.";
  }
  if (inject === "refresh") {
    return "OAuth refresh token. Botpasses exchanges it for a short-lived access token before each call.";
  }
  if (inject === "sigv4") {
    return "AWS Signature Version 4. Username is the access key ID; the value is the secret access key. Region and service come from the host.";
  }
  if (inject === "header:Authorization") {
    return "Sent as a raw Authorization header, with no Bearer prefix.";
  }
  if (inject.startsWith("header:")) return `Sent as the ${inject.slice("header:".length)} request header.`;
  if (inject.startsWith("query:")) return `Appended to the URL as ?${inject.slice("query:".length)}=.`;
  if (inject.startsWith("cookie:")) return `Sent as the ${inject.slice("cookie:".length)} cookie.`;
  if (inject.startsWith("hmac:")) {
    return "Signs the request body with the secret and sets the vendor signature header. The secret itself is never sent.";
  }
  return "Sent as Authorization: Bearer. Typical for API tokens.";
}

/** Extra guidance that only applies to one Kind. Empty for the plain API token. */
export function kindHint(kind: string): string {
  if (kind === "client_secret") {
    return `Allowed hosts must include the token host as well as the API host (for example ${APP_SECRET_HOSTS}).`;
  }
  return "";
}

export const ALLOWED_HOSTS_HELP = "Only these hosts will ever receive this credential. Comma-separated, no scheme.";

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

/** "Send as" dropdown. Bearer first because it is the default. */
export const INJECT_OPTIONS = [
  { value: "bearer", label: "Authorization: Bearer (typical API token)" },
  { value: "client_credentials", label: "OAuth client secret (mint app token)" },
  { value: "basic", label: "HTTP Basic (username + password)" },
  { value: "header:Authorization", label: "Raw Authorization header" },
  { value: "header:X-API-Key", label: "X-API-Key header" },
  { value: "query:api_key", label: "Query string (?api_key=)" },
  { value: "sigv4", label: "AWS Signature V4 (access key ID + secret)" },
] as const;

export function injectOptionsHtml(): string {
  return INJECT_OPTIONS.map(
    (o) => `<option value="${o.value}"${o.value === "bearer" ? " selected" : ""}>${o.label}</option>`,
  ).join("");
}

/** Map a stored row onto the two Kind choices operators see. */
export function formKindForItem(kind: string, inject: string): "secret" | "client_secret" {
  if (kind === "client_secret" || inject === "client_credentials") return "client_secret";
  return "secret";
}

/** Credentials table pill. App secrets must not read as token. */
export function kindPillLabel(kind: string, inject?: string): string {
  if (kind === "client_secret" || inject === "client_credentials") return "app secret";
  if (kind === "login") return "login";
  return "token";
}

export function usernameFieldLabel(kind: string, inject: string): string {
  if (kind === "client_secret" || inject === "client_credentials") return "Client ID";
  if (inject === "sigv4") return "AWS access key ID";
  return "HTTP Basic username";
}

export function valueFieldLabel(kind: string, inject: string): string {
  if (kind === "client_secret" || inject === "client_credentials") return "Client Secret";
  if (inject === "sigv4") return "AWS secret access key";
  return "Value";
}

export function itemStoresLoginPayload(kind: string): boolean {
  return kind === "login";
}

/** Body the console and collect page send for store, edit, and fulfill. */
export type StoreFormValues = {
  name: string;
  kind: string;
  inject: string;
  username: string;
  allowedHosts: string;
  value: string;
  environment?: string;
};

export type StoreRequestBody = {
  name: string;
  kind: "secret" | "client_secret";
  inject: string;
  username?: string;
  allowed_hosts: string[];
  value?: string;
  environment?: string;
};

export function splitHosts(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
}

/**
 * One place decides how the form fields become the JSON body. Throws on an unknown send mode so
 * the form never posts one; the server repeats the check with `parseInjectMode` and answers 400.
 */
export function storeRequestBody(values: StoreFormValues, opts: { editing: boolean }): StoreRequestBody {
  const kind = values.kind === "client_secret" ? "client_secret" : "secret";
  const requested = kind === "client_secret" ? "client_credentials" : values.inject || "bearer";
  const inject = injectModeOf(requested);
  if (!inject) throw new Error(invalidInjectMessage(requested));
  const body: StoreRequestBody = {
    name: values.name,
    kind,
    inject,
    allowed_hosts: splitHosts(values.allowedHosts),
  };
  if (needsLoginUsername(kind, inject) && values.username.trim()) body.username = values.username.trim();
  if (!opts.editing || values.value) body.value = values.value;
  if (values.environment) body.environment = values.environment;
  return body;
}
