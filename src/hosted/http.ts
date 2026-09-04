import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HEALTH_PRODUCT } from "../brand.ts";
import { defaultEnvironmentForDeployPlane } from "./deploy-plane.ts";
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
import { HttpError } from "./errors.ts";
import type { HostedKernel } from "./kernel.ts";
import {
  handleHostedMcpRpc,
  isMcpHandshakeMethod,
  listHostedMcpTools,
  type JsonRpcRequest,
} from "./mcp.ts";
import { hostedCollectHtml, hostedCollectMissingHtml } from "./collect-page.ts";
import { hostedOperatorHtml } from "./operator-page.ts";
import { hostedPageHeaders, MARKETING_CSP_EXTRAS, newCspNonce, securityHeaders } from "./security-headers.ts";
import { isPublicSitePath, tryServeSite } from "./static-site.ts";
import { hostedAsset } from "./hosted-assets.ts";
import { hostedFont } from "./console-fonts.ts";
import { handleAuthApi, tryAuthPage } from "./http-auth-routes.ts";
import { handleAccessApi } from "./http-access-routes.ts";
import { handleClientRoutes } from "./http-client-routes.ts";
import { handleGrantRoutes } from "./http-grant-routes.ts";
import { handleItemRoutes } from "./http-item-routes.ts";
import { asEnv, json, optional, readJson, sendError } from "./http-util.ts";
import type { OperatorIdentity } from "./operator-identity.ts";
import { assertDcrIp, handleOauth, isOauthPath } from "./oauth-as.ts";
import { handleConsentGet, handleConsentPost } from "./oauth-interactions.ts";
import { isMcpClientSurface, isOauthDiscoveryPath, oauthDiscoveryDocument } from "./oauth-metadata.ts";
import { bindCors, corsHeaders, hostAllowlist, originAllowed, originOk } from "./http-cors.ts";
import type Provider from "oidc-provider";

const KEEPALIVE_MS = 25_000;

/**
 * Host header check. Loopback hosts are only trusted when `allowLoopback` is set (tests and
 * local runs); a public plane never answers to `Host: localhost`.
 */
