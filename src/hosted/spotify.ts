/**
 * Spotify app tokens (client credentials) and user tokens (auth code + PKCE).
 * Values never leave the vault process. Tool results show [redacted] only.
 */
import { createHash, randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../crypto.ts";
import { redactOauthJson } from "../redact.ts";
import { HttpError } from "./errors.ts";
import type { ConnectorFetch, ConnectorItem, ConnectorResult } from "./connector.ts";
import { executeConnector } from "./connector.ts";

export const SPOTIFY_API_HOST = "api.spotify.com";
export const SPOTIFY_ACCOUNTS_HOST = "accounts.spotify.com";
export const SPOTIFY_LOOPBACK_REDIRECT = "http://127.0.0.1:8888/callback";

const TOKEN_SKEW_MS = 60_000;
const USER_SCOPES = [
  "user-read-email",
  "user-read-private",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
].join(" ");

export type MintKind = "client_credentials" | "refresh" | "authorization_code";

export type MintedToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  last4: string;
  tokenType: string;
};

export type SpotifyUserStart = {
  authorize_url: string;
  redirect_uri: string;
  state: string;
};

export type SpotifyOauthState = {
  orgId: string;
  userId: string;
  itemId: string;
  itemName: string;
  environment: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  exp: number;
};

type CacheKey = string;
const mintCache = new Map<CacheKey, MintedToken>();

export function clearSpotifyMintCache(): void {
  mintCache.clear();
}

function cacheKey(orgId: string, itemId: string, clientId: string, kind: MintKind): CacheKey {
  return `${orgId}:${itemId}:${clientId}:${kind}`;
}

export function isSpotifyApiHost(host: string): boolean {
  return host.toLowerCase() === SPOTIFY_API_HOST;
}

export function isSpotifyAccountsHost(host: string): boolean {
  return host.toLowerCase() === SPOTIFY_ACCOUNTS_HOST;
}

export function isSpotifyTokenPath(host: string, path: string): boolean {
  return isSpotifyAccountsHost(host) && path.split("?")[0] === "/api/token";
}

export function isSpotifyUserPath(host: string, path: string): boolean {
  if (!isSpotifyApiHost(host)) return false;
  const p = path.split("?")[0] ?? "";
  if (p === "/v1/me" || p.startsWith("/v1/me/")) return true;
  if (p === "/v1/playlists" || p.startsWith("/v1/playlists/")) return true;
  if (p.startsWith("/v1/users/") && p.includes("/playlists")) return true;
  return false;
}

export function isClientSecretInject(inject: string): boolean {
  return inject === "basic" || inject === "client_credentials";
}

/** App client secret: Basic username is the public Client ID. */
export function resolveSpotifyClientId(item: ConnectorItem, argsClientId?: string): string | undefined {
  const fromArgs = argsClientId?.trim();
  if (fromArgs) return fromArgs;
  const fromItem = item.username?.trim();
  if (fromItem) return fromItem;
  return undefined;
}

export function shouldMintClientCredentials(input: {
  host: string;
  path: string;
  item: ConnectorItem;
  clientId?: string;
}): boolean {
  if (isSpotifyTokenPath(input.host, input.path)) return false;
  if (!isSpotifyApiHost(input.host)) return false;
  if (isClientSecretInject(input.item.inject)) return true;
  if (resolveSpotifyClientId(input.item, input.clientId)) return true;
  return false;
}

export function shouldUseBasicOnTokenHost(host: string, item: ConnectorItem): boolean {
  if (isSpotifyAccountsHost(host)) return true;
  return isClientSecretInject(item.inject);
}

export function userContextHint(path: string): string {
  return (
    `Client credentials cannot call ${path.split("?")[0] || "/v1/me"} or private playlists. ` +
    "Connect a Spotify user in the Botpasses console (Authorization Code + PKCE). " +
    "Public search (GET /v1/search) works with the app token."
  );
}

export function emptyOriginHint(status: number): string | undefined {
  if (status === 410) {
    return (
      "Upstream returned 410 with an empty body. This is the origin status, not a Botpasses consume error. " +
      "Retry uses the same approval — do not ask for a new 8-digit code."
    );
  }
  if (status === 401) {
    return (
      "Upstream 401: missing or invalid access token. A Client Secret is not a user access token. " +
      "Token mint uses HTTP Basic (client_id:client_secret) and application/x-www-form-urlencoded. " +
      "Retry uses the same approval."
    );
  }
  return undefined;
}

export { redactOauthJson };

export function redactConnectorOauthBody(body: string, item: ConnectorItem, extra: string[] = []): string {
  let out = redactOauthJson(body);
  if (item.secret.length > 0) out = out.split(item.secret).join("[redacted]");
  for (const value of extra) {
    if (value.length >= 8) out = out.split(value).join("[redacted]");
  }
  if (item.last4.length >= 4 && item.secret.length >= 8) {
    out = out.split(item.last4).join("••••");
  }
  return out;
}

function last4(value: string): string {
  return value.length <= 4 ? value : value.slice(-4);
}

export function readMintedAccessToken(body: string): MintedToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(502, "Token endpoint returned a non-JSON body");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new HttpError(502, "Token endpoint returned a non-object body");
  }
  const rec = parsed as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
  };
  if (typeof rec.access_token !== "string" || rec.access_token.length === 0) {
    throw new HttpError(502, "Token endpoint did not return access_token");
  }
  const expiresIn = typeof rec.expires_in === "number" ? rec.expires_in : 3600;
  return {
    accessToken: rec.access_token,
    refreshToken: typeof rec.refresh_token === "string" && rec.refresh_token.length > 0
      ? rec.refresh_token
      : undefined,
    expiresAt: Date.now() + Math.max(30, expiresIn) * 1000,
    last4: last4(rec.access_token),
    tokenType: typeof rec.token_type === "string" ? rec.token_type : "Bearer",
  };
}

