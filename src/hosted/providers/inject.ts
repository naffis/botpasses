/**
 * Turns a stored item's `inject` mode into the concrete change to one outgoing request:
 * headers, an extended path (query modes), or form fields (OAuth token endpoints). The item's
 * value is read here and nowhere else in the connector.
 */
import type { HmacScheme, InjectMode, TokenAuthStyle } from "../../hosted-types.ts";
import { HttpError } from "../errors.ts";
import { injectModeOf, invalidInjectMessage } from "../store-form-fields.ts";
import { hmacSignatureHeaders } from "./hmac.ts";
import { sigv4Headers } from "./sigv4.ts";

/** Store-time validation. Same grammar as the browser form; the server answers 400. */
export function parseInjectMode(raw: string): InjectMode {
  const mode = injectModeOf(raw);
  if (!mode) throw new HttpError(400, invalidInjectMessage(raw), { status: "inject_invalid", inject: raw.trim() });
  return mode;
}

export type ParsedInject =
  | { kind: "bearer" }
  | { kind: "basic" }
  | { kind: "client_credentials" }
  | { kind: "refresh" }
  | { kind: "sigv4" }
  | { kind: "header"; name: string }
  | { kind: "query"; param: string }
  | { kind: "cookie"; name: string }
  | { kind: "hmac"; scheme: HmacScheme };

/** Split a validated mode into a discriminated union so callers can switch exhaustively. */
export function parseInject(mode: InjectMode): ParsedInject {
  switch (mode) {
    case "bearer":
    case "basic":
    case "client_credentials":
    case "refresh":
    case "sigv4":
      return { kind: mode };
    case "hmac:stripe_sig":
      return { kind: "hmac", scheme: "stripe_sig" };
    case "hmac:slack_sig":
      return { kind: "hmac", scheme: "slack_sig" };
    case "hmac:github_sig":
      return { kind: "hmac", scheme: "github_sig" };
    default:
      break;
  }
  const sep = mode.indexOf(":");
  const prefix = mode.slice(0, sep);
  const arg = mode.slice(sep + 1);
  if (prefix === "header") return { kind: "header", name: arg };
  if (prefix === "query") return { kind: "query", param: arg };
  if (prefix === "cookie") return { kind: "cookie", name: arg };
  throw new HttpError(500, "inject_unsupported", { status: "inject_unsupported", inject: mode });
}

export type InjectSubject = {
  secret: string;
  username: string | null;
  inject: string;
  kind: "secret" | "login" | "client_secret";
};

export type InjectRequest = {
  host: string;
  method: string;
  /** Path plus query, already validated by assertSafePath. */
  path: string;
  /** Encoded body as it will be sent, or undefined. */
  body?: string;
  contentType?: string;
  /**
   * Set when the request targets a known provider's token endpoint. Client-credential shaped
   * modes then follow the provider's auth style instead of Bearer.
   */
  tokenEndpoint?: { auth: TokenAuthStyle };
  now: Date;
};

export type InjectedRequest = {
  headers: Record<string, string>;
  path: string;
  body?: string;
};

function basicHeader(username: string | null, secret: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${username ?? ""}:${secret}`).toString("base64")}` };
}

/** Append `fields` to a form-urlencoded body. Token endpoints never take JSON. */
function withFormFields(req: InjectRequest, fields: Record<string, string>): { body: string } {
  if (req.contentType && !req.contentType.includes("application/x-www-form-urlencoded")) {
    throw new HttpError(400, "OAuth token endpoints take application/x-www-form-urlencoded bodies", {
      status: "inject_denied",
    });
  }
  const params = new URLSearchParams(req.body ?? "");
  for (const [k, v] of Object.entries(fields)) params.set(k, v);
  return { body: params.toString() };
}

/** Client id + secret at a token endpoint, placed as the provider expects (RFC 6749 2.3.1). */
function clientAuth(item: InjectSubject, req: InjectRequest, auth: TokenAuthStyle): InjectedRequest {
  switch (auth) {
    case "basic":
      return { headers: basicHeader(item.username, item.secret), path: req.path, body: req.body };
    case "post_body":
      return {
        headers: {},
        path: req.path,
        ...withFormFields(req, { client_id: item.username ?? "", client_secret: item.secret }),
      };
    default: {
      const _exhaustive: never = auth;
      throw new Error(`Unhandled token auth style: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Apply the item's inject mode to the request. Throws 400 `inject_denied` when the mode cannot be
 * honoured for this target (a refresh token sent anywhere but the token endpoint, a sigv4 item on
 * a non-AWS host) and 500 `inject_unsupported` when the stored string is not a mode at all.
 */
export function applyInject(item: InjectSubject, req: InjectRequest): InjectedRequest {
  const mode = injectModeOf(item.inject);
  if (!mode) {
    throw new HttpError(500, "inject_unsupported", { status: "inject_unsupported", inject: item.inject });
  }
  const parsed = parseInject(mode);
  const passthrough = { path: req.path, body: req.body };
  switch (parsed.kind) {
    case "bearer":
      if (req.tokenEndpoint) return clientAuth(item, req, req.tokenEndpoint.auth);
      if (item.kind === "login") return { headers: basicHeader(item.username, item.secret), ...passthrough };
      return { headers: { authorization: `Bearer ${item.secret}` }, ...passthrough };
    case "basic":
      if (req.tokenEndpoint) return clientAuth(item, req, req.tokenEndpoint.auth);
      return { headers: basicHeader(item.username, item.secret), ...passthrough };
    case "client_credentials":
      if (req.tokenEndpoint) return clientAuth(item, req, req.tokenEndpoint.auth);
      return { headers: basicHeader(item.username, item.secret), ...passthrough };
    case "refresh":
      if (!req.tokenEndpoint) {
        throw new HttpError(400, "A refresh token is only sent to the provider token endpoint", {
          status: "inject_denied",
        });
      }
      // RFC 6749 section 6: refresh_token grant as a public (PKCE) client, identified by client_id
      // alone. A confidential client's exchange never comes through here: mcp-http.ts
      // `refreshTokenCall` sends the sibling client secret item per `provider.tokenAuth` instead.
      return {
        headers: {},
        path: req.path,
        ...withFormFields(req, {
          grant_type: "refresh_token",
          refresh_token: item.secret,
          ...(item.username ? { client_id: item.username } : {}),
        }),
      };
    case "sigv4":
      return {
        headers: sigv4Headers({
          accessKeyId: item.username ?? "",
          secretAccessKey: item.secret,
          method: req.method,
          host: req.host,
          path: req.path,
          body: req.body,
          contentType: req.contentType,
          now: req.now,
        }),
        ...passthrough,
      };
    case "header":
      return { headers: { [parsed.name.toLowerCase()]: item.secret }, ...passthrough };
    case "query": {
      const joiner = req.path.includes("?") ? "&" : "?";
      return {
        headers: {},
        path: `${req.path}${joiner}${encodeURIComponent(parsed.param)}=${encodeURIComponent(item.secret)}`,
        body: req.body,
      };
    }
    case "cookie":
      return { headers: { cookie: `${parsed.name}=${item.secret}` }, ...passthrough };
    case "hmac":
      return { headers: hmacSignatureHeaders(parsed.scheme, item.secret, req.body ?? "", req.now), ...passthrough };
    default: {
      const _exhaustive: never = parsed;
      throw new Error(`Unhandled inject mode: ${String(_exhaustive)}`);
    }
  }
}
