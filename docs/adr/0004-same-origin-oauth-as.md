# 0004. Same-origin OAuth authorization server

- Status: accepted
- Date: 2026-08-31

## Context

MCP clients must discover an authorization server for `/mcp`. Clerk was that AS. Hand-rolling authorize/token/PKCE is the CVE class. Official MCP SDK AS helpers are frozen.

## Decision

This origin is the AS, using `oidc-provider` 9.12 as the protocol engine. We own clients, consent, keys, CIMD fetch (SSRF-pinned), and DCR policy.

Locks: PKCE S256 only; `aud` = `${origin}/mcp`; access JWT TTL 600s; `features.revocation` at `/oauth/revoke`; CIMD via oidc-provider `features.clientIdMetadataDocument` with `fetch` replaced by `createPinnedFetch` (`cimd-fetch.ts`); DCR redirect_uris are https, RFC 8252 loopback http (`127.0.0.1`, `[::1]`, `localhost`), or a named desktop scheme (cursor, cursor-mcp, vscode, vscode-insiders, grok, grokbot, xai, xai-grok); no `logo_uri` on consent; `devInteractions` off; `provider.proxy` on hosted; OP session TTL 1 h, login never remembered, destroyed on logout; cookie keys HKDF-derived from `VAULT_SESSION_SECRET`.

Amended 2026-09-10 (BOTP-12): `http://localhost` is accepted again for DCR. S17 had refused it because the name can resolve off-box, but MCP hosts register `http://localhost:<port>/callback` in the same DCR set as a desktop scheme and an https cloud callback. One rejected URI failed the whole registration (`assertRedirectUri` in `oauth-clients.ts`). SSRF still refuses localhost as a connect target.

Amended 2026-09-10 (BOTP-13): a 401 on GET or HEAD `/mcp` (the SSE listen) sends the same Bearer `WWW-Authenticate` with `resource_metadata` as `POST /mcp` `tools/call`. Streamable HTTP hosts open that stream during connect; omitting the challenge left needsAuth with no auth URL (Authorize → Retry, no browser). Handshake methods (`initialize`, `ping`, `tools/list`) may still answer without a principal so a preconfigured `avm_` token does not force a connect card. A rejected DCR `redirect_uri` logs `dcr_redirect_rejected` with scheme and reason only.

Amended 2026-09-04: the vault client is `(org_id, oauth_client_id)`. The access JWT `sub` (the operator account) selects the org before the client lookup, because hosted MCP clients register one dynamic client id per server URL and reuse it for every user. Clients are created in the plane's default environment and named after `client_name`.

JWT access tokens emit `access_token.issued`. Ledger write is `extraTokenClaims` (returns the `org_id` claim, throw fails the grant) plus that event. Refresh: `refresh_token.saved`. JWT ATs are not in the adapter.

Amended 2026-09-04 (audit W2): consent binds the operator session's org into the Grant (`org:<id>` resource scope); the access JWT carries it as `org_id` and `/mcp` verifies membership against it, never the account's first membership. Only a fresh consent reactivates a revoked `(org_id, oauth_client_id)` row; a refresh for a revoked client is `invalid_grant`, and revoking the client destroys every grant the org's members gave for that client id. Engine options (`clientAuthMethods: ["none"]`, `responseTypes: ["code"]`, scopes, grant types, DPoP off) and the discovery document come from one constant set. `VAULT_OIDC_PREVIOUS_JWK` keeps a retired key in JWKS for verification only.

## Consequences

- Env: `VAULT_OIDC_PRIVATE_JWK` (RS256 private JWK); `VAULT_OIDC_PREVIOUS_JWK` during a rotation ([runbook](../ops/oidc-key-rotation.md)).
- Well-known documents name this origin only.
- Immediate revoke is `clients.revoked_at` + `jti` denylist + grant denylist (`access_events.grant_id`) + reject missing `jti` or `org_id`.

## Alternatives considered

- Clerk / Auth0 / WorkOS as AS. Same vendor class.
- Better Auth MCP plugin. Unauthenticated DCR defaults; new package.
- Hand-rolled authorize/token. RFC 9700 interop risk.
