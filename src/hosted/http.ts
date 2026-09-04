import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { logRequest, requestIdFrom } from "./observe.ts";
import type { AddressInfo } from "node:net";
import { HEALTH_PRODUCT } from "../brand.ts";
import {
  requireModelOrOperator,
  requireOperator,
  requireTrusted,
  testAuthResolver,
  type AuthResolver,
  type Principal,
} from "./auth.ts";
import { AgentPassAuthority, agentPassEnabled } from "./agentpass.ts";
import { type ConnectorFetch } from "./connector.ts";
import { HttpError } from "./errors.ts";
import type { HostedKernel } from "./kernel.ts";
import { listHostedMcpTools } from "./mcp.ts";
import { hostedCollectHtml, hostedCollectMissingHtml } from "./collect-page.ts";
import { hostedOperatorHtml } from "./operator-page.ts";
import { hostedPageHeaders, MARKETING_CSP_EXTRAS, newCspNonce, securityHeaders } from "./security-headers.ts";
import { isPublicSitePath, tryServeSite } from "./static-site.ts";
import { hostedAsset } from "./hosted-assets.ts";
import { hostedFont } from "./console-fonts.ts";
import { handleAuthApi, tryAuthPage } from "./http-auth-routes.ts";
import { handleAccessApi } from "./http-access-routes.ts";
import { handleClientRoutes } from "./http-client-routes.ts";
import { handleConnectCallback } from "./http-connect-routes.ts";
import { handleGrantRoutes } from "./http-grant-routes.ts";
import { handleItemRoutes } from "./http-item-routes.ts";
import { handleMemberRoutes } from "./http-member-routes.ts";
import { handleMcpPost, KEEPALIVE_MS, sseKeepalive } from "./http-mcp-routes.ts";
import {
  asEnv,
  isLoopbackHost,
  isPublicHtmlPath,
  json,
  optional,
  originIsLoopback,
  readJson,
  robotsTxt,
  sendError,
} from "./http-util.ts";
import type { OperatorIdentity } from "./operator-identity.ts";
import { assertDcrIp, handleOauth, isOauthPath } from "./oauth-as.ts";
import { handleConsentGet, handleConsentPost } from "./oauth-interactions.ts";
import { isMcpClientSurface, isOauthDiscoveryPath, oauthDiscoveryDocument } from "./oauth-metadata.ts";
import { bindCors, corsHeaders, hostAllowlist, originAllowed, originOk } from "./http-cors.ts";
import type Provider from "oidc-provider";

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
    const startedAt = process.hrtime.bigint();
    const requestId = requestIdFrom(req.headers);
    res.setHeader("x-request-id", requestId);
    res.on("finish", () => {
      logRequest({
        method: req.method ?? "GET",
        path: (req.url ?? "/").split("?")[0] ?? "/",
        status: res.statusCode,
        ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
        requestId,
      });
    });
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

    if (await handleConnectCallback(req, res, url, method, path, principal, opts.kernel, opts.fetchImpl)) return;

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
      await handleMcpPost(req, res, path, principal, {
        kernel: opts.kernel,
        identity,
        secureCookies,
        publicUrl,
        allowLoopback,
        deployPlane,
        fetchImpl: opts.fetchImpl,
        resolveAddresses: opts.resolveAddresses,
      });
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
        oidcProvider,
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
      await handleMemberRoutes(req, res, url, method, path, principal, {
        kernel: opts.kernel,
        publicUrl,
        htmlHeaders: (nonce) => operatorAppHeaders(nonce),
        newCspNonce,
      })
    ) {
      return;
    }
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
      const op = requireOperator(principal);
      const body = await readJson(req);
      json(res, 200, await opts.kernel.createOrgForUser(String(body.name ?? ""), op.userId));
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

export { KEEPALIVE_MS };
