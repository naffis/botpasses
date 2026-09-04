import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HEALTH_PRODUCT, WWW_AUTHENTICATE_REALM } from "./brand.ts";
import { tokensEqual } from "./crypto.ts";
import { handleMcpRpc, newMcpSession, type JsonRpcRequest, type McpSession } from "./mcp.ts";
import { operatorHtml } from "./operator-page.ts";
import type { LoopbackRole, Vault } from "./vault.ts";
import type { GrantScope } from "./types.ts";

export type ServerOptions = {
  vault: Vault;
  host?: string;
  port?: number;
};

/** Largest JSON body the loopback API reads; the rest is a 413. */
export const LOCAL_BODY_CAP = 128 * 1024;

/** Expected failures carry a status and a message that is safe to show to the operator. */
class LocalHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LocalHttpError";
    this.status = status;
  }
}

export function createVaultServer(opts: ServerOptions) {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8788;
  // The loopback server serves one operator's agents; the last `initialize` names the agent for
  // stateless POSTs that carry no agent_id of their own.
  const session = newMcpSession();

  const server = createServer((req, res) => {
    void route(opts.vault, host, req, res, session).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const { status, message } = describeError(err);
      json(res, status, { error: message });
    });
  });

  return {
    host,
    port,
    server,
    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolve, reject) => {
        server.listen(port, host, () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            resolve({ host: addr.address, port: addr.port });
            return;
          }
          resolve({ host, port });
        });
        server.on("error", reject);
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * Errors thrown by the vault's own validation are plain `Error`s with operator-facing text and
 * become a 400. Anything carrying a `code` (node system and sqlite errors) or a runtime error
 * class is a bug or a store failure: the client sees a generic message, stderr gets the detail.
 */
function describeError(err: unknown): { status: number; message: string } {
  if (err instanceof LocalHttpError) return { status: err.status, message: err.message };
  const hasCode = typeof err === "object" && err !== null && "code" in err;
  const runtime = err instanceof SyntaxError || err instanceof TypeError || err instanceof RangeError;
  if (err instanceof Error && !hasCode && !runtime) {
    return { status: 400, message: err.message.slice(0, 200) };
  }
  console.error(JSON.stringify({ event: "local_request_error", message: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500), at: new Date().toISOString() }));
  return { status: 500, message: "Internal error" };
}

function readBearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  const raw = Array.isArray(auth) ? auth[0] : auth;
  if (!raw?.startsWith("Bearer ")) return undefined;
  return raw.slice("Bearer ".length).trim();
}

/**
 * Which loopback bearer a route needs. `/api/*` is the operator surface (store, approve,
 * revoke, audit) and takes only the operator token; `POST /mcp` is the model surface and takes
 * only the model token. A model client therefore cannot approve its own grants.
 */
export function loopbackRoleFor(method: string, path: string): LoopbackRole | undefined {
  if (path.startsWith("/api/")) return "operator";
  if (method === "POST" && path === "/mcp") return "model";
  return undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

/**
 * The loopback server answers only to a loopback `Host` (or the exact bind host). A browser
 * page on another origin that resolves a hostname to 127.0.0.1 (DNS rebinding) sends that
 * hostname as `Host` and is refused before any route runs.
 */
export function localHostAllowed(hostHeader: string | undefined, bindHost: string): boolean {
  const raw = (hostHeader ?? "").trim().toLowerCase();
  if (!raw) return false;
  const hostname = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : (raw.split(":")[0] ?? "");
  if (!hostname) return false;
  return isLoopbackHostname(hostname) || hostname === bindHost.toLowerCase();
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": `Bearer realm="${WWW_AUTHENTICATE_REALM}"`,
    ...jsonHeaders(),
  });
  res.end(JSON.stringify({ error: "Authentication required" }));
}

