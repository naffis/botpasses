import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HEALTH_PRODUCT, WWW_AUTHENTICATE_REALM } from "./brand.ts";
import { handleMcpRpc, newMcpSession, type JsonRpcRequest, type McpSession } from "./mcp.ts";
import { operatorHtml } from "./operator-page.ts";
import type { Vault } from "./vault.ts";
import type { GrantScope } from "./types.ts";

export type ServerOptions = {
  vault: Vault;
  host?: string;
  port?: number;
};

export function createVaultServer(opts: ServerOptions) {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8788;
  // The loopback server serves one operator's agents; the last `initialize` names the agent for
  // stateless POSTs that carry no agent_id of their own.
  const session = newMcpSession();

  const server = createServer((req, res) => {
    void route(opts.vault, req, res, session).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, 400, { error: message });
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

function tokensEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function readBearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  const raw = Array.isArray(auth) ? auth[0] : auth;
  if (!raw?.startsWith("Bearer ")) return undefined;
  return raw.slice("Bearer ".length).trim();
}

function needsLoopbackAuth(method: string, path: string): boolean {
  return path.startsWith("/api/") || (method === "POST" && path === "/mcp");
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": `Bearer realm="${WWW_AUTHENTICATE_REALM}"`,
  });
  res.end(JSON.stringify({ error: "Authentication required" }));
}

async function route(vault: Vault, req: IncomingMessage, res: ServerResponse, session: McpSession): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (needsLoopbackAuth(method, path)) {
    const token = readBearer(req);
    if (!token || !tokensEqual(token, vault.loopbackToken())) {
      unauthorized(res);
      return;
    }
  }

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(operatorHtml());
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
    const grants = vault.revokeGrant({ grantId: decodeURIComponent(revoke[1] ?? "") });
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
      res.writeHead(202);
      res.end();
      return;
    }
    json(res, 200, rpc);
    return;
  }
  json(res, 404, { error: "not found" });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Record<string, unknown>;
}
