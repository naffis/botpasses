import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { isMcpClientSurface } from "./oauth-metadata.ts";

export type CorsBind = {
  req: IncomingMessage;
  path: string;
  allowed: string[];
  testMode: boolean;
  publicUrl: string;
};

const bound = new WeakMap<ServerResponse, CorsBind>();

export function bindCors(res: ServerResponse, ctx: CorsBind): void {
  bound.set(res, ctx);
  const original = res.writeHead.bind(res);
  res.writeHead = ((
    statusCode: number,
    reasonOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeaders[],
    maybeHeaders?: OutgoingHttpHeaders | OutgoingHttpHeaders[],
  ) => {
    const hasReason = typeof reasonOrHeaders === "string";
    const raw = headerBag(hasReason ? maybeHeaders : reasonOrHeaders);
    if (isMcpClientSurface(ctx.path)) {
      for (const [k, v] of Object.entries(corsHeaders(res))) {
        if (raw[k] === undefined && raw[k.toLowerCase()] === undefined) raw[k] = v;
      }
    }
    return hasReason ? original(statusCode, reasonOrHeaders, raw) : original(statusCode, raw);
  }) as ServerResponse["writeHead"];
}

export function corsPublicUrl(res: ServerResponse): string {
  return bound.get(res)?.publicUrl ?? "";
}

export function corsPath(res: ServerResponse): string {
  return bound.get(res)?.path ?? "";
}

function headerBag(incoming?: OutgoingHttpHeaders | OutgoingHttpHeaders[]): OutgoingHttpHeaders {
  if (!incoming) return {};
  if (Array.isArray(incoming)) return Object.assign({}, ...incoming);
  return { ...incoming };
}

export function hostAllowlist(publicUrl: string): string[] {
  try {
    return [new URL(publicUrl).host, "127.0.0.1", "localhost"];
  } catch {
    return ["127.0.0.1", "localhost"];
  }
}

export function hostAllowed(hostHeader: string, allowed: string[]): boolean {
  const host = (hostHeader.split(":")[0] ?? "").toLowerCase();
  if (!host) return false;
  if (host === "127.0.0.1" || host === "localhost") return true;
  return allowed.some((a) => (a.split(":")[0] ?? "").toLowerCase() === host);
}

export function originAllowed(origin: string, allowedHosts: string[]): boolean {
  try {
    return hostAllowed(new URL(origin).hostname, allowedHosts);
  } catch {
    return false;
  }
}

export function originOk(req: IncomingMessage, allowed: string[], path: string): boolean {
  const host = req.headers.host ?? "";
  if (!hostAllowed(host, allowed)) return false;
  if (isMcpClientSurface(path)) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return hostAllowed(new URL(origin).hostname, allowed);
  } catch {
    return false;
  }
}

export function corsHeaders(res: ServerResponse): Record<string, string> {
  const ctx = bound.get(res);
  const testHeaders = ctx?.testMode
    ? ", X-Test-Channel, X-Test-User, X-Test-Org, X-Test-Client"
    : "";
  const headers: Record<string, string> = {
    "access-control-allow-headers": `Authorization, Content-Type, Mcp-Session-Id, X-CSRF-Token${testHeaders}`,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-expose-headers": "WWW-Authenticate, Mcp-Session-Id",
  };
  const origin = typeof ctx?.req.headers.origin === "string" ? ctx.req.headers.origin : "";
  if (origin && ctx && (originAllowed(origin, ctx.allowed) || isMcpClientSurface(ctx.path))) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}
