/**
 * A provider is data: everything Botpasses needs to mint, refresh, and steer for one OAuth2
 * vendor. No provider-specific code lives outside the registry; engines read these fields.
 */
import type { OauthGrantType, TokenAuthStyle } from "../../hosted-types.ts";

export type ProviderId = "spotify" | "github" | "google" | "slack" | "stripe";

/**
 * Paths that need a user token rather than an app token. A prefix matches the path itself or
 * any path below it; a `*` segment matches exactly one path segment (`/v1/users/*\/playlists`).
 */
export type UserPathHint = {
  pathPrefixes: string[];
  message: string;
};

export type Provider = {
  id: ProviderId;
  displayName: string;
  /** Resource hosts a minted or stored token is sent to as `Authorization: Bearer`. */
  apiHosts: string[];
  /** Host of the token endpoint. Client credentials are sent here, never to an API host. */
  tokenHost: string;
  tokenPath: string;
  tokenAuth: TokenAuthStyle;
  grantTypes: OauthGrantType[];
  /** Absolute authorize URL for the user connect flow (authorization_code). */
  authorizeUrl?: string;
  /** Name of the query parameter that carries scopes on `authorizeUrl`. */
  scopesParam?: string;
  defaultScopes?: string[];
  /** Whether the user connect flow sends a PKCE challenge (RFC 7636). */
  pkce?: boolean;
  /** JSON keys in token-endpoint bodies that must read `[redacted]` in tool results. */
  redactKeys: string[];
  userPathHints?: UserPathHint[];
  docsUrl?: string;
};

export type MintedToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  last4: string;
  tokenType: string;
};