export function hostAllowed(hostHeader: string, allowed: string[], allowLoopback = false): boolean {
  const host = (hostHeader.split(":")[0] ?? "").toLowerCase();
  if (!host) return false;
  if (isLoopbackHost(host)) return allowLoopback;
  return allowed.some((a) => (a.split(":")[0] ?? "").toLowerCase() === host);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function originIsLoopback(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type HostedHttpOpts = {
  kernel: HostedKernel;
  host?: string;
  port?: number;
  publicUrl?: string;
  authResolver?: AuthResolver;
  fetchImpl?: ConnectorFetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  allowedHosts?: string[];
  siteRoot?: string;
  deployPlane?: "staging" | "production";
  identity?: OperatorIdentity;
  oidcProvider?: Provider;
  secureCookies?: boolean;
};

export function createHostedServer(opts: HostedHttpOpts) {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8788;
  const publicUrl = opts.publicUrl ?? opts.kernel.publicUrl;
  const auth = opts.authResolver ?? testAuthResolver;
  const agentpass = agentPassEnabled() ? new AgentPassAuthority(opts.kernel, publicUrl) : undefined;
  const allowed = opts.allowedHosts ?? hostAllowlist(publicUrl);
  const siteRoot = opts.siteRoot;
  const deployPlane = opts.deployPlane ?? opts.kernel.deployPlane;
  const testMode = opts.authResolver === testAuthResolver || process.env.VAULT_AUTH_MODE === "test";
  const allowLoopback = auth === testAuthResolver || testMode || !publicUrl.startsWith("https://");
  const secureCookies = opts.secureCookies ?? publicUrl.startsWith("https://");
  const identity = opts.identity;
  const oidcProvider = opts.oidcProvider;

  function operatorAppHeaders(nonce: string): Record<string, string> {
    return hostedPageHeaders(deployPlane, {
      html: true,
      nonce,
      extraFontSrc: ["'self'"],
      extraImgSrc: ["'self'"],
    });
  }

  const server = createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendError(res, err);
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    bindCors(res, { req, path, allowed, testMode, publicUrl });
    const originHdr = typeof req.headers.origin === "string" ? req.headers.origin : "";
    if (originHdr && !originAllowed(originHdr, allowed) && !isMcpClientSurface(path)) {
      res.writeHead(403, {
        "content-type": "application/json; charset=utf-8",
        ...securityHeaders({ html: false }),
      });
      res.end(JSON.stringify({ error: "Origin not allowed" }));
      return;
    }

    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders(res));
      res.end();
      return;
    }

    if (method === "GET" && path === "/health") {
      json(res, 200, { ok: true, product: HEALTH_PRODUCT }, true);
      return;
    }
    if (method === "GET" && path === "/ready") {
      try {
        await opts.kernel.ping();
        json(res, 200, { ok: true }, true);
      } catch {
        json(res, 503, { ok: false }, true);
      }
      return;
    }
    if ((method === "GET" || method === "HEAD") && isOauthDiscoveryPath(path)) {
      const body = oauthDiscoveryDocument(path, publicUrl);
      if (body) {
        json(res, 200, body);
        return;
      }
    }
    if ((method === "GET" || method === "HEAD") && path.startsWith("/assets/")) {
      const font = hostedFont(path);
      if (font) {
        res.writeHead(200, {
          "content-type": font.type,
          "cache-control": "public, max-age=31536000, immutable",
          ...securityHeaders({ html: false, cache: false }),
        });
        res.end(font.body);
        return;
      }
      const asset = hostedAsset(path);
      if (asset) {
        res.writeHead(200, {
          "content-type": asset.type,
          "cache-control": "public, max-age=31536000, immutable",
          ...securityHeaders({ html: false, cache: false }),
        });
        res.end(asset.body);
        return;
      }
    }
    if ((method === "GET" || method === "HEAD") && path === "/robots.txt") {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-cache",
        ...securityHeaders({ html: false, cache: false }),
        ...(deployPlane === "staging" ? { "x-robots-tag": "noindex, nofollow" } : {}),
      });
      res.end(robotsTxt(deployPlane));
      return;
    }
    if (siteRoot && (method === "GET" || method === "HEAD") && isPublicSitePath(path)) {
      if (
        tryServeSite(
          req,
          res,
          siteRoot,
          path,
          hostedPageHeaders(deployPlane, { html: true, nonce: newCspNonce(), ...MARKETING_CSP_EXTRAS }),
          securityHeaders({ html: false, cache: false }),
        )
      ) {
        return;
      }
    }
    if (agentpass && method === "GET" && path === "/agentpass/configuration") {
      json(res, 200, agentpass.configuration());
      return;
    }
    if (agentpass && method === "GET" && path === "/agentpass/jwks") {
      json(res, 200, agentpass.jwks());
      return;
    }

    if (!originOk(req, allowed, path) || !hostAllowed(req.headers.host ?? "", allowed, allowLoopback)) {
      json(res, 403, { error: "Origin/Host not allowed" });
      return;
    }
    if (!allowLoopback && originHdr && originIsLoopback(originHdr) && !isMcpClientSurface(path)) {
      json(res, 403, { error: "Origin/Host not allowed" });
      return;
    }

    if (oidcProvider && isOauthPath(path) && !path.startsWith("/.well-known/")) {
      if (method === "POST" && path === "/oauth/register") assertDcrIp(req);
      await handleOauth(oidcProvider, req, res);
      return;
    }

    let principal: Principal | undefined;
    try {
      principal = await auth(req, opts.kernel);
    } catch (err) {
      const publicGet = (method === "GET" || method === "HEAD") && isPublicHtmlPath(path, Boolean(siteRoot));
      if (!publicGet) {
        sendError(res, err, path);
        return;
      }
      principal = undefined;
    }
    const bearer = typeof req.headers.authorization === "string" &&
      req.headers.authorization.toLowerCase().startsWith("bearer ");
    if (bearer && !principal && isMcpClientSurface(path) && !isOauthDiscoveryPath(path)) {
      sendError(res, new HttpError(401, "Authentication required"), path);
      return;
    }

    if (oidcProvider && (method === "GET" || method === "HEAD") && path === "/consent") {
      await handleConsentGet(
        oidcProvider,
        req,
        res,
        principal,
        operatorAppHeaders(newCspNonce()),
      );
      return;
    }
    if (
      tryAuthPage(
        method,
        path,
        res,
        operatorAppHeaders(newCspNonce()),
        principal,
      )
    ) {
      return;
    }

    if (method === "GET" && path === "/mcp") {
      try {
        requireModelOrOperator(principal);
      } catch (err) {
        sendError(res, err, path);
        return;
      }
      sseKeepalive(res);
      return;
    }

    if (method === "GET" && path === "/integrations/spotify/callback") {
      if (!principal || principal.channel !== "operator") {
        res.writeHead(302, { location: "/sign-in" });
        res.end();
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const err = url.searchParams.get("error");
      if (err || !code || !state) {
        res.writeHead(302, { location: "/console#vault" });
        res.end();
        return;
      }
      try {
        await opts.kernel.finishSpotifyUserOauth({
          orgId: principal.orgId,
          userId: principal.userId,
          state,
          code,
          fetchImpl: opts.fetchImpl,
        });
        res.writeHead(302, { location: "/console#vault?spotify=connected" });
        res.end();
      } catch {
        res.writeHead(302, { location: "/console#vault?spotify=error" });
        res.end();
      }
      return;
    }

    if (method === "GET" && path === "/console/") {
      res.writeHead(308, { location: "/console" });
      res.end();
      return;
    }
    if (
      (method === "GET" || method === "HEAD") &&
      (path === "/console" || (!siteRoot && (path === "/" || path === "/index.html")))
    ) {
      const nonce = newCspNonce();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        ...operatorAppHeaders(nonce),
      });
      res.end(method === "HEAD" ? undefined : hostedOperatorHtml({ hosted: Boolean(siteRoot), nonce, deployPlane }));
      return;
    }
    const collect = /^\/collect\/([^/]+)$/.exec(path);
    if (method === "GET" && collect) {
      const needId = decodeURIComponent(collect[1] ?? "");
      const found = await opts.kernel.getNeed(needId);
      if (!found) {
        const nonce = newCspNonce();
        res.writeHead(404, {
          "content-type": "text/html; charset=utf-8",
          ...operatorAppHeaders(nonce),
        });
        res.end(hostedCollectMissingHtml());
        return;
      }
      const nonce = newCspNonce();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        ...operatorAppHeaders(nonce),
      });
      res.end(
        hostedCollectHtml({
          needId: found.need.id,
          origin: publicUrl.replace(/\/$/, "") || `http://${req.headers.host ?? "127.0.0.1"}`,
          nonce,
        }),
      );
      return;
    }

    if (method === "POST" && path === "/mcp") {
      const body = (await readJson(req)) as JsonRpcRequest;
      if (!principal && isMcpHandshakeMethod(body.method)) {
        const rpc = await handleHostedMcpRpc(
          {
            kernel: opts.kernel,
            principal: { channel: "model", orgId: "anon", clientId: "anon", environment: "staging" },
            fetchImpl: opts.fetchImpl,
            resolveAddresses: opts.resolveAddresses,
          },
          body,
        );
        if (!rpc) {
          res.writeHead(202, securityHeaders({ html: false }));
          res.end();
          return;
        }
        json(res, 200, rpc);
        return;
      }
      let model: ModelPrincipal;
      try {
        assertCookieMcpRequest(req, principal, {
          identity,
          secureCookies,
          publicOrigin: new URL(publicUrl).origin,
          allowLoopback,
        });
        model = await mcpModelPrincipal(opts.kernel, principal, deployPlane);
      } catch (err) {
        sendError(res, err, path);
        return;
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
        res.writeHead(202, securityHeaders({ html: false }));
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

  function setCookies(res: ServerResponse, cookies: string[], status: number, body: unknown): void {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": cookies,
      ...securityHeaders({ html: false }),
      ...corsHeaders(res),
    });
    res.end(JSON.stringify(body));
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
    if (identity) {
      const handled = await handleAuthApi(req, res, method, path, principal, {
        identity,
        secure: secureCookies,
        htmlHeaders: hostedPageHeaders(deployPlane, { html: true, nonce: newCspNonce() }),
        readJson,
        json,
        setCookies,
        clientIp: (r) =>
          identity.clientIp(
            typeof r.headers["x-forwarded-for"] === "string" ? r.headers["x-forwarded-for"] : undefined,
            r.socket.remoteAddress,
          ),
      });
      if (handled) return;
    }
    const mutating = method === "POST" || method === "DELETE" || method === "PATCH" || method === "PUT";
    if (identity && mutating && cookieCsrfApplies(path, principal)) {
      identity.assertCsrf(
        req.headers.cookie,
        typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined,
        secureCookies,
      );
    }
    if (oidcProvider && method === "POST" && path === "/consent") {
      const body = await readJson(req);
      await handleConsentPost(
        oidcProvider,
        req,
        res,
        principal,
        body,
        `${publicUrl.replace(/\/$/, "")}/mcp`,
      );
      return;
    }
    if (
      await handleAccessApi(req, res, method, path, principal, opts.kernel, readJson, json)
    ) {
      return;
    }
    if (await handleItemRoutes(req, res, url, method, path, principal, opts.kernel)) return;
    if (await handleClientRoutes(req, res, method, path, principal, opts.kernel, publicUrl)) return;
    if (
      await handleGrantRoutes(req, res, url, method, path, principal, {
        kernel: opts.kernel,
        htmlHeaders: () => operatorAppHeaders(newCspNonce()),
      })
    ) {
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
      if (principal) requireModelOrOperator(principal);
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

/**
 * Cookie sessions may drive MCP as a model (the stdio shim), but only from our own pages: the
 * request must carry the CSRF header and an Origin on this deployment (S4). Bearer principals
 * and header-authenticated test principals have no cookie to ride.
 */
function assertCookieMcpRequest(
  req: IncomingMessage,
  principal: Principal | undefined,
  ctx: {
    identity: OperatorIdentity | undefined;
    secureCookies: boolean;
    publicOrigin: string;
    allowLoopback: boolean;
  },
): void {
  if (principal?.channel !== "operator" || !principal.sessionHash) return;
  if (!ctx.identity) throw new HttpError(403, "CSRF required");
  ctx.identity.assertCsrf(
    req.headers.cookie,
    typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined,
    ctx.secureCookies,
  );
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  const sameOrigin = origin === ctx.publicOrigin || (ctx.allowLoopback && originIsLoopback(origin));
  if (!sameOrigin) throw new HttpError(403, "Origin not allowed for cookie MCP");
}

/**
 * The stdio shim runs as a synthetic model client for the operator. Its environment is the
 * plane default, never something the request body chose (S4).
 */
async function mcpModelPrincipal(
  kernel: HostedKernel,
  principal: Principal | undefined,
  deployPlane: "staging" | "production",
): Promise<ModelPrincipal> {
  if (principal?.channel === "model") return principal;
  if (principal?.channel === "operator") {
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

/**
 * Cookie sessions need the double-submit header on every mutation. Only the email-OTP steps
 * (no session yet) and POST /approve (protected by its HMAC token; an HTML form from an email
 * link cannot set headers) are exempt. TOTP and logout are no longer exempt here; their handlers
 * run first in `handleAuthApi` and enforce CSRF themselves.
 */
function cookieCsrfApplies(path: string, principal: Principal | undefined): boolean {
  if (principal?.channel !== "operator" || !principal.sessionHash) return false;
  if (path.startsWith("/api/auth/otp/")) return false;
  if (path === "/approve") return false;
  return true;
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

export { KEEPALIVE_MS };

function isPublicHtmlPath(path: string, hosted: boolean): boolean {
  if (!hosted) return path === "/" || path === "/index.html" || path.startsWith("/collect/");
  return isPublicSitePath(path) || path === "/console" || path.startsWith("/collect/") ||
    path === "/sign-in" || path === "/sign-up" || path === "/enroll-totp" || path === "/consent" ||
    path === "/device";
}

function robotsTxt(plane: "staging" | "production"): string {
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
