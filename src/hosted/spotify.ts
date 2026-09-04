/**
 * Compatibility shim for kernel.ts's Spotify user-connect flow. Every fact lives in
 * src/hosted/providers/registry.ts; these wrappers bind the generic engine to the `spotify`
 * entry so kernel.ts compiles unchanged. New callers should use the provider modules directly.
 */
import type { ConnectorFetch, ConnectorItem, ConnectorResult } from "./connector.ts";
import { HttpError } from "./errors.ts";
import { exchangeAuthorizationCode, mintClientCredentials, refreshAccessToken } from "./providers/oauth.ts";
import { providerById } from "./providers/registry.ts";
import { clearMintCache } from "./providers/token-cache.ts";
import type { MintedToken, Provider } from "./providers/types.ts";
import {
  authorizeUrl,
  chooseRedirect,
  openOauthState as openProviderOauthState,
  sealOauthState as sealProviderOauthState,
  type ProviderOauthState,
} from "./providers/user-oauth.ts";

export { pkceVerifier } from "./providers/user-oauth.ts";
export { refreshItemName } from "./providers/oauth.ts";
export type { MintedToken } from "./providers/types.ts";

function spotify(): Provider {
  const provider = providerById("spotify");
  if (!provider) throw new Error("spotify provider missing from registry");
  return provider;
}

export const SPOTIFY_API_HOST = spotify().apiHosts[0] ?? "api.spotify.com";
export const SPOTIFY_ACCOUNTS_HOST = spotify().tokenHost;

export type MintKind = "client_credentials" | "refresh" | "authorization_code";

/** Kernel's sealed state shape. The provider id is fixed to spotify on seal and checked on open. */
export type SpotifyOauthState = Omit<ProviderOauthState, "providerId">;

export function clearSpotifyMintCache(): void {
  clearMintCache();
}

export function chooseSpotifyRedirect(publicUrl: string, requested?: string): string {
  return chooseRedirect(spotify(), publicUrl, requested);
}

export function sealOauthState(payload: SpotifyOauthState, kek: Buffer): string {
  return sealProviderOauthState({ ...payload, providerId: "spotify" }, kek);
}

export function openOauthState(state: string, kek: Buffer, now = Date.now()): SpotifyOauthState {
  const opened = openProviderOauthState(state, kek, now);
  if (opened.providerId !== "spotify") {
    throw new HttpError(400, "Invalid OAuth state", { provider: opened.providerId });
  }
  return opened;
}

export function spotifyAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  scopes?: string;
}): string {
  return authorizeUrl(spotify(), {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    state: input.state,
    codeVerifier: input.codeVerifier,
    scopes: input.scopes?.split(" ").filter(Boolean),
  });
}

/** Legacy entry point; dispatches to the generic engine by grant type. */
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
  const provider = spotify();
  const deps = { fetchImpl: input.fetchImpl, resolveAddresses: input.resolveAddresses };
  switch (input.grantType) {
    case "client_credentials":
      return mintClientCredentials(provider, input.item, input.clientId, deps);
    case "refresh":
      return refreshAccessToken(
        provider,
        input.refreshToken ? { ...input.item, secret: input.refreshToken } : input.item,
        input.clientId,
        deps,
      );
    case "authorization_code":
      return exchangeAuthorizationCode(
        provider,
        input.item,
        {
          clientId: input.clientId,
          code: input.code ?? "",
          redirectUri: input.redirectUri ?? "",
          codeVerifier: input.codeVerifier,
        },
        deps,
      );
    default: {
      const _exhaustive: never = input.grantType;
      throw new Error(`Unhandled grant type: ${String(_exhaustive)}`);
    }
  }
}
