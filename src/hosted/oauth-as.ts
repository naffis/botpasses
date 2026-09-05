import { hkdfSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import Provider, { errors as oidcErrors, type Grant, type ProviderCallback, type ProviderContext } from "oidc-provider";
import type { VaultEnvName } from "../hosted-types.ts";
import type { HostedKernel } from "./kernel.ts";
import type { OidcPrivateJwk } from "./boot.ts";
import { createStoreAdapter } from "./oidc-adapter.ts";
import { hashToken } from "./operator-identity.ts";
import { IpWindowLimiter, requestClientIp } from "./identity-limiter.ts";
import { HttpError } from "./errors.ts";
import { sendError } from "./http-util.ts";
import { createPinnedFetch, type PinnedFetch } from "./cimd-fetch.ts";
import { deviceConfirmHtml, deviceHtml, deviceSuccessHtml, oauthErrorHtml } from "./oauth-pages.ts";
import { bindSecurityHeaders } from "./security-headers.ts";
import { logVaultEvent } from "./observe.ts";
import { ORG_CLAIM, oidcKid, verifyAccessJwt, type OidcKeySet } from "./access-jwt.ts";
import {
  OAUTH_GRANT_TYPES,
  OAUTH_RESPONSE_TYPES,
  OAUTH_SCOPES,
  OAUTH_TOKEN_ENDPOINT_AUTH_METHODS,
} from "./oauth-metadata.ts";
import {
  asTokenRef,
  clientMetadataValidator,
  issuanceFromGty,
  issuanceKind,
  logLedgerPersistFailure,
  orgForIssuance,
  persistIssuedAccess,
  persistIssuedRefresh,
  persistRevokedGrant,
  persistRevokedToken,
  type IssuanceKind,
  type IssuedTokenInput,
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
  /**
   * The key `jwk` replaced. Published in JWKS and accepted for verification so tokens
   * signed before a rotation stay valid until they expire; never used to sign.
   */
  previousJwk?: OidcPrivateJwk;
  /** Hosted: cookies are Secure and the provider trusts X-Forwarded-Proto from the edge. */
  secureCookies: boolean;
  /** Vault environment new OAuth clients are bound to. Defaults to `kernel.deployPlane`. */
  deployPlane?: VaultEnvName;
  /** Outbound fetch for CIMD, jwks_uri, sector_identifier_uri. Defaults to the SSRF-pinned fetch. */
  fetchImpl?: PinnedFetch;
  /** Rate and concurrency gate for outbound metadata fetches. Defaults to one shared per process. */
  cimdGate?: CimdGate;
};

/** Per-provider state that request handlers outside this module need (consent page, logout). */
type ProviderBinding = { kernel: HostedKernel; secureCookies: boolean; callback: ProviderCallback };
const bindings = new WeakMap<Provider, ProviderBinding>();

/** The kernel a provider was built with, so interaction handlers can read the store. */
export function kernelForProvider(provider: Provider): HostedKernel | undefined {
  return bindings.get(provider)?.kernel;
}

const dcrLimiter = new IpWindowLimiter();
const deviceLimiter = new IpWindowLimiter();

const OIDC_COOKIE_KEY_INFO = "botpasses/oidc-provider/cookie-keys/v1";
const OP_SESSION_TTL_S = 3600;

/* ---- outbound metadata fetch gate (CIMD, jwks_uri, sector_identifier_uri) ---- */

const CIMD_FETCHES_PER_HOST_PER_HOUR = 30;
const CIMD_FETCHES_PER_IP_PER_HOUR = 10;
const CIMD_MAX_IN_FLIGHT = 4;

export type CimdGateOpts = { perHostPerHour?: number; perIpPerHour?: number; maxInFlight?: number };

/**
 * A `client_id` URL makes this server fetch a document from a host the requester chose.
 * The gate bounds that in three ways: per target host, per requesting IP, and a small
 * cap on fetches in flight at once, so an authorize storm cannot turn the AS into an
 * amplifier against a third party or exhaust its own sockets.
 */
export class CimdGate {
  readonly #hosts = new IpWindowLimiter();
  readonly #ips = new IpWindowLimiter();
  readonly #perHost: number;
  readonly #perIp: number;
  readonly #maxInFlight: number;
  #inFlight = 0;

  constructor(opts: CimdGateOpts = {}) {
    this.#perHost = opts.perHostPerHour ?? CIMD_FETCHES_PER_HOST_PER_HOUR;
    this.#perIp = opts.perIpPerHour ?? CIMD_FETCHES_PER_IP_PER_HOUR;
    this.#maxInFlight = opts.maxInFlight ?? CIMD_MAX_IN_FLIGHT;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  /**
   * Both windows must have room. The requester's IP window is charged first, so a
   * request the host window then refuses still counts against the requester, not the host.
   */
  allow(clientId: string, ip: string | undefined, now: number): boolean {
    const hour = 60 * 60 * 1000;
    if (!this.#ips.allow(`cimd-ip:${ip ?? "unknown"}`, this.#perIp, hour, now)) return false;
    return this.#hosts.allow(cimdHostKey(clientId), this.#perHost, hour, now);
  }

  /** Wraps a fetch so at most `maxInFlight` documents are being fetched at once. */
  wrap(inner: PinnedFetch): PinnedFetch {
    return async (input, init) => {
      if (this.#inFlight >= this.#maxInFlight) {
        throw new HttpError(503, "Too many metadata fetches in flight");
      }
      this.#inFlight += 1;
      try {
        return await inner(input, init);
      } finally {
        this.#inFlight -= 1;
      }
    };
  }
}

const sharedCimdGate = new CimdGate();

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

function looksLikeJwt(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function signingKey(jwk: OidcPrivateJwk): Record<string, unknown> {
  return { ...jwk, use: "sig", kid: oidcKid(jwk) };
}

export function createOauthProvider(opts: OauthAsOpts): Provider {
  const issuer = opts.issuer.replace(/\/$/, "");
  const audience = mcpAud(issuer);
  const environment = opts.deployPlane ?? opts.kernel.deployPlane;
  const Adapter = createStoreAdapter(opts.kernel.store);
  const keySet: OidcKeySet = { current: opts.jwk, previous: opts.previousJwk };
  const currentKid = oidcKid(opts.jwk);
  if (opts.previousJwk && oidcKid(opts.previousJwk) === currentKid) {
    throw new Error("VAULT_OIDC_PREVIOUS_JWK must be a different key from VAULT_OIDC_PRIVATE_JWK");
  }
  const cimdGate = opts.cimdGate ?? sharedCimdGate;
  const { kernel } = opts;

  /** Ledger input for a token, with the org read from its Grant (marker set at consent). */
  async function issuedInput(
    token: { jti: string; clientId: string; accountId?: string; exp?: number; grantId?: string },
    grant: Grant | undefined,
    clientName: string | undefined,
    issuance: IssuanceKind,
  ): Promise<IssuedTokenInput> {
    const orgId = token.accountId ? await orgForIssuance(kernel, grant, token.accountId) : undefined;
    return {
      jti: token.jti,
      oauthClientId: token.clientId,
      accountId: token.accountId,
      exp: token.exp,
      clientName,
      orgId,
      grantId: token.grantId,
      issuance,
    };
  }

  /**
   * A refresh must not outlive the vault client it was consented for. Runs before the
   * refresh token is rotated, so a refused refresh leaves nothing half-issued.
   */
  async function assertGrantClientLive(ctx: ProviderContext): Promise<void> {
    const grant = ctx.oidc?.entities?.Grant;
    const refresh = ctx.oidc?.entities?.RefreshToken;
    const accountId = grant?.accountId ?? refresh?.accountId;
    const clientId = grant?.clientId ?? refresh?.clientId;
    if (!accountId || !clientId) return;
    const orgId = await orgForIssuance(kernel, grant, accountId);
    const client = await kernel.store.findClientByOrgAndOauthId(orgId, clientId);
    if (client?.revokedAt) throw new oidcErrors.InvalidGrant("client is revoked");
  }

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
            // Always sign with the current key, even while the previous one is still published.
            jwt: { sign: { alg: "RS256", kid: currentKid } },
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
      // Nothing here binds tokens to a DPoP key; leaving the feature on would advertise
      // sender constraining that /mcp does not enforce.
      dPoP: { enabled: false },
      clientIdMetadataDocument: {
        enabled: true,
        ack: "draft-02",
        allowFetch: (ctx, clientId) =>
          cimdGate.allow(clientId, ctx ? requestClientIp(ctx.req) : undefined, Date.now()),
        cacheDuration: { min: 60, max: 3600 },
      },
    },
    fetch: cimdGate.wrap(opts.fetchImpl ?? createPinnedFetch()),
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
      const accountId = typeof token.accountId === "string" ? token.accountId : undefined;
      if (!accountId) throw new oidcErrors.InvalidGrant("access token has no account");
      const grantType = ctx.oidc?.params?.grant_type;
      const issuance = typeof grantType === "string" ? issuanceKind(grantType) : issuanceFromGty(token.gty);
      const input = await issuedInput(
        { jti: token.jti, clientId: token.clientId, accountId, exp: token.exp, grantId: token.grantId },
        ctx.oidc?.entities?.Grant,
        ctx.oidc?.client?.clientName,
        issuance,
      );
      await persistIssuedAccess(kernel, input, environment);
      // The org the operator consented in rides in the token; /mcp verifies membership against it.
      return { [ORG_CLAIM]: input.orgId };
    },
    jwks: {
      keys: opts.previousJwk ? [signingKey(opts.jwk), signingKey(opts.previousJwk)] : [signingKey(opts.jwk)],
    },
    issueRefreshToken: () => true,
    rotateRefreshToken: async (ctx) => {
      await assertGrantClientLive(ctx);
      return true;
    },
    scopes: [...OAUTH_SCOPES],
    clientAuthMethods: [...OAUTH_TOKEN_ENDPOINT_AUTH_METHODS],
    responseTypes: [...OAUTH_RESPONSE_TYPES],
    clientDefaults: {
      application_type: "native",
      token_endpoint_auth_method: "none",
      grant_types: [...OAUTH_GRANT_TYPES],
      response_types: [...OAUTH_RESPONSE_TYPES],
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

  /**
   * RFC 7009 completions oidc-provider does not do on its own, run once its chain has
   * answered for an authenticated client:
   * - a revoked refresh token took its grant with it; the access tokens issued under that
   *   grant are JWTs that still verify, so the ledger denylists them by grant id here,
   *   before the 200 goes out;
   * - a JWT access token is refused by the engine (structured tokens are not in its
   *   store), so one that verifies and belongs to this client is denylisted by jti. The
   *   response is 200 either way, as the RFC requires for unknown tokens.
   */
  provider.use(async (ctx, next) => {
    await next();
    if (ctx.oidc?.route !== "revocation") return;
    const token = ctx.oidc.params?.token;
    const client = ctx.oidc.client;
    if (typeof token !== "string" || !client) return;
    const revoked = ctx.oidc.entities?.RefreshToken ?? ctx.oidc.entities?.AccessToken;
    if (revoked?.grantId) {
      await persistRevokedGrant(kernel, revoked.grantId);
      return;
    }
    if (!looksLikeJwt(token)) return;
    const payload = await verifyAccessJwt(token, keySet, issuer);
    if (payload && payload.client_id === client.clientId && typeof payload.jti === "string") {
      await persistRevokedToken(kernel, payload.jti);
    }
    ctx.status = 200;
    ctx.body = "";
  });

  bindings.set(provider, { kernel, secureCookies: opts.secureCookies, callback: provider.callback() });

  const clientNameFor = async (clientId: string): Promise<string | undefined> => {
    try {
      return (await provider.Client.find(clientId))?.clientName;
    } catch {
      return undefined;
    }
  };

  const grantFor = async (grantId: string | undefined): Promise<Grant | undefined> => {
    if (!grantId) return undefined;
    try {
      return await provider.Grant.find(grantId, { ignoreExpiration: true });
    } catch {
      return undefined;
    }
  };

  provider.on("access_token.issued", (...args: unknown[]) => {
    const token = asTokenRef(args[0]);
    if (!token?.jti || !token.clientId) return;
    const { jti, clientId } = token;
    void Promise.all([clientNameFor(clientId), grantFor(token.grantId)])
      .then(([clientName, grant]) =>
        issuedInput(
          { jti, clientId, accountId: token.accountId, exp: token.exp, grantId: token.grantId },
          grant,
          clientName,
          issuanceFromGty(token.gty),
        ),
      )
      .then((input) => persistIssuedAccess(kernel, input, environment))
      .catch((err: unknown) => logLedgerPersistFailure("access_issued", err));
  });

  provider.on("refresh_token.saved", (...args: unknown[]) => {
    const token = asTokenRef(args[0]);
    if (!token?.jti || !token.clientId) return;
    const { jti, clientId } = token;
    void Promise.all([clientNameFor(clientId), grantFor(token.grantId)])
      .then(([clientName, grant]) =>
        issuedInput(
          { jti, clientId, accountId: token.accountId, exp: token.exp, grantId: token.grantId },
          grant,
          clientName,
          issuanceFromGty(token.gty),
        ),
      )
      .then((input) => persistIssuedRefresh(kernel, input, environment))
      .catch((err: unknown) => logLedgerPersistFailure("refresh_saved", err));
  });

  const onDestroyed = (...args: unknown[]) => {
    const token = asTokenRef(args[0]);
    if (token?.jti) {
      void persistRevokedToken(kernel, token.jti).catch((err: unknown) =>
        logLedgerPersistFailure("token_destroyed", err),
      );
    }
  };
  provider.on("access_token.destroyed", onDestroyed);
  provider.on("refresh_token.destroyed", onDestroyed);
  // Emitted with (ctx, grantId) when a refresh token is revoked or replayed: every access
  // token issued under that grant is still valid by signature, so the ledger denylists them.
  provider.on("grant.revoked", (...args: unknown[]) => {
    const grantId = args[1];
    logVaultEvent("oauth_grant_revoked", {});
    if (typeof grantId !== "string") return;
    void persistRevokedGrant(kernel, grantId).catch((err: unknown) =>
      logLedgerPersistFailure("grant_revoked", err),
    );
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

export const DEVICE_ATTEMPTS_PER_WINDOW = 10;
const DEVICE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * `POST /device` takes the user code, a short digit string, so guesses are cheap. Ten
 * attempts per 15 minutes per requesting IP, and the same per OP session cookie so a
 * browser session cannot spread its guesses across addresses.
 */
export function assertDeviceAttempt(req: IncomingMessage, limiter: IpWindowLimiter = deviceLimiter): void {
  const now = Date.now();
  const ip = requestClientIp(req);
  if (!limiter.allow(`device-ip:${ip}`, DEVICE_ATTEMPTS_PER_WINDOW, DEVICE_ATTEMPT_WINDOW_MS, now)) {
    throw new HttpError(429, "Too many device code attempts");
  }
  const session = cookieValue(req, "_session");
  if (
    session &&
    !limiter.allow(`device-session:${hashToken(session)}`, DEVICE_ATTEMPTS_PER_WINDOW, DEVICE_ATTEMPT_WINDOW_MS, now)
  ) {
    throw new HttpError(429, "Too many device code attempts");
  }
}

/**
 * Hands a request to oidc-provider and settles when its response has been written.
 * Koa's callback takes no `next`; an error escaping it (Koa answers its own errors, so
 * this is a last resort) is turned into a JSON error response when nothing was sent yet.
 */
export async function handleOauth(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  bindSecurityHeaders(res);
  const cb = bindings.get(provider)?.callback ?? provider.callback();
  try {
    await cb(req, res);
  } catch (err) {
    if (res.headersSent) throw err;
    sendError(res, err);
  }
}
