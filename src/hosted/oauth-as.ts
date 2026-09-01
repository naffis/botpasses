import type { IncomingMessage, ServerResponse } from "node:http";
import Provider, { errors as oidcErrors } from "oidc-provider";
import type { HostedKernel } from "./kernel.ts";
import type { OidcPrivateJwk } from "./boot.ts";
import { createStoreAdapter } from "./oidc-adapter.ts";
import { IpWindowLimiter } from "./operator-identity.ts";
import { hashToken } from "./operator-identity.ts";
import { HttpError } from "./errors.ts";
import { fetchCimdDocument } from "./cimd-fetch.ts";
import { deviceHtml } from "./auth-pages.ts";
import { bindSecurityHeaders } from "./security-headers.ts";
import { logVaultEvent } from "./observe.ts";

export type OauthAsOpts = {
  issuer: string;
  kernel: HostedKernel;
  sessionSecret: string;
  jwk: OidcPrivateJwk;
  secureCookies: boolean;
};

const dcrLimiter = new IpWindowLimiter();

function logLedgerPersistFailure(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logVaultEvent("ledger_persist_failed", { kind, message: message.slice(0, 200) });
}

function mcpAud(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/mcp`;
}

function assertRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("invalid redirect_uri");
  }
  if (parsed.protocol === "javascript:" || parsed.protocol === "data:" || parsed.protocol === "file:") {
    throw new Error("redirect_uri scheme is not allowed");
  }
  const loopback =
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.protocol === "http:";
  if (parsed.protocol === "https:" || loopback) return;
  throw new Error("redirect_uri must be https or loopback http");
}

export function createOauthProvider(opts: OauthAsOpts): Provider {
  const issuer = opts.issuer.replace(/\/$/, "");
  const audience = mcpAud(issuer);
  const Adapter = createStoreAdapter(opts.kernel.store);
  const provider = new Provider(issuer, {
    adapter: Adapter,
    clients: [],
    cookies: {
      keys: [opts.sessionSecret],
      short: { sameSite: "lax", secure: opts.secureCookies },
      long: { sameSite: "lax", secure: opts.secureCookies },
    },
    pkce: {
      required: () => true,
    },
    routes: {
      authorization: "/oauth/authorize",
      token: "/oauth/token",
      jwks: "/oauth/jwks",
      registration: "/oauth/register",
      revocation: "/oauth/revoke",
      end_session: "/oauth/session/end",
      device_authorization: "/oauth/device/auth",
    },
    features: {
      devInteractions: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => audience,
        getResourceServerInfo(_ctx: unknown, resourceIndicator: string) {
          if (resourceIndicator !== audience) {
            throw new oidcErrors.InvalidTarget("resource must be the MCP origin");
          }
          return {
            scope: "mcp",
            audience,
            accessTokenFormat: "jwt" as const,
            accessTokenTTL: 600,
          };
        },
        useGrantedResource: () => true,
      },
      registration: {
        enabled: true,
        idFactory: () => `dcr_${crypto.randomUUID()}`,
      },
      registrationManagement: { enabled: false },
      deviceFlow: {
        enabled: true,
        charset: "digits",
        userCodeInputSource(ctx: { body?: string }, _form: string, _out: unknown, err: unknown) {
          ctx.body = deviceHtml(err ? "That code did not work. Try again." : undefined);
        },
      },
      revocation: { enabled: true },
    },
    findAccount(_ctx: unknown, id: string) {
      return {
        accountId: id,
        async claims() {
          return { sub: id };
        },
      };
    },
    interactions: {
      url(_ctx: unknown, interaction: { uid: string }) {
        return `/consent?uid=${encodeURIComponent(interaction.uid)}`;
      },
    },
    extraClientMetadata: {
      properties: ["client_name"],
      validator(_ctx: unknown, key: string, value: unknown, metadata: Record<string, unknown>) {
        if (key === "client_name" && typeof value === "string" && value.length > 80) {
          throw new Error("client_name too long");
        }
        delete metadata.logo_uri;
        delete metadata.policy_uri;
        const uris = metadata.redirect_uris;
        if (Array.isArray(uris)) {
          for (const uri of uris) {
            if (typeof uri !== "string") {
              throw new oidcErrors.InvalidClientMetadata("invalid redirect_uri");
            }
            try {
              assertRedirectUri(uri);
            } catch (err) {
              throw new oidcErrors.InvalidClientMetadata(
                err instanceof Error ? err.message : "invalid redirect_uri",
              );
            }
          }
        }
      },
    },
    extraTokenClaims: async (_ctx: unknown, token: { kind?: string; jti?: string; clientId?: string; accountId?: string; exp?: number }) => {
      if (token.kind !== "AccessToken" && token.kind !== "access_token") {
        return undefined;
      }
      if (!token.jti || !token.clientId) throw new Error("token missing jti");
      await persistIssuedAccess(opts.kernel, {
        jti: token.jti,
        oauthClientId: token.clientId,
        accountId: typeof token.accountId === "string" ? token.accountId : undefined,
        exp: token.exp,
      });
      return undefined;
    },
    jwks: {
      keys: [{ ...opts.jwk, use: "sig", kid: opts.jwk.n.slice(0, 8) }],
    },
    issueRefreshToken: () => true,
    rotateRefreshToken: () => true,
    scopes: ["openid", "mcp"],
    clientDefaults: {
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
      response_types: ["code"],
      id_token_signed_response_alg: "RS256",
    },
    ttl: {
      AccessToken: 600,
      AuthorizationCode: 60,
      DeviceCode: 600,
      RefreshToken: 14 * 24 * 3600,
      Interaction: 3600,
      Session: 14 * 24 * 3600,
    },
    renderError(_ctx: unknown, out: unknown) {
      void out;
      return undefined;
    },
  });

  provider.on("access_token.issued", (...args: unknown[]) => {
    const token = asTokenRef(args[0]);
    if (!token?.jti || !token.clientId) return;
    void persistIssuedAccess(opts.kernel, {
      jti: token.jti,
      oauthClientId: token.clientId,
      accountId: token.accountId,
      exp: token.exp,
    }).catch((err: unknown) => logLedgerPersistFailure("access_issued", err));
  });

  provider.on("refresh_token.saved", (...args: unknown[]) => {
    const token = asTokenRef(args[0]);
    if (!token?.jti || !token.clientId) return;
    void persistIssuedRefresh(opts.kernel, {
      jti: token.jti,
      oauthClientId: token.clientId,
      accountId: token.accountId,
      exp: token.exp,
    }).catch((err: unknown) => logLedgerPersistFailure("refresh_saved", err));
  });

  const onDestroyed = (...args: unknown[]) => {
    const token = asTokenRef(args[0]);
    if (token?.jti) {
      void persistRevokedToken(opts.kernel, token.jti).catch((err: unknown) =>
        logLedgerPersistFailure("token_destroyed", err),
      );
    }
  };
  provider.on("access_token.destroyed", onDestroyed);
  provider.on("refresh_token.destroyed", onDestroyed);
  provider.on("grant.revoked", () => {
    logVaultEvent("oauth_grant_revoked", {});
  });

  return provider;
}

export async function persistRevokedToken(kernel: HostedKernel, jti: string): Promise<void> {
  const existing = await kernel.store.getAccessEventByJti(hashToken(jti));
  if (!existing || existing.revokedAt) return;
  const at = new Date().toISOString();
  await kernel.store.revokeAccessEvent(existing.jtiHash, at);
  await kernel.writeAudit(
    existing.orgId,
    "token_revoked",
    existing.actorUserId ?? existing.clientId ?? "oauth",
    null,
    existing.clientId,
  );
}

async function persistIssuedOauth(
  kernel: HostedKernel,
  kind: "oauth_access" | "oauth_refresh",
  input: { jti: string; oauthClientId: string; accountId?: string; exp?: number },
): Promise<void> {
  const existing = await kernel.store.getAccessEventByJti(hashToken(input.jti));
  if (existing) return;
  const orgUser = input.accountId ? await kernel.ensureVaultOrgForUser(input.accountId) : undefined;
  if (!orgUser) throw new Error("token missing account");
  const client = await kernel.ensureModelClient({
    orgId: orgUser.orgId,
    name: input.oauthClientId.slice(0, 80),
    environment: "staging",
    clerkOauthUserId: input.oauthClientId,
  });
  const at = new Date().toISOString();
  await kernel.recordAccessEvent({
    orgId: orgUser.orgId,
    clientId: client.id,
    actorUserId: input.accountId ?? null,
    kind,
    jtiHash: hashToken(input.jti),
    issuedAt: at,
    expiresAt: input.exp ? new Date(input.exp * 1000).toISOString() : null,
  });
  await kernel.store.setClientLastTokenAt(client.id, at);
  await kernel.writeAudit(orgUser.orgId, "token_issued", input.accountId ?? client.id, null, client.id);
}

export async function persistIssuedAccess(
  kernel: HostedKernel,
  input: { jti: string; oauthClientId: string; accountId?: string; exp?: number },
): Promise<void> {
  return persistIssuedOauth(kernel, "oauth_access", input);
}

export async function persistIssuedRefresh(
  kernel: HostedKernel,
  input: { jti: string; oauthClientId: string; accountId?: string; exp?: number },
): Promise<void> {
  return persistIssuedOauth(kernel, "oauth_refresh", input);
}

function asTokenRef(value: unknown): { jti?: string; clientId?: string; accountId?: string; exp?: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  return {
    jti: typeof rec.jti === "string" ? rec.jti : undefined,
    clientId: typeof rec.clientId === "string" ? rec.clientId : undefined,
    accountId: typeof rec.accountId === "string" ? rec.accountId : undefined,
    exp: typeof rec.exp === "number" ? rec.exp : undefined,
  };
}

export function isOauthPath(path: string): boolean {
  return (
    path.startsWith("/oauth/") ||
    path === "/device" ||
    path === "/.well-known/openid-configuration" ||
    path === "/.well-known/oauth-authorization-server"
  );
}

export function assertDcrIp(req: IncomingMessage): void {
  const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.socket.remoteAddress ?? "0.0.0.0").trim();
  if (!dcrLimiter.allow(`dcr:${ip}`, 20, 60 * 60 * 1000, Date.now())) {
    throw new HttpError(429, "Too many registrations");
  }
}

export function assertDcrRequest(req: IncomingMessage, body: Record<string, unknown>): void {
  assertDcrIp(req);
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) throw new HttpError(400, "redirect_uris required");
  for (const uri of uris) {
    if (typeof uri !== "string") throw new HttpError(400, "invalid redirect_uri");
    try {
      assertRedirectUri(uri);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : "invalid redirect_uri");
    }
  }
  if (typeof body.client_name === "string" && body.client_name.length > 80) {
    throw new HttpError(400, "client_name too long");
  }
}

export async function maybeLoadCimd(clientId: string): Promise<unknown | undefined> {
  if (!clientId.startsWith("https://")) return undefined;
  return fetchCimdDocument(clientId);
}

export function oauthCallback(provider: Provider) {
  return provider.callback();
}

export function handleOauth(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  bindSecurityHeaders(res);
  return new Promise((resolve, reject) => {
    const cb = provider.callback();
    cb(req, res, (err?: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
