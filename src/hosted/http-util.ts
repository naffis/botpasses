/** Shared request/response helpers for the hosted HTTP router and its route modules. */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WWW_AUTHENTICATE_REALM } from "../brand.ts";
import type { GrantPolicy, ItemKind, VaultEnvName } from "../hosted-types.ts";
import { HttpError, isHttpError, isNeedItemError } from "./errors.ts";
import { corsHeaders, corsPath, corsPublicUrl } from "./http-cors.ts";
import { mcpWwwAuthenticate } from "./oauth-metadata.ts";
import { captureException, logVaultEvent, redactMessage } from "./observe.ts";
import { securityHeaders } from "./security-headers.ts";
import { isPublicSitePath } from "./static-site.ts";

export const BODY_CAP = 128 * 1024;

/**
 * One request id per request. The router binds the inbound (or minted) id before routing so
 * the access log line, the `x-request-id` header, the 500 body, and the Sentry event all carry
 * the same value. A response nobody bound (a test calling `sendError` directly) mints one.
 */
const requestIds = new WeakMap<ServerResponse, string>();

export function bindRequestId(res: ServerResponse, requestId: string): void {
  requestIds.set(res, requestId);
}

export function requestIdOf(res: ServerResponse): string {
  const bound = requestIds.get(res);
  if (bound) return bound;
  const minted = randomUUID();
  requestIds.set(res, minted);
  return minted;
}

/** `decodeURIComponent` for one path segment; a malformed escape is the caller's 400, not a 500. */
export function decodePathSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "Malformed path");
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export function originIsLoopback(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function json(res: ServerResponse, status: number, body: unknown, skipSecurity = false): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...(skipSecurity ? {} : securityHeaders({ html: false })),
    ...corsHeaders(res),
  });
  res.end(JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, status: number, html: string, extra: Record<string, string>): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(html);
}

/**
 * HttpError and NeedItemError go to the client as they are. Anything else is a bug or a store
 * failure: the client gets a generic 500 with an `x-request-id`, the detail is logged and captured
 * server-side under that id. Driver messages (pg constraint names, row values) never leave the process.
 */
export function sendError(res: ServerResponse, err: unknown, path = ""): void {
  const routePath = path || corsPath(res);
  if (isNeedItemError(err)) {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      ...securityHeaders({ html: false }),
      ...corsHeaders(res),
    };
    res.writeHead(err.status, headers);
    res.end(JSON.stringify(err.payload));
    return;
  }
  if (isHttpError(err)) {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      ...securityHeaders({ html: false }),
      ...corsHeaders(res),
    };
    if (err.status === 401) {
      headers["www-authenticate"] =
        routePath === "/mcp" || routePath.startsWith("/mcp")
          ? mcpWwwAuthenticate(corsPublicUrl(res), WWW_AUTHENTICATE_REALM)
          : `Bearer realm="${WWW_AUTHENTICATE_REALM}"`;
    }
    res.writeHead(err.status, headers);
    res.end(JSON.stringify({ error: err.message, ...err.extra }));
    return;
  }
  const requestId = requestIdOf(res);
  const message = redactMessage(err instanceof Error ? err.message : String(err));
  logVaultEvent("request_error", { request_id: requestId, path: routePath, message });
  void captureException(err, { requestId, path: routePath });
  res.writeHead(500, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
    ...securityHeaders({ html: false }),
    ...corsHeaders(res),
  });
  res.end(JSON.stringify({ error: "Internal error", request_id: requestId }));
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > BODY_CAP) throw new HttpError(413, "Body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** JSON object body. Malformed JSON is a 400 that does not echo the bytes back. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    if (err instanceof SyntaxError) throw new HttpError(400, "Invalid JSON");
    throw err;
  }
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Record<string, unknown>;
}

/** JSON or `application/x-www-form-urlencoded` (HTML forms). Form values are strings. */
export async function readJsonOrForm(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
  if (!type.includes("application/x-www-form-urlencoded")) return readJson(req);
  const raw = await readRaw(req);
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(raw.toString("utf8"))) out[k] = v;
  return out;
}

export function asEnv(value: unknown): VaultEnvName {
  if (value === "production") return "production";
  return "staging";
}

export function asKind(value: unknown): ItemKind {
  if (value === "login") return "login";
  if (value === "client_secret") return "client_secret";
  return "secret";
}

export function asHosts(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

export function asPolicy(value: unknown): GrantPolicy {
  if (
    value === "prompt" ||
    value === "session" ||
    value === "item_standing" ||
    value === "folder_standing"
  ) {
    return value;
  }
  return "prompt";
}

export function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Pages an anonymous GET may load (a bad Bearer is ignored there instead of a 401). */
export function isPublicHtmlPath(path: string, hosted: boolean): boolean {
  if (!hosted) return path === "/" || path === "/index.html" || path.startsWith("/collect/");
  return isPublicSitePath(path) || path === "/console" || path.startsWith("/collect/") ||
    path === "/sign-in" || path === "/sign-up" || path === "/enroll-totp" || path === "/verify-totp" || path === "/consent" ||
    path === "/device";
}

export function robotsTxt(plane: "staging" | "production"): string {
  if (plane === "staging") {
    return "User-agent: *\nAllow: /\n";
  }
  return [
    "Sitemap: https://botpasses.com/sitemap-index.xml",
    "User-agent: *",
    "Allow: /",
    "Allow: /docs",
    "Disallow: /console",
    "Disallow: /sign-in",
    "Disallow: /sign-up",
    "Disallow: /enroll-totp",
    "Disallow: /verify-totp",
    "Disallow: /consent",
    "Disallow: /device",
    "Disallow: /collect",
    "Disallow: /api",
    "Disallow: /mcp",
    "Disallow: /approve",
    "Disallow: /runtime",
    "Disallow: /oauth",
    "Disallow: /agentpass",
    "",
  ].join("\n");
}
