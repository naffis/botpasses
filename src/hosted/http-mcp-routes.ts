/** POST /mcp JSON-RPC and GET /mcp SSE. Principal resolution for cookie sessions lives here too. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeployPlane } from "../brand.ts";
import type { ConnectorFetch } from "./connector.ts";
import { defaultEnvironmentForDeployPlane } from "./deploy-plane.ts";
import { HttpError } from "./errors.ts";
import { requireModelOrOperator, type ModelPrincipal, type Principal } from "./auth.ts";
import { json, originIsLoopback, readJson, sendError } from "./http-util.ts";
import type { HostedKernel } from "./kernel.ts";
import { handleHostedMcpRpc, type JsonRpcRequest } from "./mcp.ts";
import type { OperatorIdentity } from "./operator-identity.ts";
import { securityHeaders } from "./security-headers.ts";

export const KEEPALIVE_MS = 25_000;

export type McpRouteOpts = {
  kernel: HostedKernel;
  identity: OperatorIdentity | undefined;
  secureCookies: boolean;
  publicUrl: string;
  allowLoopback: boolean;
  deployPlane: DeployPlane;
  fetchImpl?: ConnectorFetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
};

/**
 * Every POST /mcp method needs a model principal. An anonymous `initialize` 200 is why
 * Grok Bot's AuthenticateMcpServer returned `no_auth_link` (BOTP-13): the host builds
 * the browser URL from a 401 on that first JSON-RPC, not from GET /mcp. A preconfigured
 * `avm_` Bearer still skips the connect card because the host sends the header. Operator
 * cookies become the stdio shim.
 */
export async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  principal: Principal | undefined,
  opts: McpRouteOpts,
): Promise<void> {
  const body = (await readJson(req)) as JsonRpcRequest;
  const deps = { kernel: opts.kernel, fetchImpl: opts.fetchImpl, resolveAddresses: opts.resolveAddresses };
  let model: ModelPrincipal;
  try {
    assertCookieMcpRequest(req, principal, opts);
    model = await mcpModelPrincipal(opts.kernel, principal, opts.deployPlane);
  } catch (err) {
    sendError(res, err, path);
    return;
  }
  await respond(res, await handleHostedMcpRpc({ ...deps, principal: model }, body));
}

async function respond(res: ServerResponse, rpc: Awaited<ReturnType<typeof handleHostedMcpRpc>>): Promise<void> {
  if (!rpc) {
    res.writeHead(202, securityHeaders({ html: false }));
    res.end();
    return;
  }
  json(res, 200, rpc);
}

/**
 * Cookie sessions may drive MCP as a model (the stdio shim), but only from our own pages: the
 * request must carry the CSRF header and an Origin on this deployment (S4). Bearer principals
 * and header-authenticated test principals have no cookie to ride.
 */
export function assertCookieMcpRequest(
  req: IncomingMessage,
  principal: Principal | undefined,
  ctx: Pick<McpRouteOpts, "identity" | "secureCookies" | "publicUrl" | "allowLoopback">,
): void {
  if (principal?.channel !== "operator" || !principal.sessionHash) return;
  if (!ctx.identity) throw new HttpError(403, "CSRF required");
  ctx.identity.assertCsrf(
    req.headers.cookie,
    typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined,
    ctx.secureCookies,
  );
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  const sameOrigin =
    origin === new URL(ctx.publicUrl).origin || (ctx.allowLoopback && originIsLoopback(origin));
  if (!sameOrigin) throw new HttpError(403, "Origin not allowed for cookie MCP");
}

/**
 * The stdio shim runs as a synthetic model client for the operator. Its environment is the
 * plane default, never something the request body chose (S4). An operator session that has not
 * passed the authenticator step (or has no org yet) is refused like every other operator route.
 */
export async function mcpModelPrincipal(
  kernel: HostedKernel,
  principal: Principal | undefined,
  deployPlane: DeployPlane,
): Promise<ModelPrincipal> {
  if (principal?.channel === "model") return principal;
  if (principal?.channel === "operator") {
    requireModelOrOperator(principal);
    if (!principal.orgId) throw new HttpError(403, "Organization required");
    const environment = defaultEnvironmentForDeployPlane(deployPlane);
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
      environment: client.environment,
    };
  }
  throw new HttpError(401, "Model OAuth required");
}

export function sseKeepalive(res: ServerResponse): void {
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
