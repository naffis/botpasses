# 0004. Same-origin OAuth authorization server

- Status: accepted
- Date: 2026-08-31

## Context

MCP clients must discover an authorization server for `/mcp`. Clerk was that AS. Hand-rolling authorize/token/PKCE is the CVE class. Official MCP SDK AS helpers are frozen.

## Decision

This origin is the AS, using `oidc-provider` 9.12 as the protocol engine. We own clients, consent, keys, CIMD fetch (SSRF-pinned), and DCR policy.

Locks: PKCE S256 only; `aud` = `${origin}/mcp`; access JWT TTL 600s; `features.revocation` at `/oauth/revoke`; CIMD via `cimd-fetch.ts`; DCR HTTPS redirect_uris (loopback http exception); no `logo_uri` on consent; `devInteractions` off.

JWT access tokens emit `access_token.issued`. Ledger write is `extraTokenClaims` (return `undefined`, throw fails the grant) plus that event. Refresh: `refresh_token.saved`. JWT ATs are not in the adapter.

## Consequences

- Env: `VAULT_OIDC_PRIVATE_JWK` (RS256 private JWK).
- Well-known documents name this origin only.
- Immediate revoke is `clients.revoked_at` + `jti` denylist + reject missing `jti`.

## Alternatives considered

- Clerk / Auth0 / WorkOS as AS. Same vendor class.
- Better Auth MCP plugin. Unauthenticated DCR defaults; new package.
- Hand-rolled authorize/token. RFC 9700 interop risk.