export function cachedMint(orgId: string, itemId: string, clientId: string, kind: MintKind): MintedToken | undefined {
  const hit = mintCache.get(cacheKey(orgId, itemId, clientId, kind));
  if (!hit) return undefined;
  if (hit.expiresAt - TOKEN_SKEW_MS <= Date.now()) {
    mintCache.delete(cacheKey(orgId, itemId, clientId, kind));
    return undefined;
  }
  return hit;
}

export function storeMint(orgId: string, itemId: string, clientId: string, kind: MintKind, token: MintedToken): void {
  mintCache.set(cacheKey(orgId, itemId, clientId, kind), token);
}

export function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function hostedSpotifyRedirect(publicUrl: string): string {
  return `${publicUrl.replace(/\/$/, "")}/integrations/spotify/callback`;
}

export function chooseSpotifyRedirect(publicUrl: string, requested?: string): string {
  const hosted = hostedSpotifyRedirect(publicUrl);
  if (!requested) {
    return publicUrl.startsWith("http://127.0.0.1") || publicUrl.startsWith("http://localhost")
      ? SPOTIFY_LOOPBACK_REDIRECT
      : hosted;
  }
  if (requested === hosted || requested === SPOTIFY_LOOPBACK_REDIRECT) return requested;
  throw new HttpError(400, "redirect_uri must be the Botpasses callback or http://127.0.0.1:8888/callback");
}

export function sealOauthState(payload: SpotifyOauthState, kek: Buffer): string {
  const envelope = encrypt(JSON.stringify(payload), kek, "spotify-oauth-state");
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function openOauthState(state: string, kek: Buffer, now = Date.now()): SpotifyOauthState {
  let envelope: { iv: string; ciphertext: string; tag: string };
  try {
    envelope = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
      iv: string;
      ciphertext: string;
      tag: string;
    };
  } catch {
    throw new HttpError(400, "Invalid Spotify OAuth state");
  }
  let raw: string;
  try {
    raw = decrypt(envelope, kek, "spotify-oauth-state");
  } catch {
    throw new HttpError(400, "Invalid Spotify OAuth state");
  }
  const parsed = JSON.parse(raw) as SpotifyOauthState;
  if (!parsed.orgId || !parsed.clientId || !parsed.codeVerifier || !parsed.redirectUri) {
    throw new HttpError(400, "Invalid Spotify OAuth state");
  }
  if (parsed.exp < now) throw new HttpError(410, "Spotify OAuth state expired");
  return parsed;
}

export function spotifyAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  scopes?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scopes ?? USER_SCOPES,
    state: input.state,
    code_challenge: pkceChallenge(input.codeVerifier),
    code_challenge_method: "S256",
  });
  return `https://${SPOTIFY_ACCOUNTS_HOST}/authorize?${params.toString()}`;
}

export function tokenFormBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export async function mintSpotifyAccessToken(input: {
  item: ConnectorItem;
  clientId: string;
  grantType: MintKind;
  refreshToken?: string;
  code?: string;
  redirectUri?: string;
  codeVerifier?: string;
  fetchImpl?: ConnectorFetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
}): Promise<{ minted: MintedToken; origin: ConnectorResult }> {
  const fields: Record<string, string> =
    input.grantType === "refresh"
      ? { grant_type: "refresh_token", refresh_token: input.refreshToken ?? "" }
      : input.grantType === "authorization_code" || input.code
        ? {
            grant_type: "authorization_code",
            code: input.code ?? "",
            redirect_uri: input.redirectUri ?? "",
            code_verifier: input.codeVerifier ?? "",
          }
        : { grant_type: "client_credentials" };
  const mintedItem: ConnectorItem = {
    ...input.item,
    username: input.clientId,
    inject: "basic",
    allowedHosts: input.item.allowedHosts.includes(SPOTIFY_ACCOUNTS_HOST)
      ? input.item.allowedHosts
      : [...input.item.allowedHosts, SPOTIFY_ACCOUNTS_HOST],
  };
  const origin = await executeConnector(
    mintedItem,
    {
      method: "POST",
      path: "/api/token",
      host: SPOTIFY_ACCOUNTS_HOST,
      body: fields,
      contentType: "application/x-www-form-urlencoded",
    },
    { fetchImpl: input.fetchImpl, resolveAddresses: input.resolveAddresses, redact: false },
  );
  if (origin.status < 200 || origin.status >= 300) {
    return {
      minted: { accessToken: "", expiresAt: 0, last4: "", tokenType: "Bearer" },
      origin: { ...origin, body: redactOauthJson(origin.body) },
    };
  }
  const minted = readMintedAccessToken(origin.body);
  return {
    minted,
    origin: {
      status: origin.status,
      body: redactConnectorOauthBody(origin.body, input.item, [minted.accessToken]),
    },
  };
}

export function itemWithAccessToken(item: ConnectorItem, accessToken: string): ConnectorItem {
  return {
    ...item,
    secret: accessToken,
    inject: "bearer",
    username: null,
    last4: last4(accessToken),
  };
}

export function refreshItemName(secretName: string): string {
  return secretName.endsWith("_SECRET") ? secretName.replace(/_SECRET$/, "_REFRESH") : `${secretName}_REFRESH`;
}
