import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HEALTH_PRODUCT, WWW_AUTHENTICATE_REALM } from "../brand.ts";
import type { ItemKind, VaultEnvName } from "../hosted-types.ts";
import {
  requireModelOrOperator,
  requireOperator,
  requireTrusted,
  testAuthResolver,
  type AuthResolver,
  type ModelPrincipal,
  type Principal,
} from "./auth.ts";
import { AgentPassAuthority, agentPassEnabled } from "./agentpass.ts";
import { type ConnectorFetch } from "./connector.ts";
import { HttpError, isHttpError } from "./errors.ts";
import type { HostedKernel } from "./kernel.ts";
import {
  handleHostedMcpRpc,
  listHostedMcpTools,
  type JsonRpcRequest,
} from "./mcp.ts";
import { hostedOperatorHtml } from "./operator-page.ts";
import { captureException } from "./observe.ts";
import { OrgRateLimiter } from "./rate-limit.ts";

const BODY_CAP = 128 * 1024;
const KEEPALIVE_MS = 25_000;

export type HostedHttpOpts = {
  kernel: HostedKernel;
  host?: string;
  port?: number;
  publicUrl?: string;
  authResolver?: AuthResolver;
  fetchImpl?: ConnectorFetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  clerkIssuer?: string;
  allowedHosts?: string[];
};

