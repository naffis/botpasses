/** Shared request/response helpers for the hosted HTTP router and its route modules. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { WWW_AUTHENTICATE_REALM } from "../brand.ts";
import type { GrantPolicy, ItemKind, VaultEnvName } from "../hosted-types.ts";
import { HttpError, isHttpError, isNeedItemError } from "./errors.ts";
import { corsHeaders, corsPath, corsPublicUrl } from "./http-cors.ts";
import { mcpWwwAuthenticate } from "./oauth-metadata.ts";
import { captureException } from "./observe.ts";
import { securityHeaders } from "./security-headers.ts";

export const BODY_CAP = 128 * 1024;

export function json(res: ServerResponse, status: number, body: unknown, skipSecurity = false): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...(skipSecurity ? {} : securityHeaders({ html: false })),
    ...corsHeaders(res),
  });
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, err: unknown, path = ""): void {
  void captureException(err);
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
  const message = err instanceof Error ? err.message : String(err);
  json(res, 400, { error: message });
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > BODY_CAP) throw new HttpError(413, "Body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Record<string, unknown>;
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
