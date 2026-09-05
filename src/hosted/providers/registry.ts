/**
 * Known OAuth2 providers. Every vendor fact (hosts, token endpoint shape, scopes, hints) is an
 * entry here; connector.ts and mcp-http.ts stay vendor-free and look providers up by host.
 */
import type { Provider, ProviderId, UserPathHint } from "./types.ts";

const OAUTH_TOKEN_KEYS = ["access_token", "refresh_token", "id_token"];

export const PROVIDERS: readonly Provider[] = [
  {
    id: "spotify",
    displayName: "Spotify",
    apiHosts: ["api.spotify.com"],
    tokenHost: "accounts.spotify.com",
    tokenPath: "/api/token",
    tokenAuth: "basic",
    grantTypes: ["client_credentials", "authorization_code", "refresh_token"],
    authorizeUrl: "https://accounts.spotify.com/authorize",
    scopesParam: "scope",
    defaultScopes: [
      "user-read-email",
      "user-read-private",
      "playlist-read-private",
      "playlist-read-collaborative",
      "playlist-modify-public",
      "playlist-modify-private",
    ],
    pkce: true,
    redactKeys: OAUTH_TOKEN_KEYS,
    userPathHints: [
      {
        pathPrefixes: ["/v1/me", "/v1/playlists", "/v1/users/*/playlists"],
        message:
          "Client credentials cannot call this path or private playlists. Connect a Spotify user in the Botpasses console (Authorization Code + PKCE). Public search (GET /v1/search) works with the app token.",
      },
    ],
    docsUrl: "https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow",
  },
  {
    id: "github",
    displayName: "GitHub",
    apiHosts: ["api.github.com"],
    tokenHost: "github.com",
    tokenPath: "/login/oauth/access_token",
    tokenAuth: "post_body",
    // GitHub Apps have no client_credentials grant; app tokens come from user or installation flows.
    grantTypes: ["authorization_code", "refresh_token"],
    authorizeUrl: "https://github.com/login/oauth/authorize",
    scopesParam: "scope",
    pkce: false,
    redactKeys: OAUTH_TOKEN_KEYS,
    docsUrl: "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps",
  },
  {
    id: "google",
    displayName: "Google",
    apiHosts: ["www.googleapis.com", "gmail.googleapis.com", "sheets.googleapis.com"],
    tokenHost: "oauth2.googleapis.com",
    tokenPath: "/token",
    tokenAuth: "post_body",
    grantTypes: ["authorization_code", "refresh_token"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    // Google refuses an authorize request without `scope`. `openid email` names the account; the
    // rest are the narrowest scopes for each API host above (Gmail read, Sheets read, Drive
    // limited to files the app opened or created).
    scopesParam: "scope",
    scopesRequired: true,
    defaultScopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
    // A refresh token comes only with offline access, and after the first consent only when the
    // user is asked again; a re-connect must be able to rotate the stored refresh token.
    authorizeParams: { access_type: "offline", prompt: "consent" },
    pkce: true,
    redactKeys: OAUTH_TOKEN_KEYS,
    docsUrl: "https://developers.google.com/identity/protocols/oauth2/web-server",
  },
  {
    id: "slack",
    displayName: "Slack",
    apiHosts: ["slack.com"],
    tokenHost: "slack.com",
    tokenPath: "/api/oauth.v2.access",
    tokenAuth: "basic",
    grantTypes: ["authorization_code", "refresh_token"],
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    // A user token (xoxp) is requested with `user_scope`; `scope` asks for a bot token instead.
    // Slack joins scopes with commas and refuses an authorize request that names none.
    scopesParam: "user_scope",
    scopesDelimiter: ",",
    scopesRequired: true,
    defaultScopes: ["users:read", "channels:read", "chat:write"],
    pkce: false,
    redactKeys: OAUTH_TOKEN_KEYS,
    docsUrl: "https://api.slack.com/authentication/oauth-v2",
  },
  {
    id: "stripe",
    displayName: "Stripe Connect",
    apiHosts: ["api.stripe.com"],
    tokenHost: "connect.stripe.com",
    tokenPath: "/oauth/token",
    tokenAuth: "post_body",
    grantTypes: ["authorization_code", "refresh_token"],
    authorizeUrl: "https://connect.stripe.com/oauth/authorize",
    scopesParam: "scope",
    defaultScopes: ["read_write"],
    pkce: false,
    redactKeys: OAUTH_TOKEN_KEYS,
    docsUrl: "https://docs.stripe.com/connect/oauth-reference",
  },
];

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Provider whose API hosts or token host include `host`. Exact, case-insensitive. */
export function providerForHost(host: string): Provider | undefined {
  const h = host.toLowerCase();
  return PROVIDERS.find((p) => p.tokenHost === h || p.apiHosts.includes(h));
}

export function isProviderId(value: string): value is ProviderId {
  return PROVIDERS.some((p) => p.id === value);
}

function pathOnly(path: string): string {
  return path.split("?")[0] ?? "";
}

/** True when `host`/`path` is the provider's token endpoint (query string ignored). */
export function isTokenPath(provider: Provider, host: string, path: string): boolean {
  return host.toLowerCase() === provider.tokenHost && pathOnly(path) === provider.tokenPath;
}

/** True when the API host belongs to the provider (the token host does not count). */
export function isApiHost(provider: Provider, host: string): boolean {
  return provider.apiHosts.includes(host.toLowerCase());
}

/** Prefix match where `*` stands for exactly one path segment. */
export function pathMatchesPrefix(path: string, prefix: string): boolean {
  const segs = pathOnly(path).split("/").filter(Boolean);
  const want = prefix.split("/").filter(Boolean);
  if (want.length > segs.length) return false;
  return want.every((w, i) => w === "*" || w === segs[i]);
}

/** The hint whose prefixes cover this API path, if the path needs a user token. */
export function userPathHint(provider: Provider, host: string, path: string): UserPathHint | undefined {
  if (!isApiHost(provider, host)) return undefined;
  return provider.userPathHints?.find((hint) => hint.pathPrefixes.some((p) => pathMatchesPrefix(path, p)));
}
