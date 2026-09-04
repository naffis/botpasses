# 0004. Same-origin OAuth authorization server

- Status: accepted
- Date: 2026-08-31

## Context

MCP clients must discover an authorization server for `/mcp`. Clerk was that AS. Hand-rolling authorize/token/PKCE is the CVE class. Official MCP SDK AS helpers are frozen.

## Decision

This origin is the AS, using `oidc-provider` 9.12 as the protocol engine. We own clients, consent, keys, CIMD fetch (SSRF-pinned), and DCR policy.

Locks: PKCE S256 only; `aud` = `${origin}/mcp`; access JWT TTL 600s; `features.revocation` at `/oauth/revoke`; CIMD via oidc-provider `features.clientIdMetadataDocument` with `fetch` replaced by `createPinnedFetch` (`cimd-fetch.ts`); DCR redirect_uris are https, IP-literal loopback http (`127.0.0.1`, `[::1]`), or a named desktop scheme; no `logo_uri` on consent; `devInteractions` off; `provider.proxy` on hosted; OP session TTL 1 h, login never remembered, destroyed on logout; cookie keys HKDF-derived from `VAULT_SESSION_SECRET`.

Amended 2026-09-04: the vault client is `(org_id, oauth_client_id)`. The access JWT `sub` (the operator account) selects the org before the client lookup, because hosted MCP clients register one dynamic client id per server URL and reuse it for every user. Clients are created in the plane's default environment and named after `client_name`.

JWT access tokens emit `access_token.issued`. Ledger write is `extraTokenClaims` (return `undefined`, throw fails the grant) plus that event. Refresh: `refresh_token.saved`. JWT ATs are not in the adapter.

## Consequences

- Env: `VAULT_OIDC_PRIVATE_JWK` (RS256 private JWK).
- Well-known documents name this origin only.
- Immediate revoke is `clients.revoked_at` + `jti` denylist + reject missing `jti`.

## Alternatives considered

- Clerk / Auth0 / WorkOS as AS. Same vendor class.
- Better Auth MCP plugin. Unauthenticated DCR defaults; new package.
- Hand-rolled authorize/token. RFC 9700 interop risk.