export function createHostedServer(opts: HostedHttpOpts) {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8788;
  const publicUrl = opts.publicUrl ?? opts.kernel.publicUrl;
  const auth = opts.authResolver ?? testAuthResolver;
  const limiter = new OrgRateLimiter();
  const agentpass = agentPassEnabled() ? new AgentPassAuthority(opts.kernel, publicUrl) : undefined;
  const allowed = opts.allowedHosts ?? hostAllowlist(publicUrl);

  const server = createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendError(res, err);
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (method === "GET" && path === "/health") {
      json(res, 200, { ok: true, product: HEALTH_PRODUCT });
      return;
    }
    if (method === "GET" && path === "/ready") {
      try {
        await opts.kernel.ping();
        json(res, 200, { ok: true });
      } catch {
        json(res, 503, { ok: false });
      }
      return;
    }
    if (method === "GET" && path === "/.well-known/oauth-protected-resource") {
      json(res, 200, {
        resource: publicUrl,
        authorization_servers: opts.clerkIssuer ? [opts.clerkIssuer] : [],
      });
      return;
    }
    if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
      json(res, 200, {
        issuer: opts.clerkIssuer ?? publicUrl,
        authorization_endpoint: `${opts.clerkIssuer ?? publicUrl}/oauth/authorize`,
        token_endpoint: `${opts.clerkIssuer ?? publicUrl}/oauth/token`,
      });
      return;
    }
    if (agentpass && method === "GET" && path === "/agentpass/configuration") {
      json(res, 200, agentpass.configuration());
      return;
    }
    if (agentpass && method === "GET" && path === "/agentpass/jwks") {
      json(res, 200, agentpass.jwks());
      return;
    }

    if (!originOk(req, allowed)) {
      json(res, 403, { error: "Origin/Host not allowed" });
      return;
    }

    let principal: Principal | undefined;
    try {
      principal = await auth(req, opts.kernel);
    } catch (err) {
      sendError(res, err);
      return;
    }

    if (method === "GET" && path === "/mcp") {
      try {
        requireModelOrOperator(principal);
      } catch (err) {
        sendError(res, err);
        return;
      }
      sseKeepalive(res);
      return;
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(hostedOperatorHtml());
      return;
    }

    if (method === "POST" && path === "/mcp") {
      const body = (await readJson(req)) as JsonRpcRequest;
      let model: ModelPrincipal;
      try {
        model = await mcpModelPrincipal(opts.kernel, principal, body);
      } catch (err) {
        sendError(res, err);
        return;
      }
      if (body.method === "tools/call" && mcpToolName(body) === "request_grant") {
        if (!limiter.allow(model.orgId)) throw new HttpError(429, "request_grant rate limit");
      }
      const rpc = await handleHostedMcpRpc(
        {
          kernel: opts.kernel,
          principal: model,
          fetchImpl: opts.fetchImpl,
          resolveAddresses: opts.resolveAddresses,
        },
        body,
      );
      if (!rpc) {
        res.writeHead(202);
        res.end();
        return;
      }
      json(res, 200, rpc);
      return;
    }

    try {
      await api(req, res, url, method, path, principal, agentpass);
    } catch (err) {
      sendError(res, err);
    }
  }

  async function api(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    path: string,
    principal: Principal | undefined,
    authority: AgentPassAuthority | undefined,
  ): Promise<void> {
    if (method === "GET" && path === "/api/items") {
      const op = requireOperator(principal);
      const environment = asEnv(url.searchParams.get("environment") ?? "staging");
      json(res, 200, { items: await opts.kernel.listItems(op.orgId, environment) });
      return;
    }
    if (method === "POST" && path === "/api/items") {
      const op = requireOperator(principal);
      const body = await readJson(req);
      const item = await opts.kernel.createItem({
        orgId: op.orgId,
        actor: op.userId,
        environment: asEnv(body.environment),
        kind: asKind(body.kind),
        name: String(body.name ?? ""),
        value: String(body.value ?? ""),
        username: optional(body.username),
        allowedHosts: asHosts(body.allowed_hosts ?? body.allowedHosts),
        inject: String(body.inject ?? "bearer"),
        folderName: optional(body.folder_name ?? body.folderName),
      });
      json(res, 200, { item });
      return;
    }
    const rotate = /^\/api\/items\/([^/]+)\/rotate$/.exec(path);
    if (method === "POST" && rotate) {
      const op = requireOperator(principal);
      const body = await readJson(req);
      const item = await opts.kernel.rotateItem({
        orgId: op.orgId,
        actor: op.userId,
        itemId: decodeURIComponent(rotate[1] ?? ""),
        value: String(body.value ?? ""),
      });
      json(res, 200, { item });
      return;
    }
    const del = /^\/api\/items\/([^/]+)$/.exec(path);
    if (method === "DELETE" && del) {
      const op = requireOperator(principal);
      await opts.kernel.deleteItem(op.orgId, op.userId, decodeURIComponent(del[1] ?? ""));
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && path === "/api/folders") {
      const op = requireOperator(principal);
      const body = await readJson(req);
      const folder = await opts.kernel.createFolder(
        op.orgId,
        asEnv(body.environment),
        String(body.name ?? ""),
      );
      json(res, 200, { folder });
      return;
    }
    if (method === "DELETE" && path === "/api/orgs") {
      const op = requireOperator(principal);
      const body = await readJson(req);
      await opts.kernel.deleteOrg(
        op.orgId,
        op.userId,
        op.role,
        String(body.confirm_name ?? body.confirmName ?? ""),
      );
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && path === "/api/orgs") {
      const userId = principal?.channel === "operator" ? principal.userId : undefined;
      if (!userId) throw new HttpError(401, "Authentication required");
      const body = await readJson(req);
      const created = await opts.kernel.createOrg(String(body.name ?? "org"), userId);
      json(res, 200, created);
      return;
    }
    if (method === "POST" && path === "/api/clients/trusted") {
      const op = requireOperator(principal);
      const body = await readJson(req);
      const created = await opts.kernel.createTrustedClient({
        orgId: op.orgId,
        name: String(body.name ?? "trusted"),
        environment: asEnv(body.environment),
      });
      json(res, 200, { client: { id: created.client.id, name: created.client.name }, token: created.plaintext });
      return;
    }
    if (method === "POST" && path === "/api/clients/model") {
      const op = requireOperator(principal);
      const body = await readJson(req);
      const created = await opts.kernel.createModelClient({
        orgId: op.orgId,
        name: String(body.name ?? "grok"),
        environment: asEnv(body.environment),
        issueBearer: true,
      });
      json(res, 200, {
        client: { id: created.client.id, name: created.client.name, kind: created.client.kind },
        token: created.plaintext,
        mcp_url: `${publicUrl.replace(/\/$/, "")}/mcp`,
      });
      return;
    }
    if (method === "POST" && path === "/api/grants/request") {
      const actor = requireModelOrOperator(principal);
      const orgId = actor.orgId;
      if (!limiter.allow(orgId)) throw new HttpError(429, "request_grant rate limit");
      const body = await readJson(req);
      const clientId =
        actor.channel === "model" ? actor.clientId : String(body.client_id ?? body.clientId ?? "");
      const result = await opts.kernel.requestGrant({
        orgId,
        clientId,
        itemName: String(body.item_name ?? body.itemName ?? ""),
        environment: asEnv(body.environment),
        taskId: optional(body.task_id ?? body.taskId),
        taskDescription: optional(body.task_description ?? body.taskDescription),
        operatorEmail: optional(body.operator_email ?? body.operatorEmail),
      });
      json(res, 200, {
        grant: result.grant,
        approval_code: result.code,
        notify_failed: result.notifyFailed ?? false,
      });
      return;
    }
    if (method === "GET" && path === "/api/inbox") {
      const op = requireOperator(principal);
      const grants = await opts.kernel.inbox(op.orgId);
      const agentpass = agentPassEnabled()
        ? (await opts.kernel.store.listAgentPasses(op.orgId)).filter((p) => p.status === "pending")
        : [];
      json(res, 200, { grants, agentpass });
      return;
    }
    if (method === "GET" && path === "/api/audit") {
      const op = requireOperator(principal);
      json(res, 200, { audit: await opts.kernel.store.listAudit(op.orgId) });
      return;
    }
    const approve = /^\/api\/grants\/([^/]+)\/approve$/.exec(path);
    if (method === "POST" && approve) {
      const op = requireOperator(principal);
      const body = await readJson(req);
      const grant = await opts.kernel.approveGrant({
        orgId: op.orgId,
        grantId: decodeURIComponent(approve[1] ?? ""),
        policy: asPolicy(body.policy),
        confirmName: optional(body.confirm_name ?? body.confirmName),
        role: op.role,
        actor: op.userId,
      });
      json(res, 200, { grant });
      return;
    }
    const revoke = /^\/api\/grants\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && revoke) {
      const op = requireOperator(principal);
      const grant = await opts.kernel.revokeGrant(
        op.orgId,
        op.userId,
        decodeURIComponent(revoke[1] ?? ""),
      );
      json(res, 200, { grant });
      return;
    }
    if (method === "POST" && path === "/api/grants/approve-by-code") {
      const op = requireOperator(principal);
      const body = await readJson(req);
      const grant = await opts.kernel.approveByCode(
        op.orgId,
        op.userId,
        op.role,
        String(body.code ?? ""),
      );
      json(res, 200, { grant });
      return;
    }
    if ((method === "GET" || method === "POST") && path === "/approve") {
      const op = requireOperator(principal);
      const token =
        url.searchParams.get("token") ?? String((await readJson(req)).token ?? "");
      const grant = await opts.kernel.approveMagic(op.orgId, op.userId, op.role, token);
      json(res, 200, { grant });
      return;
    }
    if (method === "POST" && path === "/runtime/resolve") {
      const trusted = requireTrusted(principal);
      const body = await readJson(req);
      const resolved = await opts.kernel.resolveTrusted({
        orgId: trusted.orgId,
        clientId: trusted.clientId,
        itemName: String(body.item_name ?? body.itemName ?? ""),
        environment: asEnv(body.environment ?? trusted.environment),
      });
      json(res, 200, resolved);
      return;
    }
    if (authority && method === "POST" && path === "/agentpass/requests") {
      const op = requireOperator(principal);
      const body = await readJson(req);
      const created = await authority.createRequest({
        orgId: op.orgId,
        holderCnf: String(body.holder_cnf ?? body.holderCnf ?? ""),
        scope: Array.isArray(body.scope) ? body.scope.map(String) : [],
        taskId: optional(body.task_id),
      });
      json(res, 200, created);
      return;
    }
    const apGet = /^\/agentpass\/requests\/([^/]+)$/.exec(path);
    if (authority && method === "GET" && apGet) {
      const op = requireOperator(principal);
      json(res, 200, await authority.getRequest(op.orgId, decodeURIComponent(apGet[1] ?? "")));
      return;
    }
    const apApprove = /^\/agentpass\/requests\/([^/]+)\/approve$/.exec(path);
    if (authority && method === "POST" && apApprove) {
      const op = requireOperator(principal);
      await authority.approve(op.orgId, decodeURIComponent(apApprove[1] ?? ""));
      json(res, 200, { ok: true });
      return;
    }
    if (authority && method === "POST" && path === "/agentpass/validate") {
      const body = await readJson(req);
      json(
        res,
        200,
        await authority.validate({
          id: String(body.id ?? ""),
          holderProof: body.holder_proof ?? body.holderProof,
        }),
      );
      return;
    }
    if (authority && method === "POST" && path === "/agentpass/authorization-check") {
      const body = await readJson(req);
      json(
        res,
        200,
        await authority.authorizationCheck({
          id: String(body.id ?? ""),
          holderProof: body.holder_proof ?? body.holderProof,
        }),
      );
      return;
    }
    if (method === "GET" && path === "/mcp/tools") {
      requireModelOrOperator(principal);
      json(res, 200, { tools: listHostedMcpTools() });
      return;
    }
    json(res, 404, { error: "not found" });
  }

  return {
    host,
    port,
    server,
    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolve, reject) => {
        server.listen(port, host, () => {
          const addr = server.address() as AddressInfo;
          resolve({ host: addr.address, port: addr.port });
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

async function mcpModelPrincipal(
  kernel: HostedKernel,
  principal: Principal | undefined,
  body: JsonRpcRequest,
): Promise<ModelPrincipal> {
  if (principal?.channel === "model") return principal;
  if (principal?.channel === "operator") {
    const environment = envFromMcpRpc(body);
    const client = await kernel.ensureModelClient({
      orgId: principal.orgId,
      name: `stdio:${principal.userId}`,
      environment,
      clerkOauthUserId: `stdio:${principal.userId}:${environment}`,
    });
    return {
      channel: "model",
      orgId: principal.orgId,
      clientId: client.id,
      environment,
    };
  }
  throw new HttpError(401, "Model OAuth required");
}

function envFromMcpRpc(body: JsonRpcRequest): VaultEnvName {
  const params = body.params;
  if (!params || typeof params !== "object") return "staging";
  const args = params.arguments;
  if (!args || typeof args !== "object" || args === null) return "staging";
  const env = (args as { environment?: unknown }).environment;
  return env === "production" ? "production" : "staging";
}

function asEnv(value: unknown): VaultEnvName {
  if (value === "production") return "production";
  return "staging";
}

function asKind(value: unknown): ItemKind {
  return value === "login" ? "login" : "secret";
}

function asHosts(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function asPolicy(value: unknown) {
  if (
    value === "prompt" ||
    value === "session" ||
    value === "item_standing" ||
    value === "folder_standing"
  ) {
    return value;
  }
  return "prompt" as const;
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mcpToolName(body: JsonRpcRequest): string | undefined {
  const name = body.params?.name;
  return typeof name === "string" ? name : undefined;
}

function hostAllowlist(publicUrl: string): string[] {
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

function originOk(req: IncomingMessage, allowed: string[]): boolean {
  const host = req.headers.host ?? "";
  if (!hostAllowed(host, allowed)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin).hostname;
    return hostAllowed(o, allowed);
  } catch {
    return false;
  }
}

function sseKeepalive(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const timer = setInterval(() => {
    res.write(": keepalive\n\n");
  }, KEEPALIVE_MS);
  res.on("close", () => clearInterval(timer));
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Authorization, Content-Type, Mcp-Session-Id, X-Test-Channel, X-Test-User, X-Test-Org, X-Test-Client",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-expose-headers": "WWW-Authenticate, Mcp-Session-Id",
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(),
  });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: unknown): void {
  void captureException(err);
  if (isHttpError(err)) {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    };
    if (err.status === 401) headers["www-authenticate"] = `Bearer realm="${WWW_AUTHENTICATE_REALM}"`;
    res.writeHead(err.status, headers);
    res.end(JSON.stringify({ error: err.message }));
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  json(res, 400, { error: message });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
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

export { KEEPALIVE_MS };