async function route(
  vault: Vault,
  bindHost: string,
  req: IncomingMessage,
  res: ServerResponse,
  session: McpSession,
): Promise<void> {
  if (!localHostAllowed(req.headers.host, bindHost)) {
    json(res, 403, { error: "Host not allowed" });
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  const role = loopbackRoleFor(method, path);
  if (role) {
    const token = readBearer(req);
    if (!token || !tokensEqual(token, vault.loopbackToken(role))) {
      unauthorized(res);
      return;
    }
  }

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    });
    res.end(operatorHtml(nonce));
    return;
  }
  if (method === "GET" && path === "/health") {
    json(res, 200, { ok: true, product: HEALTH_PRODUCT });
    return;
  }
  if (method === "GET" && (path === "/api/secrets" || path === "/api/items")) {
    const items = vault.listItems();
    json(res, 200, path === "/api/items" ? { items } : { secrets: items });
    return;
  }
  if (method === "POST" && (path === "/api/secrets" || path === "/api/items")) {
    const body = await readJson(req);
    const name = String(body.name ?? "");
    const value = String(body.value ?? "");
    const secret = vault.setSecret(name, value, {
      allowedHosts: hostsFrom(body.allowed_hosts ?? body.allowedHosts),
      inject: optional(body.inject),
    });
    json(res, 200, path === "/api/items" ? { item: secret } : { secret });
    return;
  }
  if (method === "GET" && path === "/api/grants") {
    json(res, 200, { grants: vault.listGrants() });
    return;
  }
  if (method === "POST" && path === "/api/grants/request") {
    const body = await readJson(req);
    const grant = vault.requestGrant({
      secretName: String(body.secretName ?? body.secret_name ?? ""),
      agentId: String(body.agentId ?? body.agent_id ?? ""),
      toolId: String(body.toolId ?? body.tool_id ?? ""),
      scope: asScope(body.scope),
    });
    json(res, 200, { grant });
    return;
  }
  if (method === "POST" && path === "/api/grants") {
    const body = await readJson(req);
    const grant = vault.approveGrant({
      grantId: optional(body.grantId ?? body.grant_id),
      secretName: optional(body.secretName ?? body.secret_name),
      agentId: String(body.agentId ?? body.agent_id ?? ""),
      toolId: String(body.toolId ?? body.tool_id ?? ""),
      scope: asScope(body.scope),
      ttl: optional(body.ttl),
    });
    json(res, 200, { grant });
    return;
  }
  const revoke = /^\/api\/grants\/([^/]+)\/revoke$/.exec(path);
  if (method === "POST" && revoke) {
    const grants = vault.revokeGrant({ grantId: decodePathSegment(revoke[1] ?? "") });
    json(res, 200, { grants });
    return;
  }
  if (method === "GET" && path === "/api/audit") {
    json(res, 200, { audit: vault.listAudit() });
    return;
  }
  if (method === "POST" && path === "/mcp") {
    const body = (await readJson(req)) as JsonRpcRequest;
    const rpc = await handleMcpRpc(vault, body, session);
    if (!rpc) {
      res.writeHead(202, jsonHeaders());
      res.end();
      return;
    }
    json(res, 200, rpc);
    return;
  }
  json(res, 404, { error: "not found" });
}

function jsonHeaders(): Record<string, string> {
  return { "x-content-type-options": "nosniff", "cache-control": "no-store" };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...jsonHeaders() });
  res.end(JSON.stringify(body));
}

function decodePathSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new LocalHttpError(400, "Malformed path");
  }
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `allowed_hosts` as an array or a comma-separated string; undefined keeps the stored hosts. */
function hostsFrom(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
}

function asScope(value: unknown): GrantScope | undefined {
  if (value === "once" || value === "session") return value;
  return undefined;
}

/** JSON object body, capped at `LOCAL_BODY_CAP`. Malformed JSON is a 400 that does not echo the bytes. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > LOCAL_BODY_CAP) throw new LocalHttpError(413, "Body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LocalHttpError(400, "Invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Record<string, unknown>;
}
