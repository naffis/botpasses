import { hkdfSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import Provider, { errors as oidcErrors, type ProviderContext } from "oidc-provider";
import type { VaultEnvName } from "../hosted-types.ts";
import type { HostedKernel } from "./kernel.ts";
import type { OidcPrivateJwk } from "./boot.ts";
import { createStoreAdapter } from "./oidc-adapter.ts";
import { IpWindowLimiter } from "./operator-identity.ts";
import { requestClientIp } from "./identity-limiter.ts";
import { HttpError } from "./errors.ts";
import { createPinnedFetch, type PinnedFetch } from "./cimd-fetch.ts";
import { deviceConfirmHtml, deviceHtml, deviceSuccessHtml, oauthErrorHtml } from "./oauth-pages.ts";
import { bindSecurityHeaders } from "./security-headers.ts";
import { logVaultEvent } from "./observe.ts";
import {
  asTokenRef,
  clientMetadataValidator,
  logLedgerPersistFailure,
  persistIssuedAccess,
  persistIssuedRefresh,
  persistRevokedToken,
} from "./oauth-clients.ts";

export {
  assertRedirectUri,
  DESKTOP_REDIRECT_SCHEMES,
  isDesktopRedirect,
  persistIssuedAccess,
  persistIssuedRefresh,
  persistRevokedToken,
  redirectHosts,
} from "./oauth-clients.ts";

export type OauthAsOpts = {
  issuer: string;
  kernel: HostedKernel;
  sessionSecret: string;
  jwk: OidcPrivateJwk;
  /** Hosted: cookies are Secure and the provider trusts X-Forwarded-Proto from the edge. */
  secureCookies: boolean;
  /** Vault environment new OAuth clients are bound to. Defaults to `kernel.deployPlane`. */
  deployPlane?: VaultEnvName;
  /** Outbound fetch for CIMD, jwks_uri, sector_identifier_uri. Defaults to the SSRF-pinned fetch. */
  fetchImpl?: PinnedFetch;
};

/** Per-provider state that request handlers outside this module need (consent page, logout). */
type ProviderBinding = { kernel: HostedKernel; secureCookies: boolean };
const bindings = new WeakMap<Provider, ProviderBinding>();

/** The kernel a provider was built with, so interaction handlers can read the store. */
export function kernelForProvider(provider: Provider): HostedKernel | undefined {
  return bindings.get(provider)?.kernel;
}

const dcrLimiter = new IpWindowLimiter();
const cimdLimiter = new IpWindowLimiter();
const CIMD_FETCHES_PER_HOST_PER_HOUR = 30;

const OIDC_COOKIE_KEY_INFO = "botpasses/oidc-provider/cookie-keys/v1";
const OP_SESSION_TTL_S = 3600;

/**
 * oidc-provider signs its cookies with these keys. They are HKDF-derived from
 * VAULT_SESSION_SECRET with a purpose string so the raw secret stays the CSRF HMAC
 * key only; a leak of one derived key does not hand over the other purpose.
 */
export function deriveOidcCookieKeys(sessionSecret: string): string[] {
  const derived = hkdfSync("sha256", sessionSecret, "", OIDC_COOKIE_KEY_INFO, 32);
  return [Buffer.from(derived).toString("base64url")];
}

function mcpAud(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/mcp`;
}

function formSecret(ctx: ProviderContext): string | undefined {
  return ctx.oidc?.session?.state?.secret;
}

function deviceErrorMessage(err: (Error & { userCode?: string }) | undefined): string | undefined {
  if (!err) return undefined;
  switch (err.name) {
    case "NoCodeError":
    case "NotFoundError":
      return "That code did not work. Check it and try again.";
    case "ExpiredError":
      return "That code has expired. Start again on your device.";
    case "AlreadyUsedError":
      return "That code was already used. Start again on your device.";
    case "AbortedError":
      return "The device sign-in was cancelled.";
    default:
      return err.userCode ? "That code did not work. Check it and try again." : "Something went wrong. Try again.";
  }
}

function cimdHostKey(clientId: string): string {
  try {
    return `cimd:${new URL(clientId).host}`;
  } catch {
    return "cimd:invalid";
  }
}

export function createOauthProvider(opts: OauthAsOpts): Provider {
  const issuer = opts.issuer.replace(/\/$/, "");
  const audience = mcpAud(issuer);
  const environment = opts.deployPlane ?? opts.kernel.deployPlane;
  const Adapter = createStoreAdapter(opts.kernel.store);
  const provider = new Provider(issuer, {
    adapter: Adapter,
    clients: [],
    cookies: {
      keys: deriveOidcCookieKeys(opts.sessionSecret),
      short: { httpOnly: true, sameSite: "lax", secure: opts.secureCookies },
      long: { httpOnly: true, sameSite: "lax", secure: opts.secureCookies },
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
        getResourceServerInfo(_ctx, resourceIndicator) {
          if (resourceIndicator !== audience) {
            throw new oidcErrors.InvalidTarget("resource must be the MCP origin");
          }
          return {
            scope: "mcp",
            audience,
            accessTokenFormat: "jwt",
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
        userCodeInputSource(ctx, _form, _out, err) {
          ctx.type = "html";
          ctx.body = deviceHtml(deviceErrorMessage(err), { xsrf: formSecret(ctx) });
        },
        userCodeConfirmSource(ctx, _form, client, _deviceInfo, userCode) {
          ctx.type = "html";
          ctx.body = deviceConfirmHtml({
            clientName: client.clientName || client.clientId,
            userCode,
            xsrf: formSecret(ctx) ?? "",
          });
        },
        successSource(ctx) {
          ctx.type = "html";
          ctx.body = deviceSuccessHtml(ctx.oidc?.client?.clientName);
        },
      },
      revocation: { enabled: true },
      clientIdMetadataDocument: {
        enabled: true,
        ack: "draft-02",
        allowFetch: (_ctx, clientId) =>
          cimdLimiter.allow(cimdHostKey(clientId), CIMD_FETCHES_PER_HOST_PER_HOUR, 60 * 60 * 1000, Date.now()),
        cacheDuration: { min: 60, max: 3600 },
      },
    },
    fetch: opts.fetchImpl ?? createPinnedFetch(),
    findAccount(_ctx, id) {
      return {
        accountId: id,
        async claims() {
          return { sub: id };
        },
      };
    },
    interactions: {
      url(_ctx, interaction) {
        return `/consent?uid=${encodeURIComponent(interaction.uid)}`;
      },
    },
    extraClientMetadata: {
      properties: ["client_name"],
      validator: clientMetadataValidator,
    },
    extraTokenClaims: async (ctx, token) => {
      if (token.kind !== "AccessToken" && token.kind !== "access_token") {
        return undefined;
      }
      if (!token.jti || !token.clientId) throw new Error("token missing jti");
      await persistIssuedAccess(
        opts.kernel,
        {
          jti: token.jti,
          oauthClientId: token.clientId,
          accountId: typeof token.accountId === "string" ? token.accountId : undefined,
          exp: token.exp,
          clientName: ctx.oidc?.client?.clientName,
        },
        environment,
      );
      return undefined;
    },
    jwks: {
      keys: [{ ...opts.jwk, use: "sig", kid: opts.jwk.n.slice(0, 8) }],
    },
    issueRefreshToken: () => true,
    rotateRefreshToken: () => true,
    scopes: ["openid", "mcp"],
    clientDefaults: {
      application_type: "native",
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
      IdToken: 3600,
      // The OP's own login must not outlive a Botpasses session by much: a consent
      // given an hour ago is re-prompted, and logout destroys it (endOidcSession).
      Session: OP_SESSION_TTL_S,
      Grant: 14 * 24 * 3600,
    },
    renderError(ctx, out) {
      ctx.type = "html";
      ctx.body = oauthErrorHtml(out);
    },
  });
  // Fly terminates TLS. Without this Koa sees plain http, `ctx.secure` is false, and
  // the cookie library refuses to set a Secure cookie on /oauth/authorize and /device.
  provider.proxy = opts.secureCookies;
  bindings.set(provider, { kernel: opts.kernel, secureCookies: opts.secureCookies });

  const clientNameFor = async (clientId: string): Promise<string | undefined> => {
    try {
      return (await provider.Client.find(clientId))?.clientName;
    } catch {
      return undefined;
    }
  };

  provider.on("access_token.issued", (...args: unknown[]) => {
    const token = asTokenRef(args[0]);
    if (!token?.jti || !token.clientId) return;
    const { jti, clientId } = token;
    void clientNameFor(clientId)
      .then((clientName) =>
        persistIssuedAccess(
          opts.kernel,
          { jti, oauthClientId: clientId, accountId: token.accountId, exp: token.exp, clientName },
          environment,
        ),
      )
      .catch((err: unknown) => logLedgerPersistFailure("access_issued", err));
  });

  provider.on("refresh_token.saved", (...args: unknown[]) => {
    const token = asTokenRef(args[0]);
    if (!token?.jti || !token.clientId) return;
    const { jti, clientId } = token;
    void clientNameFor(clientId)
      .then((clientName) =>
        persistIssuedRefresh(
          opts.kernel,
          { jti, oauthClientId: clientId, accountId: token.accountId, exp: token.exp, clientName },
          environment,
        ),
      )
      .catch((err: unknown) => logLedgerPersistFailure("refresh_saved", err));
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

/**
 * Destroys the OP's own browser session so a later authorize request cannot reuse a
 * login that Botpasses has already ended. Returns Set-Cookie headers that clear the OP
 * session cookie; the caller (`POST /api/auth/logout`) appends them to its own.
 */
export async function endOidcSession(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<string[]> {
  const ctx = provider.createContext(req, res);
  const session = await provider.Session.get(ctx);
  if (!session.new) await session.destroy();
  const secure = bindings.get(provider)?.secureCookies ?? false;
  const name = provider.cookieName("session");
  const attrs = `Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  return [`${name}=; ${attrs}`, `${name}.sig=; ${attrs}`];
}

/** Paths oidc-provider owns. `/device/:uid` is the device-flow resume route. */
export function isOauthPath(path: string): boolean {
  return (
    path.startsWith("/oauth/") ||
    path === "/device" ||
    path.startsWith("/device/") ||
    path === "/.well-known/openid-configuration" ||
    path === "/.well-known/oauth-authorization-server"
  );
}

export function assertDcrIp(req: IncomingMessage): void {
  const ip = requestClientIp(req);
  if (!dcrLimiter.allow(`dcr:${ip}`, 20, 60 * 60 * 1000, Date.now())) {
    throw new HttpError(429, "Too many registrations");
  }
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
